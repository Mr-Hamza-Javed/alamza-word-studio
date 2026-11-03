"""Job queue, persistence and the worker-process supervisor."""

from __future__ import annotations

import asyncio
import json
import re
import multiprocessing as mp
import shutil
import sqlite3
import threading
import time
import uuid
from pathlib import Path

from .config import DB_PATH, JOBS_DIR, LOG_DIR
from .runtime import find_preview, needs_preview

# Overall progress ranges for each stage.
_STAGES_PLAIN = {"audio": (0, 3), "model": (3, 10), "transcribe": (10, 78), "align": (78, 97), "finalize": (97, 100)}
_STAGES_DIAR = {"audio": (0, 3), "model": (3, 10), "transcribe": (10, 68), "align": (68, 82), "diarize": (82, 97), "finalize": (97, 100)}

_COLUMNS = ["id", "name", "input_path", "status", "stage", "stage_label", "progress", "created", "started",
            "finished", "duration", "language", "model", "settings", "error", "warnings", "elapsed", "size", "words"]


class Broadcaster:
    def __init__(self):
        self._subs: set[tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = set()
        self._lock = threading.Lock()

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=500)
        with self._lock:
            self._subs.add((asyncio.get_running_loop(), q))
        return q

    def unsubscribe(self, q: asyncio.Queue):
        with self._lock:
            self._subs = {s for s in self._subs if s[1] is not q}

    def publish(self, event: dict):
        with self._lock:
            subs = list(self._subs)
        for loop, q in subs:
            def _put(q=q):
                if q.full():
                    try:
                        q.get_nowait()
                    except Exception:
                        pass
                q.put_nowait(event)
            try:
                loop.call_soon_threadsafe(_put)
            except RuntimeError:
                pass


class JobManager:
    def __init__(self, broadcaster: Broadcaster):
        self.events = broadcaster
        self._db_lock = threading.Lock()
        self._db = sqlite3.connect(DB_PATH, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._init_db()
        self._cv = threading.Condition()
        self._cancel: set[str] = set()
        self._current: str | None = None
        self._proc = None
        self._conn = None
        self._running = True
        self._worker_state = "stopped"
        self.downloads: dict[str, dict] = {}
        self._thread = threading.Thread(target=self._loop, name="ws-supervisor", daemon=True)
        self._thread.start()

    # ---------------- persistence ----------------
    def _init_db(self):
        with self._db_lock:
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS jobs (" + ", ".join(
                    f"{c} TEXT PRIMARY KEY" if c == "id" else f"{c}" for c in _COLUMNS) + ")")
            existing = {r[1] for r in self._db.execute("PRAGMA table_info(jobs)")}
            for c in _COLUMNS:
                if c not in existing:
                    self._db.execute(f"ALTER TABLE jobs ADD COLUMN {c}")
            # Anything left running when the app closed goes back to the queue.
            self._db.execute("UPDATE jobs SET status='queued', stage=NULL, progress=0 WHERE status='running'")
            self._db.commit()

    def _row(self, row) -> dict | None:
        if row is None:
            return None
        d = dict(row)
        for key in ("settings", "warnings"):
            try:
                d[key] = json.loads(d[key]) if d.get(key) else ({} if key == "settings" else [])
            except Exception:
                d[key] = {} if key == "settings" else []
        d.get("settings", {}).pop("hf_token", None)
        # Media always lives in <data>/jobs/<id>/; resolve it there so a moved/copied app folder keeps working.
        if d.get("input_path"):
            d["input_path"] = str(JOBS_DIR / d["id"] / re.split(r"[\\/]", d["input_path"])[-1])
        # True when playback uses an audio-only copy instead of the original file.
        d["has_preview"] = (find_preview(JOBS_DIR / d["id"]) is not None
                            or needs_preview(Path(d.get("input_path") or "x.wav")))
        d["edited"] = _is_edited(d["id"])
        return d

    def get(self, job_id: str) -> dict | None:
        with self._db_lock:
            row = self._db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        return self._row(row)

    def list(self) -> list[dict]:
        with self._db_lock:
            rows = self._db.execute("SELECT * FROM jobs ORDER BY created DESC").fetchall()
        return [self._row(r) for r in rows]

    def _update(self, job_id: str, publish: bool = True, **fields):
        if not fields:
            return
        for k in ("settings", "warnings"):
            if k in fields and not isinstance(fields[k], str):
                fields[k] = json.dumps(fields[k])
        cols = ", ".join(f"{k}=?" for k in fields)
        with self._db_lock:
            self._db.execute(f"UPDATE jobs SET {cols} WHERE id=?", (*fields.values(), job_id))
            self._db.commit()
        if publish:
            job = self.get(job_id)
            if job:
                self.events.publish({"type": "job", "job": job})

    def _settings_raw(self, job_id: str) -> dict:
        with self._db_lock:
            row = self._db.execute("SELECT settings FROM jobs WHERE id=?", (job_id,)).fetchone()
        try:
            return json.loads(row[0]) if row and row[0] else {}
        except Exception:
            return {}

    # ---------------- public API ----------------
    def create(self, name: str, src_path: Path, settings: dict) -> dict:
        job_id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
        job_dir = JOBS_DIR / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        dest = job_dir / ("source" + src_path.suffix.lower())
        shutil.move(str(src_path), dest)
        with self._db_lock:
            self._db.execute(
                "INSERT INTO jobs (id, name, input_path, status, progress, created, model, language, settings, size, warnings) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (job_id, name, dest.name, "queued", 0, time.time(), settings.get("model"), settings.get("language"),
                 json.dumps(settings), dest.stat().st_size, "[]"))
            self._db.commit()
        job = self.get(job_id)
        self.events.publish({"type": "job", "job": job})
        with self._cv:
            self._cv.notify_all()
        return job

    def retry(self, job_id: str, settings: dict | None = None) -> dict | None:
        job = self.get(job_id)
        if not job or job["status"] in ("queued", "running"):
            return job
        new_settings = self._settings_raw(job_id)
        if settings:
            new_settings.update(settings)
        for f in ("result.json", "original.json"):
            (JOBS_DIR / job_id / f).unlink(missing_ok=True)
        self._update(job_id, status="queued", stage=None, stage_label=None, progress=0, error=None, warnings=[],
                     started=None, finished=None, elapsed=None, settings=new_settings,
                     model=new_settings.get("model"), language=new_settings.get("language"), words=None)
        with self._cv:
            self._cv.notify_all()
        return self.get(job_id)

    def cancel(self, job_id: str) -> bool:
        job = self.get(job_id)
        if not job:
            return False
        if job["status"] == "queued":
            self._update(job_id, status="cancelled", stage=None, progress=0)
            return True
        if job["status"] == "running":
            with self._cv:
                self._cancel.add(job_id)
                self._cv.notify_all()
            return True
        return False

    def delete(self, job_id: str) -> bool:
        job = self.get(job_id)
        if not job:
            return False
        if job["status"] == "running":
            self.cancel(job_id)
            for _ in range(50):
                time.sleep(0.1)
                if self._current != job_id:
                    break
        with self._db_lock:
            self._db.execute("DELETE FROM jobs WHERE id=?", (job_id,))
            self._db.commit()
        shutil.rmtree(JOBS_DIR / job_id, ignore_errors=True)
        self.events.publish({"type": "deleted", "id": job_id})
        return True

    def set_word_count(self, job_id: str, words: int):
        self._update(job_id, words=words)

    def worker_status(self) -> dict:
        return {"state": self._worker_state, "current": self._current,
                "queued": sum(1 for j in self.list() if j["status"] == "queued")}

    def unload_models(self):
        if self._conn and self._current is None:
            try:
                self._conn.send({"type": "unload"})
            except Exception:
                pass

    def release_models(self):
        """Stop the idle engine process so no model files stay open."""
        if self._current is None:
            self._kill_worker()

    def shutdown(self):
        self._running = False
        with self._cv:
            self._cv.notify_all()
        self._kill_worker()

    # ---------------- model downloads ----------------
    def download_model(self, model_id: str):
        if self.downloads.get(model_id, {}).get("state") == "downloading":
            return
        self.downloads[model_id] = {"state": "downloading", "started": time.time()}
        self.events.publish({"type": "model", "id": model_id, **self.downloads[model_id]})

        def run():
            from . import catalog

            try:
                catalog.download(model_id)
                self.downloads[model_id] = {"state": "done"}
            except Exception as exc:
                self.downloads[model_id] = {"state": "error", "error": str(exc)}
            self.events.publish({"type": "model", "id": model_id, **self.downloads[model_id]})

        threading.Thread(target=run, daemon=True).start()

    # ---------------- worker supervision ----------------
    def _next_queued(self) -> str | None:
        with self._db_lock:
            row = self._db.execute("SELECT id FROM jobs WHERE status='queued' ORDER BY created ASC LIMIT 1").fetchone()
        return row[0] if row else None

    def _ensure_worker(self):
        if self._proc is not None and self._proc.is_alive():
            return
        from .worker import worker_main

        ctx = mp.get_context("spawn")
        parent, child = ctx.Pipe()
        self._worker_state = "starting"
        self._proc = ctx.Process(target=worker_main, args=(child, str(LOG_DIR / "worker.log")), daemon=True,
                                 name="ws-worker")
        self._proc.start()
        self._conn = parent
        # Wait for "ready" (imports torch/whisperx; can take a while on first run).
        deadline = time.time() + 300
        while time.time() < deadline:
            if parent.poll(0.5):
                msg = parent.recv()
                if msg.get("type") == "ready":
                    self._worker_state = "idle"
                    return
            if not self._proc.is_alive():
                break
        raise RuntimeError("The transcription engine failed to start. See logs/worker.log.")

    def _kill_worker(self):
        proc, self._proc = self._proc, None
        self._conn = None
        self._worker_state = "stopped"
        if proc is not None and proc.is_alive():
            proc.kill()
            proc.join(5)

    def _loop(self):
        while self._running:
            job_id = self._next_queued()
            if not job_id:
                with self._cv:
                    self._cv.wait(timeout=2)
                continue
            self._run_one(job_id)

    def _run_one(self, job_id: str):
        settings = self._settings_raw(job_id)
        from .config import load_settings

        # Secrets are never stored per-job; inject the current token at run time.
        settings["hf_token"] = load_settings().get("hf_token", "")
        job = self.get(job_id)
        if not job:
            return
        ranges = _STAGES_DIAR if settings.get("diarize") else _STAGES_PLAIN
        self._current = job_id
        started = time.time()
        self._update(job_id, status="running", started=started, stage="starting", stage_label="Starting engine",
                     progress=0, error=None)
        try:
            self._ensure_worker()
        except Exception as exc:
            self._update(job_id, status="error", error=str(exc), finished=time.time())
            self._current = None
            self._kill_worker()
            return
        self._worker_state = "busy"
        payload = {"id": job_id, "input": job["input_path"], "dir": str(JOBS_DIR / job_id), "settings": settings}
        try:
            self._conn.send({"type": "job", "job": payload})
        except Exception as exc:
            self._update(job_id, status="error", error=f"Engine error: {exc}", finished=time.time())
            self._kill_worker()
            self._current = None
            return

        stage = "starting"
        last_pub = 0.0
        while True:
            if job_id in self._cancel:
                self._cancel.discard(job_id)
                self._kill_worker()
                self._update(job_id, status="cancelled", stage=None, stage_label=None, finished=time.time(),
                             elapsed=time.time() - started)
                break
            try:
                has = self._conn.poll(0.3)
            except Exception:
                has = False
            if not has:
                if self._proc is None or not self._proc.is_alive():
                    self._update(job_id, status="error", finished=time.time(),
                                 error="The engine stopped unexpectedly (possibly out of memory). Try a smaller model.")
                    self._kill_worker()
                    break
                continue
            try:
                msg = self._conn.recv()
            except Exception:
                continue
            kind = msg.get("type")
            if kind == "progress":
                stage = msg.get("stage") or stage
                lo, hi = ranges.get(stage, (0, 100))
                pct = lo + (hi - lo) * float(msg.get("stage_pct") or 0) / 100
                fields = {"stage": stage, "progress": round(pct, 2)}
                if msg.get("label"):
                    fields["stage_label"] = msg["label"]
                now = time.time()
                if msg.get("label") or now - last_pub > 0.4:
                    last_pub = now
                    self._update(job_id, **fields)
                else:
                    self._update(job_id, publish=False, **fields)
            elif kind == "meta":
                fields = {}
                if "duration" in msg:
                    fields["duration"] = msg["duration"]
                if "language" in msg:
                    fields["language"] = msg["language"]
                self._update(job_id, **fields)
            elif kind == "done":
                words = _count_words(job_id)
                self._update(job_id, status="done", stage="done", stage_label="Done", progress=100,
                             finished=time.time(), elapsed=time.time() - started, warnings=msg.get("warnings") or [],
                             language=msg.get("language"), words=words)
                self.events.publish({"type": "finished", "id": job_id, "name": job["name"], "status": "done"})
                break
            elif kind == "error":
                self._update(job_id, status="error", error=msg.get("error"), finished=time.time(),
                             elapsed=time.time() - started)
                self.events.publish({"type": "finished", "id": job_id, "name": job["name"], "status": "error"})
                break
        self._current = None
        if self._proc is not None and self._proc.is_alive():
            self._worker_state = "idle"


def _is_edited(job_id: str) -> bool:
    try:
        r = JOBS_DIR / job_id / "result.json"
        o = JOBS_DIR / job_id / "original.json"
        return r.exists() and o.exists() and r.stat().st_mtime > o.stat().st_mtime + 1
    except OSError:
        return False


def _count_words(job_id: str) -> int:
    try:
        data = json.loads((JOBS_DIR / job_id / "result.json").read_text("utf-8"))
        return sum(len(s.get("words") or s.get("text", "").split()) for s in data.get("segments", []))
    except Exception:
        return 0

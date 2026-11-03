"""FastAPI app: REST API, live events (SSE), media streaming and the web UI."""

from __future__ import annotations

import asyncio
import io
import json
import re
import shutil
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Callable

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import APP_NAME, __version__, autostart, catalog, exporters, runtime
from .config import DATA_DIR, DEFAULT_SETTINGS, JOBS_DIR, LOG_DIR, WEB_DIR, load_settings, output_dir, save_settings
from .jobs import Broadcaster, JobManager

MEDIA_TYPES = {
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg",
    ".oga": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac", ".webm": "video/webm", ".mp4": "video/mp4",
    ".m4v": "video/mp4", ".mov": "video/mp4",
}
VIDEO_EXT = {".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".wmv", ".flv"}
JOB_SETTING_KEYS = ["model", "language", "compute_type", "batch_size", "threads", "beam_size", "align_model",
                    "initial_prompt", "hotwords", "vad_onset", "vad_offset", "chunk_size", "diarize", "min_speakers",
                    "max_speakers", "keep_models_loaded"]
EXPORT_KEYS = ["max_chars_per_line", "max_lines", "max_cue_duration", "split_on_speaker", "include_speaker_labels",
               "txt_timestamps"]


def _safe_name(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")
    return name[:120] or "transcript"


def create_app(urls: Callable[[], dict] | None = None, on_quit: Callable[[], None] | None = None,
               on_event: Callable[[dict], None] | None = None) -> FastAPI:
    app = FastAPI(title=APP_NAME, version=__version__, docs_url="/api/docs", redoc_url=None)
    events = Broadcaster()
    jobs = JobManager(events)
    app.state.jobs = jobs

    def job_dir(job_id: str) -> Path:
        if not re.fullmatch(r"[\w-]+", job_id):
            raise HTTPException(400, "Bad id")
        return JOBS_DIR / job_id

    def must_job(job_id: str) -> dict:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(404, "Job not found")
        return job

    def load_result(job_id: str) -> dict:
        path = job_dir(job_id) / "result.json"
        if not path.exists():
            raise HTTPException(404, "Transcript not ready")
        return json.loads(path.read_text("utf-8"))

    def export_opts(extra: dict | None = None) -> dict:
        s = load_settings()
        opts = {k: s[k] for k in EXPORT_KEYS}
        for k, v in (extra or {}).items():
            if k in EXPORT_KEYS and v is not None:
                opts[k] = v
        return opts

    def auto_export(job_id: str):
        s = load_settings()
        if not s.get("auto_export"):
            return
        job = jobs.get(job_id)
        if not job or job["status"] != "done":
            return
        try:
            result = load_result(job_id)
            folder = output_dir(s) / _safe_name(Path(job["name"]).stem)
            folder.mkdir(parents=True, exist_ok=True)
            opts = export_opts({"title": Path(job["name"]).stem})
            for fmt in s.get("export_formats") or ["json", "txt", "srt"]:
                if fmt in exporters.FORMATS:
                    ext = exporters.FORMATS[fmt]["ext"]
                    (folder / f"{Path(job['name']).stem}.{ext}").write_text(
                        exporters.export(result, fmt, opts), "utf-8")
        except Exception as exc:  # never break the queue over an export
            (LOG_DIR / "export.log").open("a", encoding="utf-8").write(f"{time.ctime()} {job_id}: {exc}\n")

    # Hook auto-export onto job completion.
    _orig_publish = events.publish

    def publish(evt: dict):
        _orig_publish(evt)
        if evt.get("type") == "finished":
            if evt.get("status") == "done":
                auto_export(evt["id"])
            if on_event:
                try:
                    on_event(evt)
                except Exception:
                    pass

    events.publish = publish  # type: ignore[assignment]

    # ---------------- app / system ----------------
    @app.get("/api/health")
    def health():
        return {"app": APP_NAME, "version": __version__}

    @app.get("/api/system")
    def system():
        info = runtime.system_info()
        info.update({"version": __version__, "app": APP_NAME, "data_dir": str(DATA_DIR),
                     "output_dir": str(output_dir()), "urls": urls() if urls else {},
                     "worker": jobs.worker_status(), "autostart_supported": autostart.supported()})
        return info

    @app.post("/api/quit")
    def quit_app():
        if on_quit:
            asyncio.get_event_loop().call_later(0.4, on_quit)
        return {"ok": True}

    @app.post("/api/open-output")
    def open_output():
        folder = output_dir()
        folder.mkdir(parents=True, exist_ok=True)
        runtime.open_path(folder)
        return {"ok": True}

    @app.post("/api/unload-models")
    def unload_models():
        jobs.unload_models()
        return {"ok": True}

    # ---------------- settings ----------------
    @app.get("/api/settings")
    def get_settings():
        s = load_settings()
        s["hf_token_set"] = bool(s.get("hf_token"))
        s["hf_token"] = ""
        s["start_with_windows"] = autostart.is_enabled() if autostart.supported() else False
        s["output_dir_resolved"] = str(output_dir(s))
        return s

    @app.put("/api/settings")
    async def put_settings(request: Request):
        patch = await request.json()
        if not isinstance(patch, dict):
            raise HTTPException(400, "Bad settings")
        if "hf_token" in patch and not patch["hf_token"]:
            patch.pop("hf_token")  # empty means "unchanged"
        if patch.get("clear_hf_token"):
            patch["hf_token"] = ""
        if "start_with_windows" in patch and autostart.supported():
            autostart.set_enabled(bool(patch["start_with_windows"]))
        if "model" in patch and patch["model"] not in catalog.MODEL_IDS:
            raise HTTPException(400, "Unknown model")
        save_settings({k: v for k, v in patch.items() if k in DEFAULT_SETTINGS})
        return get_settings()

    # ---------------- models ----------------
    @app.get("/api/models")
    def models():
        items = catalog.catalog()
        for m in items:
            m["download"] = jobs.downloads.get(m["id"])
        return {"models": items, "languages": catalog.LANGUAGES,
                "align_models": {k: v["label"] for k, v in catalog.ALIGN_MODELS.items()},
                "formats": {k: v["label"] for k, v in exporters.FORMATS.items()}}

    @app.post("/api/models/{model_id}/download")
    def download_model(model_id: str):
        if model_id not in catalog.MODEL_IDS:
            raise HTTPException(404, "Unknown model")
        jobs.download_model(model_id)
        return {"ok": True}

    @app.delete("/api/models/{model_id}")
    def delete_model(model_id: str):
        if model_id not in catalog.MODEL_IDS:
            raise HTTPException(404, "Unknown model")
        jobs.unload_models()
        return {"ok": catalog.delete(model_id)}

    # ---------------- jobs ----------------
    @app.get("/api/jobs")
    def list_jobs():
        return {"jobs": jobs.list(), "worker": jobs.worker_status()}

    @app.post("/api/jobs")
    async def create_jobs(files: list[UploadFile] = File(...), settings: str = Form("{}")):
        try:
            overrides = json.loads(settings or "{}")
        except json.JSONDecodeError:
            raise HTTPException(400, "Bad settings JSON")
        base = load_settings()
        job_settings = {k: base[k] for k in JOB_SETTING_KEYS}
        job_settings.update({k: v for k, v in overrides.items() if k in JOB_SETTING_KEYS})
        if job_settings["model"] not in catalog.MODEL_IDS:
            raise HTTPException(400, "Unknown model")
        tmp_dir = DATA_DIR / "tmp"
        tmp_dir.mkdir(exist_ok=True)
        created = []
        for f in files:
            suffix = Path(f.filename or "audio").suffix.lower() or ".bin"
            fd, tmp = tempfile.mkstemp(suffix=suffix, dir=tmp_dir)
            with open(fd, "wb") as out:
                while chunk := await f.read(4 * 1024 * 1024):
                    out.write(chunk)
            created.append(jobs.create(Path(f.filename or "audio").name, Path(tmp), dict(job_settings)))
        return {"jobs": created}

    @app.get("/api/jobs/{job_id}")
    def get_job(job_id: str):
        return must_job(job_id)

    @app.delete("/api/jobs/{job_id}")
    def delete_job(job_id: str):
        must_job(job_id)
        return {"ok": jobs.delete(job_id)}

    @app.post("/api/jobs/{job_id}/cancel")
    def cancel_job(job_id: str):
        must_job(job_id)
        return {"ok": jobs.cancel(job_id)}

    @app.post("/api/jobs/{job_id}/retry")
    async def retry_job(job_id: str, request: Request):
        must_job(job_id)
        try:
            body = await request.json()
        except Exception:
            body = {}
        overrides = {k: v for k, v in (body or {}).items() if k in JOB_SETTING_KEYS}
        return jobs.retry(job_id, overrides)

    @app.post("/api/jobs/{job_id}/rename")
    async def rename_job(job_id: str, request: Request):
        must_job(job_id)
        body = await request.json()
        name = str(body.get("name") or "").strip()[:200]
        if not name:
            raise HTTPException(400, "Name required")
        jobs._update(job_id, name=name)
        return jobs.get(job_id)

    @app.post("/api/jobs/{job_id}/reveal")
    def reveal(job_id: str):
        job = must_job(job_id)
        runtime.reveal_file(Path(job["input_path"]))
        return {"ok": True}

    @app.get("/api/jobs/{job_id}/result")
    def get_result(job_id: str):
        must_job(job_id)
        return load_result(job_id)

    @app.put("/api/jobs/{job_id}/result")
    async def put_result(job_id: str, request: Request):
        must_job(job_id)
        current = load_result(job_id)
        body = await request.json()
        segs = body.get("segments")
        if not isinstance(segs, list):
            raise HTTPException(400, "segments required")
        clean = []
        for s in segs:
            words = [{k: w.get(k) for k in ("word", "start", "end", "score", "speaker") if k in w}
                     for w in (s.get("words") or []) if str(w.get("word") or "").strip()]
            seg = {"start": s.get("start"), "end": s.get("end"), "words": words,
                   "text": " ".join(w["word"].strip() for w in words) if words else str(s.get("text") or "").strip()}
            if s.get("speaker"):
                seg["speaker"] = s["speaker"]
            if seg["text"]:
                clean.append(seg)
        current["segments"] = clean
        if isinstance(body.get("speakers"), dict):
            current["speakers"] = {str(k): str(v)[:60] for k, v in body["speakers"].items() if v}
        current["edited_at"] = time.time()
        (job_dir(job_id) / "result.json").write_text(json.dumps(current, ensure_ascii=False), "utf-8")
        jobs.set_word_count(job_id, sum(len(s["words"]) or len(s["text"].split()) for s in clean))
        return {"ok": True, "result": current}

    @app.post("/api/jobs/{job_id}/revert")
    def revert(job_id: str):
        must_job(job_id)
        d = job_dir(job_id)
        if not (d / "original.json").exists():
            raise HTTPException(404, "No original")
        shutil.copyfile(d / "original.json", d / "result.json")
        jobs._update(job_id)
        return load_result(job_id)

    @app.get("/api/jobs/{job_id}/peaks")
    def peaks(job_id: str):
        path = job_dir(job_id) / "peaks.json"
        if not path.exists():
            raise HTTPException(404, "No waveform")
        return FileResponse(path, media_type="application/json")

    @app.get("/api/jobs/{job_id}/media")
    def media(job_id: str, request: Request):
        job = must_job(job_id)
        d = job_dir(job_id)
        preview = d / "preview.wav"
        path = preview if preview.exists() else Path(job["input_path"])
        if not path.exists():
            raise HTTPException(404, "Media missing")
        return _range_response(path, request, MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream"))

    @app.get("/api/jobs/{job_id}/export/{fmt}")
    def export_one(job_id: str, fmt: str, request: Request):
        job = must_job(job_id)
        if fmt not in exporters.FORMATS:
            raise HTTPException(404, "Unknown format")
        q = dict(request.query_params)
        opts = export_opts(_parse_opts(q))
        opts["title"] = Path(job["name"]).stem
        text = exporters.export(load_result(job_id), fmt, opts)
        info = exporters.FORMATS[fmt]
        filename = f"{_safe_name(Path(job['name']).stem)}.{info['ext']}"
        disposition = "inline" if q.get("inline") else "attachment"
        return Response(text.encode("utf-8"), media_type=info["mime"] + "; charset=utf-8",
                        headers={"Content-Disposition": f"{disposition}; filename*=UTF-8''{_quote(filename)}"})

    @app.post("/api/jobs/{job_id}/export-zip")
    async def export_zip(job_id: str, request: Request):
        job = must_job(job_id)
        body = await request.json()
        fmts = [f for f in body.get("formats", []) if f in exporters.FORMATS] or ["json", "txt", "srt"]
        opts = export_opts(body.get("options") or {})
        stem = _safe_name(Path(job["name"]).stem)
        opts["title"] = stem
        result = load_result(job_id)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for f in fmts:
                z.writestr(f"{stem}.{exporters.FORMATS[f]['ext']}", exporters.export(result, f, opts))
        return Response(buf.getvalue(), media_type="application/zip",
                        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{_quote(stem + '.zip')}"})

    @app.post("/api/jobs/{job_id}/save-exports")
    async def save_exports(job_id: str, request: Request):
        job = must_job(job_id)
        body = await request.json()
        fmts = [f for f in body.get("formats", []) if f in exporters.FORMATS] or ["json", "txt", "srt"]
        opts = export_opts(body.get("options") or {})
        stem = _safe_name(Path(job["name"]).stem)
        opts["title"] = stem
        result = load_result(job_id)
        folder = output_dir() / stem
        folder.mkdir(parents=True, exist_ok=True)
        written = []
        for f in fmts:
            p = folder / f"{stem}.{exporters.FORMATS[f]['ext']}"
            p.write_text(exporters.export(result, f, opts), "utf-8")
            written.append(str(p))
        if body.get("open", True):
            runtime.open_path(folder)
        return {"ok": True, "folder": str(folder), "files": written}

    # ---------------- live events ----------------
    @app.get("/api/events")
    async def stream(request: Request):
        q = events.subscribe()

        async def gen():
            try:
                yield "retry: 2000\n\n"
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        evt = await asyncio.wait_for(q.get(), timeout=2.0)
                    except asyncio.TimeoutError:
                        info = runtime.system_info()
                        evt = {"type": "system", "cpu_percent": info["cpu_percent"], "ram_percent": info["ram_percent"],
                               "ram_used": info["ram_used"], "worker": jobs.worker_status()}
                    yield f"data: {json.dumps(evt)}\n\n"
            finally:
                events.unsubscribe(q)

        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.on_event("shutdown")
    def _shutdown():
        jobs.shutdown()

    @app.middleware("http")
    async def no_cache_ui(request: Request, call_next):
        response = await call_next(request)
        if not request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.exception_handler(Exception)
    async def on_error(request: Request, exc: Exception):
        return JSONResponse({"detail": str(exc)}, status_code=500)

    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
    return app


def _parse_opts(q: dict) -> dict:
    out = {}
    for k in EXPORT_KEYS:
        if k in q:
            v = q[k]
            default = DEFAULT_SETTINGS[k]
            if isinstance(default, bool):
                out[k] = v.lower() in ("1", "true", "yes", "on")
            elif isinstance(default, int):
                out[k] = int(float(v))
            elif isinstance(default, float):
                out[k] = float(v)
    return out


def _quote(s: str) -> str:
    from urllib.parse import quote

    return quote(s)


def _range_response(path: Path, request: Request, media_type: str):
    size = path.stat().st_size
    rng = request.headers.get("range")
    if not rng:
        return FileResponse(path, media_type=media_type, headers={"Accept-Ranges": "bytes"})
    m = re.match(r"bytes=(\d*)-(\d*)", rng)
    if not m:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
    start_s, end_s = m.groups()
    if start_s == "":
        length = int(end_s or 0)
        start, end = max(0, size - length), size - 1
    else:
        start = int(start_s)
        end = min(int(end_s), size - 1) if end_s else size - 1
    if start >= size or start > end:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})

    def body(chunk=1024 * 512):
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                data = f.read(min(chunk, left))
                if not data:
                    break
                left -= len(data)
                yield data

    return StreamingResponse(body(), status_code=206, media_type=media_type, headers={
        "Content-Range": f"bytes {start}-{end}/{size}", "Accept-Ranges": "bytes",
        "Content-Length": str(end - start + 1)})

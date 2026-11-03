"""Move data and downloaded models from the old (non-portable) locations into the app folder.

Safe to run many times: it only touches things that still exist in the old places,
moves instead of copying (no duplicate disk usage), and never deletes anything
that doesn't belong to this app.

    python -m wordstudio.migrate
"""

from __future__ import annotations

import fnmatch
import json
import os
import shutil
import sqlite3
import sys
from pathlib import Path

from .config import (DATA_DIR, DB_PATH, EXPORTS_DIR, HF_HOME, JOBS_DIR, LEGACY_ENV, NLTK_DIR, SETTINGS_PATH,
                     TORCH_HOME)

# Hugging Face repos this app downloads (Whisper models, aligners for other languages, speaker models).
HF_REPO_PATTERNS = [
    "models--Systran--faster-*", "models--mobiuslabsgmbh--faster-*", "models--distil-whisper--*",
    "models--deepdml--faster-*", "models--pyannote--*", "models--jonatasgrosman--*", "models--speechbrain--*",
    "models--*wav2vec2*", "models--*--wav2vec2*",
]
TORCH_CKPT_PATTERNS = ["wav2vec2_*.pth", "wav2vec2_*.pt"]
TORCH_HUB_DIR_PATTERNS = ["snakers4_silero-vad*"]
NLTK_ITEMS = ["tokenizers/punkt_tab", "tokenizers/punkt", "tokenizers/punkt_tab.zip", "tokenizers/punkt.zip"]


class Report:
    def __init__(self, log=print):
        self.log = log
        self.moved = 0
        self.freed = 0
        self.items: list[str] = []

    def add(self, what: str, size: int = 0, freed: bool = False):
        if freed:
            self.freed += size
        else:
            self.moved += size
        self.items.append(what)
        self.log(f"    {what}" + (f" ({_fmt(size)})" if size else ""))


def _fmt(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit in ("B", "KB") else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n} B"


def _size(p: Path) -> int:
    try:
        if p.is_symlink():
            return 0
        if p.is_file():
            return p.stat().st_size
        return sum(f.stat().st_size for f in p.rglob("*") if f.is_file() and not f.is_symlink())
    except OSError:
        return 0


def _same(a: Path, b: Path) -> bool:
    try:
        return a.resolve() == b.resolve()
    except OSError:
        return False


def _merge_move(src: Path, dst: Path) -> None:
    """Move src into dst. If dst exists, move only what's missing, then drop src."""
    if not dst.exists() and not dst.is_symlink():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
        return
    if src.is_dir() and not src.is_symlink() and dst.is_dir():
        for child in list(src.iterdir()):
            _merge_move(child, dst / child.name)
        shutil.rmtree(src, ignore_errors=True)
    else:
        # Same file already present at the destination: the old copy is a duplicate.
        if src.is_dir() and not src.is_symlink():
            shutil.rmtree(src, ignore_errors=True)
        else:
            src.unlink(missing_ok=True)


def _prune_empty(path: Path, stop: Path | None = None) -> None:
    """Remove path and its parents while they are empty (ignoring lock folders)."""
    path = Path(path)
    while path.exists() and path.is_dir():
        if stop is not None and _same(path, stop):
            break
        entries = [e for e in path.iterdir() if e.name not in (".locks",)]
        if entries:
            break
        shutil.rmtree(path, ignore_errors=True)
        path = path.parent


def _home_cache() -> Path:
    xdg = LEGACY_ENV.get("XDG_CACHE_HOME")
    return Path(xdg) if xdg else Path.home() / ".cache"


# ---------------------------------------------------------------- locations
def legacy_data_dirs() -> list[Path]:
    out = []
    if LEGACY_ENV.get("LOCALAPPDATA"):
        out.append(Path(LEGACY_ENV["LOCALAPPDATA"]) / "AlamzaWordStudio")
    elif sys.platform == "win32":
        out.append(Path.home() / "AppData" / "Local" / "AlamzaWordStudio")
    out.append(Path.home() / "Library" / "Application Support" / "AlamzaWordStudio")
    out.append(Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "alamza-word-studio")
    return [p for p in out if p.exists() and not _same(p, DATA_DIR)]


def legacy_hf_hubs() -> list[Path]:
    cands = []
    for key in ("HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE"):
        if LEGACY_ENV.get(key):
            cands.append(Path(LEGACY_ENV[key]))
    if LEGACY_ENV.get("HF_HOME"):
        cands.append(Path(LEGACY_ENV["HF_HOME"]) / "hub")
    cands.append(_home_cache() / "huggingface" / "hub")
    seen, out = set(), []
    for c in cands:
        if c.exists() and not _same(c, HF_HOME / "hub") and str(c) not in seen:
            seen.add(str(c))
            out.append(c)
    return out


def legacy_torch_hubs() -> list[Path]:
    cands = []
    if LEGACY_ENV.get("TORCH_HOME"):
        cands.append(Path(LEGACY_ENV["TORCH_HOME"]) / "hub")
    cands.append(_home_cache() / "torch" / "hub")
    return [c for c in cands if c.exists() and not _same(c, TORCH_HOME / "hub")]


def legacy_nltk_dirs() -> list[Path]:
    cands = []
    for part in (LEGACY_ENV.get("NLTK_DATA") or "").split(os.pathsep):
        if part:
            cands.append(Path(part))
    if LEGACY_ENV.get("APPDATA"):
        cands.append(Path(LEGACY_ENV["APPDATA"]) / "nltk_data")
    cands.append(Path.home() / "nltk_data")
    return [c for c in cands if c.exists() and not _same(c, NLTK_DIR)]


# ---------------------------------------------------------------- steps
def migrate_data(rep: Report) -> None:
    for old in legacy_data_dirs():
        rep.log(f"  Transcripts & settings from {old}")
        old_jobs = old / "jobs"
        if old_jobs.exists():
            n = 0
            for job in old_jobs.iterdir():
                if job.is_dir():
                    _merge_move(job, JOBS_DIR / job.name)
                    n += 1
            rep.add(f"{n} transcripts moved")
        old_db = old / "wordstudio.db"
        if old_db.exists():
            _merge_db(old_db)
            rep.add("library database merged")
        old_settings = old / "settings.json"
        if old_settings.exists():
            _merge_settings(old_settings)
            rep.add("settings kept (auto-export now off, exports go to the app's exports folder)")
        # ffmpeg copy, logs, temp uploads: not needed any more.
        freed = _size(old)
        shutil.rmtree(old, ignore_errors=True)
        if freed:
            rep.add("old leftovers removed", freed, freed=True)

    # Files the old version auto-exported to Documents.
    docs = Path.home() / "Documents" / "Alamza Word Studio"
    if docs.exists() and not _same(docs, EXPORTS_DIR):
        size = _size(docs)
        _merge_move(docs, EXPORTS_DIR)
        rep.add(f"old exports moved from {docs}", size)


def _merge_db(old_db: Path) -> None:
    if not DB_PATH.exists():
        shutil.move(str(old_db), str(DB_PATH))
        return
    con = sqlite3.connect(DB_PATH)
    try:
        con.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY)")
        new_cols = {r[1] for r in con.execute("PRAGMA table_info(jobs)")}
        con.execute("ATTACH DATABASE ? AS old", (str(old_db),))
        old_cols = [r[1] for r in con.execute("PRAGMA old.table_info(jobs)")]
        for c in old_cols:
            if c not in new_cols:
                con.execute(f"ALTER TABLE jobs ADD COLUMN {c}")
        cols = ", ".join(old_cols)
        con.execute(f"INSERT OR IGNORE INTO jobs ({cols}) SELECT {cols} FROM old.jobs")
        con.commit()
        con.execute("DETACH DATABASE old")
    finally:
        con.close()
    old_db.unlink(missing_ok=True)


def _merge_settings(old_settings: Path) -> None:
    try:
        old = json.loads(old_settings.read_text("utf-8"))
    except Exception:
        old = {}
    try:
        new = json.loads(SETTINGS_PATH.read_text("utf-8")) if SETTINGS_PATH.exists() else {}
    except Exception:
        new = {}
    merged = {**old, **new}
    merged["auto_export"] = False
    if not str(old.get("output_dir") or "").strip():
        merged["output_dir"] = ""
    SETTINGS_PATH.write_text(json.dumps(merged, indent=2), "utf-8")
    old_settings.unlink(missing_ok=True)


def migrate_hf(rep: Report) -> None:
    dest = HF_HOME / "hub"
    for hub in legacy_hf_hubs():
        moved_any = False
        for repo in list(hub.iterdir()):
            if repo.is_dir() and any(fnmatch.fnmatch(repo.name, p) for p in HF_REPO_PATTERNS):
                size = _size(repo)
                _merge_move(repo, dest / repo.name)
                lock = hub / ".locks" / repo.name
                if lock.exists():
                    shutil.rmtree(lock, ignore_errors=True)
                rep.add(f"model {repo.name.replace('models--', '').replace('--', '/')}", size)
                moved_any = True
        if moved_any:
            _prune_empty(hub / ".locks")
            _prune_empty(hub)
            _prune_empty(hub.parent)


def migrate_torch(rep: Report) -> None:
    dest = TORCH_HOME / "hub"
    for hub in legacy_torch_hubs():
        ckpt = hub / "checkpoints"
        if ckpt.exists():
            for f in list(ckpt.iterdir()):
                if any(fnmatch.fnmatch(f.name, p) for p in TORCH_CKPT_PATTERNS):
                    size = _size(f)
                    _merge_move(f, dest / "checkpoints" / f.name)
                    rep.add(f"word aligner {f.name}", size)
        for d in list(hub.iterdir()):
            if d.is_dir() and any(fnmatch.fnmatch(d.name, p) for p in TORCH_HUB_DIR_PATTERNS):
                size = _size(d)
                _merge_move(d, dest / d.name)
                rep.add(f"voice detector {d.name}", size)
        _prune_empty(ckpt)
        _prune_empty(hub)
        _prune_empty(hub.parent)


def migrate_nltk(rep: Report) -> None:
    for base in legacy_nltk_dirs():
        found = False
        for item in NLTK_ITEMS:
            src = base / item
            if src.exists():
                _merge_move(src, NLTK_DIR / item)
                found = True
        if found:
            rep.add(f"sentence data from {base}")
            _prune_empty(base / "tokenizers")
            _prune_empty(base)


def refresh_autostart(rep: Report) -> None:
    try:
        from . import autostart

        if autostart.supported() and autostart.is_enabled() and autostart.current_command() != autostart.command():
            autostart.set_enabled(True)
            rep.add("start-with-Windows updated to the new location")
    except Exception:
        pass


def needed() -> bool:
    return bool(legacy_data_dirs() or (Path.home() / "Documents" / "Alamza Word Studio").exists()
                or any(_has(h, HF_REPO_PATTERNS) for h in legacy_hf_hubs())
                or any(_has(h / "checkpoints", TORCH_CKPT_PATTERNS) or _has(h, TORCH_HUB_DIR_PATTERNS) for h in legacy_torch_hubs())
                or any((b / i).exists() for b in legacy_nltk_dirs() for i in NLTK_ITEMS))


def _has(folder: Path, patterns: list[str]) -> bool:
    try:
        return folder.exists() and any(any(fnmatch.fnmatch(p.name, pat) for pat in patterns) for p in folder.iterdir())
    except OSError:
        return False


def run(log=print) -> Report:
    rep = Report(log)
    steps = [("data", migrate_data), ("models", migrate_hf), ("aligner", migrate_torch), ("nltk", migrate_nltk),
             ("autostart", refresh_autostart)]
    for name, fn in steps:
        try:
            fn(rep)
        except Exception as exc:  # keep going; report what failed
            log(f"    ! {name}: {exc}")
    return rep


if __name__ == "__main__":
    print("  Moving existing data and models into the app folder...")
    r = run()
    if not r.items:
        print("    Nothing to move. Everything is already inside the app folder.")
    else:
        print(f"    Done. Moved {_fmt(r.moved)} into the app folder, freed {_fmt(r.freed)} of leftovers.")

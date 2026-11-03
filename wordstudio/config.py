"""Paths and persistent user settings."""

from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path

from . import APP_ID

ROOT_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT_DIR / "web"
ASSETS_DIR = ROOT_DIR / "assets"


def _data_dir() -> Path:
    override = os.environ.get("AWS_DATA_DIR")
    if override:
        return Path(override)
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "AlamzaWordStudio"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "AlamzaWordStudio"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / APP_ID


DATA_DIR = _data_dir()
JOBS_DIR = DATA_DIR / "jobs"
BIN_DIR = DATA_DIR / "bin"
LOG_DIR = DATA_DIR / "logs"
DB_PATH = DATA_DIR / "wordstudio.db"
SETTINGS_PATH = DATA_DIR / "settings.json"

for _d in (DATA_DIR, JOBS_DIR, BIN_DIR, LOG_DIR):
    _d.mkdir(parents=True, exist_ok=True)


DEFAULT_SETTINGS: dict = {
    # Transcription defaults
    "model": "distil-large-v3",
    "language": "en",
    "compute_type": "int8",
    "batch_size": 4,
    "threads": 0,  # 0 = auto (all physical cores)
    "beam_size": 5,
    "align_model": "default",  # "default" | "large"
    "initial_prompt": "",
    "hotwords": "",
    "vad_onset": 0.5,
    "vad_offset": 0.363,
    "chunk_size": 30,
    "diarize": False,
    "min_speakers": 0,
    "max_speakers": 0,
    "hf_token": "",
    # Subtitle / export defaults
    "export_formats": ["json", "txt", "srt"],
    "max_chars_per_line": 42,
    "max_lines": 2,
    "max_cue_duration": 6.0,
    "split_on_speaker": True,
    "include_speaker_labels": True,
    "txt_timestamps": False,
    # App
    "port": 7865,
    "lan_access": False,
    "open_browser_on_start": True,
    "start_with_windows": False,
    "theme": "system",
    "low_confidence_threshold": 0.5,
    "notify_on_finish": True,
    "auto_export": True,
    "output_dir": "",  # empty = Documents/Alamza Word Studio
    "keep_models_loaded": True,
}

_lock = threading.Lock()


def output_dir(settings: dict | None = None) -> Path:
    settings = settings or load_settings()
    custom = (settings.get("output_dir") or "").strip()
    if custom:
        return Path(custom).expanduser()
    docs = Path.home() / "Documents"
    return (docs if docs.exists() else Path.home()) / "Alamza Word Studio"


def load_settings() -> dict:
    data = dict(DEFAULT_SETTINGS)
    try:
        if SETTINGS_PATH.exists():
            saved = json.loads(SETTINGS_PATH.read_text("utf-8"))
            if isinstance(saved, dict):
                data.update({k: v for k, v in saved.items() if k in DEFAULT_SETTINGS})
    except Exception:
        pass
    return data


def save_settings(patch: dict) -> dict:
    with _lock:
        data = load_settings()
        for key, value in patch.items():
            if key in DEFAULT_SETTINGS:
                data[key] = value
        tmp = SETTINGS_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2), "utf-8")
        tmp.replace(SETTINGS_PATH)
        return data

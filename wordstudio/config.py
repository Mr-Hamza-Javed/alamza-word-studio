"""Paths and persistent user settings.

Everything lives inside the app folder so it can be copied to another PC as-is:

    <app>/runtime/python     private Python + packages (created by install.bat)
    <app>/runtime/bin        ffmpeg
    <app>/models             Whisper models, aligner, NLTK data, speaker models
    <app>/data               transcripts, settings, logs
    <app>/exports            auto-exported files (only if auto-export is on)
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT_DIR / "web"
ASSETS_DIR = ROOT_DIR / "assets"
RUNTIME_DIR = ROOT_DIR / "runtime"
MODELS_DIR = ROOT_DIR / "models"
EXPORTS_DIR = ROOT_DIR / "exports"
DATA_DIR = Path(os.environ.get("AWS_DATA_DIR") or ROOT_DIR / "data")

JOBS_DIR = DATA_DIR / "jobs"
LOG_DIR = DATA_DIR / "logs"
BIN_DIR = RUNTIME_DIR / "bin"
DB_PATH = DATA_DIR / "wordstudio.db"
SETTINGS_PATH = DATA_DIR / "settings.json"

HF_HOME = MODELS_DIR / "huggingface"
TORCH_HOME = MODELS_DIR / "torch"
NLTK_DIR = MODELS_DIR / "nltk_data"

# Point every library's download cache into the app folder. This must happen before
# huggingface_hub / torch / nltk are imported, and child processes inherit it.
os.environ["HF_HOME"] = str(HF_HOME)
os.environ["HF_HUB_CACHE"] = str(HF_HOME / "hub")
os.environ.pop("HUGGINGFACE_HUB_CACHE", None)
os.environ["TORCH_HOME"] = str(TORCH_HOME)
os.environ["NLTK_DATA"] = str(NLTK_DIR)
# Small caches other libraries create (font lists, telemetry ids) stay in the folder too.
CACHE_DIR = RUNTIME_DIR / "cache"
os.environ["XDG_CACHE_HOME"] = str(CACHE_DIR)
os.environ["MPLCONFIGDIR"] = str(CACHE_DIR / "matplotlib")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

for _d in (DATA_DIR, JOBS_DIR, LOG_DIR, BIN_DIR, CACHE_DIR, HF_HOME / "hub", TORCH_HOME / "hub" / "checkpoints", NLTK_DIR):
    _d.mkdir(parents=True, exist_ok=True)


DEFAULT_SETTINGS: dict = {
    # Transcription defaults
    "model": "tiny.en",  # the only model installed by default; others are downloaded from the app
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
    "auto_export": False,
    "output_dir": "",  # empty = <app>/exports
    "keep_models_loaded": True,
}

_lock = threading.Lock()


def output_dir(settings: dict | None = None) -> Path:
    settings = settings or load_settings()
    custom = (settings.get("output_dir") or "").strip()
    if custom:
        p = Path(custom).expanduser()
        # Relative paths are relative to the app folder (keeps custom folders portable).
        return p if p.is_absolute() else ROOT_DIR / p
    return EXPORTS_DIR


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

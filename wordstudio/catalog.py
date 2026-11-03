"""Whisper model catalog, download status and model management."""

from __future__ import annotations

import shutil
from pathlib import Path

# speed: relative CPU speed (higher = faster), accuracy: 1..10
# rtf_cpu: rough "seconds of compute per second of audio" on a modern
# 10-core laptop CPU with int8 (used only for ETA hints in the UI).
MODELS: list[dict] = [
    {"id": "tiny.en", "label": "Tiny (English)", "params": "39M", "size_mb": 75, "ram_gb": 1, "speed": 10, "accuracy": 3, "english_only": True, "rtf_cpu": 0.05, "family": "tiny"},
    {"id": "tiny", "label": "Tiny", "params": "39M", "size_mb": 75, "ram_gb": 1, "speed": 10, "accuracy": 2, "english_only": False, "rtf_cpu": 0.05, "family": "tiny"},
    {"id": "base.en", "label": "Base (English)", "params": "74M", "size_mb": 145, "ram_gb": 1, "speed": 9, "accuracy": 4, "english_only": True, "rtf_cpu": 0.08, "family": "base"},
    {"id": "base", "label": "Base", "params": "74M", "size_mb": 145, "ram_gb": 1, "speed": 9, "accuracy": 3, "english_only": False, "rtf_cpu": 0.08, "family": "base"},
    {"id": "small.en", "label": "Small (English)", "params": "244M", "size_mb": 485, "ram_gb": 2, "speed": 7, "accuracy": 6, "english_only": True, "rtf_cpu": 0.25, "family": "small"},
    {"id": "small", "label": "Small", "params": "244M", "size_mb": 485, "ram_gb": 2, "speed": 7, "accuracy": 5, "english_only": False, "rtf_cpu": 0.25, "family": "small"},
    {"id": "distil-small.en", "label": "Distil Small (English)", "params": "166M", "size_mb": 335, "ram_gb": 2, "speed": 8, "accuracy": 5, "english_only": True, "rtf_cpu": 0.15, "family": "distil"},
    {"id": "medium.en", "label": "Medium (English)", "params": "769M", "size_mb": 1530, "ram_gb": 4, "speed": 5, "accuracy": 7, "english_only": True, "rtf_cpu": 0.75, "family": "medium"},
    {"id": "medium", "label": "Medium", "params": "769M", "size_mb": 1530, "ram_gb": 4, "speed": 5, "accuracy": 7, "english_only": False, "rtf_cpu": 0.75, "family": "medium"},
    {"id": "distil-medium.en", "label": "Distil Medium (English)", "params": "394M", "size_mb": 790, "ram_gb": 3, "speed": 7, "accuracy": 6, "english_only": True, "rtf_cpu": 0.35, "family": "distil"},
    {"id": "distil-large-v3", "label": "Distil Large v3", "params": "756M", "size_mb": 1510, "ram_gb": 4, "speed": 6, "accuracy": 8, "english_only": True, "rtf_cpu": 0.65, "family": "distil", "recommended": True,
     "note": "Best speed/accuracy balance for English on CPU."},
    {"id": "distil-large-v3.5", "label": "Distil Large v3.5", "params": "756M", "size_mb": 1510, "ram_gb": 4, "speed": 6, "accuracy": 8, "english_only": True, "rtf_cpu": 0.65, "family": "distil",
     "note": "Newer distil model trained on more data; needs a recent faster-whisper."},
    {"id": "distil-large-v2", "label": "Distil Large v2", "params": "756M", "size_mb": 1510, "ram_gb": 4, "speed": 6, "accuracy": 7, "english_only": True, "rtf_cpu": 0.65, "family": "distil"},
    {"id": "large-v3-turbo", "label": "Large v3 Turbo", "params": "809M", "size_mb": 1620, "ram_gb": 4, "speed": 5, "accuracy": 9, "english_only": False, "rtf_cpu": 0.85, "family": "large",
     "note": "Near large-v3 accuracy, much faster. Fewer repeats on long audio."},
    {"id": "large-v3", "label": "Large v3", "params": "1550M", "size_mb": 3090, "ram_gb": 7, "speed": 2, "accuracy": 10, "english_only": False, "rtf_cpu": 2.2, "family": "large",
     "note": "Highest accuracy. Slow on CPU."},
    {"id": "large-v2", "label": "Large v2", "params": "1550M", "size_mb": 3090, "ram_gb": 7, "speed": 2, "accuracy": 9, "english_only": False, "rtf_cpu": 2.2, "family": "large"},
    {"id": "large-v1", "label": "Large v1", "params": "1550M", "size_mb": 3090, "ram_gb": 7, "speed": 2, "accuracy": 8, "english_only": False, "rtf_cpu": 2.2, "family": "large"},
]

MODEL_IDS = {m["id"] for m in MODELS}

# Fallback mapping (faster-whisper's own table is preferred when available).
_REPOS = {
    "tiny.en": "Systran/faster-whisper-tiny.en",
    "tiny": "Systran/faster-whisper-tiny",
    "base.en": "Systran/faster-whisper-base.en",
    "base": "Systran/faster-whisper-base",
    "small.en": "Systran/faster-whisper-small.en",
    "small": "Systran/faster-whisper-small",
    "medium.en": "Systran/faster-whisper-medium.en",
    "medium": "Systran/faster-whisper-medium",
    "large-v1": "Systran/faster-whisper-large-v1",
    "large-v2": "Systran/faster-whisper-large-v2",
    "large-v3": "Systran/faster-whisper-large-v3",
    "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "distil-large-v2": "Systran/faster-distil-whisper-large-v2",
    "distil-medium.en": "Systran/faster-distil-whisper-medium.en",
    "distil-small.en": "Systran/faster-distil-whisper-small.en",
    "distil-large-v3": "Systran/faster-distil-whisper-large-v3",
    "distil-large-v3.5": "distil-whisper/distil-large-v3.5-ct2",
}

ALIGN_MODELS = {
    "default": {"label": "Standard (wav2vec2 base, ~360 MB)", "name": None},
    "large": {"label": "Precise (wav2vec2 large, ~1.2 GB)", "name": "WAV2VEC2_ASR_LARGE_LV60K_960H"},
}

LANGUAGES = {
    "auto": "Auto-detect", "en": "English", "ur": "Urdu", "hi": "Hindi", "ar": "Arabic",
    "fr": "French", "de": "German", "es": "Spanish", "it": "Italian", "pt": "Portuguese",
    "nl": "Dutch", "ru": "Russian", "tr": "Turkish", "fa": "Persian", "zh": "Chinese",
    "ja": "Japanese", "ko": "Korean", "uk": "Ukrainian", "pl": "Polish", "cs": "Czech",
    "el": "Greek", "fi": "Finnish", "da": "Danish", "he": "Hebrew", "hu": "Hungarian",
    "vi": "Vietnamese", "te": "Telugu", "ml": "Malayalam", "ca": "Catalan", "id": "Indonesian",
}


def repo_for(model_id: str) -> str:
    try:
        from faster_whisper.utils import _MODELS  # type: ignore

        if model_id in _MODELS:
            return _MODELS[model_id]
    except Exception:
        pass
    return _REPOS.get(model_id, model_id)


def _hf_cache_dir() -> Path:
    try:
        from huggingface_hub.constants import HF_HUB_CACHE  # type: ignore

        return Path(HF_HUB_CACHE)
    except Exception:
        import os

        base = os.environ.get("HF_HOME") or str(Path.home() / ".cache" / "huggingface")
        return Path(base) / "hub"


def _repo_dir(repo: str) -> Path:
    return _hf_cache_dir() / ("models--" + repo.replace("/", "--"))


def _dir_size(path: Path) -> int:
    total = 0
    if not path.exists():
        return 0
    # blobs hold the real data; snapshots are links.
    blobs = path / "blobs"
    target = blobs if blobs.exists() else path
    for f in target.rglob("*"):
        try:
            if f.is_file() and not f.is_symlink():
                total += f.stat().st_size
        except OSError:
            pass
    return total


def is_downloaded(model_id: str) -> bool:
    repo_dir = _repo_dir(repo_for(model_id))
    snaps = repo_dir / "snapshots"
    if not snaps.exists():
        return False
    for snap in snaps.iterdir():
        if (snap / "model.bin").exists():
            return True
    return False


def catalog() -> list[dict]:
    out = []
    for m in MODELS:
        item = dict(m)
        item["downloaded"] = is_downloaded(m["id"])
        item["disk_bytes"] = _dir_size(_repo_dir(repo_for(m["id"]))) if item["downloaded"] else 0
        item["repo"] = repo_for(m["id"])
        out.append(item)
    return out


def download(model_id: str) -> None:
    from faster_whisper import download_model  # type: ignore

    download_model(model_id)


def delete(model_id: str) -> bool:
    repo_dir = _repo_dir(repo_for(model_id))
    if repo_dir.exists():
        shutil.rmtree(repo_dir, ignore_errors=True)
        return True
    return False

"""Transcription worker. Runs in its own process so a job can be cancelled instantly
(the process is killed) and heavy models stay loaded between jobs."""

from __future__ import annotations

import gc
import inspect
import json
import math
import os
import re
import sys
import time
import traceback
import wave
from pathlib import Path

SAMPLE_RATE = 16000
_PROGRESS_RE = re.compile(r"Progress:\s*([\d.]+)%")
_TQDM_RE = re.compile(r"(\d{1,3})%\|")


class _ProgressTap:
    """Stands in for stdout/stderr and turns WhisperX/tqdm progress prints into events."""

    def __init__(self, emit, log):
        self.emit = emit
        self.log = log
        self.stage = None
        self._last = 0.0

    def write(self, text):
        if self.log:
            try:
                self.log.write(text)
            except Exception:
                pass
        if not text or not self.stage:
            return len(text or "")
        m = _PROGRESS_RE.search(text) or _TQDM_RE.search(text)
        if m:
            try:
                pct = max(0.0, min(100.0, float(m.group(1))))
            except ValueError:
                return len(text)
            now = time.time()
            if pct >= 100 or now - self._last > 0.25:
                self._last = now
                self.emit({"type": "progress", "stage": self.stage, "stage_pct": pct})
        return len(text)

    def flush(self):
        if self.log:
            try:
                self.log.flush()
            except Exception:
                pass

    def isatty(self):
        return False


def _clean(obj):
    """Make WhisperX output JSON-safe (numpy types, NaN)."""
    if isinstance(obj, dict):
        return {str(k): _clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_clean(v) for v in obj]
    if hasattr(obj, "item") and not isinstance(obj, (str, bytes)):
        try:
            obj = obj.item()
        except Exception:
            pass
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return round(obj, 3)
    return obj


def _filter_kwargs(fn, kwargs: dict) -> dict:
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return kwargs
    if any(p.kind == p.VAR_KEYWORD for p in params.values()):
        return kwargs
    return {k: v for k, v in kwargs.items() if k in params}


def _asr_option_names() -> set[str] | None:
    try:
        from faster_whisper.transcribe import TranscriptionOptions  # type: ignore

        if hasattr(TranscriptionOptions, "_fields"):
            return set(TranscriptionOptions._fields)
        import dataclasses

        return {f.name for f in dataclasses.fields(TranscriptionOptions)}
    except Exception:
        return None


class Engine:
    def __init__(self, emit):
        self.emit = emit
        self.asr = None
        self.asr_key = None
        self.align = {}
        self.diar = None
        self.diar_key = None

    # ---------- model loading ----------
    def get_asr(self, s: dict, language: str | None):
        import whisperx  # type: ignore

        asr_options = {
            "beam_size": int(s.get("beam_size") or 5),
            "initial_prompt": (s.get("initial_prompt") or "").strip() or None,
            "hotwords": (s.get("hotwords") or "").strip() or None,
        }
        allowed = _asr_option_names()
        if allowed is not None:
            asr_options = {k: v for k, v in asr_options.items() if k in allowed}
        vad_options = {"vad_onset": float(s.get("vad_onset", 0.5)), "vad_offset": float(s.get("vad_offset", 0.363))}
        threads = int(s.get("threads") or 0) or _default_threads()
        key = json.dumps([s["model"], s["compute_type"], threads, language, asr_options, vad_options], sort_keys=True)
        if self.asr is not None and self.asr_key == key:
            return self.asr
        self.asr = None
        gc.collect()
        kwargs = dict(
            compute_type=s.get("compute_type", "int8"),
            asr_options=asr_options,
            vad_options=vad_options,
            language=language,
            threads=threads,
        )
        loader = _real(whisperx, "asr", "load_model")
        self.asr = loader(s["model"], "cpu", **_filter_kwargs(loader, kwargs))
        self.asr_key = key
        return self.asr

    def get_align(self, language: str, align_choice: str):
        import whisperx  # type: ignore

        from .catalog import ALIGN_MODELS

        _ensure_nltk()
        name = ALIGN_MODELS.get(align_choice, ALIGN_MODELS["default"])["name"] if language == "en" else None
        key = (language, name)
        if key not in self.align:
            if len(self.align) >= 2:
                self.align.clear()
                gc.collect()
            self.align[key] = whisperx.load_align_model(language_code=language, device="cpu", model_name=name)
        return self.align[key]

    def get_diarizer(self, token: str):
        try:
            from whisperx.diarize import DiarizationPipeline  # type: ignore
        except Exception:
            import whisperx  # type: ignore

            DiarizationPipeline = whisperx.DiarizationPipeline  # type: ignore
        if self.diar is not None and self.diar_key == token:
            return self.diar
        params = inspect.signature(DiarizationPipeline.__init__).parameters
        kwargs = {"device": "cpu"}
        if "use_auth_token" in params:
            kwargs["use_auth_token"] = token
        elif "token" in params:
            kwargs["token"] = token
        self.diar = DiarizationPipeline(**kwargs)
        self.diar_key = token
        return self.diar

    def unload(self):
        self.asr = None
        self.asr_key = None
        self.align.clear()
        self.diar = None
        self.diar_key = None
        gc.collect()

    # ---------- the job ----------
    def run(self, job: dict):
        import numpy as np  # type: ignore
        import torch  # type: ignore
        import whisperx  # type: ignore

        from .catalog import MODELS

        s = job["settings"]
        job_dir = Path(job["dir"])
        src = Path(job["input"])
        timings = {}
        threads = int(s.get("threads") or 0) or _default_threads()
        torch.set_num_threads(threads)

        meta = next((m for m in MODELS if m["id"] == s["model"]), {})
        language = s.get("language") or "en"
        if language == "auto":
            language = None
        if meta.get("english_only"):
            language = "en"

        # 1. audio
        t0 = time.time()
        self.stage("audio", "Decoding audio")
        audio = whisperx.load_audio(str(src))
        duration = len(audio) / SAMPLE_RATE
        self.emit({"type": "meta", "duration": duration})
        _write_peaks(audio, job_dir / "peaks.json", np)
        from .runtime import find_preview, make_preview, needs_preview

        if needs_preview(src) and not find_preview(job_dir):
            if not make_preview(src, job_dir):
                _write_wav(audio, job_dir / "preview.wav", np)
        timings["audio"] = time.time() - t0

        # 2. model
        t0 = time.time()
        from .catalog import is_downloaded

        self.stage("model", "Downloading model" if not is_downloaded(s["model"]) else "Loading model")
        model = self.get_asr(s, language)
        timings["model"] = time.time() - t0

        # 3. transcribe
        t0 = time.time()
        self.stage("transcribe", "Transcribing")
        tkw = {"batch_size": int(s.get("batch_size") or 4), "language": language,
               "chunk_size": int(s.get("chunk_size") or 30)}
        result = model.transcribe(audio, **_with_progress(model.transcribe, tkw, self.callback("transcribe")))
        detected = result.get("language") or language or "en"
        timings["transcribe"] = time.time() - t0
        self.emit({"type": "meta", "language": detected})

        # 4. align
        t0 = time.time()
        aligned = False
        warnings = []
        try:
            self.stage("align", "Aligning words")
            model_a, metadata = self.get_align(detected, s.get("align_model", "default"))
            akw = {"return_char_alignments": False, "interpolate_method": "nearest"}
            aligner = _real(whisperx, "alignment", "align")
            result = aligner(result["segments"], model_a, metadata, audio, "cpu",
                             **_with_progress(aligner, akw, self.callback("align")))
            aligned = True
        except Exception as exc:  # language without an aligner, etc.
            warnings.append(f"Word alignment unavailable: {exc}")
        timings["align"] = time.time() - t0

        # 5. diarize
        if s.get("diarize"):
            t0 = time.time()
            token = (s.get("hf_token") or "").strip()
            if not token:
                warnings.append("Speaker detection skipped: add a Hugging Face token in Settings.")
            else:
                self.stage("diarize", "Detecting speakers")
                try:
                    diar = self.get_diarizer(token)
                    dkw = {}
                    if int(s.get("min_speakers") or 0) > 0:
                        dkw["min_speakers"] = int(s["min_speakers"])
                    if int(s.get("max_speakers") or 0) > 0:
                        dkw["max_speakers"] = int(s["max_speakers"])
                    diar_segments = diar(audio, **_with_progress(diar.__call__, dkw, self.callback("diarize"), False))
                    if isinstance(diar_segments, tuple):
                        diar_segments = diar_segments[0]
                    result = whisperx.assign_word_speakers(diar_segments, result)
                except Exception as exc:
                    warnings.append(f"Speaker detection failed: {exc}")
            timings["diarize"] = time.time() - t0

        self.stage("finalize", "Saving")
        segments = []
        for seg in result.get("segments", []):
            words = []
            for w in seg.get("words", []) or []:
                words.append({k: w.get(k) for k in ("word", "start", "end", "score", "speaker") if k in w})
            item = {"start": seg.get("start"), "end": seg.get("end"), "text": (seg.get("text") or "").strip(), "words": words}
            if seg.get("speaker"):
                item["speaker"] = seg["speaker"]
            segments.append(item)

        out = _clean({
            "version": 1,
            "language": detected,
            "duration": duration,
            "model": s["model"],
            "aligned": aligned,
            "settings": {k: v for k, v in s.items() if k != "hf_token"},
            "timings": timings,
            "warnings": warnings,
            "speakers": {},
            "segments": segments,
        })
        text = json.dumps(out, ensure_ascii=False)
        (job_dir / "original.json").write_text(text, "utf-8")
        (job_dir / "result.json").write_text(text, "utf-8")

        if not s.get("keep_models_loaded", True):
            self.unload()
        return {"duration": duration, "language": detected, "warnings": warnings, "timings": timings}

    def callback(self, stage: str):
        last = [0.0]

        def cb(pct):
            now = time.time()
            if pct >= 100 or now - last[0] > 0.25:
                last[0] = now
                self.emit({"type": "progress", "stage": stage, "stage_pct": max(0.0, min(100.0, float(pct)))})

        return cb

    def stage(self, stage: str, label: str):
        tap = sys.stdout if isinstance(sys.stdout, _ProgressTap) else None
        if tap:
            tap.stage = stage
        if isinstance(sys.stderr, _ProgressTap):
            sys.stderr.stage = stage
        self.emit({"type": "progress", "stage": stage, "label": label, "stage_pct": 0})


def _ensure_nltk():
    """WhisperX's aligner splits sentences with NLTK's punkt_tab data."""
    try:
        import nltk  # type: ignore

        from .config import NLTK_DIR

        if str(NLTK_DIR) not in nltk.data.path:
            nltk.data.path.insert(0, str(NLTK_DIR))
        try:
            nltk.data.find("tokenizers/punkt_tab")
        except LookupError:
            nltk.download("punkt_tab", download_dir=str(NLTK_DIR), quiet=True)
    except Exception:
        pass


def _real(module, sub: str, name: str):
    """whisperx exposes lazy *args wrappers; use the real function so signatures can be inspected."""
    try:
        import importlib

        return getattr(importlib.import_module(f"{module.__name__}.{sub}"), name)
    except Exception:
        return getattr(module, name)


def _with_progress(fn, kwargs: dict, callback, printable: bool = True) -> dict:
    """Prefer a progress_callback; fall back to parsing print_progress output."""
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        params = {}
    kw = dict(kwargs)
    if "progress_callback" in params:
        kw["progress_callback"] = callback
    elif printable and "print_progress" in params:
        kw["print_progress"] = True
    return _filter_kwargs(fn, kw)


def _default_threads() -> int:
    try:
        import psutil  # type: ignore

        return max(1, psutil.cpu_count(logical=False) or os.cpu_count() or 4)
    except Exception:
        return max(1, os.cpu_count() or 4)


def _write_peaks(audio, path: Path, np):
    n = len(audio)
    if n == 0:
        path.write_text("[]")
        return
    duration = n / SAMPLE_RATE
    bins = int(min(max(duration * 25, 200), 80000))
    size = max(1, n // bins)
    trimmed = audio[: size * bins] if n >= size * bins else np.pad(audio, (0, size * bins - n))
    peaks = np.abs(trimmed.reshape(bins, size)).max(axis=1)
    top = float(np.percentile(peaks, 99.5)) or 1.0
    scaled = np.clip(peaks / top * 100, 0, 100).astype(int).tolist()
    path.write_text(json.dumps({"duration": duration, "peaks": scaled}))


def _write_wav(audio, path: Path, np):
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm)


def worker_main(conn, log_path: str):
    """Entry point of the worker process."""
    log = open(log_path, "a", encoding="utf-8", buffering=1)

    def emit(evt):
        try:
            conn.send(evt)
        except Exception:
            pass

    tap = _ProgressTap(emit, log)
    sys.stdout = tap
    sys.stderr = tap
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

    from .runtime import ensure_ffmpeg

    ensure_ffmpeg()
    engine = Engine(emit)
    emit({"type": "ready"})

    while True:
        try:
            msg = conn.recv()
        except (EOFError, OSError):
            break
        kind = msg.get("type")
        if kind == "stop":
            break
        if kind == "unload":
            engine.unload()
            emit({"type": "unloaded"})
            continue
        if kind == "job":
            job = msg["job"]
            started = time.time()
            try:
                info = engine.run(job)
                emit({"type": "done", "id": job["id"], "elapsed": time.time() - started, **info})
            except BaseException as exc:  # noqa: BLE001
                tb = traceback.format_exc()
                log.write(tb)
                emit({"type": "error", "id": job["id"], "error": _friendly_error(exc), "trace": tb[-4000:]})
            finally:
                tap.stage = None
                gc.collect()


def _friendly_error(exc: BaseException) -> str:
    msg = str(exc) or exc.__class__.__name__
    low = msg.lower()
    if "ffmpeg" in low and ("not found" in low or "no such file" in low):
        return "FFmpeg was not found. Re-run install.bat."
    if "401" in low or "403" in low or "gated" in low or ("accept" in low and "hugging" in low):
        return ("Hugging Face refused access. Check your token and accept the model terms at "
                "huggingface.co/pyannote/speaker-diarization-community-1.")
    if "connection" in low or "resolve" in low or "offline" in low:
        return "Could not download the model. Check your internet connection (needed only the first time)."
    if isinstance(exc, MemoryError) or "out of memory" in low:
        return "Ran out of memory. Try a smaller model or batch size."
    return msg

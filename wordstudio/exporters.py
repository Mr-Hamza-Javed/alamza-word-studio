"""Turn a transcript into JSON, TXT, SRT, VTT, word-level subtitles, ASS karaoke, TSV, CSV and Markdown."""

from __future__ import annotations

import csv
import io
import json

FORMATS = {
    "json": {"label": "JSON (full data)", "ext": "json", "mime": "application/json"},
    "txt": {"label": "Plain text", "ext": "txt", "mime": "text/plain"},
    "srt": {"label": "SRT subtitles", "ext": "srt", "mime": "application/x-subrip"},
    "vtt": {"label": "WebVTT subtitles", "ext": "vtt", "mime": "text/vtt"},
    "word_srt": {"label": "Word-by-word SRT", "ext": "words.srt", "mime": "application/x-subrip"},
    "karaoke_vtt": {"label": "Karaoke WebVTT", "ext": "karaoke.vtt", "mime": "text/vtt"},
    "ass": {"label": "ASS karaoke (Aegisub)", "ext": "ass", "mime": "text/x-ssa"},
    "tsv": {"label": "Words TSV", "ext": "words.tsv", "mime": "text/tab-separated-values"},
    "csv": {"label": "Words CSV (Excel)", "ext": "words.csv", "mime": "text/csv"},
    "md": {"label": "Markdown", "ext": "md", "mime": "text/markdown"},
}

DEFAULT_OPTS = {
    "max_chars_per_line": 42,
    "max_lines": 2,
    "max_cue_duration": 6.0,
    "split_on_speaker": True,
    "include_speaker_labels": True,
    "txt_timestamps": False,
}


# ---------------- helpers ----------------
def _ts(t: float, sep: str = ",") -> str:
    t = max(0.0, float(t or 0))
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def _ts_ass(t: float) -> str:
    cs = int(round(max(0.0, float(t or 0)) * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _short_ts(t: float) -> str:
    t = int(max(0, float(t or 0)))
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def speaker_name(result: dict, spk: str | None) -> str | None:
    if not spk:
        return None
    custom = (result.get("speakers") or {}).get(spk)
    if custom:
        return custom
    try:
        return f"Speaker {int(spk.rsplit('_', 1)[-1]) + 1}"
    except ValueError:
        return spk


def timed_words(result: dict) -> list[dict]:
    """Flat list of words with start/end filled in (numbers etc. may lack timings)."""
    out = []
    for si, seg in enumerate(result.get("segments", [])):
        words = seg.get("words") or []
        if not words:
            # Unaligned segment: spread its words evenly.
            toks = (seg.get("text") or "").split()
            if not toks:
                continue
            s, e = float(seg.get("start") or 0), float(seg.get("end") or 0)
            step = (e - s) / len(toks) if e > s else 0.3
            for i, tok in enumerate(toks):
                out.append({"word": tok, "start": s + i * step, "end": s + (i + 1) * step, "score": None,
                            "speaker": seg.get("speaker"), "seg": si})
            continue
        for w in words:
            text = (w.get("word") or "").strip()
            if not text:
                continue
            out.append({"word": text, "start": w.get("start"), "end": w.get("end"), "score": w.get("score"),
                        "speaker": w.get("speaker") or seg.get("speaker"), "seg": si,
                        "_ss": seg.get("start"), "_se": seg.get("end")})
    # Fill gaps by interpolating between neighbours.
    n = len(out)
    for i, w in enumerate(out):
        if w["start"] is None:
            prev_end = next((out[j]["end"] for j in range(i - 1, -1, -1) if out[j]["end"] is not None), None)
            nxt_start = next((out[j]["start"] for j in range(i + 1, n) if out[j]["start"] is not None), None)
            base = prev_end if prev_end is not None else (w.get("_ss") or 0)
            w["start"] = float(base)
            limit = nxt_start if nxt_start is not None else (w.get("_se") or base + 0.4)
            w["end"] = max(w["start"] + 0.05, min(float(limit), w["start"] + 0.6))
        elif w["end"] is None:
            w["end"] = float(w["start"]) + 0.3
    for w in out:
        w.pop("_ss", None)
        w.pop("_se", None)
    return out


def _wrap(text: str, max_chars: int, max_lines: int) -> str:
    if len(text) <= max_chars or max_lines <= 1:
        return text
    words = text.split(" ")
    # Balanced split into max_lines lines.
    target = len(text) / max_lines
    lines, cur = [], ""
    for w in words:
        if cur and len(cur) + 1 + len(w) > max(target, 1) * 1.15 and len(lines) < max_lines - 1:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}" if cur else w
    lines.append(cur)
    return "\n".join(lines)


def build_cues(result: dict, opts: dict) -> list[dict]:
    o = {**DEFAULT_OPTS, **(opts or {})}
    max_len = int(o["max_chars_per_line"]) * max(1, int(o["max_lines"]))
    max_dur = float(o["max_cue_duration"])
    words = timed_words(result)
    cues: list[dict] = []
    cur: list[dict] = []

    def flush():
        if cur:
            cues.append({"start": cur[0]["start"], "end": cur[-1]["end"], "words": list(cur),
                         "speaker": cur[0].get("speaker"), "text": " ".join(w["word"] for w in cur)})
            cur.clear()

    for i, w in enumerate(words):
        if cur:
            text_len = sum(len(x["word"]) + 1 for x in cur) + len(w["word"])
            gap = w["start"] - cur[-1]["end"]
            if (text_len > max_len or w["end"] - cur[0]["start"] > max_dur or gap > 1.5
                    or (o["split_on_speaker"] and w.get("speaker") != cur[-1].get("speaker"))
                    or w["seg"] != cur[-1]["seg"] and text_len > max_len * 0.4):
                flush()
            elif cur[-1]["word"][-1:] in ".?!" and text_len > max_len * 0.5:
                flush()
        cur.append(w)
    flush()
    # Avoid overlapping cues.
    for a, b in zip(cues, cues[1:]):
        if a["end"] > b["start"]:
            a["end"] = b["start"]
    for c in cues:
        c["lines"] = _wrap(c["text"], int(o["max_chars_per_line"]), int(o["max_lines"]))
    return cues


def _label(result: dict, cue: dict, opts: dict) -> str:
    if opts.get("include_speaker_labels", True) and cue.get("speaker"):
        name = speaker_name(result, cue["speaker"])
        return f"[{name}] "
    return ""


# ---------------- exporters ----------------
def to_json(result: dict, opts: dict) -> str:
    data = dict(result)
    data["speaker_names"] = {k: speaker_name(result, k) for k in _speakers(result)}
    return json.dumps(data, ensure_ascii=False, indent=2)


def _speakers(result: dict) -> list[str]:
    seen = []
    for s in result.get("segments", []):
        if s.get("speaker") and s["speaker"] not in seen:
            seen.append(s["speaker"])
    return seen


def to_txt(result: dict, opts: dict) -> str:
    o = {**DEFAULT_OPTS, **(opts or {})}
    lines, last_spk = [], None
    for seg in result.get("segments", []):
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        prefix = ""
        if o["txt_timestamps"]:
            prefix += f"[{_short_ts(seg.get('start'))}] "
        spk = seg.get("speaker")
        if o["include_speaker_labels"] and spk:
            if spk != last_spk:
                if lines:
                    lines.append("")
                prefix += f"{speaker_name(result, spk)}: "
            last_spk = spk
        lines.append(prefix + text)
    return "\n".join(lines) + "\n"


def to_srt(result: dict, opts: dict) -> str:
    out = []
    for i, c in enumerate(build_cues(result, opts), 1):
        out.append(f"{i}\n{_ts(c['start'])} --> {_ts(c['end'])}\n{_label(result, c, opts)}{c['lines']}\n")
    return "\n".join(out)


def to_vtt(result: dict, opts: dict) -> str:
    out = ["WEBVTT\n"]
    for c in build_cues(result, opts):
        text = c["lines"]
        if opts.get("include_speaker_labels", True) and c.get("speaker"):
            text = f"<v {speaker_name(result, c['speaker'])}>{text}"
        out.append(f"{_ts(c['start'], '.')} --> {_ts(c['end'], '.')}\n{text}\n")
    return "\n".join(out)


def to_word_srt(result: dict, opts: dict) -> str:
    out = []
    for i, w in enumerate(timed_words(result), 1):
        out.append(f"{i}\n{_ts(w['start'])} --> {_ts(w['end'])}\n{w['word']}\n")
    return "\n".join(out)


def to_karaoke_vtt(result: dict, opts: dict) -> str:
    out = ["WEBVTT\n"]
    for c in build_cues(result, opts):
        parts = []
        for j, w in enumerate(c["words"]):
            parts.append(w["word"] if j == 0 else f"<{_ts(w['start'], '.')}>{w['word']}")
        out.append(f"{_ts(c['start'], '.')} --> {_ts(c['end'], '.')}\n{_label(result, c, opts)}{' '.join(parts)}\n")
    return "\n".join(out)


def to_ass(result: dict, opts: dict) -> str:
    head = (
        "[Script Info]\nTitle: Alamza Word Studio\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
        "MarginR, MarginV, Encoding\n"
        "Style: Default,Arial,64,&H0000E5FF,&H00FFFFFF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,80,80,70,1\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    rows = []
    for c in build_cues(result, opts):
        parts = []
        prev_end = c["start"]
        for w in c["words"]:
            gap = max(0, int(round((w["start"] - prev_end) * 100)))
            if gap:
                parts.append(f"{{\\k{gap}}}")
            dur = max(1, int(round((w["end"] - w["start"]) * 100)))
            parts.append(f"{{\\kf{dur}}}{w['word']} ")
            prev_end = w["end"]
        name = speaker_name(result, c.get("speaker")) or ""
        rows.append(f"Dialogue: 0,{_ts_ass(c['start'])},{_ts_ass(c['end'])},Default,{name},0,0,0,,{''.join(parts).strip()}")
    return head + "\n".join(rows) + "\n"


def _word_rows(result: dict):
    for w in timed_words(result):
        yield [f"{w['start']:.3f}", f"{w['end']:.3f}", w["word"],
               "" if w.get("score") is None else f"{w['score']:.3f}", speaker_name(result, w.get("speaker")) or ""]


def to_tsv(result: dict, opts: dict) -> str:
    lines = ["start\tend\tword\tconfidence\tspeaker"]
    lines += ["\t".join(r) for r in _word_rows(result)]
    return "\n".join(lines) + "\n"


def to_csv(result: dict, opts: dict) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["start", "end", "word", "confidence", "speaker"])
    writer.writerows(_word_rows(result))
    return "﻿" + buf.getvalue()  # BOM so Excel opens UTF-8 correctly


def to_md(result: dict, opts: dict) -> str:
    title = opts.get("title") or "Transcript"
    out = [f"# {title}", "", f"*Language: {result.get('language', '?')} · Model: {result.get('model', '?')} · "
                              f"Duration: {_short_ts(result.get('duration') or 0)}*", ""]
    last = object()
    for seg in result.get("segments", []):
        spk = seg.get("speaker")
        if spk != last:
            who = speaker_name(result, spk)
            out.append("")
            out.append(f"**{who}** · `{_short_ts(seg.get('start'))}`" if who else f"`{_short_ts(seg.get('start'))}`")
            out.append("")
            last = spk
        out.append((seg.get("text") or "").strip())
    return "\n".join(out).strip() + "\n"


_EXPORTERS = {
    "json": to_json, "txt": to_txt, "srt": to_srt, "vtt": to_vtt, "word_srt": to_word_srt,
    "karaoke_vtt": to_karaoke_vtt, "ass": to_ass, "tsv": to_tsv, "csv": to_csv, "md": to_md,
}


def export(result: dict, fmt: str, opts: dict | None = None) -> str:
    if fmt not in _EXPORTERS:
        raise ValueError(f"Unknown format: {fmt}")
    return _EXPORTERS[fmt](result, opts or {})

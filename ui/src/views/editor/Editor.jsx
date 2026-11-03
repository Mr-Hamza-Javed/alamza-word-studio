import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, Pause, Play, RotateCcw, RotateCw, Undo2, Redo2, Pencil, PanelRight, Search, ChevronUp, ChevronDown, X,
  Crosshair, Type, AlertCircle, Repeat, Volume2, VolumeX, MoreHorizontal, Trash2, FolderOpen, Scissors, Merge, Ban,
  CheckCircle2, Loader2, Maximize2, Minimize2, Download, Replace, XCircle,
} from "lucide-react";
import { api } from "../../lib/api";
import { toast, useStore } from "../../lib/store";
import { fileExt, fmtDuration, fmtTime, speakerLabel, VIDEO_EXT } from "../../lib/format";
import { confirmDialog, Menu, Progress, StatusBadge } from "../../components/ui";
import RerunModal from "../../components/RerunModal";
import Waveform from "./Waveform";
import Transcript from "./Transcript";
import SidePanel from "./SidePanel";
import {
  editWord, flatten, mergeWithPrevious, normalize, replaceAll, search, segmentAt, setSegmentSpeaker, speakerOrder,
  splitSegment, toSave, wordAt,
} from "./model";

const RATES = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const pref = (k, d) => { try { const v = localStorage.getItem("aws-ed-" + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem("aws-ed-" + k, JSON.stringify(v)); } catch {} };

export default function Editor({ id }) {
  const job = useStore((s) => s.jobs.find((j) => j.id === id));
  const jobsLoaded = useStore((s) => s.jobsLoaded);
  if (!job) {
    return jobsLoaded ? (
      <div className="processing"><div className="card"><h3>Transcript not found</h3><p className="muted">It may have been deleted.</p><a className="btn primary" href="#/library">Back to Library</a></div></div>
    ) : null;
  }
  if (job.status !== "done") return <JobStatus job={job} />;
  return <DoneEditor key={`${job.id}-${job.finished}`} job={job} />;
}

/* ---------------- Processing / failed state ---------------- */
function JobStatus({ job }) {
  const [now, setNow] = useState(Date.now() / 1000);
  const [rerun, setRerun] = useState(false);
  useEffect(() => { const t = setInterval(() => setNow(Date.now() / 1000), 1000); return () => clearInterval(t); }, []);
  const p = job.progress || 0;
  const elapsed = job.started ? now - job.started : 0;
  const eta = p > 12 && elapsed > 5 ? (elapsed * (100 - p)) / p : null;
  const steps = [["audio", "Decode"], ["model", "Load model"], ["transcribe", "Transcribe"], ["align", "Word timing"],
    ...(job.settings?.diarize ? [["diarize", "Speakers"]] : []), ["finalize", "Save"]];
  const idx = steps.findIndex(([s]) => s === job.stage);
  return (
    <div className="editor" style={{ gridTemplateRows: "auto 1fr" }}>
      <div className="ed-head">
        <a className="icon-btn" href="#/library" title="Back"><ArrowLeft /></a>
        <b className="ellipsis grow" style={{ fontSize: 15 }}>{job.name}</b>
        <StatusBadge status={job.status} />
      </div>
      <div className="processing">
        <div className="card">
          {job.status === "running" && <>
            <div className="big-pct">{Math.round(p)}%</div>
            <div style={{ fontWeight: 600, marginBottom: 14 }}>{job.stage_label || "Starting"}…</div>
            <Progress value={p} />
            <div className="row" style={{ justifyContent: "center", gap: 6, margin: "16px 0 6px", flexWrap: "wrap" }}>
              {steps.map(([s, label], i) => (
                <span key={s} className={`badge ${i < idx ? "success" : i === idx ? "accent" : ""}`}>
                  {i < idx ? <CheckCircle2 /> : i === idx ? <Loader2 style={{ animation: "spin 1s linear infinite" }} /> : null}{label}
                </span>
              ))}
            </div>
            <p className="muted" style={{ fontSize: 12.5 }}>
              {fmtDuration(elapsed)} elapsed{eta ? ` · about ${fmtDuration(eta)} left` : ""}{job.duration ? ` · ${fmtDuration(job.duration)} of audio` : ""} · {job.model}
            </p>
            <p className="muted" style={{ fontSize: 12 }}>You can close this tab. The app keeps working in the tray and notifies you when it's done.</p>
            <button className="btn danger" onClick={() => api.post(`/api/jobs/${job.id}/cancel`)}><Ban />Cancel</button>
          </>}
          {job.status === "queued" && <>
            <Loader2 style={{ width: 30, height: 30, color: "var(--accent)", animation: "spin 1.2s linear infinite" }} />
            <h3 style={{ margin: "10px 0 4px" }}>Waiting in queue</h3>
            <p className="muted">It starts automatically when the current file finishes.</p>
            <button className="btn danger" onClick={() => api.post(`/api/jobs/${job.id}/cancel`)}><Ban />Remove from queue</button>
          </>}
          {(job.status === "error" || job.status === "cancelled") && <>
            {job.status === "error" ? <XCircle style={{ width: 34, height: 34, color: "var(--danger)" }} /> : <Ban style={{ width: 34, height: 34, color: "var(--warning)" }} />}
            <h3 style={{ margin: "10px 0 6px" }}>{job.status === "error" ? "Transcription failed" : "Cancelled"}</h3>
            {job.error && <p className="callout warn" style={{ textAlign: "left" }}>{job.error}</p>}
            <div className="row" style={{ justifyContent: "center", marginTop: 12 }}>
              <button className="btn" onClick={() => api.post(`/api/jobs/${job.id}/retry`)}><RotateCw />Try again</button>
              <button className="btn primary" onClick={() => setRerun(true)}>Change settings…</button>
            </div>
          </>}
        </div>
      </div>
      {rerun && <RerunModal job={job} onClose={() => setRerun(false)} />}
    </div>
  );
}

/* ---------------- Editor ---------------- */
function DoneEditor({ job }) {
  const settings = useStore((s) => s.settings);
  const [doc, setDoc] = useState(null);
  const [peaks, setPeaks] = useState(null);
  const [saveState, setSaveState] = useState("saved"); // saved | dirty | saving | error
  const [version, setVersion] = useState(0);
  const [extraSpk, setExtraSpk] = useState([]);

  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(() => pref("rate", 1));
  const [volume, setVolume] = useState(() => pref("volume", 1));
  const [muted, setMuted] = useState(false);
  const [follow, setFollow] = useState(() => pref("follow", true));
  const [readAlong, setReadAlong] = useState(() => pref("readAlong", false));
  const [showConf, setShowConf] = useState(() => pref("conf", true));
  const [panel, setPanel] = useState(() => pref("panel", true));
  const [tab, setTab] = useState("export");
  const [bigVideo, setBigVideo] = useState(false);
  const [editing, setEditing] = useState(false);
  const [loopSeg, setLoopSeg] = useState(false);
  const [loop, setLoop] = useState(null);
  const [query, setQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  const [replaceText, setReplaceText] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [popover, setPopover] = useState(null);
  const [captionIdx, setCaptionIdx] = useState(-1);
  const [rerun, setRerun] = useState(false);
  const [title, setTitle] = useState(job.name);

  const mediaRef = useRef(null);
  const wrapRef = useRef(null);
  const searchRef = useRef(null);
  const wordEls = useRef([]);
  const segEls = useRef([]);
  const userScrollAt = useRef(0);
  const followRef = useRef(follow);
  const readAlongRef = useRef(readAlong);
  const loopRef = useRef(null);
  followRef.current = follow;
  readAlongRef.current = readAlong;
  loopRef.current = loop;

  const isVideo = VIDEO_EXT.includes(fileExt(job.input_path || job.name)) && !job.has_preview;
  const isVideoRef = useRef(isVideo);
  isVideoRef.current = isVideo;

  // Load transcript + waveform
  useEffect(() => {
    let alive = true;
    api.get(`/api/jobs/${job.id}/result`).then((r) => alive && setDoc(normalize(r))).catch((e) => toast(e.message, "error"));
    api.get(`/api/jobs/${job.id}/peaks`).then((p) => alive && setPeaks(p)).catch(() => {});
    return () => { alive = false; };
  }, [job.id]);

  const segments = doc?.segments || [];
  const names = doc?.speakers || {};
  const flat = useMemo(() => flatten(segments), [segments]);
  const order = useMemo(() => {
    const o = speakerOrder(segments);
    [...Object.keys(names), ...extraSpk].forEach((s) => !o.includes(s) && o.push(s));
    return o;
  }, [segments, names, extraSpk]);
  const matches = useMemo(() => (query.trim().length >= 1 ? search(flat, query) : []), [flat, query]);
  const duration = doc?.duration || peaks?.duration || job.duration || 0;

  /* ---------- editing with undo ---------- */
  const docRef = useRef(doc);
  docRef.current = doc;
  const histRef = useRef({ past: [], future: [] });
  const [, setHistVer] = useState(0);
  const hist = histRef.current;
  const snapshot = (d) => ({ segments: d.segments, speakers: d.speakers });
  const commit = useCallback((nextSegments, nextNames) => {
    const d = docRef.current;
    const h = histRef.current;
    h.past = [...h.past.slice(-99), snapshot(d)];
    h.future = [];
    setDoc({ ...d, segments: nextSegments ?? d.segments, speakers: nextNames ?? d.speakers });
    setHistVer((v) => v + 1);
    setSaveState("dirty");
  }, []);
  const undo = useCallback(() => {
    const h = histRef.current, d = docRef.current;
    if (!h.past.length) return;
    h.future = [snapshot(d), ...h.future];
    const prev = h.past[h.past.length - 1];
    h.past = h.past.slice(0, -1);
    setDoc({ ...d, ...prev });
    setHistVer((v) => v + 1);
    setSaveState("dirty");
  }, []);
  const redo = useCallback(() => {
    const h = histRef.current, d = docRef.current;
    if (!h.future.length) return;
    h.past = [...h.past, snapshot(d)];
    const nxt = h.future[0];
    h.future = h.future.slice(1);
    setDoc({ ...d, ...nxt });
    setHistVer((v) => v + 1);
    setSaveState("dirty");
  }, []);

  const save = useCallback(async () => {
    const d = docRef.current;
    if (!d) return;
    setSaveState("saving");
    try {
      await api.put(`/api/jobs/${job.id}/result`, { segments: toSave(d.segments), speakers: d.speakers });
      setSaveState((s) => (s === "saving" ? "saved" : s));
      setVersion((v) => v + 1);
    } catch (e) {
      setSaveState("error");
      toast(`Couldn't save: ${e.message}`, "error");
    }
  }, [job.id]);
  const ensureSaved = useCallback(async () => {
    if (saveState === "dirty" || saveState === "error") await save();
  }, [saveState, save]);

  // Leaving the editor (e.g. back to Library) before autosave fired: save right away.
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;
  useEffect(() => () => {
    const d = docRef.current;
    if (d && (saveStateRef.current === "dirty" || saveStateRef.current === "error")) {
      fetch(`/api/jobs/${job.id}/result`, {
        method: "PUT", keepalive: true, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segments: toSave(d.segments), speakers: d.speakers }),
      }).catch(() => {});
    }
  }, [job.id]);

  // Autosave shortly after edits.
  useEffect(() => {
    if (saveState !== "dirty") return;
    const t = setTimeout(save, 1500);
    return () => clearTimeout(t);
  }, [saveState, doc, save]);
  useEffect(() => {
    const warn = (e) => { if (saveState === "dirty" || saveState === "saving") { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saveState]);

  /* ---------- media ---------- */
  // Loading a source resets playbackRate to defaultPlaybackRate, so set both.
  useEffect(() => { const m = mediaRef.current; if (m) { m.defaultPlaybackRate = rate; m.playbackRate = rate; } setPref("rate", rate); }, [rate, doc]);
  useEffect(() => { const m = mediaRef.current; if (m) { m.volume = volume; m.muted = muted; } setPref("volume", volume); }, [volume, muted, doc]);
  useEffect(() => setPref("follow", follow), [follow]);
  useEffect(() => setPref("readAlong", readAlong), [readAlong]);
  useEffect(() => setPref("conf", showConf), [showConf]);
  useEffect(() => setPref("panel", panel), [panel]);

  const seek = useCallback((t, play = false) => {
    const m = mediaRef.current;
    if (!m) return;
    m.currentTime = Math.max(0, Math.min(duration || m.duration || 0, t));
    userScrollAt.current = 0;
    if (play && m.paused) m.play().catch(() => {});
  }, [duration]);
  const toggle = useCallback(() => {
    const m = mediaRef.current;
    if (!m) return;
    if (m.paused) m.play().catch((e) => toast(`Can't play this file in the browser: ${e.message}`, "error")); else m.pause();
  }, []);

  // Collect DOM nodes after each render of the transcript.
  useLayoutEffect(() => {
    const root = wrapRef.current;
    if (!root) return;
    wordEls.current = Array.from(root.querySelectorAll(".w"));
    segEls.current = Array.from(root.querySelectorAll(".seg-block"));
  }, [segments, editing, showConf, readAlong]);

  /* ---------- the highlight loop ---------- */
  useEffect(() => {
    if (!doc) return;
    let raf, lastIdx = -2, lastSeg = -2;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const m = mediaRef.current;
      if (!m) return;
      const t = m.currentTime;
      const lp = loopRef.current;
      if (lp && !m.paused && t >= lp.end) { m.currentTime = lp.start; return; }
      const idx = wordAt(flat, t);
      if (idx === lastIdx) return;
      const els = wordEls.current;
      if (lastIdx >= 0) els[lastIdx]?.classList.remove("on");
      if (idx >= 0) els[idx]?.classList.add("on");
      const si = idx >= 0 ? flat[idx].si : segmentAt(segments, t);
      if (si !== lastSeg) {
        if (lastSeg >= 0) {
          segEls.current[lastSeg]?.classList.remove("active");
          segEls.current[lastSeg]?.querySelectorAll(".past").forEach((e) => e.classList.remove("past"));
        }
        if (si >= 0) segEls.current[si]?.classList.add("active");
        lastSeg = si;
      }
      if (readAlongRef.current && si >= 0) {
        const curWi = idx >= 0 ? flat[idx].wi : -1;
        segEls.current[si]?.querySelectorAll(".w").forEach((e, k) => e.classList.toggle("past", curWi >= 0 && k < curWi));
      }
      lastIdx = idx;
      if (isVideoRef.current) setCaptionIdx(idx);
      // Follow playback
      const el = idx >= 0 ? els[idx] : null;
      const wrap = wrapRef.current;
      if (el && wrap && followRef.current && !m.paused && Date.now() - userScrollAt.current > 3500) {
        const r = el.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
        const rel = (r.top - wr.top) / wr.height;
        if (rel < 0.15 || rel > 0.7) wrap.scrollTo({ top: wrap.scrollTop + (r.top - wr.top) - wr.height * 0.35, behavior: "smooth" });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      wordEls.current.forEach((e) => e.classList.remove("on", "past"));
      segEls.current.forEach((e) => e.classList.remove("active"));
    };
  }, [doc, flat, segments, editing, showConf, readAlong]);

  // Loop current segment
  useEffect(() => {
    if (!loopSeg) { setLoop(null); return; }
    const m = mediaRef.current;
    const si = segmentAt(segments, m?.currentTime || 0);
    const s = segments[si >= 0 ? si : 0];
    if (s) setLoop({ start: s.words[0]?.start ?? s.start, end: s.words[s.words.length - 1]?.end ?? s.end });
  }, [loopSeg]);

  /* ---------- search highlighting ---------- */
  useEffect(() => {
    const els = wordEls.current;
    els.forEach((e) => e.classList.remove("match", "current"));
    matches.forEach((m, i) => m.forEach((fi) => { els[fi]?.classList.add("match"); if (i === matchIdx) els[fi]?.classList.add("current"); }));
  }, [matches, matchIdx, segments, editing, showConf]);
  const gotoMatch = useCallback((i) => {
    if (!matches.length) return;
    const n = (i + matches.length) % matches.length;
    setMatchIdx(n);
    const fi = matches[n][0];
    const el = wordEls.current[fi];
    seek(flat[fi].start);
    if (el && wrapRef.current) {
      const wr = wrapRef.current.getBoundingClientRect(), r = el.getBoundingClientRect();
      wrapRef.current.scrollTo({ top: wrapRef.current.scrollTop + (r.top - wr.top) - wr.height * 0.35, behavior: "smooth" });
      userScrollAt.current = Date.now();
    }
  }, [matches, flat, seek]);
  const navigated = useRef(false);
  useEffect(() => { setMatchIdx(0); navigated.current = false; }, [query]);

  /* ---------- word clicks ---------- */
  const onTranscriptClick = (e) => {
    const el = e.target.closest(".w");
    if (!el) { if (!e.target.closest(".word-editor")) setPopover(null); return; }
    const fi = Number(el.dataset.fi), si = Number(el.dataset.si), wi = Number(el.dataset.wi);
    if (editing) {
      const wr = wrapRef.current.getBoundingClientRect(), r = el.getBoundingClientRect();
      setPopover({ si, wi, value: segments[si].words[wi].word, top: r.bottom - wr.top + wrapRef.current.scrollTop + 6, left: Math.max(8, Math.min(r.left - wr.left, wr.width - 330)) });
    } else {
      seek(flat[fi].start, true);
    }
  };
  const applyPopover = (value, move = 0) => {
    if (!popover) return;
    const { si, wi } = popover;
    const before = segments[si].words[wi].word;
    let next = segments;
    if (value !== before) { next = editWord(segments, si, wi, value); commit(next); }
    setPopover(null);
    if (move) {
      // Open the editor on the neighbouring word after the DOM updates.
      const f = flatten(next);
      const cur = f.findIndex((w) => w.si === si && w.wi === wi);
      const target = cur + move;
      requestAnimationFrame(() => {
        const el = wordEls.current[target];
        if (el) el.click();
      });
    }
  };

  const onSeekPlay = useCallback((t) => seek(t, true), [seek]);
  const changeSpeakerRef = useRef(null);
  const onSpeakerChange = useCallback((si, spk) => changeSpeakerRef.current(si, spk), []);
  const changeSpeaker = (si, spk) => {
    if (spk === "__new") spk = addSpeaker();
    commit(setSegmentSpeaker(segments, si, spk || null));
  };
  changeSpeakerRef.current = changeSpeaker;
  const addSpeaker = () => {
    let n = 0;
    while (order.includes(`SPEAKER_${String(n).padStart(2, "0")}`)) n++;
    const id = `SPEAKER_${String(n).padStart(2, "0")}`;
    setExtraSpk((x) => [...x, id]);
    return id;
  };
  const setNames = (nextNames) => {
    setDoc((d) => ({ ...d, speakers: nextNames }));
    setSaveState("dirty");
  };

  const doReplaceAll = () => {
    const [next, count] = replaceAll(segments, query, replaceText, false);
    if (!count) return toast("No matches to replace", "info");
    commit(next);
    toast(`Replaced ${count} occurrence${count > 1 ? "s" : ""}`, "success");
  };

  const revert = async () => {
    const r = await api.post(`/api/jobs/${job.id}/revert`);
    setDoc(normalize(r));
    histRef.current = { past: [], future: [] };
    setHistVer((v) => v + 1);
    setSaveState("saved");
    setVersion((v) => v + 1);
    toast("Reverted to the original transcript", "success");
  };

  const rename = async () => {
    const name = title.trim();
    if (!name || name === job.name) return setTitle(job.name);
    await api.post(`/api/jobs/${job.id}/rename`, { name }).catch((e) => toast(e.message, "error"));
  };

  const del = async () => {
    if (!(await confirmDialog({ title: "Delete this transcript?", message: "The transcript, media and edits will be removed.", danger: true, confirmLabel: "Delete" }))) return;
    await api.del(`/api/jobs/${job.id}`);
    location.hash = "#/library";
  };

  /* ---------- keyboard ---------- */
  useEffect(() => {
    const onKey = (e) => {
      const inField = e.target.closest("input, textarea, select");
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); save(); return; }
      if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); setShowSearch(true); setTimeout(() => searchRef.current?.select(), 0); return; }
      if (mod && e.key.toLowerCase() === "e") { e.preventDefault(); setPanel(true); setTab("export"); return; }
      if (inField) return;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); redo(); return; }
      if (mod || e.altKey) return;
      const m = mediaRef.current;
      const t = m?.currentTime || 0;
      switch (e.key) {
        case " ": case "k": case "K": e.preventDefault(); toggle(); break;
        case "j": case "J": seek(t - 5); break;
        case "l": case "L": seek(t + 5); break;
        case "ArrowLeft": e.preventDefault(); seek(t - 1); break;
        case "ArrowRight": e.preventDefault(); seek(t + 1); break;
        case "ArrowUp": case "ArrowDown": {
          e.preventDefault();
          const startOf = (s) => s.words[0]?.start ?? s.start ?? 0;
          // Segment we're in (or the last one that started before now).
          let cur = -1;
          for (let i = 0; i < segments.length && startOf(segments[i]) <= t + 0.05; i++) cur = i;
          let target;
          if (e.key === "ArrowDown") target = segments[cur + 1];
          else if (cur >= 0 && t - startOf(segments[cur]) > 1) target = segments[cur]; // back to start of this one
          else target = segments[Math.max(0, cur - 1)];
          if (target) seek(startOf(target));
          break;
        }
        case "[": setRate((r) => RATES[Math.max(0, RATES.indexOf(r) - 1)] ?? 1); break;
        case "]": setRate((r) => RATES[Math.min(RATES.length - 1, RATES.indexOf(r) + 1)] ?? 1); break;
        case "e": case "E": setEditing((x) => !x); setPopover(null); break;
        case "f": case "F": setFollow((x) => !x); break;
        case "p": case "P": setPanel((x) => !x); break;
        case "Escape": setPopover(null); setShowSearch(false); setQuery(""); break;
        default:
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [segments, toggle, seek, save, undo, redo]);

  if (!doc) {
    return <div className="processing"><Loader2 style={{ width: 28, height: 28, color: "var(--accent)", animation: "spin 1s linear infinite" }} /></div>;
  }

  const capSeg = captionIdx >= 0 ? segments[flat[captionIdx]?.si] : null;
  const capWi = captionIdx >= 0 ? flat[captionIdx]?.wi : -1;
  const lowThreshold = settings?.low_confidence_threshold ?? 0.5;
  const mediaSrc = `/api/jobs/${job.id}/media`;
  const mediaProps = {
    ref: mediaRef, src: mediaSrc, preload: "auto",
    onPlay: () => setPlaying(true), onPause: () => setPlaying(false), onEnded: () => setPlaying(false),
    onError: () => toast("This media format can't play in the browser. The transcript still works.", "error"),
  };

  return (
    <div className="editor">
      {/* Header */}
      <div className="ed-head">
        <a className="icon-btn" href="#/library" title="Back to Library"><ArrowLeft /></a>
        <input className="ed-title" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={rename}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} size={Math.min(50, Math.max(8, title.length))} />
        <div className="ed-chips">
          <span className="chip mono">{doc.model}</span>
          <span className="chip">{doc.language?.toUpperCase()}</span>
          <span className="chip">{fmtDuration(duration)}</span>
          {order.length > 0 && <span className="chip">{order.length} speaker{order.length > 1 ? "s" : ""}</span>}
        </div>
        <div className="grow" />
        <span className="muted row" style={{ fontSize: 12, gap: 5 }}>
          {saveState === "saving" && <><Loader2 style={{ width: 13, animation: "spin 1s linear infinite" }} />Saving…</>}
          {saveState === "dirty" && <><span className="dirty-dot" />Unsaved</>}
          {saveState === "saved" && hist.past.length > 0 && <><CheckCircle2 style={{ width: 13, color: "var(--success)" }} />Saved</>}
          {saveState === "error" && <span style={{ color: "var(--danger)" }}>Save failed</span>}
        </span>
        <button className="icon-btn" title="Undo (Ctrl+Z)" disabled={!hist.past.length} onClick={undo}><Undo2 /></button>
        <button className="icon-btn" title="Redo (Ctrl+Y)" disabled={!hist.future.length} onClick={redo}><Redo2 /></button>
        <button className={`btn sm ${editing ? "primary" : ""}`} onClick={() => { setEditing(!editing); setPopover(null); }} title="Edit mode (E)"><Pencil />{editing ? "Editing" : "Edit"}</button>
        <button className="btn sm" onClick={() => { setPanel(true); setTab("export"); }} title="Export (Ctrl+E)"><Download />Export</button>
        <button className={`icon-btn ${panel ? "active" : ""}`} onClick={() => setPanel(!panel)} title="Side panel (P)"><PanelRight /></button>
        <Menu trigger={({ toggle: t }) => <button className="icon-btn" onClick={t}><MoreHorizontal /></button>}>
          <button onClick={() => setRerun(true)}><RotateCw />Re-run with other settings</button>
          <button onClick={() => api.post(`/api/jobs/${job.id}/reveal`)}><FolderOpen />Show source file</button>
          <hr />
          <button className="danger" onClick={del}><Trash2 />Delete transcript</button>
        </Menu>
      </div>

      {/* Player */}
      <div className={`player ${isVideo ? "" : "no-video"}`}>
        {isVideo ? (
          <div className={`video-wrap ${bigVideo ? "big" : ""}`} onClick={toggle}>
            <video {...mediaProps} playsInline />
            {capSeg && (
              <div className="caption">
                {captionChunk(capSeg.words, capWi).map(({ w, i }) => <span key={i} className={i === capWi ? "on" : ""}>{w.word} </span>)}
              </div>
            )}
            <button className="icon-btn sm" style={{ position: "absolute", top: 6, right: 6, background: "rgba(0,0,0,.45)", color: "#fff" }}
              onClick={(e) => { e.stopPropagation(); setBigVideo(!bigVideo); }}>{bigVideo ? <Minimize2 /> : <Maximize2 />}</button>
          </div>
        ) : <audio {...mediaProps} />}
        <div className="player-main">
          {peaks ? <Waveform peaks={peaks.peaks} duration={duration} mediaRef={mediaRef} segments={segments} order={order} loop={loop} /> : <div className="wave" />}
          <div className="controls">
            <button className="icon-btn" title="Back 5s (J)" onClick={() => seek((mediaRef.current?.currentTime || 0) - 5)}><RotateCcw /></button>
            <button className="icon-btn play" title="Play/Pause (Space)" onClick={toggle}>{playing ? <Pause /> : <Play />}</button>
            <button className="icon-btn" title="Forward 5s (L)" onClick={() => seek((mediaRef.current?.currentTime || 0) + 5)}><RotateCw /></button>
            <TimeDisplay mediaRef={mediaRef} duration={duration} />
            <div className="grow" />
            <button className={`icon-btn ${follow ? "active" : ""}`} title="Follow playback (F)" onClick={() => setFollow(!follow)}><Crosshair /></button>
            <button className={`icon-btn ${readAlong ? "active" : ""}`} title="Read-along: dim words not yet spoken" onClick={() => setReadAlong(!readAlong)}><Type /></button>
            <button className={`icon-btn ${showConf ? "active" : ""}`} title="Underline low-confidence words" onClick={() => setShowConf(!showConf)}><AlertCircle /></button>
            <button className={`icon-btn ${loopSeg ? "active" : ""}`} title="Loop current segment" onClick={() => setLoopSeg(!loopSeg)}><Repeat /></button>
            <span className="ctl-sep" />
            <select className="select sm" style={{ width: 72 }} value={rate} onChange={(e) => setRate(Number(e.target.value))} title="Speed ([ / ])">
              {RATES.map((r) => <option key={r} value={r}>{r}×</option>)}
            </select>
            <button className="icon-btn" onClick={() => setMuted(!muted)} title="Mute">{muted || volume === 0 ? <VolumeX /> : <Volume2 />}</button>
            <input type="range" className="range vol" min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={(e) => { setVolume(Number(e.target.value)); setMuted(false); }} />
          </div>
        </div>
      </div>

      {/* Body */}
      <div className={`ed-body ${panel ? "" : "panel-closed"}`}>
        <div className="transcript-wrap" ref={wrapRef} onWheel={() => (userScrollAt.current = Date.now())}
          onPointerDown={(e) => { if (e.target === e.currentTarget) userScrollAt.current = Date.now(); }} onClick={onTranscriptClick}>
          <div className="tr-tools" onClick={(e) => e.stopPropagation()}>
            <div className="search-box">
              <div className="input-icon"><Search />
                <input ref={searchRef} className="input sm" placeholder="Search transcript (Ctrl+F)" value={query}
                  onFocus={() => setShowSearch(true)} onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      if (!navigated.current) { navigated.current = true; gotoMatch(matchIdx); } else gotoMatch(matchIdx + (e.shiftKey ? -1 : 1));
                    }
                    if (e.key === "Escape") { setQuery(""); e.currentTarget.blur(); }
                  }} />
              </div>
              {query && <>
                <span className="search-count">{matches.length ? `${matchIdx + 1} / ${matches.length}` : "0 results"}</span>
                <button className="icon-btn sm" onClick={() => gotoMatch(matchIdx - 1)} disabled={!matches.length}><ChevronUp /></button>
                <button className="icon-btn sm" onClick={() => gotoMatch(matchIdx + 1)} disabled={!matches.length}><ChevronDown /></button>
                <button className="icon-btn sm" onClick={() => setQuery("")}><X /></button>
              </>}
            </div>
            {editing && query && <>
              <input className="input sm" style={{ width: 160 }} placeholder="Replace with…" value={replaceText} onChange={(e) => setReplaceText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && doReplaceAll()} />
              <button className="btn sm" onClick={doReplaceAll}><Replace />Replace all</button>
            </>}
            <div className="grow" />
            {editing ? <span className="badge accent"><Pencil />Edit mode · click a word to change it</span>
              : <span className="muted" style={{ fontSize: 11.5 }}>Click any word to play from there</span>}
          </div>

          <Transcript segments={segments} order={order} names={names} editing={editing} lowThreshold={lowThreshold}
            showConfidence={showConf} readAlong={readAlong} onSeek={onSeekPlay} onSpeakerChange={onSpeakerChange} />

          {popover && (
            <WordPopover
              key={`${popover.si}-${popover.wi}`} pop={popover} word={segments[popover.si]?.words[popover.wi]}
              onApply={applyPopover} onClose={() => setPopover(null)}
              onPlay={() => { const w = segments[popover.si].words[popover.wi]; seek(w.start, true); }}
              onSplit={() => { commit(splitSegment(segments, popover.si, popover.wi)); setPopover(null); }}
              onMerge={() => { commit(mergeWithPrevious(segments, popover.si)); setPopover(null); }}
              onDelete={() => applyPopover("")}
            />
          )}
        </div>
        {panel && (
          <SidePanel tab={tab} setTab={setTab} job={job} doc={doc} order={order} names={names} setNames={setNames}
            ensureSaved={ensureSaved} version={version} dirty={saveState !== "saved"}
            onRerun={() => setRerun(true)} onRevert={revert} onAddSpeaker={() => { addSpeaker(); setTab("speakers"); }} />
        )}
      </div>
      {rerun && <RerunModal job={job} onClose={() => setRerun(false)} />}
    </div>
  );
}

/** Current time, updated from the media element itself so the editor doesn't re-render while playing. */
function TimeDisplay({ mediaRef, duration }) {
  const [t, setT] = useState(0);
  useEffect(() => {
    const m = mediaRef.current;
    if (!m) return;
    const on = () => setT(m.currentTime);
    ["timeupdate", "seeked", "loadedmetadata"].forEach((ev) => m.addEventListener(ev, on));
    return () => ["timeupdate", "seeked", "loadedmetadata"].forEach((ev) => m.removeEventListener(ev, on));
  }, [mediaRef]);
  return <span className="time"><b>{fmtTime(t, true)}</b> / {fmtTime(duration)}</span>;
}

/** Subtitle-sized slice of a segment around the current word (max ~2 lines). */
function captionChunk(words, cur, maxChars = 84) {
  const chunks = [];
  let chunk = [], len = 0;
  words.forEach((w, i) => {
    if (chunk.length && len + w.word.length + 1 > maxChars) { chunks.push(chunk); chunk = []; len = 0; }
    chunk.push({ w, i });
    len += w.word.length + 1;
  });
  if (chunk.length) chunks.push(chunk);
  return chunks.find((c) => c.some((x) => x.i === cur)) || chunks[0] || [];
}

function WordPopover({ pop, word, onApply, onClose, onPlay, onSplit, onMerge, onDelete }) {
  const [value, setValue] = useState(pop.value);
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  if (!word) return null;
  return (
    <div className="word-editor" style={{ top: pop.top, left: pop.left }} onClick={(e) => e.stopPropagation()}>
      <input ref={ref} className="input" value={value} onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); onApply(value); }
          else if (e.key === "Escape") { e.preventDefault(); onClose(); }
          else if (e.key === "Tab") { e.preventDefault(); onApply(value, e.shiftKey ? -1 : 1); }
        }} />
      <span className="wtime">{fmtTime(word.start, true)}{word.score != null ? ` · ${Math.round(word.score * 100)}%` : ""}</span>
      <button className="icon-btn sm" title="Play word" onClick={onPlay}><Play /></button>
      <button className="icon-btn sm" title="Start a new segment here" disabled={pop.wi === 0} onClick={onSplit}><Scissors /></button>
      <button className="icon-btn sm" title="Merge with previous segment" disabled={pop.si === 0 || pop.wi !== 0} onClick={onMerge}><Merge /></button>
      <button className="icon-btn sm" title="Delete word" onClick={onDelete}><Trash2 /></button>
      <button className="icon-btn sm" title="Apply (Enter)" onClick={() => onApply(value)}><CheckCircle2 /></button>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { FileAudio, FileVideo, Gauge, Rocket, Scale, Trophy, UploadCloud, X, Play, Save, ListOrdered, Ban, ExternalLink, Wand2, RotateCw } from "lucide-react";
import { api } from "../lib/api";
import { toast, useStore } from "../lib/store";
import { estimateSeconds, fileExt, fmtBytes, fmtDuration, MEDIA_ACCEPT, VIDEO_EXT } from "../lib/format";
import ModelPicker from "../components/ModelPicker";
import JobOptions, { pickJobSettings } from "../components/JobOptions";
import { Progress, StatusBadge } from "../components/ui";

const PRESETS = [
  { id: "fast", label: "Fast", icon: Rocket, model: "small.en", sub: "Small · quick drafts" },
  { id: "balanced", label: "Balanced", icon: Scale, model: "distil-large-v3", sub: "Distil large · best for CPU" },
  { id: "accurate", label: "Accurate", icon: Gauge, model: "large-v3-turbo", sub: "Turbo · near-best quality" },
  { id: "max", label: "Maximum", icon: Trophy, model: "large-v3", sub: "Large v3 · slowest" },
];

function probeDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(file.type.startsWith("video") ? "video" : "audio");
    el.preload = "metadata";
    const done = (v) => { URL.revokeObjectURL(url); resolve(v); };
    el.onloadedmetadata = () => done(isFinite(el.duration) ? el.duration : null);
    el.onerror = () => done(null);
    setTimeout(() => done(null), 6000);
    el.src = url;
  });
}

export default function Transcribe() {
  const settings = useStore((s) => s.settings);
  const models = useStore((s) => s.models);
  const system = useStore((s) => s.system);
  const jobs = useStore((s) => s.jobs);
  const saveSettings = useStore((s) => s.saveSettings);
  const [files, setFiles] = useState([]); // {file, duration}
  const [opts, setOpts] = useState(() => pickJobSettings(settings));
  const [over, setOver] = useState(false);
  const [uploading, setUploading] = useState(null);
  const inputRef = useRef(null);

  // Allow dropping files anywhere on the page.
  useEffect(() => {
    const prevent = (e) => { e.preventDefault(); };
    const onDrop = (e) => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer?.files); };
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", onDrop);
    return () => { window.removeEventListener("dragover", prevent); window.removeEventListener("drop", onDrop); };
  }, []);

  async function addFiles(list) {
    const arr = Array.from(list || []).filter((f) => f.size > 0);
    if (!arr.length) return;
    const entries = arr.map((file) => ({ file, duration: null, key: `${file.name}-${file.size}-${file.lastModified}` }));
    setFiles((prev) => {
      const keys = new Set(prev.map((p) => p.key));
      return [...prev, ...entries.filter((e) => !keys.has(e.key))];
    });
    for (const e of entries) {
      const d = await probeDuration(e.file);
      setFiles((prev) => prev.map((p) => (p.key === e.key ? { ...p, duration: d } : p)));
    }
  }

  const model = models.find((m) => m.id === opts.model);
  const totalSeconds = files.reduce((a, f) => a + (f.duration || 0), 0);
  const est = estimateSeconds(model, totalSeconds, system?.cores);
  const preset = PRESETS.find((p) => p.model === opts.model)?.id;
  const queue = useMemo(() => {
    const active = jobs.filter((j) => j.status === "running" || j.status === "queued").sort((a, b) => a.created - b.created);
    const recent = jobs.filter((j) => !["running", "queued"].includes(j.status)).slice(0, 5);
    return { active, recent };
  }, [jobs]);

  async function start() {
    if (!files.length) return inputRef.current?.click();
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
    setUploading(0);
    try {
      const res = await api.upload(files.map((f) => f.file), opts, (p) => setUploading(p));
      toast(`${res.jobs.length} file${res.jobs.length > 1 ? "s" : ""} added to the queue`, "success");
      res.jobs.forEach((j) => useStore.getState().upsertJob(j));
      setFiles([]);
      if (res.jobs.length === 1) location.hash = `#/job/${res.jobs[0].id}`;
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setUploading(null);
    }
  }

  async function saveDefaults() {
    await saveSettings(opts);
    toast("Saved as your default settings", "success");
  }

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Transcribe</h1>
          <div className="sub">Word-level transcripts, fully offline on your PC{system ? ` · ${system.cpu}` : ""}</div>
        </div>
      </div>

      <div className="tx-grid">
        <div className="col" style={{ gap: 14 }}>
          {/* Drop zone */}
          <div
            className={`drop ${over ? "over" : ""} ${files.length ? "compact" : ""}`}
            onClick={() => inputRef.current?.click()}
            onDragEnter={() => setOver(true)} onDragLeave={() => setOver(false)}
            role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
          >
            <div className="drop-icon"><UploadCloud /></div>
            <div>
              <h3>{files.length ? "Add more files" : "Drop audio or video files here"}</h3>
              <p>MP3, WAV, M4A, FLAC, OGG, MP4, MKV, MOV, WEBM and more · or click to browse</p>
            </div>
            <input ref={inputRef} type="file" multiple accept={MEDIA_ACCEPT} hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
          </div>

          {files.length > 0 && (
            <div className="file-list">
              {files.map((f) => {
                const isVideo = VIDEO_EXT.includes(fileExt(f.file.name)) || f.file.type.startsWith("video");
                return (
                  <div key={f.key} className="file-row">
                    <div className="f-icon">{isVideo ? <FileVideo /> : <FileAudio />}</div>
                    <div className="grow">
                      <div className="f-name ellipsis">{f.file.name}</div>
                      <div className="f-meta">{fmtBytes(f.file.size)} · {f.duration ? fmtDuration(f.duration) : "length unknown"}
                        {f.duration && model ? ` · ~${fmtDuration(estimateSeconds(model, f.duration, system?.cores))} to process` : ""}</div>
                    </div>
                    <button className="icon-btn sm" onClick={() => setFiles(files.filter((x) => x.key !== f.key))} aria-label="Remove"><X /></button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Model */}
          <div className="card">
            <div className="card-head"><Wand2 className="h-icon" /><h3 className="grow">Model</h3>
              <a className="btn ghost sm" href="#/models">Manage models</a></div>
            <div className="card-body col" style={{ gap: 12 }}>
              <div className="presets">
                {PRESETS.map((p) => (
                  <button key={p.id} type="button" className={`preset ${preset === p.id ? "on" : ""}`} onClick={() => setOpts({ ...opts, model: p.model })}>
                    <div className="p-top"><p.icon />{p.label}</div>
                    <div className="p-sub">{p.sub}</div>
                  </button>
                ))}
              </div>
              <ModelPicker models={models} value={opts.model} onChange={(id) => setOpts({ ...opts, model: id })} audioSeconds={totalSeconds} cores={system?.cores} />
              {model && !model.downloaded && (
                <div className="callout"><span>{model.label} will be downloaded on first use ({model.size_mb >= 1000 ? `${(model.size_mb / 1024).toFixed(1)} GB` : `${model.size_mb} MB`}). After that it works offline.</span></div>
              )}
            </div>
          </div>

          {/* Options */}
          <div className="card">
            <div className="card-head"><ListOrdered className="h-icon" /><h3 className="grow">Options</h3>
              <button className="btn ghost sm" onClick={saveDefaults} title="Use these settings by default"><Save />Save as default</button></div>
            <div className="card-body"><JobOptions value={opts} onChange={setOpts} /></div>
          </div>

          <div className="start-bar">
            <div className="est grow">
              {files.length ? (
                <>
                  <b>{files.length} file{files.length > 1 ? "s" : ""}{totalSeconds ? ` · ${fmtDuration(totalSeconds)} of audio` : ""}</b>
                  <small>{est ? `Estimated processing: ~${fmtDuration(est)} with ${model?.label}` : model?.label}{opts.diarize ? " + speaker detection" : ""}</small>
                </>
              ) : (
                <><b>No files selected</b><small>Add audio or video to start</small></>
              )}
            </div>
            {uploading != null && <div style={{ width: 140 }}><Progress value={uploading * 100} /><small className="muted">Uploading {Math.round(uploading * 100)}%</small></div>}
            <button className="btn primary lg" onClick={start} disabled={uploading != null}>
              <Play />{files.length ? `Transcribe${files.length > 1 ? ` ${files.length} files` : ""}` : "Choose files"}
            </button>
          </div>
        </div>

        {/* Queue */}
        <div className="col" style={{ gap: 14, position: "sticky", top: 22 }}>
          <div className="card">
            <div className="card-head"><ListOrdered className="h-icon" /><h3 className="grow">Queue</h3>
              {queue.active.length > 0 && <span className="badge accent">{queue.active.length} active</span>}</div>
            {queue.active.length === 0 && <div className="card-body muted" style={{ fontSize: 12.5 }}>Nothing running. Files you add appear here with live progress.</div>}
            {queue.active.map((j) => <QueueItem key={j.id} job={j} />)}
          </div>
          {queue.recent.length > 0 && (
            <div className="card">
              <div className="card-head"><h3 className="grow">Recent</h3><a className="btn ghost sm" href="#/library">View all</a></div>
              {queue.recent.map((j) => (
                <a key={j.id} href={`#/job/${j.id}`} className="queue-item" style={{ display: "block", color: "inherit" }}>
                  <div className="q-top"><span className="q-name ellipsis grow">{j.name}</span><StatusBadge status={j.status} /></div>
                  <div className="q-meta"><span>{j.model} · {fmtDuration(j.duration)}</span><span>{j.words ? `${j.words} words` : ""}</span></div>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const STEPS = ["audio", "model", "transcribe", "align", "diarize", "finalize"];

export function QueueItem({ job }) {
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    if (job.status !== "running") return;
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, [job.status]);
  const elapsed = job.started ? now - job.started : 0;
  const p = job.progress || 0;
  const eta = p > 12 && elapsed > 5 ? (elapsed * (100 - p)) / p : null;
  const steps = STEPS.filter((s) => s !== "diarize" || job.settings?.diarize);
  const idx = steps.indexOf(job.stage);

  async function cancel(e) {
    e.preventDefault();
    await api.post(`/api/jobs/${job.id}/cancel`).catch((err) => toast(err.message, "error"));
  }
  return (
    <a href={`#/job/${job.id}`} className="queue-item" style={{ display: "block", color: "inherit" }}>
      <div className="q-top">
        {job.status === "running" ? <span className="spinner" /> : null}
        <span className="q-name ellipsis grow" title={job.name}>{job.name}</span>
        <button className="icon-btn sm" title="Cancel" onClick={cancel}><Ban /></button>
      </div>
      {job.status === "running" ? (
        <>
          <div className="stage-steps">{steps.map((s, i) => <span key={s} className={i < idx ? "done" : i === idx ? "now" : ""} title={s} />)}</div>
          <Progress value={p} />
          <div className="q-meta">
            <span>{job.stage_label || "Starting"} · {Math.round(p)}%</span>
            <span>{fmtDuration(elapsed)}{eta ? ` · ~${fmtDuration(eta)} left` : ""}</span>
          </div>
        </>
      ) : (
        <div className="q-meta"><span>Waiting in queue</span><span>{job.model}</span></div>
      )}
    </a>
  );
}

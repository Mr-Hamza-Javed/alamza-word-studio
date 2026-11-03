import { useEffect, useMemo, useState } from "react";
import { Copy, Download, FolderDown, Info, Users, FileOutput, RotateCcw, RotateCw, FolderOpen, AlertTriangle, Plus } from "lucide-react";
import { api, downloadBlob } from "../../lib/api";
import { toast, useStore } from "../../lib/store";
import { fmtDate, fmtDuration, speakerColor, speakerLabel } from "../../lib/format";
import { Field, NumberInput, Progress, Toggle, confirmDialog } from "../../components/ui";
import { speakerStats } from "./model";

export default function SidePanel({ tab, setTab, job, doc, order, names, setNames, ensureSaved, onRerun, onRevert, onAddSpeaker, version, dirty }) {
  return (
    <aside className="side-panel">
      <div className="tabs">
        <button className={tab === "export" ? "on" : ""} onClick={() => setTab("export")}><FileOutput />Export</button>
        <button className={tab === "speakers" ? "on" : ""} onClick={() => setTab("speakers")}><Users />Speakers</button>
        <button className={tab === "info" ? "on" : ""} onClick={() => setTab("info")}><Info />Info</button>
      </div>
      {tab === "export" && <ExportTab job={job} ensureSaved={ensureSaved} hasSpeakers={order.length > 0} version={version} dirty={dirty} />}
      {tab === "speakers" && <SpeakersTab doc={doc} order={order} names={names} setNames={setNames} onAddSpeaker={onAddSpeaker} />}
      {tab === "info" && <InfoTab job={job} doc={doc} order={order} onRerun={onRerun} onRevert={onRevert} />}
    </aside>
  );
}

function ExportTab({ job, ensureSaved, hasSpeakers, version, dirty }) {
  const settings = useStore((s) => s.settings);
  const formats = useStore((s) => s.formats);
  const [sel, setSel] = useState(() => settings?.export_formats || ["json", "txt", "srt"]);
  const [opts, setOpts] = useState(() => ({
    max_chars_per_line: settings.max_chars_per_line, max_lines: settings.max_lines, max_cue_duration: settings.max_cue_duration,
    split_on_speaker: settings.split_on_speaker, include_speaker_labels: settings.include_speaker_labels, txt_timestamps: settings.txt_timestamps,
  }));
  const [previewFmt, setPreviewFmt] = useState("srt");
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const qs = useMemo(() => new URLSearchParams(Object.entries(opts).map(([k, v]) => [k, String(v)])).toString(), [opts]);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const txt = await api.get(`/api/jobs/${job.id}/export/${previewFmt}?inline=1&${qs}`);
        if (alive) setPreview(typeof txt === "string" ? txt.slice(0, 6000) : JSON.stringify(txt, null, 2).slice(0, 6000));
      } catch (e) { if (alive) setPreview(`Preview unavailable: ${e.message}`); }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [previewFmt, qs, job.id, version]);

  const set = (k) => (v) => setOpts((o) => ({ ...o, [k]: v }));
  const toggle = (f) => setSel((s) => (s.includes(f) ? s.filter((x) => x !== f) : [...s, f]));

  async function download() {
    if (!sel.length) return toast("Choose at least one format", "error");
    setBusy(true);
    try {
      await ensureSaved();
      if (sel.length === 1) {
        const res = await api.raw("GET", `/api/jobs/${job.id}/export/${sel[0]}?${qs}`);
        await downloadBlob(res, `transcript.${sel[0]}`);
      } else {
        const res = await api.raw("POST", `/api/jobs/${job.id}/export-zip`, { formats: sel, options: opts });
        await downloadBlob(res, "transcript.zip");
      }
    } catch (e) { toast(e.message, "error"); } finally { setBusy(false); }
  }
  async function saveToFolder() {
    setBusy(true);
    try {
      await ensureSaved();
      const r = await api.post(`/api/jobs/${job.id}/save-exports`, { formats: sel, options: opts });
      toast(`Saved ${r.files.length} file${r.files.length > 1 ? "s" : ""} to ${r.folder}`, "success");
    } catch (e) { toast(e.message, "error"); } finally { setBusy(false); }
  }
  async function copyText() {
    await ensureSaved();
    const txt = await api.get(`/api/jobs/${job.id}/export/txt?inline=1&${qs}`);
    await navigator.clipboard.writeText(txt);
    toast("Transcript copied to clipboard", "success", { duration: 1800 });
  }

  return (
    <div className="panel-body">
      <div>
        <div className="section-title">Formats</div>
        <div className="fmt-grid">
          {Object.entries(formats).map(([k, label]) => (
            <label key={k} className={`fmt ${sel.includes(k) ? "on" : ""}`} title={label}>
              <input type="checkbox" checked={sel.includes(k)} onChange={() => toggle(k)} />
              <span className="ellipsis">{label.replace(/ \(.*\)/, "")}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="row">
        <button className="btn primary grow" disabled={busy} onClick={download}><Download />Download{sel.length > 1 ? ` (${sel.length})` : ""}</button>
        <button className="btn" disabled={busy} onClick={saveToFolder} title="Save to output folder"><FolderDown /></button>
        <button className="btn" onClick={copyText} title="Copy plain text"><Copy /></button>
      </div>

      <div>
        <div className="section-title">Subtitle layout</div>
        <div className="grid-3" style={{ gap: 8 }}>
          <Field label="Chars/line"><NumberInput className="sm" value={opts.max_chars_per_line} min={10} max={120} onChange={(v) => v && set("max_chars_per_line")(v)} /></Field>
          <Field label="Lines"><NumberInput className="sm" value={opts.max_lines} min={1} max={4} onChange={(v) => v && set("max_lines")(v)} /></Field>
          <Field label="Max sec"><NumberInput className="sm" value={opts.max_cue_duration} min={1} max={20} step={0.5} onChange={(v) => v && set("max_cue_duration")(v)} /></Field>
        </div>
        <div className="col" style={{ marginTop: 10, gap: 8 }}>
          {hasSpeakers && <Toggle checked={opts.include_speaker_labels} onChange={set("include_speaker_labels")} label="Speaker names" />}
          {hasSpeakers && <Toggle checked={opts.split_on_speaker} onChange={set("split_on_speaker")} label="Split on speaker change" />}
          <Toggle checked={opts.txt_timestamps} onChange={set("txt_timestamps")} label="Timestamps in TXT" />
        </div>
      </div>

      <div>
        <div className="row" style={{ marginBottom: 6 }}>
          <div className="section-title grow" style={{ margin: 0 }}>Preview</div>
          <select className="select sm" style={{ width: 150 }} value={previewFmt} onChange={(e) => setPreviewFmt(e.target.value)}>
            {Object.entries(formats).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        {dirty && <div className="muted" style={{ fontSize: 11.5, marginBottom: 4 }}>Showing last saved version. Downloads save your edits first.</div>}
        <pre className="preview-box">{preview || "…"}</pre>
      </div>
    </div>
  );
}

function SpeakersTab({ doc, order, names, setNames, onAddSpeaker }) {
  const { stats, total } = useMemo(() => speakerStats(doc.segments), [doc.segments]);
  if (!order.length) {
    return (
      <div className="panel-body">
        <div className="empty" style={{ padding: "30px 10px" }}><Users /><h3>No speakers</h3>
          <p style={{ fontSize: 12.5 }}>Turn on <b>Speaker detection</b> when transcribing, or add speakers and assign them in edit mode.</p>
          <button className="btn" onClick={onAddSpeaker}><Plus />Add speaker</button>
        </div>
      </div>
    );
  }
  return (
    <div className="panel-body">
      <div className="section-title">Rename speakers</div>
      {order.map((spk) => {
        const st = stats[spk] || { time: 0, words: 0 };
        const pct = total ? (st.time / total) * 100 : 0;
        return (
          <div key={spk} className="spk-row">
            <span className="swatch" style={{ background: speakerColor(spk, order) }} />
            <input className="input" value={names[spk] ?? ""} placeholder={speakerLabel(spk)} onChange={(e) => setNames({ ...names, [spk]: e.target.value })} />
            <span className="muted mono" style={{ fontSize: 11 }}>{Math.round(pct)}%</span>
            <div className="spk-stat"><Progress value={pct} /><span>{fmtDuration(st.time)} · {st.words} words</span></div>
          </div>
        );
      })}
      <button className="btn sm" onClick={onAddSpeaker}><Plus />Add speaker</button>
      <div className="callout"><Info /><span>Names are used in the transcript and in all exports. Press <kbd>E</kbd> to edit and reassign segments.</span></div>
    </div>
  );
}

function InfoTab({ job, doc, order, onRerun, onRevert }) {
  const words = doc.segments.reduce((a, s) => a + s.words.length, 0);
  const scored = doc.segments.flatMap((s) => s.words).filter((w) => w.score != null);
  const conf = scored.length ? scored.reduce((a, w) => a + w.score, 0) / scored.length : null;
  const dur = doc.duration || job.duration || 0;
  const wpm = dur ? Math.round(words / (dur / 60)) : 0;
  const elapsed = job.elapsed || 0;
  const speed = elapsed && dur ? dur / elapsed : null;
  const s = job.settings || {};
  return (
    <div className="panel-body">
      <div className="stat-tiles">
        <div className="stat-tile"><small>Duration</small><b>{fmtDuration(dur)}</b></div>
        <div className="stat-tile"><small>Words</small><b>{words.toLocaleString()}</b></div>
        <div className="stat-tile"><small>Confidence</small><b>{conf != null ? `${Math.round(conf * 100)}%` : "–"}</b></div>
        <div className="stat-tile"><small>Pace</small><b>{wpm} wpm</b></div>
        <div className="stat-tile"><small>Processed in</small><b>{fmtDuration(elapsed)}</b></div>
        <div className="stat-tile"><small>Speed</small><b>{speed ? `${speed.toFixed(1)}× real-time` : "–"}</b></div>
      </div>
      {doc.warnings?.length > 0 && (
        <div className="warn-list">{doc.warnings.map((w, i) => <div key={i} className="callout warn"><AlertTriangle /><span>{w.split("\n")[0].slice(0, 300)}</span></div>)}</div>
      )}
      <dl className="kv">
        <dt>Model</dt><dd className="mono">{doc.model}</dd>
        <dt>Language</dt><dd>{doc.language}</dd>
        <dt>Word timing</dt><dd>{doc.aligned ? (s.align_model === "large" ? "Precise" : "Standard") : "Segment level only"}</dd>
        <dt>Speakers</dt><dd>{order.length || (s.diarize ? "None found" : "Off")}</dd>
        <dt>Precision</dt><dd>{s.compute_type} · batch {s.batch_size}</dd>
        <dt>Created</dt><dd>{fmtDate(job.created)}</dd>
        {job.edited && <><dt>Edited</dt><dd>Yes</dd></>}
      </dl>
      <div className="col" style={{ gap: 6 }}>
        <button className="btn" onClick={onRerun}><RotateCw />Re-run with other settings</button>
        <button className="btn" onClick={() => api.post(`/api/jobs/${job.id}/reveal`)}><FolderOpen />Show source file</button>
        {job.edited && <button className="btn danger" onClick={async () => {
          if (await confirmDialog({ title: "Revert all edits?", message: "Restores the original transcript from the model. Your edits will be lost.", danger: true, confirmLabel: "Revert" })) onRevert();
        }}><RotateCcw />Revert to original</button>}
      </div>
    </div>
  );
}

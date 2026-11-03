import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, FileAudio, FolderOpen, MoreHorizontal, RotateCw, Search, Trash2, Download, Library as LibIcon, Ban, ExternalLink } from "lucide-react";
import { api, downloadBlob } from "../lib/api";
import { toast, useStore } from "../lib/store";
import { fmtDate, fmtDuration } from "../lib/format";
import { confirmDialog, Menu, Progress, Segmented, StatusBadge } from "../components/ui";
import RerunModal from "../components/RerunModal";

const FILTERS = [
  { value: "all", label: "All" }, { value: "done", label: "Done" }, { value: "active", label: "In progress" },
  { value: "error", label: "Failed" },
];

export default function Library() {
  const jobs = useStore((s) => s.jobs);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState({ key: "created", dir: -1 });
  const [selected, setSelected] = useState(new Set());
  const [rerun, setRerun] = useState(null);

  const rows = useMemo(() => {
    let r = jobs;
    if (filter === "done") r = r.filter((j) => j.status === "done");
    else if (filter === "active") r = r.filter((j) => j.status === "running" || j.status === "queued");
    else if (filter === "error") r = r.filter((j) => j.status === "error" || j.status === "cancelled");
    if (q.trim()) {
      const s = q.toLowerCase();
      r = r.filter((j) => j.name.toLowerCase().includes(s) || (j.model || "").includes(s));
    }
    return [...r].sort((a, b) => {
      const va = a[sort.key] ?? 0, vb = b[sort.key] ?? 0;
      return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * sort.dir;
    });
  }, [jobs, q, filter, sort]);

  const totals = useMemo(() => {
    const done = jobs.filter((j) => j.status === "done");
    return { count: done.length, audio: done.reduce((a, j) => a + (j.duration || 0), 0), words: done.reduce((a, j) => a + (j.words || 0), 0) };
  }, [jobs]);

  const th = (key, label, style) => (
    <th className="sortable" style={style} onClick={() => setSort((s) => ({ key, dir: s.key === key ? -s.dir : -1 }))}>
      <span className="row" style={{ gap: 4 }}>{label}{sort.key === key && (sort.dir < 0 ? <ArrowDown style={{ width: 12 }} /> : <ArrowUp style={{ width: 12 }} />)}</span>
    </th>
  );

  async function del(ids) {
    const ok = await confirmDialog({ title: `Delete ${ids.length > 1 ? `${ids.length} transcripts` : "transcript"}?`, message: "The transcript, uploaded media and edits will be removed. Exported files in your output folder are kept.", danger: true, confirmLabel: "Delete" });
    if (!ok) return;
    for (const id of ids) await api.del(`/api/jobs/${id}`).catch((e) => toast(e.message, "error"));
    setSelected(new Set());
    toast("Deleted", "success");
  }

  const toggleSel = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allSel = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Library</h1>
          <div className="sub">{totals.count} transcripts · {fmtDuration(totals.audio)} of audio · {totals.words.toLocaleString()} words</div>
        </div>
        <button className="btn" onClick={() => api.post("/api/open-output")}><FolderOpen />Output folder</button>
        <a className="btn primary" href="#/transcribe"><FileAudio />New transcript</a>
      </div>

      <div className="toolbar">
        <div className="input-icon" style={{ width: 280 }}><Search /><input className="input" placeholder="Search by name or model…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <Segmented value={filter} onChange={setFilter} options={FILTERS} />
        <div className="grow" />
        {selected.size > 0 && <>
          <span className="muted" style={{ fontSize: 12.5 }}>{selected.size} selected</span>
          <button className="btn danger sm" onClick={() => del([...selected])}><Trash2 />Delete</button>
        </>}
      </div>

      <div className="card table-wrap">
        {rows.length === 0 ? (
          <div className="empty"><LibIcon /><h3>{jobs.length ? "No matches" : "No transcripts yet"}</h3>
            <p>{jobs.length ? "Try another search or filter." : "Transcribe your first file to see it here."}</p>
            {!jobs.length && <a className="btn primary" href="#/transcribe">Start transcribing</a>}</div>
        ) : (
          <table className="table">
            <thead><tr>
              <th style={{ width: 34 }}><input type="checkbox" checked={allSel} onChange={() => setSelected(allSel ? new Set() : new Set(rows.map((r) => r.id)))} /></th>
              {th("name", "Name")}
              {th("duration", "Length", { width: 80 })}
              {th("model", "Model", { width: 140 })}
              {th("words", "Words", { width: 80 })}
              {th("created", "Created", { width: 150 })}
              {th("status", "Status", { width: 130 })}
              <th style={{ width: 110 }} />
            </tr></thead>
            <tbody>
              {rows.map((j) => (
                <tr key={j.id} className={selected.has(j.id) ? "selected" : ""} onClick={() => (location.hash = `#/job/${j.id}`)}>
                  <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selected.has(j.id)} onChange={() => toggleSel(j.id)} /></td>
                  <td><div className="t-name ellipsis" title={j.name}>{j.name}</div>
                    {j.status === "running" && <div style={{ marginTop: 5, maxWidth: 260 }}><Progress value={j.progress} /></div>}
                    {j.status === "error" && <div className="ellipsis" style={{ color: "var(--danger)", fontSize: 11.5, maxWidth: 380 }} title={j.error}>{j.error}</div>}
                  </td>
                  <td>{fmtDuration(j.duration)}</td>
                  <td className="mono" style={{ fontSize: 11.5 }}>{j.model}{j.settings?.diarize ? " · spk" : ""}</td>
                  <td>{j.words ? j.words.toLocaleString() : "–"}</td>
                  <td>{fmtDate(j.created)}</td>
                  <td><StatusBadge status={j.status} />{j.edited && <span className="badge success" style={{ marginLeft: 4 }}>Edited</span>}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="t-actions">
                      {j.status === "done" && <button className="icon-btn sm" title="Download TXT + SRT + JSON" onClick={async () => {
                        const res = await api.raw("POST", `/api/jobs/${j.id}/export-zip`, { formats: useStore.getState().settings?.export_formats || ["json", "txt", "srt"] });
                        downloadBlob(res, "transcript.zip");
                      }}><Download /></button>}
                      <Menu trigger={({ toggle }) => <button className="icon-btn sm" onClick={toggle}><MoreHorizontal /></button>}>
                        <button onClick={() => (location.hash = `#/job/${j.id}`)}><ExternalLink />Open</button>
                        {(j.status === "running" || j.status === "queued") ? (
                          <button onClick={() => api.post(`/api/jobs/${j.id}/cancel`)}><Ban />Cancel</button>
                        ) : (
                          <button onClick={() => setRerun(j)}><RotateCw />Re-run with other settings</button>
                        )}
                        <button onClick={() => api.post(`/api/jobs/${j.id}/reveal`)}><FolderOpen />Show source file</button>
                        <hr />
                        <button className="danger" onClick={() => del([j.id])}><Trash2 />Delete</button>
                      </Menu>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {rerun && <RerunModal job={rerun} onClose={() => setRerun(null)} />}
    </div>
  );
}

import { useMemo, useState } from "react";
import { CheckCircle2, Download, HardDrive, Star, Trash2, Cpu, MemoryStick, Info, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import { toast, useStore } from "../lib/store";
import { fmtBytes, fmtDuration, estimateSeconds } from "../lib/format";
import { confirmDialog, Progress, Segmented } from "../components/ui";

export default function Models() {
  const models = useStore((s) => s.models);
  const system = useStore((s) => s.system);
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const [filter, setFilter] = useState("all");

  const list = useMemo(() => {
    if (filter === "installed") return models.filter((m) => m.downloaded);
    if (filter === "english") return models.filter((m) => m.english_only);
    if (filter === "multi") return models.filter((m) => !m.english_only);
    return models;
  }, [models, filter]);
  const used = models.reduce((a, m) => a + (m.disk_bytes || 0), 0);
  const ramGb = system ? system.ram_total / 1024 ** 3 : 0;

  async function download(m) {
    await api.post(`/api/models/${m.id}/download`).catch((e) => toast(e.message, "error"));
    useStore.getState().refreshModels();
    toast(`Downloading ${m.label}…`, "info");
  }
  async function remove(m) {
    const ok = await confirmDialog({ title: `Delete ${m.label}?`, message: `Frees ${fmtBytes(m.disk_bytes)}. You can download it again any time.`, danger: true, confirmLabel: "Delete" });
    if (!ok) return;
    await api.del(`/api/models/${m.id}`);
    useStore.getState().refreshModels();
    toast(`${m.label} deleted`, "success");
  }

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow"><h1>Models</h1><div className="sub">Download once, then everything runs offline.</div></div>
        <span className="chip"><HardDrive />{fmtBytes(used)} used</span>
        <button className="btn" onClick={() => api.post("/api/unload-models").then(() => toast("Models unloaded from memory", "success"))}><MemoryStick />Free memory</button>
      </div>

      {system && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-body row wrap" style={{ gap: 18 }}>
            <div className="row" style={{ gap: 10 }}><div className="drop-icon" style={{ width: 38, height: 38, borderRadius: 11, background: "var(--grad)", color: "#fff", display: "grid", placeItems: "center" }}><Cpu style={{ width: 18 }} /></div>
              <div><b>{system.cpu}</b><div className="muted" style={{ fontSize: 12 }}>{system.cores} cores · {system.threads} threads · {ramGb.toFixed(0)} GB RAM · CPU mode (int8)</div></div></div>
            <div className="grow" />
            <div className="callout" style={{ maxWidth: 520 }}><Info /><span>For English on this PC, <b>Distil Large v3</b> gives the best speed/accuracy. Use <b>Large v3 Turbo</b> when accuracy matters most or for other languages.</span></div>
          </div>
        </div>
      )}

      <div className="toolbar">
        <Segmented value={filter} onChange={setFilter} options={[
          { value: "all", label: "All" }, { value: "installed", label: "Installed" }, { value: "english", label: "English only" }, { value: "multi", label: "Multilingual" },
        ]} />
      </div>

      <div className="model-cards">
        {list.map((m) => {
          const dl = m.download?.state === "downloading";
          const isDefault = settings?.model === m.id;
          const hour = estimateSeconds(m, 3600, system?.cores);
          return (
            <div key={m.id} className={`card mcard ${m.recommended ? "rec" : ""}`}>
              <div className="m-title">
                <b className="grow ellipsis">{m.label}</b>
                {m.recommended && <span className="badge grad"><Star />Recommended</span>}
                {m.id === "large-v3-turbo" && <span className="badge accent"><Sparkles />Pro</span>}
                {m.downloaded && <span className="badge success"><CheckCircle2 />Installed</span>}
              </div>
              <div className="mono muted" style={{ fontSize: 11 }}>{m.id} · {m.params} params · {m.english_only ? "English only" : "Multilingual"}</div>
              {m.note && <div style={{ fontSize: 12.5, color: "var(--text-2)" }}>{m.note}</div>}
              <div className="stats">
                <div className="stat"><small>Download</small><b>{m.size_mb >= 1000 ? `${(m.size_mb / 1024).toFixed(1)} GB` : `${m.size_mb} MB`}</b></div>
                <div className="stat"><small>RAM</small><b>~{m.ram_gb} GB</b></div>
                <div className="stat"><small>1h audio</small><b>~{fmtDuration(hour)}</b></div>
              </div>
              <div className="meterline"><span>Speed</span><Progress value={m.speed * 10} /></div>
              <div className="meterline"><span>Accuracy</span><Progress value={m.accuracy * 10} /></div>
              {m.download?.state === "error" && <div style={{ color: "var(--danger)", fontSize: 12 }}>{m.download.error}</div>}
              <div className="row" style={{ marginTop: 2 }}>
                {m.downloaded ? (
                  <>
                    <button className="btn sm" disabled={isDefault} onClick={() => saveSettings({ model: m.id }).then(() => toast(`${m.label} is now the default`, "success"))}>
                      {isDefault ? <><CheckCircle2 />Default</> : "Set as default"}</button>
                    <span className="muted grow" style={{ fontSize: 11.5, textAlign: "right" }}>{fmtBytes(m.disk_bytes)}</span>
                    <button className="icon-btn sm" title="Delete" onClick={() => remove(m)}><Trash2 /></button>
                  </>
                ) : dl ? (
                  <div className="grow"><Progress indeterminate /><small className="muted">Downloading… this can take a few minutes</small></div>
                ) : (
                  <button className="btn sm" onClick={() => download(m)}><Download />Download</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

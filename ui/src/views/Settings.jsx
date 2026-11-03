import { useEffect, useState } from "react";
import { AppWindow, FileOutput, Gauge, Info, KeyRound, Mic, Power, Users, FolderOpen, Copy, CheckCircle2, ExternalLink, Wifi } from "lucide-react";
import { api } from "../lib/api";
import { toast, useStore } from "../lib/store";
import { applyTheme } from "../lib/theme";
import { fmtBytes } from "../lib/format";
import { confirmDialog, NumberInput, Segmented, Select, Toggle } from "../components/ui";

const SECTIONS = [
  ["general", "General", AppWindow], ["transcription", "Transcription", Mic], ["speakers", "Speakers", Users],
  ["export", "Subtitles & export", FileOutput], ["performance", "Performance", Gauge], ["about", "About", Info],
];

function Row({ label, hint, children, full }) {
  return (
    <div className={`set-row ${full ? "full" : ""}`}>
      <div className="s-label"><b>{label}</b>{hint && <small>{hint}</small>}</div>
      {children && <div>{children}</div>}
    </div>
  );
}

export default function Settings({ section }) {
  const settings = useStore((s) => s.settings);
  const system = useStore((s) => s.system);
  const models = useStore((s) => s.models);
  const languages = useStore((s) => s.languages);
  const alignModels = useStore((s) => s.alignModels);
  const formats = useStore((s) => s.formats);
  const saveSettings = useStore((s) => s.saveSettings);
  const [active, setActive] = useState(section || "general");
  const [token, setToken] = useState("");
  const [outDir, setOutDir] = useState(settings?.output_dir || "");

  useEffect(() => { if (section) setActive(section); }, [section]);
  if (!settings) return null;

  const save = async (patch, msg) => {
    try {
      await saveSettings(patch);
      toast(msg || "Settings saved", "success", { duration: 1600 });
    } catch (e) {
      toast(e.message, "error");
    }
  };
  const set = (k) => (v) => save({ [k]: v });
  const urls = system?.urls || {};
  const copy = (t) => navigator.clipboard?.writeText(t).then(() => toast("Link copied", "success", { duration: 1500 }));

  return (
    <div className="page">
      <div className="page-head"><div className="grow"><h1>Settings</h1><div className="sub">Changes save automatically.</div></div></div>
      <div className="settings-grid">
        <nav className="settings-nav">
          {SECTIONS.map(([id, label, Icon]) => (
            <button key={id} className={active === id ? "on" : ""} onClick={() => { setActive(id); history.replaceState(null, "", `#/settings/${id}`); }}><Icon />{label}</button>
          ))}
        </nav>

        <div className="card"><div className="card-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
          {active === "general" && <>
            <Row label="App link" hint="Open this in any browser on this PC. The tray icon near the clock also opens it.">
              <div className="col" style={{ gap: 6 }}>
                <div className="row"><input className="input sm mono" readOnly value={urls.local || location.origin} /><button className="icon-btn" onClick={() => copy(urls.local || location.origin)}><Copy /></button></div>
                {urls.lan && <div className="row"><input className="input sm mono" readOnly value={urls.lan} /><button className="icon-btn" onClick={() => copy(urls.lan)}><Copy /></button></div>}
              </div>
            </Row>
            <Row label="Theme"><Segmented value={settings.theme} onChange={(v) => { applyTheme(v); set("theme")(v); }} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} /></Row>
            <Row label="Start with Windows" hint="Runs quietly in the system tray when you sign in.">
              <Toggle checked={settings.start_with_windows} onChange={set("start_with_windows")} disabled={!system?.autostart_supported} />
            </Row>
            {system?.autostart_supported && (
              <Row label="Start Menu & Desktop shortcuts" hint={system.shortcuts ? "Shortcuts exist on this PC. Recreate them if you moved the folder." : "Not added on this PC yet (e.g. after copying the folder from another PC)."}>
                <button className="btn" onClick={() => api.post("/api/shortcuts").then(() => { toast("Shortcuts added", "success"); useStore.getState().loadAll(); }).catch((e) => toast(e.message, "error"))}>
                  {system.shortcuts ? "Recreate shortcuts" : "Add shortcuts"}</button>
              </Row>
            )}
            <Row label="Open browser when the app starts" hint="Turn off if you prefer to open it from the tray icon."><Toggle checked={settings.open_browser_on_start} onChange={set("open_browser_on_start")} /></Row>
            <Row label="Notify when a transcript is ready" hint="Tray and browser notifications.">
              <Toggle checked={settings.notify_on_finish} onChange={(v) => { if (v && "Notification" in window) Notification.requestPermission(); set("notify_on_finish")(v); }} />
            </Row>
            <Row label={<span className="row" style={{ gap: 6 }}><Wifi style={{ width: 15 }} />Allow access from other devices</span>} hint="Lets phones/PCs on your Wi-Fi open the app. Takes effect after restarting the app.">
              <Toggle checked={settings.lan_access} onChange={set("lan_access")} />
            </Row>
            <Row label="Port" hint="Takes effect after restarting the app.">
              <NumberInput value={settings.port} min={1024} max={65000} onChange={(v) => v && set("port")(v)} />
            </Row>
          </>}

          {active === "transcription" && <>
            <Row label="Default model">
              <Select value={settings.model} onChange={set("model")} options={models.map((m) => ({ value: m.id, label: `${m.label}${m.downloaded ? "" : " (not downloaded)"}` }))} />
            </Row>
            <Row label="Default language"><Select value={settings.language} onChange={set("language")} options={Object.entries(languages).map(([k, v]) => ({ value: k, label: v }))} /></Row>
            <Row label="Word timing precision"><Select value={settings.align_model} onChange={set("align_model")} options={Object.entries(alignModels).map(([k, v]) => ({ value: k, label: v }))} /></Row>
            <Row label="Default context prompt" hint="Names and terms you use often.">
              <input className="input" defaultValue={settings.initial_prompt} onBlur={(e) => e.target.value !== settings.initial_prompt && set("initial_prompt")(e.target.value)} placeholder="Optional" />
            </Row>
            <Row label="Low-confidence highlight" hint="Words below this score are underlined in the editor so you can check them.">
              <div className="row"><input type="range" className="range" min={0} max={0.95} step={0.05} value={settings.low_confidence_threshold}
                onChange={(e) => useStore.setState({ settings: { ...settings, low_confidence_threshold: Number(e.target.value) } })}
                onMouseUp={(e) => set("low_confidence_threshold")(Number(e.target.value))} /><span className="mono" style={{ width: 40 }}>{Math.round(settings.low_confidence_threshold * 100)}%</span></div>
            </Row>
          </>}

          {active === "speakers" && <>
            <Row label="Speaker detection by default" hint="Off by default. You can switch it on for each file."><Toggle checked={settings.diarize} onChange={set("diarize")} /></Row>
            <Row label={<span className="row" style={{ gap: 6 }}><KeyRound style={{ width: 15 }} />Hugging Face token</span>} hint={settings.hf_token_set ? "A token is saved. Paste a new one to replace it." : "Required for speaker detection. Stored only on this PC."}>
              <div className="row">
                <input className="input" type="password" placeholder={settings.hf_token_set ? "••••••••••••  (saved)" : "hf_…"} value={token} onChange={(e) => setToken(e.target.value)} />
                <button className="btn" disabled={!token.trim()} onClick={() => save({ hf_token: token.trim() }, "Token saved").then(() => setToken(""))}>Save</button>
                {settings.hf_token_set && <button className="btn ghost danger" onClick={() => save({ clear_hf_token: true }, "Token removed")}>Remove</button>}
              </div>
            </Row>
            <Row full label="How to get a free token (one time, 2 minutes)">
              <div className="callout"><Info /><div>
                <ol>
                  <li>Create a free account at <a href="https://huggingface.co/join" target="_blank" rel="noreferrer">huggingface.co <ExternalLink style={{ width: 11 }} /></a></li>
                  <li>Open <a href="https://huggingface.co/pyannote/speaker-diarization-community-1" target="_blank" rel="noreferrer">pyannote/speaker-diarization-community-1</a> and click <b>Agree and access repository</b>.</li>
                  <li>Go to <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noreferrer">Settings → Access Tokens</a>, create a <b>Read</b> token and paste it above.</li>
                </ol>
              </div></div>
            </Row>
          </>}

          {active === "export" && <>
            <Row label="Auto-export when finished" hint="Off by default. When on, saves the formats below to the exports folder automatically (the Download button always works)."><Toggle checked={settings.auto_export} onChange={set("auto_export")} /></Row>
            <Row label="Formats" full>
              <div className="fmt-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
                {Object.entries(formats).map(([k, label]) => {
                  const on = settings.export_formats.includes(k);
                  return (
                    <label key={k} className={`fmt ${on ? "on" : ""}`}>
                      <input type="checkbox" checked={on} onChange={() => set("export_formats")(on ? settings.export_formats.filter((f) => f !== k) : [...settings.export_formats, k])} />{label}
                    </label>
                  );
                })}
              </div>
            </Row>
            <Row label="Output folder" hint={`Current: ${settings.output_dir_resolved}`}>
              <div className="row">
                <input className="input" placeholder="Default: exports folder inside the app" value={outDir} onChange={(e) => setOutDir(e.target.value)} onBlur={() => outDir !== settings.output_dir && set("output_dir")(outDir)} />
                <button className="icon-btn" title="Open folder" onClick={() => api.post("/api/open-output")}><FolderOpen /></button>
              </div>
            </Row>
            <Row label="Max characters per subtitle line"><NumberInput value={settings.max_chars_per_line} min={10} max={120} onChange={(v) => v && set("max_chars_per_line")(v)} /></Row>
            <Row label="Max lines per subtitle"><NumberInput value={settings.max_lines} min={1} max={4} onChange={(v) => v && set("max_lines")(v)} /></Row>
            <Row label="Max subtitle duration (seconds)"><NumberInput value={settings.max_cue_duration} min={1} max={20} step={0.5} onChange={(v) => v && set("max_cue_duration")(v)} /></Row>
            <Row label="New subtitle when the speaker changes"><Toggle checked={settings.split_on_speaker} onChange={set("split_on_speaker")} /></Row>
            <Row label="Include speaker names"><Toggle checked={settings.include_speaker_labels} onChange={set("include_speaker_labels")} /></Row>
            <Row label="Timestamps in TXT"><Toggle checked={settings.txt_timestamps} onChange={set("txt_timestamps")} /></Row>
          </>}

          {active === "performance" && <>
            <Row label="CPU threads" hint={`0 = auto (uses ${system?.cores} physical cores)`}><NumberInput value={settings.threads} min={0} max={system?.threads || 64} onChange={(v) => v !== "" && set("threads")(v)} /></Row>
            <Row label="Batch size" hint="4 is a good default on laptops. Higher is faster but uses more RAM."><NumberInput value={settings.batch_size} min={1} max={32} onChange={(v) => v && set("batch_size")(v)} /></Row>
            <Row label="Precision"><Select value={settings.compute_type} onChange={set("compute_type")} options={[{ value: "int8", label: "int8 (fastest, recommended)" }, { value: "int8_float32", label: "int8 / float32" }, { value: "float32", label: "float32 (slowest)" }]} /></Row>
            <Row label="Keep models in memory" hint="Faster when transcribing several files. Uses 2–7 GB RAM while loaded."><Toggle checked={settings.keep_models_loaded} onChange={set("keep_models_loaded")} /></Row>
            <Row label="Free memory now" hint="Unloads models until the next transcription."><button className="btn" onClick={() => api.post("/api/unload-models").then(() => toast("Models unloaded", "success"))}>Unload models</button></Row>
            <div className="callout" style={{ margin: "12px 0" }}><Info /><span>Tip: on a laptop, plug in the charger and set Windows power mode to <b>Best performance</b>. Battery mode can make transcription 2–3× slower.</span></div>
          </>}

          {active === "about" && <>
            <div className="row" style={{ padding: "16px 0", gap: 14 }}>
              <img src="./icon.svg" width="54" height="54" alt="" />
              <div><h2 style={{ fontSize: 18 }}>Alamza Word Studio</h2><div className="muted">Version {system?.version} · powered by WhisperX</div></div>
            </div>
            <Row label="Computer">{system && <span>{system.cpu}<br /><small className="muted">{system.cores} cores · {fmtBytes(system.ram_total)} RAM · {system.os}</small></span>}</Row>
            <Row label="FFmpeg">{system?.ffmpeg ? <span className="badge success"><CheckCircle2 />Available</span> : <span className="badge danger">Missing (re-run install.bat)</span>}</Row>
            <Row label="App folder (portable)" hint="Everything lives here: app, models, transcripts and settings. Copy this folder to use it on another PC.">
              <div className="row"><input className="input sm mono" readOnly value={system?.app_dir || ""} />
                <button className="icon-btn" title="Open folder" onClick={() => api.post("/api/open-app-folder")}><FolderOpen /></button></div>
            </Row>
            <Row label="API" hint="Automate transcription from scripts."><a className="btn" href="/api/docs" target="_blank" rel="noreferrer"><ExternalLink />Open API docs</a></Row>
            <Row label="Quit the app" hint="Stops the server and removes the tray icon. Start it again from the Start Menu.">
              <button className="btn danger" onClick={async () => {
                if (await confirmDialog({ title: "Quit Alamza Word Studio?", message: "Running transcriptions will stop.", danger: true, confirmLabel: "Quit" })) {
                  await api.post("/api/quit").catch(() => {});
                  toast("App closed. You can close this tab.", "info", { duration: 10000 });
                }
              }}><Power />Quit</button>
            </Row>
          </>}
        </div></div>
      </div>
    </div>
  );
}

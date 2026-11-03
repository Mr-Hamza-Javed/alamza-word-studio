import { Cpu, Keyboard, Library, Mic, Moon, Settings, Sun, Monitor } from "lucide-react";
import { useStore } from "../lib/store";
import { applyTheme } from "../lib/theme";
import { Progress } from "./ui";

export default function Sidebar({ route, onHelp }) {
  const jobs = useStore((s) => s.jobs);
  const live = useStore((s) => s.live);
  const connected = useStore((s) => s.connected);
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);

  const active = jobs.filter((j) => j.status === "running" || j.status === "queued").sort((a, b) => a.created - b.created);
  const done = jobs.filter((j) => j.status === "done").length;
  const worker = live?.worker?.state || "stopped";
  const busy = worker === "busy" || worker === "starting";
  const theme = settings?.theme || "system";
  const nextTheme = { system: "light", light: "dark", dark: "system" }[theme];
  const ThemeIcon = { system: Monitor, light: Sun, dark: Moon }[theme];

  const nav = [
    ["transcribe", "Transcribe", Mic],
    ["library", "Library", Library, done || ""],
    ["models", "Models", Cpu],
    ["settings", "Settings", Settings],
  ];
  const isActive = (n) => route.name === n || (n === "library" && route.name === "job");

  return (
    <aside className="sidebar">
      <a className="brand" href="#/transcribe">
        <img src="./icon.svg" alt="" width="30" height="30" />
        <div className="brand-text"><strong>Alamza</strong><span>Word Studio</span></div>
      </a>
      <nav className="nav">
        {nav.map(([id, label, Icon, badge]) => (
          <a key={id} href={`#/${id}`} className={isActive(id) ? "active" : ""}>
            <Icon /><span>{label}</span>{badge ? <b className="badge">{badge}</b> : null}
          </a>
        ))}
      </nav>

      <div className="side-section">
        {active.length > 0 && <div className="side-title">Queue · {active.length}</div>}
        {active.slice(0, 6).map((j) => (
          <a key={j.id} href={`#/job/${j.id}`} className="side-job">
            <div className="name ellipsis" title={j.name}>{j.name}</div>
            {j.status === "running" ? (
              <>
                <div style={{ marginTop: 6 }}><Progress value={j.progress} /></div>
                <div className="meta"><span>{j.stage_label || "Working"}</span><span>{Math.round(j.progress || 0)}%</span></div>
              </>
            ) : <div className="meta"><span>Waiting</span><span>{j.model}</span></div>}
          </a>
        ))}
      </div>

      <div className="side-foot">
        <div className="meter" title="CPU usage"><span>CPU</span><div className="bar"><i style={{ width: `${live.cpu_percent || 0}%` }} /></div><em>{Math.round(live.cpu_percent || 0)}%</em></div>
        <div className="meter" title="Memory usage"><span>RAM</span><div className="bar"><i style={{ width: `${live.ram_percent || 0}%` }} /></div><em>{Math.round(live.ram_percent || 0)}%</em></div>
        <div className="side-meta">
          <span className={`dot ${!connected ? "" : busy ? "busy" : "ok"}`} />
          <span className="grow ellipsis">{!connected ? "Offline" : busy ? "Engine working" : worker === "idle" ? "Engine ready" : "Engine idle"}</span>
          <button className="icon-btn sm" title={`Theme: ${theme}`} onClick={() => { applyTheme(nextTheme); saveSettings({ theme: nextTheme }); }}><ThemeIcon /></button>
          <button className="icon-btn sm" title="Keyboard shortcuts (?)" onClick={onHelp}><Keyboard /></button>
        </div>
      </div>
    </aside>
  );
}

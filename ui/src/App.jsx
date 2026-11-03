import { useEffect, useState } from "react";
import { useStore, connectEvents } from "./lib/store";
import { applyTheme } from "./lib/theme";
import Sidebar from "./components/Sidebar";
import { ConfirmHost, Modal, Toasts } from "./components/ui";
import Transcribe from "./views/Transcribe";
import Library from "./views/Library";
import Models from "./views/Models";
import Settings from "./views/Settings";
import Editor from "./views/editor/Editor";
import { Keyboard, Loader2, WifiOff } from "lucide-react";

function useHashRoute() {
  const parse = () => {
    const h = location.hash.replace(/^#\/?/, "");
    const [name, ...rest] = h.split("/");
    return { name: name || "transcribe", arg: rest.join("/") || null };
  };
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export default function App() {
  const route = useHashRoute();
  const loaded = useStore((s) => s.jobsLoaded);
  const connected = useStore((s) => s.connected);
  const jobs = useStore((s) => s.jobs);
  const [error, setError] = useState(null);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    useStore.getState().loadAll().then(() => {
      const t = useStore.getState().settings?.theme;
      if (t) applyTheme(t);
    }).catch((e) => setError(e.message));
    connectEvents();
  }, []);

  // Files dropped on any other page: don't let the browser open them, send them to Transcribe instead.
  useEffect(() => {
    const onTranscribe = () => ["", "#", "#/"].includes(location.hash) || location.hash.startsWith("#/transcribe");
    const over = (e) => e.preventDefault();
    const drop = (e) => {
      e.preventDefault();
      if (onTranscribe()) return; // the Transcribe page handles it
      const files = Array.from(e.dataTransfer?.files || []);
      if (!files.length) return;
      useStore.setState({ pendingFiles: files });
      location.hash = "#/transcribe";
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragover", over); window.removeEventListener("drop", drop); };
  }, []);

  // Global shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest("input, textarea, select, [contenteditable=true]")) return;
      if (e.key === "?") { e.preventDefault(); setHelp((h) => !h); }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (route.name === "job") return; // editor has its own keys
      if (e.key === "1") location.hash = "#/transcribe";
      if (e.key === "2") location.hash = "#/library";
      if (e.key === "3") location.hash = "#/models";
      if (e.key === "4") location.hash = "#/settings";
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [route.name]);

  // Show overall progress in the browser tab title.
  useEffect(() => {
    const running = jobs.find((j) => j.status === "running");
    document.title = running ? `(${Math.round(running.progress || 0)}%) Alamza Word Studio` : "Alamza Word Studio";
  }, [jobs]);

  let view;
  if (!loaded) {
    view = (
      <div className="processing">
        {error ? (
          <div className="card"><WifiOff style={{ width: 34, height: 34, color: "var(--danger)" }} />
            <h3 style={{ marginTop: 10 }}>Can't reach the app server</h3>
            <p className="muted">Start Alamza Word Studio from the Start Menu or tray icon, then reload this page.</p>
            <button className="btn primary" onClick={() => location.reload()}>Reload</button>
          </div>
        ) : <Loader2 style={{ width: 28, height: 28, color: "var(--accent)", animation: "spin 1s linear infinite" }} />}
      </div>
    );
  } else if (route.name === "job" && route.arg) view = <Editor key={route.arg} id={route.arg} />;
  else if (route.name === "library") view = <Library />;
  else if (route.name === "models") view = <Models />;
  else if (route.name === "settings") view = <Settings section={route.arg} />;
  else view = <Transcribe />;

  return (
    <div className="app">
      <Sidebar route={route} onHelp={() => setHelp(true)} />
      <main className="main">
        {!connected && loaded && (
          <div className="callout warn" style={{ borderRadius: 0, justifyContent: "center" }}>
            <WifiOff /> Connection to the app server lost. Reconnecting…
          </div>
        )}
        {view}
      </main>
      <Toasts />
      <ConfirmHost />
      {help && <ShortcutsModal onClose={() => setHelp(false)} />}
    </div>
  );
}

function ShortcutsModal({ onClose }) {
  const rows = [
    ["Play / pause", "Space or K"], ["Back 5s / forward 5s", "J / L"], ["Back 1s / forward 1s", "← / →"],
    ["Previous / next segment", "↑ / ↓"], ["Speed down / up", "[ / ]"], ["Search transcript", "Ctrl F"],
    ["Toggle edit mode", "E"], ["Save edits", "Ctrl S"], ["Undo / redo", "Ctrl Z / Ctrl Y"],
    ["Follow playback", "F"], ["Toggle side panel", "P"], ["Export", "Ctrl E"],
    ["Go to Transcribe / Library", "1 / 2"], ["Go to Models / Settings", "3 / 4"], ["This help", "?"],
  ];
  return (
    <Modal title="Keyboard shortcuts" icon={<Keyboard style={{ width: 18, color: "var(--accent)" }} />} onClose={onClose} wide>
      <div className="shortcuts">
        {rows.map(([a, b]) => (
          <div key={a}><span>{a}</span><span>{b.split(" / ").map((k, i) => <span key={i}>{i > 0 && " / "}{k.split(" ").map((x) => <kbd key={x} style={{ marginLeft: 3 }}>{x}</kbd>)}</span>)}</span></div>
        ))}
      </div>
    </Modal>
  );
}

import { create } from "zustand";
import { api } from "./api";

let toastId = 0;

export const useStore = create((set, get) => ({
  jobs: [],
  jobsLoaded: false,
  system: null,
  live: { cpu_percent: 0, ram_percent: 0, worker: { state: "stopped" } },
  connected: false,
  settings: null,
  models: [],
  languages: {},
  alignModels: {},
  formats: {},
  toasts: [],

  async loadAll() {
    const [jobs, system, settings, models] = await Promise.all([
      api.get("/api/jobs"), api.get("/api/system"), api.get("/api/settings"), api.get("/api/models"),
    ]);
    set({
      jobs: jobs.jobs, jobsLoaded: true, system, settings,
      models: models.models, languages: models.languages, alignModels: models.align_models, formats: models.formats,
      live: { cpu_percent: system.cpu_percent, ram_percent: system.ram_percent, worker: system.worker },
    });
  },
  async refreshJobs() {
    const r = await api.get("/api/jobs");
    set({ jobs: r.jobs });
  },
  async refreshModels() {
    const r = await api.get("/api/models");
    set({ models: r.models });
  },
  async saveSettings(patch) {
    const s = await api.put("/api/settings", patch);
    set({ settings: s });
    return s;
  },
  upsertJob(job) {
    const jobs = get().jobs.slice();
    const i = jobs.findIndex((j) => j.id === job.id);
    if (i >= 0) jobs[i] = job;
    else jobs.unshift(job);
    set({ jobs });
  },
  removeJob(id) {
    set({ jobs: get().jobs.filter((j) => j.id !== id) });
  },
  toast(message, kind = "info", opts = {}) {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, message, kind, ...opts }] });
    setTimeout(() => get().dismissToast(id), opts.duration || (kind === "error" ? 7000 : 3500));
    return id;
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

export const toast = (...a) => useStore.getState().toast(...a);

/** Live updates from the server (Server-Sent Events) with automatic reconnect. */
export function connectEvents() {
  let es;
  let retry;
  const open = () => {
    es = new EventSource("/api/events");
    es.onopen = () => {
      const wasDown = !useStore.getState().connected;
      useStore.setState({ connected: true });
      if (wasDown) useStore.getState().refreshJobs().catch(() => {});
    };
    es.onerror = () => {
      useStore.setState({ connected: false });
      es.close();
      clearTimeout(retry);
      retry = setTimeout(open, 2500);
    };
    es.onmessage = (e) => {
      let evt;
      try { evt = JSON.parse(e.data); } catch { return; }
      const st = useStore.getState();
      if (evt.type === "job") st.upsertJob(evt.job);
      else if (evt.type === "deleted") st.removeJob(evt.id);
      else if (evt.type === "system") useStore.setState({ live: evt });
      else if (evt.type === "model") st.refreshModels().catch(() => {});
      else if (evt.type === "finished") onFinished(evt);
    };
  };
  open();
}

function onFinished(evt) {
  const ok = evt.status === "done";
  toast(`${ok ? "Finished" : "Failed"}: ${evt.name}`, ok ? "success" : "error", {
    action: ok ? { label: "Open", href: `#/job/${evt.id}` } : null,
  });
  const s = useStore.getState().settings;
  if (s?.notify_on_finish && document.hidden && "Notification" in window && Notification.permission === "granted") {
    try {
      const n = new Notification(ok ? "Transcript ready" : "Transcription failed", { body: evt.name, icon: "./icon.svg" });
      n.onclick = () => { window.focus(); location.hash = `#/job/${evt.id}`; };
    } catch {}
  }
}

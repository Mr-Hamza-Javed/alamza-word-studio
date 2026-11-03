export function fmtTime(t, withMs = false) {
  if (t == null || isNaN(t)) return "--:--";
  t = Math.max(0, t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const pad = (n) => String(n).padStart(2, "0");
  let out = h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  if (withMs) out += "." + String(Math.floor((t % 1) * 1000)).padStart(3, "0").slice(0, 2);
  return out;
}

export function fmtDuration(sec) {
  if (sec == null || isNaN(sec)) return "–";
  sec = Math.round(sec);
  if (sec < 60) return `${sec}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${m}m`;
  return s ? `${m}m ${s}s` : `${m}m`;
}

export function fmtBytes(b) {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i >= 2 ? 1 : 0)} ${u[i]}`;
}

export function fmtDate(ts) {
  if (!ts) return "–";
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `Today ${time}`;
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" }) + ` ${time}`;
}

export const SPEAKER_COLORS = ["#6366f1", "#f59e0b", "#10b981", "#ec4899", "#0ea5e9", "#ef4444", "#8b5cf6", "#14b8a6", "#f97316", "#84cc16"];

export function speakerColor(spk, order) {
  if (!spk) return "var(--muted)";
  const i = order ? order.indexOf(spk) : parseInt(String(spk).replace(/\D/g, "") || "0", 10);
  return SPEAKER_COLORS[(i < 0 ? 0 : i) % SPEAKER_COLORS.length];
}

export function speakerLabel(spk, names) {
  if (!spk) return "";
  if (names && names[spk]) return names[spk];
  const n = parseInt(String(spk).split("_").pop(), 10);
  return isNaN(n) ? spk : `Speaker ${n + 1}`;
}

/** Estimated processing time in seconds for a given model on this machine. */
export function estimateSeconds(model, audioSeconds, cores) {
  if (!model || !audioSeconds) return null;
  const scale = Math.pow(10 / Math.max(1, cores || 8), 0.75);
  return audioSeconds * (model.rtf_cpu || 1) * scale + 8;
}

export const fileExt = (name) => (name.match(/\.[^.]+$/)?.[0] || "").toLowerCase();
export const VIDEO_EXT = [".mp4", ".m4v", ".mov", ".webm"];
export const MEDIA_ACCEPT = "audio/*,video/*,.mp3,.wav,.m4a,.flac,.ogg,.opus,.aac,.wma,.mp4,.mkv,.mov,.avi,.webm,.m4v,.wmv,.flv,.amr,.3gp";

/** Copy text. Falls back to a hidden textarea where the Clipboard API isn't available (http on LAN). */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) return await navigator.clipboard.writeText(text);
  } catch {}
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0;left:-9999px";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

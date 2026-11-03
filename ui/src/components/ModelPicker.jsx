import { CheckCircle2, Download, Sparkles, Star } from "lucide-react";
import { Bars } from "./ui";
import { fmtDuration, estimateSeconds } from "../lib/format";

export default function ModelPicker({ models, value, onChange, audioSeconds, cores, englishOnly }) {
  const list = englishOnly === false ? models.filter((m) => !m.english_only) : models;
  return (
    <div className="model-list" role="radiogroup">
      <div className="model-head">
        <span /><span>Model</span><span>Size</span><span>Speed</span><span>Accuracy</span><span>{audioSeconds ? "Est. time" : "RAM"}</span>
      </div>
      {list.map((m) => {
        const est = audioSeconds ? estimateSeconds(m, audioSeconds, cores) : null;
        return (
          <div
            key={m.id} role="radio" aria-checked={value === m.id} tabIndex={0}
            className={`model-row ${value === m.id ? "on" : ""}`}
            onClick={() => onChange(m.id)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onChange(m.id))}
            title={m.note || ""}
          >
            <span className="radio" />
            <div style={{ minWidth: 0 }}>
              <div className="m-name">
                <span className="ellipsis">{m.label}</span>
                {m.recommended && <span className="badge grad"><Star />Best for CPU</span>}
                {m.id === "large-v3-turbo" && <span className="badge accent"><Sparkles />Pro</span>}
              </div>
              <div className="m-sub mono">{m.id} · {m.params}{m.english_only ? " · English only" : " · 99 languages"}</div>
            </div>
            <div className="m-cell">
              {m.size_mb >= 1000 ? `${(m.size_mb / 1024).toFixed(1)} GB` : `${m.size_mb} MB`}
              <small style={{ display: "flex", alignItems: "center", gap: 3, color: m.downloaded ? "var(--success)" : undefined }}>
                {m.downloaded ? <><CheckCircle2 style={{ width: 10, height: 10 }} />Ready</> : <><Download style={{ width: 10, height: 10 }} />Download</>}
              </small>
            </div>
            <div className="m-cell"><Bars value={m.speed} /></div>
            <div className="m-cell"><Bars value={m.accuracy} /></div>
            <div className="m-cell">{est ? `~${fmtDuration(est)}` : `${m.ram_gb} GB`}</div>
          </div>
        );
      })}
    </div>
  );
}

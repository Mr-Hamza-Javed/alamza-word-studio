import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { AlertTriangle, CheckCircle2, Info, X, XCircle, Loader2, Clock, Ban } from "lucide-react";
import { useStore } from "../lib/store";

export function Toggle({ checked, onChange, label, hint, disabled }) {
  return (
    <label className="toggle" style={disabled ? { opacity: 0.55, pointerEvents: "none" } : undefined}>
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <span className="track" />
      {(label || hint) && (
        <span className="t-text">
          {label && <b>{label}</b>}
          {hint && <small>{hint}</small>}
        </span>
      )}
    </label>
  );
}

export function Field({ label, hint, children, extra }) {
  return (
    <div className="field">
      {label && <label>{label}{extra}</label>}
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Select({ value, onChange, options, className = "", ...rest }) {
  return (
    <select className={`select ${className}`} value={value ?? ""} onChange={(e) => onChange(e.target.value)} {...rest}>
      {options.map((o) =>
        typeof o === "string" ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>
      )}
    </select>
  );
}

export function NumberInput({ value, onChange, min, max, step = 1, className = "", ...rest }) {
  return (
    <input
      type="number" className={`input ${className}`} value={value ?? ""} min={min} max={max} step={step}
      onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} {...rest}
    />
  );
}

export function Segmented({ value, onChange, options }) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)} title={o.title}>
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  );
}

export function Progress({ value, indeterminate }) {
  return (
    <div className={`progress ${indeterminate ? "indeterminate" : ""}`}>
      <i style={{ width: `${Math.max(0, Math.min(100, value || 0))}%` }} />
    </div>
  );
}

export function Bars({ value, max = 10, count = 5 }) {
  const on = Math.round((value / max) * count);
  return (
    <span className="bars" aria-label={`${value} of ${max}`}>
      {Array.from({ length: count }, (_, i) => <i key={i} className={i < on ? "on" : ""} style={{ height: 5 + i * 2 }} />)}
    </span>
  );
}

export function StatusBadge({ status }) {
  const map = {
    done: ["success", <CheckCircle2 key="i" />, "Done"],
    running: ["accent", <Loader2 key="i" className="spin-icon" style={{ animation: "spin 1s linear infinite" }} />, "Running"],
    queued: ["", <Clock key="i" />, "Queued"],
    error: ["danger", <XCircle key="i" />, "Failed"],
    cancelled: ["warning", <Ban key="i" />, "Cancelled"],
  };
  const [kind, icon, label] = map[status] || ["", null, status];
  return <span className={`badge ${kind}`}>{icon}{label}</span>;
}

export function Modal({ title, icon, onClose, children, footer, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose?.();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          {icon}
          <h3 className="grow">{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Menu({ trigger, children, align = "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const key = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", close); window.removeEventListener("keydown", key); };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div className="menu" style={align === "left" ? { left: 0, right: "auto" } : undefined} onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  const icons = { success: CheckCircle2, error: XCircle, info: Info, warning: AlertTriangle };
  return (
    <div className="toasts">
      {toasts.map((t) => {
        const I = icons[t.kind] || Info;
        return (
          <div key={t.id} className={`toast ${t.kind}`}>
            <I className="k" />
            <span className="grow">{t.message}</span>
            {t.action && (
              <a className="btn sm" href={t.action.href} onClick={() => dismiss(t.id)}>{t.action.label}</a>
            )}
            <button className="icon-btn sm" onClick={() => dismiss(t.id)} aria-label="Dismiss"><X /></button>
          </div>
        );
      })}
    </div>
  );
}

/* ---- Promise-based confirm dialog ---- */
const useConfirm = create(() => ({ req: null }));

export function confirmDialog(opts) {
  return new Promise((resolve) => useConfirm.setState({ req: { ...opts, resolve } }));
}

export function ConfirmHost() {
  const req = useConfirm((s) => s.req);
  if (!req) return null;
  const done = (v) => { useConfirm.setState({ req: null }); req.resolve(v); };
  return (
    <Modal
      title={req.title || "Are you sure?"}
      icon={req.danger ? <AlertTriangle style={{ color: "var(--danger)", width: 20 }} /> : null}
      onClose={() => done(false)}
      footer={<>
        <button className="btn" onClick={() => done(false)}>Cancel</button>
        <button className={`btn ${req.danger ? "danger" : "primary"}`} autoFocus onClick={() => done(true)}>
          {req.confirmLabel || "Confirm"}
        </button>
      </>}
    >
      <p style={{ margin: 0, color: "var(--text-2)" }}>{req.message}</p>
    </Modal>
  );
}

import { useEffect, useRef, useState } from "react";
import { fmtTime, speakerColor } from "../../lib/format";

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Canvas waveform with playhead, hover time, click-to-seek, speaker lanes and Ctrl+wheel zoom.
 * Redraws itself every animation frame while the media plays.
 */
export default function Waveform({ peaks, duration, mediaRef, segments, order, loop }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const [hover, setHover] = useState(null);
  const view = useRef({ zoom: 1, start: 0 }); // start in seconds
  const [zoomLabel, setZoomLabel] = useState(1);

  useEffect(() => {
    let raf;
    let lastT = -1, lastW = 0, lastZoom = 0, lastStart = -1, lastTheme = "";
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = canvasRef.current, media = mediaRef.current;
      if (!c || !peaks?.length || !duration) return;
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth, h = c.clientHeight;
      const t = media ? media.currentTime : 0;
      const v = view.current;
      const span = duration / v.zoom;
      // Keep playhead in view while zoomed.
      if (v.zoom > 1 && media && !media.paused && (t < v.start || t > v.start + span * 0.85)) {
        v.start = Math.max(0, Math.min(duration - span, t - span * 0.15));
      }
      const theme = document.documentElement.dataset.theme || "";
      if (Math.abs(t - lastT) < 0.01 && w === lastW && v.zoom === lastZoom && v.start === lastStart && theme === lastTheme && !draw.force) return;
      draw.force = false;
      lastT = t; lastW = w; lastZoom = v.zoom; lastStart = v.start; lastTheme = theme;
      if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
      const ctx = c.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const accent = cssVar("--accent") || "#6366f1";
      const base = cssVar("--border-strong") || "#ccc";
      const lane = 5;
      const mid = (h - lane - 4) / 2;
      const barW = 2, gap = 1;
      const n = Math.floor(w / (barW + gap));
      const startT = v.start;
      // Speaker / segment lanes
      if (segments?.length) {
        segments.forEach((s) => {
          const a = ((s.start - startT) / span) * w, b = ((s.end - startT) / span) * w;
          if (b < 0 || a > w) return;
          ctx.fillStyle = s.speaker ? speakerColor(s.speaker, order) : base;
          ctx.globalAlpha = s.speaker ? 0.85 : 0.5;
          ctx.fillRect(a, h - lane, Math.max(1, b - a - 1), lane);
        });
        ctx.globalAlpha = 1;
      }
      if (loop) {
        const a = ((loop.start - startT) / span) * w, b = ((loop.end - startT) / span) * w;
        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.12;
        ctx.fillRect(a, 0, b - a, h - lane);
        ctx.globalAlpha = 1;
      }
      const px = ((t - startT) / span) * w;
      for (let i = 0; i < n; i++) {
        const t0 = startT + (i / n) * span, t1 = startT + ((i + 1) / n) * span;
        const p0 = Math.floor((t0 / duration) * peaks.length), p1 = Math.max(p0 + 1, Math.floor((t1 / duration) * peaks.length));
        let m = 0;
        for (let k = p0; k < p1 && k < peaks.length; k++) if (peaks[k] > m) m = peaks[k];
        const bh = Math.max(1.5, (m / 100) * mid * 0.95);
        const x = i * (barW + gap);
        ctx.fillStyle = x < px ? accent : base;
        ctx.fillRect(x, mid + 2 - bh, barW, bh * 2);
      }
      // Playhead
      ctx.fillStyle = cssVar("--text") || "#000";
      ctx.fillRect(Math.round(px) - 1, 0, 2, h - lane);
    };
    draw.force = true;
    raf = requestAnimationFrame(draw);
    const ro = new ResizeObserver(() => (draw.force = true));
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [peaks, duration, segments, order, loop, mediaRef]);

  const timeAt = (clientX) => {
    const r = wrapRef.current.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const v = view.current;
    return v.start + f * (duration / v.zoom);
  };

  const onWheel = (e) => {
    if (!e.ctrlKey && !e.shiftKey && view.current.zoom === 1) return;
    e.preventDefault();
    const v = view.current;
    if (e.ctrlKey) {
      const at = timeAt(e.clientX);
      const nz = Math.min(200, Math.max(1, v.zoom * (e.deltaY < 0 ? 1.25 : 0.8)));
      const span = duration / nz;
      const f = (at - v.start) / (duration / v.zoom);
      v.zoom = nz;
      v.start = Math.max(0, Math.min(duration - span, at - f * span));
    } else {
      const span = duration / v.zoom;
      v.start = Math.max(0, Math.min(duration - span, v.start + ((e.deltaX || e.deltaY) / 400) * span));
    }
    setZoomLabel(Math.round(v.zoom * 10) / 10);
  };

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  return (
    <div
      ref={wrapRef} className="wave"
      onMouseMove={(e) => setHover({ x: e.clientX - wrapRef.current.getBoundingClientRect().left, t: timeAt(e.clientX) })}
      onMouseLeave={() => setHover(null)}
      onClick={(e) => { const m = mediaRef.current; if (m) m.currentTime = timeAt(e.clientX); }}
      title="Click to seek · Ctrl+scroll to zoom"
    >
      <canvas ref={canvasRef} />
      {hover && <div className="hover-time" style={{ left: hover.x }}>{fmtTime(hover.t, true)}</div>}
      {zoomLabel > 1 && <div className="zoom-hint" onClick={(e) => { e.stopPropagation(); view.current = { zoom: 1, start: 0 }; setZoomLabel(1); }}>{zoomLabel}× · click to reset</div>}
    </div>
  );
}

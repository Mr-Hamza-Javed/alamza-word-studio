import { memo } from "react";
import { fmtTime, speakerColor, speakerLabel } from "../../lib/format";

/**
 * Renders the transcript. Kept pure/memoized: the playback highlight is applied
 * directly to DOM nodes by the editor so typing/playing never re-renders thousands of words.
 */
function Transcript({ segments, order, names, editing, lowThreshold, showConfidence, onSeek, onSpeakerChange, readAlong }) {
  let fi = 0;
  return (
    <div className={`transcript ${editing ? "editing" : ""} ${readAlong ? "dim-future" : ""}`}>
      {segments.map((seg, si) => {
        const first = seg.words[0]?.start ?? seg.start;
        const prevSpk = si > 0 ? segments[si - 1].speaker : undefined;
        const showSpk = seg.speaker && (seg.speaker !== prevSpk || editing);
        return (
          <div key={si} className="seg-block" data-si={si}>
            <div className="seg-gutter">
              <button className="seg-time" onClick={() => onSeek(first)} title="Play from here">{fmtTime(first)}</button>
              {editing ? (
                <select className="select spk-select" value={seg.speaker || ""} onChange={(e) => onSpeakerChange(si, e.target.value)}>
                  <option value="">No speaker</option>
                  {order.map((s) => <option key={s} value={s}>{speakerLabel(s, names)}</option>)}
                  <option value="__new">+ New speaker</option>
                </select>
              ) : showSpk ? (
                <span className="spk" title={speakerLabel(seg.speaker, names)}>
                  <i style={{ background: speakerColor(seg.speaker, order) }} /><span>{speakerLabel(seg.speaker, names)}</span>
                </span>
              ) : null}
            </div>
            <div className="seg-text">
              {seg.words.map((w, wi) => {
                const idx = fi++;
                let cls = "w";
                if (showConfidence && w.score != null && w.score < lowThreshold) cls += " low";
                if (w.edited) cls += " edited";
                return (
                  <span key={wi}>
                    <span className={cls} data-fi={idx} data-si={si} data-wi={wi}
                      title={w.score != null ? `${fmtTime(w.start, true)} · ${Math.round(w.score * 100)}% confidence` : fmtTime(w.start, true)}>
                      {w.word}
                    </span>{" "}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default memo(Transcript);

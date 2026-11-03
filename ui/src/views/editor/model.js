/** Transcript helpers: normalization, flattening, search and edit operations. */

/** Make every segment have a words[] array with numeric start/end (fills gaps). */
export function normalize(result) {
  const segments = (result.segments || []).map((seg) => {
    let words = (seg.words || []).filter((w) => String(w.word || "").trim()).map((w) => ({ ...w, word: String(w.word).trim() }));
    if (!words.length && seg.text) {
      const toks = seg.text.trim().split(/\s+/);
      const s = seg.start ?? 0, e = seg.end ?? s + toks.length * 0.3;
      const step = (e - s) / toks.length;
      words = toks.map((t, i) => ({ word: t, start: s + i * step, end: s + (i + 1) * step, score: null, synthetic: true }));
    }
    return { ...seg, words };
  });
  fillTimings(segments);
  return { ...result, segments, speakers: result.speakers || {} };
}

function fillTimings(segments) {
  const flat = [];
  segments.forEach((seg) => seg.words.forEach((w) => flat.push([w, seg])));
  for (let i = 0; i < flat.length; i++) {
    const [w, seg] = flat[i];
    if (w.start == null || isNaN(w.start)) {
      let prevEnd = null;
      for (let j = i - 1; j >= 0; j--) if (flat[j][0].end != null) { prevEnd = flat[j][0].end; break; }
      let nextStart = null;
      for (let j = i + 1; j < flat.length; j++) if (flat[j][0].start != null) { nextStart = flat[j][0].start; break; }
      const base = prevEnd ?? seg.start ?? 0;
      w.start = base;
      const limit = nextStart ?? seg.end ?? base + 0.4;
      w.end = Math.max(base + 0.05, Math.min(limit, base + 0.6));
      w.interpolated = true;
    } else if (w.end == null || isNaN(w.end)) {
      w.end = w.start + 0.3;
    }
  }
}

/** Flat list used for highlighting & search. */
export function flatten(segments) {
  const out = [];
  segments.forEach((seg, si) => seg.words.forEach((w, wi) => out.push({ si, wi, start: w.start, end: w.end, word: w.word, score: w.score })));
  return out;
}

/** Index of the word being spoken at time t (or -1). */
export function wordAt(flat, t) {
  let lo = 0, hi = flat.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (flat[mid].start <= t + 0.01) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (ans < 0) return -1;
  // Keep highlighting through short pauses between words.
  const w = flat[ans];
  const next = flat[ans + 1];
  if (t <= w.end + 0.15 || (next && t < next.start && next.start - w.end < 0.6)) return ans;
  return -1;
}

export function segmentAt(segments, t) {
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const st = s.words[0]?.start ?? s.start, en = s.words[s.words.length - 1]?.end ?? s.end;
    if (t >= st - 0.05 && t <= en + 0.3) return i;
    if (st > t) return -1;
  }
  return -1;
}

const strip = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}'’-]+/gu, "");

/** Returns arrays of flat indices for each match (phrase search across words). */
export function search(flat, query) {
  const toks = query.trim().toLowerCase().split(/\s+/).map(strip).filter(Boolean);
  if (!toks.length) return [];
  const words = flat.map((w) => strip(w.word));
  const out = [];
  for (let i = 0; i <= words.length - toks.length; i++) {
    let ok = true;
    for (let k = 0; k < toks.length; k++) {
      const w = words[i + k];
      const t = toks[k];
      const match = toks.length === 1 ? w.includes(t) : k === 0 ? w.endsWith(t) : k === toks.length - 1 ? w.startsWith(t) : w === t;
      if (!match) { ok = false; break; }
    }
    if (ok) out.push(Array.from({ length: toks.length }, (_, k) => i + k));
  }
  return out;
}

const clone = (segments) => segments.map((s) => ({ ...s, words: s.words.map((w) => ({ ...w })) }));

export function rebuildText(seg) {
  seg.text = seg.words.map((w) => w.word).join(" ");
  if (seg.words.length) {
    seg.start = seg.words[0].start;
    seg.end = seg.words[seg.words.length - 1].end;
  }
  return seg;
}

export function editWord(segments, si, wi, text) {
  const next = clone(segments);
  const seg = next[si];
  const w = seg.words[wi];
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    seg.words.splice(wi, 1);
  } else if (parts.length === 1) {
    if (w.word !== parts[0]) { w.word = parts[0]; w.edited = true; }
  } else {
    const step = (w.end - w.start) / parts.length;
    const repl = parts.map((p, i) => ({ word: p, start: w.start + i * step, end: w.start + (i + 1) * step, score: w.score, speaker: w.speaker, edited: true }));
    seg.words.splice(wi, 1, ...repl);
  }
  rebuildText(seg);
  return next.filter((s) => s.words.length);
}

export function setSegmentSpeaker(segments, si, speaker) {
  const next = clone(segments);
  const seg = next[si];
  if (speaker) seg.speaker = speaker; else delete seg.speaker;
  seg.words.forEach((w) => { if (speaker) w.speaker = speaker; else delete w.speaker; });
  return next;
}

export function splitSegment(segments, si, wi) {
  if (wi <= 0) return segments;
  const next = clone(segments);
  const seg = next[si];
  const tail = { ...seg, words: seg.words.slice(wi) };
  seg.words = seg.words.slice(0, wi);
  rebuildText(seg);
  rebuildText(tail);
  next.splice(si + 1, 0, tail);
  return next;
}

export function mergeWithPrevious(segments, si) {
  if (si <= 0) return segments;
  const next = clone(segments);
  const prev = next[si - 1];
  prev.words = [...prev.words, ...next[si].words];
  rebuildText(prev);
  next.splice(si, 1);
  return next;
}

export function replaceAll(segments, query, replacement, matchCase) {
  if (!query) return [segments, 0];
  const next = clone(segments);
  let count = 0;
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), matchCase ? "g" : "gi");
  next.forEach((seg) => {
    let changed = false;
    seg.words.forEach((w) => {
      const n = w.word.replace(re, () => { count++; return replacement; });
      if (n !== w.word) { w.word = n; w.edited = true; changed = true; }
    });
    if (changed) { seg.words = seg.words.filter((w) => w.word.trim()); rebuildText(seg); }
  });
  return [next.filter((s) => s.words.length), count];
}

export function speakerOrder(segments) {
  const order = [];
  segments.forEach((s) => s.speaker && !order.includes(s.speaker) && order.push(s.speaker));
  return order;
}

export function speakerStats(segments) {
  const stats = {};
  let total = 0;
  segments.forEach((s) => {
    const k = s.speaker || "";
    const dur = s.words.reduce((a, w) => a + Math.max(0, w.end - w.start), 0);
    stats[k] = stats[k] || { time: 0, words: 0 };
    stats[k].time += dur;
    stats[k].words += s.words.length;
    total += dur;
  });
  return { stats, total };
}

/** Serialize for saving (drop UI-only flags). */
export function toSave(segments) {
  return segments.map((s) => ({
    start: s.start, end: s.end, text: s.text, speaker: s.speaker,
    words: s.words.map((w) => {
      const o = { word: w.word, start: round(w.start), end: round(w.end) };
      if (w.score != null) o.score = w.score;
      if (w.speaker) o.speaker = w.speaker;
      return o;
    }),
  }));
}
const round = (x) => (x == null ? x : Math.round(x * 1000) / 1000);

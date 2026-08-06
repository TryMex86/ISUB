/**
 * Turn ASR output into short, timed subtitle cues.
 *
 * Boundary correctness is handled by TIME, not text heuristics: the caller
 * (app.js) deletes any previously-committed cues inside the region a new
 * overlapped chunk just re-transcribed, then inserts this chunk's cues in
 * their place. That works whether or not the model emits punctuation
 * (Parakeet-style ASR usually does not), unlike guessing "truncation" from
 * missing periods.
 */

const SENTENCE_RE = /[^.!?…]+(?:[.!?…]+|$)/g;

export function splitSentences(text) {
  const raw = (text || "").replace(/\s+/g, " ").trim();
  if (!raw) return [];
  const parts = raw.match(SENTENCE_RE) || [raw];
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Max ~2 lines, ~42 chars each - readable TV-style captions. */
export function formatCaption(text) {
  const words = (text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return "";
  if (words.join(" ").length <= 42) return words.join(" ");

  const lines = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > 42 && line) {
      lines.push(line);
      line = w;
      if (lines.length >= 2) {
        const rest = [w, ...words.slice(words.indexOf(w) + 1)].join(" ");
        lines[1] = `${lines[1] || ""} ${rest}`.trim().slice(0, 48);
        return lines.slice(0, 2).join("\n");
      }
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= 2) return lines.join("\n");
  return `${lines[0]}\n${lines.slice(1).join(" ").slice(0, 48)}`;
}

/** Split a long sentence into reading beats (~6-10 words) for display timing. */
function readingBeats(sentence) {
  const words = sentence.split(/\s+/).filter(Boolean);
  if (words.length <= 12) return [sentence];
  const beats = [];
  for (let i = 0; i < words.length; i += 9) {
    beats.push(words.slice(i, i + 9).join(" "));
  }
  return beats;
}

function proportionalCues(pieces, start, end) {
  const weights = pieces.map((p) => Math.max(p.length, 8));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const span = Math.max(end - start, pieces.length * 1.4);
  let t = start;
  const cues = [];
  for (let i = 0; i < pieces.length; i++) {
    const slice = (weights[i] / total) * span;
    const dur = Math.max(1.4, slice);
    const s = t;
    let e = i === pieces.length - 1 ? end : Math.min(end, t + dur);
    if (e - s < 1.1) e = Math.min(end, s + 1.1);
    cues.push({ start: s, end: e, text: formatCaption(pieces[i]) });
    t = e;
  }
  return cues;
}

/**
 * @param {{ text: string, start: number, end: number, segments?: {start,end,text}[] }} chunk
 * @returns {{ start: number, end: number, text: string }[]}
 */
export function cuesFromChunk(chunk) {
  const start = Number(chunk.start) || 0;
  const end = Math.max(start + 0.5, Number(chunk.end) || start + 1);

  let cues;
  if (Array.isArray(chunk.segments) && chunk.segments.length) {
    cues = chunk.segments
      .map((s) => ({
        start: Number(s.start),
        end: Math.max(Number(s.start) + 0.8, Number(s.end)),
        text: formatCaption(s.text || ""),
      }))
      .filter((c) => c.text);
  } else {
    const sentences = splitSentences(chunk.text || "");
    if (!sentences.length) return [];
    const pieces = [];
    for (const s of sentences) pieces.push(...readingBeats(s));
    cues = proportionalCues(pieces, start, end);
  }

  for (let i = 0; i < cues.length; i++) {
    const nextStart = i + 1 < cues.length ? cues[i + 1].start : end + 0.8;
    const hold = Math.min(nextStart - 0.05, cues[i].end + 0.65);
    cues[i].end = Math.max(cues[i].end, hold);
  }
  return cues;
}

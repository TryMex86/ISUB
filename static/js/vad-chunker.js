/**
 * Chunk audio at the quietest available moment, not just "silence".
 *
 * Continuous talkers (podcasts, YouTube commentary) often never produce a
 * long enough silence for a strict silence-detector to find within a
 * search window - their sentence gaps are commonly 150-500ms. A threshold
 * ("must be silent for 900ms+") then finds nothing and falls back to a raw
 * sample cut at a fixed time, which can land mid-word.
 *
 * Instead: within [MIN_SEC, SOFT_MAX_SEC] after the last cut, find the
 * LOCAL MINIMUM of speech activity (the quietest short window) and cut
 * there. There is always a "least bad" point, even if it is not silent —
 * this reliably lands near real word/sentence gaps.
 *
 * Every cut also carries a few seconds of overlap so app.js can re-transcribe
 * and replace the boundary region if this still landed inside a word.
 */
import fvadFactory from "/static/vendor/fvad/fvad.js";

export const SAMPLE_RATE = 16000;
export const MIN_SEC = 35;
export const SOFT_MAX_SEC = 60;
export const FRAME_MS = 30;
/** Width of the "how quiet is it here" probe window. */
export const QUIET_WINDOW_MS = 300;
export const VAD_MODE = 2;
/**
 * Re-transcribe this much prior audio on every cut. Correctness does not
 * depend on this being exact — app.js replaces committed captions in the
 * overlapped time window with this chunk's fresh output, so even a cut that
 * lands mid-word gets fully repaired once the next chunk arrives.
 */
export const BOUNDARY_OVERLAP_SEC = 8;

export const MAX_SEC = SOFT_MAX_SEC;

let modulePromise = null;

export function prefetchVad() {
  return getModule();
}

async function getModule() {
  if (!modulePromise) {
    modulePromise = fvadFactory({
      locateFile: (path) => `/static/vendor/fvad/${path}`,
    });
  }
  return modulePromise;
}

export async function createVad(mode = VAD_MODE) {
  const M = await getModule();
  const handle = M._fvad_new();
  if (!handle) throw new Error("fvad_new failed");
  if (M._fvad_set_sample_rate(handle, SAMPLE_RATE) !== 0) {
    M._fvad_free(handle);
    throw new Error("fvad sample rate rejected");
  }
  if (M._fvad_set_mode(handle, mode) !== 0) {
    M._fvad_free(handle);
    throw new Error("fvad mode rejected");
  }
  return { M, handle };
}

export function destroyVad(vad) {
  if (vad?.handle) vad.M._fvad_free(vad.handle);
}

export function classifyFrames(pcmInt16, vad) {
  const { M, handle } = vad;
  const frameSamples = (SAMPLE_RATE * FRAME_MS) / 1000;
  const nFrames = Math.floor(pcmInt16.length / frameSamples);
  const flags = new Array(nFrames);
  const bytes = frameSamples * 2;
  const ptr = M._malloc(bytes);
  try {
    for (let f = 0; f < nFrames; f++) {
      const i = f * frameSamples;
      M.HEAP16.set(pcmInt16.subarray(i, i + frameSamples), ptr >> 1);
      flags[f] = M._fvad_process(handle, ptr, frameSamples) === 1 ? 1 : 0;
    }
  } finally {
    M._free(ptr);
  }
  return flags;
}

/** Prefix sums for O(1) window-sum queries. */
function buildPrefix(flags) {
  const prefix = new Float64Array(flags.length + 1);
  for (let i = 0; i < flags.length; i++) prefix[i + 1] = prefix[i] + flags[i];
  return prefix;
}

/**
 * Find the window of `windowFrames` inside [fromI, toI) with the lowest
 * speech-frame sum. Returns { index, sum } or null if the range is too
 * small to hold a window.
 */
function findQuietestWindow(prefix, fromI, toI, windowFrames) {
  const lastStart = toI - windowFrames;
  if (lastStart < fromI) return null;
  let bestIndex = fromI;
  let bestSum = prefix[fromI + windowFrames] - prefix[fromI];
  for (let i = fromI + 1; i <= lastStart; i++) {
    const sum = prefix[i + windowFrames] - prefix[i];
    if (sum < bestSum) {
      bestSum = sum;
      bestIndex = i;
    }
    if (bestSum === 0) break; // can't do better than total silence
  }
  return { index: bestIndex, sum: bestSum };
}

function findCuts(flags, duration, windowFrames) {
  const prefix = buildPrefix(flags);
  const cuts = [];
  const quality = [];
  let chunkStart = 0;
  const frameAt = (sec) =>
    Math.min(flags.length, Math.max(0, Math.round((sec * 1000) / FRAME_MS)));
  const timeAt = (f) => (f * FRAME_MS) / 1000;

  while (chunkStart < duration - 0.05) {
    if (chunkStart + MIN_SEC >= duration) {
      cuts.push(duration);
      quality.push(0);
      break;
    }

    const softEnd = Math.min(chunkStart + SOFT_MAX_SEC, duration);
    const fromI = frameAt(chunkStart + MIN_SEC);
    const toI = frameAt(softEnd);

    const found = findQuietestWindow(prefix, fromI, toI, windowFrames);
    let cut;
    let q = 1;
    if (found) {
      const cutFrame = found.index + Math.floor(windowFrames / 2);
      cut = Math.min(duration, timeAt(cutFrame));
      q = found.sum / windowFrames;
    } else {
      cut = softEnd;
    }

    if (duration - cut < 3) cut = duration;
    if (cut - chunkStart < 10) cut = Math.min(duration, chunkStart + SOFT_MAX_SEC);

    cuts.push(cut);
    quality.push(q);
    chunkStart = cut;
  }

  if (!cuts.length || cuts[cuts.length - 1] < duration - 0.02) {
    cuts.push(duration);
    quality.push(0);
  }
  return { cuts, quality };
}

export async function* chunkByVadStream(pcm, opts = {}) {
  const windowFrames = Math.max(
    1,
    Math.round((opts.quietWindowMs ?? QUIET_WINDOW_MS) / FRAME_MS),
  );
  const overlap = opts.overlapSec ?? BOUNDARY_OVERLAP_SEC;
  const vad = await createVad(opts.mode ?? VAD_MODE);
  let flags;
  try {
    flags = classifyFrames(pcm, vad);
  } finally {
    destroyVad(vad);
  }

  const duration = pcm.length / SAMPLE_RATE;
  const { cuts, quality } = findCuts(flags, duration, windowFrames);
  let start = 0;
  let index = 0;

  for (let ci = 0; ci < cuts.length; ci++) {
    const end = cuts[ci];
    const b = Math.floor(end * SAMPLE_RATE);
    if (b - Math.floor(start * SAMPLE_RATE) < SAMPLE_RATE * 0.5) {
      start = end;
      continue;
    }

    const pcmStart = index === 0 ? start : Math.max(0, start - overlap);
    const pcmA = Math.floor(pcmStart * SAMPLE_RATE);

    yield {
      index,
      startSec: start,
      endSec: end,
      pcmOffset: pcmStart,
      cutQuality: quality[ci], // 0 = landed in true silence, 1 = no quiet spot found
      pcm: pcm.subarray(pcmA, b),
      totalHint: cuts.length,
    };
    index += 1;
    start = end;
  }
}

export async function chunkByVad(pcm, opts = {}) {
  const out = [];
  for await (const c of chunkByVadStream(pcm, opts)) out.push(c);
  return out;
}

export function pcmToWavBlob(pcm, sampleRate = SAMPLE_RATE) {
  const dataLength = pcm.byteLength;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const w = (o, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  w(8, "WAVE");
  w(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  w(36, "data");
  view.setUint32(40, dataLength, true);
  new Uint8Array(buffer, 44).set(new Uint8Array(pcm.buffer, pcm.byteOffset, dataLength));
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Separate audio → mono Int16 PCM @ 16 kHz.
 * Prefer native server ffmpeg for video (much faster than ffmpeg.wasm).
 */
import { SAMPLE_RATE } from "./vad-chunker.js";

function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function downsample(float32, fromRate, toRate) {
  if (fromRate === toRate) return float32;
  const ratio = fromRate / toRate;
  const newLen = Math.floor(float32.length / ratio);
  const result = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, float32.length - 1);
    const t = pos - i0;
    result[i] = float32[i0] * (1 - t) + float32[i1] * t;
  }
  return result;
}

async function decodeWithWebAudio(file) {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    const buf = await file.arrayBuffer();
    const decoded = await ctx.decodeAudioData(buf.slice(0));
    const ch0 = decoded.getChannelData(0);
    let mono;
    if (decoded.numberOfChannels > 1) {
      const ch1 = decoded.getChannelData(1);
      mono = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i++) mono[i] = (ch0[i] + ch1[i]) * 0.5;
    } else {
      mono = ch0;
    }
    const resampled =
      decoded.sampleRate === SAMPLE_RATE
        ? mono
        : downsample(mono, decoded.sampleRate, SAMPLE_RATE);
    return floatTo16BitPCM(resampled);
  } finally {
    await ctx.close();
  }
}

async function extractWithServer(file) {
  const fd = new FormData();
  fd.append("file", file, file.name);
  const res = await fetch("/api/extract", {
    method: "POST",
    body: fd,
    credentials: "include",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Extract failed (${res.status})`);
  }
  return wavBytesToPcm(await res.arrayBuffer());
}

function wavBytesToPcm(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  let offset = 12;
  let dataOffset = -1;
  let dataSize = 0;
  let bits = 16;
  let channels = 1;
  let rate = SAMPLE_RATE;

  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      channels = view.getUint16(offset + 10, true);
      rate = view.getUint32(offset + 12, true);
      bits = view.getUint16(offset + 22, true);
    } else if (id === "data") {
      dataOffset = offset + 8;
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataOffset < 0) throw new Error("Invalid WAV");
  if (bits !== 16) throw new Error("WAV must be 16-bit PCM");

  const frameCount = Math.floor(dataSize / (2 * channels));
  const src = new Int16Array(arrayBuffer, dataOffset, frameCount * channels);

  let pcm;
  if (channels === 1) {
    pcm = src.byteOffset === 0 ? src : new Int16Array(src);
  } else if (channels === 2) {
    pcm = new Int16Array(frameCount);
    for (let i = 0; i < frameCount; i++) {
      pcm[i] = (src[i * 2] + src[i * 2 + 1]) >> 1;
    }
  } else {
    throw new Error("Unsupported channel count");
  }

  if (rate === SAMPLE_RATE) return pcm;
  const f = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
  return floatTo16BitPCM(downsample(f, rate, SAMPLE_RATE));
}

export function isVideoFile(file) {
  const type = file.type || "";
  const name = file.name.toLowerCase();
  return (
    type.startsWith("video/") ||
    /\.(mp4|mkv|webm|mov|avi|m4v)$/.test(name)
  );
}

export function isAudioFile(file) {
  const type = file.type || "";
  const name = file.name.toLowerCase();
  return (
    type.startsWith("audio/") ||
    /\.(wav|mp3|m4a|aac|ogg|flac|opus|wma)$/.test(name)
  );
}

/**
 * @returns {Promise<{ pcm: Int16Array, durationSec: number, source: string }>}
 */
export async function separateAudio(file, onStatus = () => {}) {
  if (isAudioFile(file) && !isVideoFile(file)) {
    onStatus("Decoding audio…");
    const pcm = await decodeWithWebAudio(file);
    return { pcm, durationSec: pcm.length / SAMPLE_RATE, source: "webaudio" };
  }

  // Native ffmpeg on the server is far faster than ffmpeg.wasm in-browser
  onStatus("Extracting audio track…");
  const pcm = await extractWithServer(file);
  return { pcm, durationSec: pcm.length / SAMPLE_RATE, source: "ffmpeg" };
}

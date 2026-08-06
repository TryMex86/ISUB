import { separateAudio, isVideoFile } from "./media.js";
import { chunkByVadStream, pcmToWavBlob, prefetchVad } from "./vad-chunker.js";
import { createPlayerController } from "./player.js";
import { cuesFromChunk } from "./captions.js";

const gate = document.getElementById("gate");
const app = document.getElementById("app");
const captchaImg = document.getElementById("captcha-img");
const captchaFrame = document.getElementById("captcha-frame");
const captchaForm = document.getElementById("captcha-form");
const captchaAnswer = document.getElementById("captcha-answer");
const captchaError = document.getElementById("captcha-error");
const refreshBtn = document.getElementById("refresh-captcha");
const accessPill = document.getElementById("access-pill");
const modelLamp = document.getElementById("model-lamp");
const drop = document.getElementById("drop");
const fileInput = document.getElementById("file-input");
const openBtn = document.getElementById("open-btn");
const statusLine = document.getElementById("status-line");
const cueList = document.getElementById("cue-list");
const cueCount = document.getElementById("cue-count");
const fullText = document.getElementById("full-text");
const copyBtn = document.getElementById("copy-btn");
const clearBtn = document.getElementById("clear-btn");
const meterFill = document.getElementById("meter-fill");
const progMeta = document.getElementById("prog-meta");
const stage = document.getElementById("stage");

const player = createPlayerController({
  videoEl: document.getElementById("player-video"),
  audioEl: document.getElementById("player-audio"),
  stageEl: stage,
  crtEl: document.querySelector(".crt"),
  timecodeEl: document.getElementById("timecode"),
  burnEl: document.getElementById("caption-burn"),
  fsBtn: document.getElementById("fs-btn"),
});

let busy = false;
let cues = [];
let abortRun = null;

function setStatus(msg) {
  statusLine.textContent = msg || "";
}

function fmtClock(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function loadCaptcha() {
  captchaError.textContent = "";
  captchaFrame.classList.add("is-loading");
  captchaImg.removeAttribute("src");
  try {
    const res = await fetch("/captcha/generate", { credentials: "include" });
    if (!res.ok) throw new Error("Could not load captcha");
    const data = await res.json();
    captchaImg.src = data.img;
    captchaImg.alt = "Captcha";
  } catch (e) {
    captchaError.textContent = e.message || "Captcha failed";
  } finally {
    captchaFrame.classList.remove("is-loading");
  }
}

async function checkAuth() {
  const res = await fetch("/auth/status", { credentials: "include" });
  const data = await res.json();
  if (data.ok) {
    showApp(data);
    return true;
  }
  showGate();
  return false;
}

function showGate() {
  gate.hidden = false;
  app.hidden = true;
  loadCaptcha();
}

function showApp(data) {
  gate.hidden = true;
  app.hidden = false;
  if (data.expires_at) {
    accessPill.textContent = `until ${new Date(data.expires_at * 1000).toLocaleString()}`;
  } else {
    accessPill.textContent = "24h";
  }
  modelLamp.classList.toggle("on", !!data.model_ready);
  prefetchVad().catch(() => {});
  fetch("/api/warmup", { method: "POST", credentials: "include" })
    .then((r) => r.json())
    .then(() => modelLamp.classList.add("on"))
    .catch(() => {});
}

captchaForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  captchaError.textContent = "";
  const answer = captchaAnswer.value.trim();
  if (!answer) return;
  const btn = captchaForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const res = await fetch("/captcha/verify", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer }),
    });
    const data = await res.json();
    if (!res.ok || data.status !== "OK") {
      captchaError.textContent = data.error || "Wrong answer";
      captchaAnswer.value = "";
      await loadCaptcha();
      return;
    }
    captchaAnswer.value = "";
    await checkAuth();
  } catch {
    captchaError.textContent = "Network error";
  } finally {
    btn.disabled = false;
  }
});

refreshBtn.addEventListener("click", () => loadCaptcha());

function bindDropTarget(el) {
  ["dragenter", "dragover"].forEach((ev) => {
    el.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add("is-hot");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    el.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove("is-hot");
    });
  });
  el.addEventListener("drop", (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) runPipeline(file);
  });
}

bindDropTarget(drop);
bindDropTarget(stage);

function pickFile() {
  fileInput.click();
}

drop.addEventListener("click", (e) => {
  e.preventDefault();
  pickFile();
});

drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    pickFile();
  }
});

openBtn.addEventListener("click", (e) => {
  e.preventDefault();
  pickFile();
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) runPipeline(file);
  fileInput.value = "";
});

clearBtn.addEventListener("click", () => {
  abortRun = Symbol("abort");
  resetWorkspace();
  setStatus("Cleared");
  progMeta.textContent = "READY";
});

copyBtn.addEventListener("click", async () => {
  const text = cues.map((c) => c.text.replace(/\n/g, " ")).filter(Boolean).join(" ");
  if (!text) return;
  await navigator.clipboard.writeText(text);
  setStatus("Copied");
});

function resetWorkspace() {
  cues = [];
  cueList.innerHTML = "";
  cueCount.textContent = "0";
  fullText.textContent = "";
  meterFill.style.width = "0%";
  copyBtn.disabled = true;
  player.unload();
}

function rebuildCueList(allCues) {
  cueList.innerHTML = "";
  for (const cue of allCues) {
    const li = document.createElement("li");
    li.dataset.start = String(cue.start);
    const time = document.createElement("time");
    time.textContent = fmtClock(cue.start);
    const p = document.createElement("p");
    p.textContent = cue.text.replace(/\n/g, " ");
    li.append(time, p);
    li.addEventListener("click", () => player.seek(cue.start));
    cueList.appendChild(li);
  }
  cueCount.textContent = String(allCues.length);
}

async function sendChunk(chunk, signal) {
  const blob = pcmToWavBlob(chunk.pcm);
  const fd = new FormData();
  fd.append("file", blob, `chunk_${chunk.index}.wav`);
  fd.append("index", String(chunk.index));
  // Timestamp base = actual audio start (may include overlap from prior chunk)
  fd.append("start", String(chunk.pcmOffset ?? chunk.startSec));
  fd.append("end", String(chunk.endSec));
  const res = await fetch("/api/transcribe/chunk", {
    method: "POST",
    body: fd,
    credentials: "include",
    signal,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Chunk ${chunk.index} failed`);
  return data;
}

function cuesForClip(result, rangeStart, chunk) {
  // Timed from the overlapped audio start so the re-heard sentence lands fully
  return cuesFromChunk({
    text: result.text || "",
    start: rangeStart,
    end: chunk.endSec,
    segments: result.segments || [],
  });
}

async function runPipeline(file) {
  if (busy) return;
  busy = true;
  const token = Symbol("run");
  abortRun = token;

  resetWorkspace();
  player.loadFile(file, isVideoFile(file));
  progMeta.textContent = "EXTRACT";
  copyBtn.disabled = true;

  const ac = new AbortController();

  try {
    setStatus(`Loading ${file.name}`);
    const { pcm, durationSec, source } = await separateAudio(file, setStatus);
    if (abortRun !== token) return;

    progMeta.textContent = "VAD";
    setStatus(`Audio ${durationSec.toFixed(1)}s (${source}). Waiting for real pauses…`);

    let done = 0;
    let total = 0;
    let collected = [];

    for await (const chunk of chunkByVadStream(pcm)) {
      if (abortRun !== token) return;
      total = Math.max(total, chunk.totalHint || done + 1);
      done += 1;

      progMeta.textContent = `ASR ${done}`;
      setStatus(`Transcribing ${done}${total ? ` / ~${total}` : ""}…`);
      meterFill.style.width = `${Math.min(99, (chunk.endSec / durationSec) * 100)}%`;

      const result = await sendChunk(chunk, ac.signal);
      if (abortRun !== token) return;

      // Overlapped audio re-covers [rangeStart, chunk.startSec): drop the old
      // cues in that window (they may be cut mid-word) and replace them with
      // this chunk's fresh transcription of the same audio, by TIME not text.
      const rangeStart = chunk.pcmOffset ?? chunk.startSec;
      collected = collected.filter((c) => c.end <= rangeStart + 0.05);
      const pieceCues = cuesForClip(result, rangeStart, chunk);
      collected = collected.concat(pieceCues);

      cues = collected;
      rebuildCueList(collected);
      player.setCues(collected);
      fullText.textContent = collected.map((c) => c.text.replace(/\n/g, " ")).join(" ");
      if (collected.length) copyBtn.disabled = false;
    }

    meterFill.style.width = "100%";
    progMeta.textContent = "LIVE";
    setStatus(`${collected.length} captions ready`);
  } catch (e) {
    if (e.name === "AbortError") return;
    console.error(e);
    setStatus(e.message || "Failed");
    progMeta.textContent = "ERROR";
    if (String(e.message || "").includes("Access locked")) showGate();
  } finally {
    busy = false;
  }
}

checkAuth();

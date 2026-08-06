/**
 * Player: burn-in captions + real maximize via .crt fullscreen button
 * (native video FS cannot show DOM captions — we disable it).
 */

function toVttTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const whole = Math.floor(secs);
  const ms = Math.round((secs - whole) * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(whole)}.${pad(ms, 3)}`;
}

function cuesToVtt(cues) {
  let out = "WEBVTT\n\n";
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const text = (c.text || "").replace(/\n/g, " ").trim();
    if (!text) continue;
    out += `${i + 1}\n${toVttTime(c.start)} --> ${toVttTime(c.end)}\n${text}\n\n`;
  }
  return out;
}

export function createPlayerController({
  videoEl,
  audioEl,
  stageEl,
  crtEl,
  timecodeEl,
  burnEl,
  fsBtn,
}) {
  let mediaUrl = null;
  let vttUrl = null;
  let mode = null;
  let cues = [];
  let raf = 0;
  let lastIdx = -1;

  // Prefer browser native controls without their fullscreen (Chrome/Edge)
  try {
    videoEl.setAttribute("controlsList", "nofullscreen noremoteplayback");
    videoEl.disablePictureInPicture = true;
  } catch (_) {
    /* ignore */
  }

  function activeMedia() {
    return mode === "video" ? videoEl : mode === "audio" ? audioEl : null;
  }

  function fmt(sec) {
    if (!Number.isFinite(sec)) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function findCueIndex(t) {
    let lo = 0;
    let hi = cues.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = cues[mid];
      if (t < c.start) hi = mid - 1;
      else if (t >= c.end) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  function fsElement() {
    return (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.msFullscreenElement ||
      null
    );
  }

  function isCrtFullscreen() {
    return fsElement() === crtEl;
  }

  function syncBurn(t) {
    if (!burnEl) return;
    const idx = findCueIndex(t);
    if (idx === lastIdx) {
      if (idx >= 0) burnEl.hidden = false;
      return;
    }
    lastIdx = idx;
    if (idx >= 0) {
      burnEl.hidden = false;
      burnEl.textContent = cues[idx].text;
    } else {
      burnEl.textContent = "";
      burnEl.hidden = true;
    }

    const rows = document.querySelectorAll("#cue-list li");
    rows.forEach((row, i) => row.classList.toggle("is-active", i === idx));
    const active = rows[idx];
    const list = document.getElementById("cue-list");
    // Scroll only the caption pane - never the page (that shove the player down)
    if (active && list) {
      const listTop = list.scrollTop;
      const listBottom = listTop + list.clientHeight;
      const rowTop = active.offsetTop;
      const rowBottom = rowTop + active.offsetHeight;
      if (rowTop < listTop) {
        list.scrollTop = rowTop - 8;
      } else if (rowBottom > listBottom) {
        list.scrollTop = rowBottom - list.clientHeight + 8;
      }
    }
  }

  function tick() {
    const m = activeMedia();
    if (m) {
      const t = m.currentTime || 0;
      const d = Number.isFinite(m.duration) ? m.duration : 0;
      if (timecodeEl) timecodeEl.textContent = `${fmt(t)} / ${fmt(d)}`;
      syncBurn(t);
    }
    updateFsLabel();
    raf = requestAnimationFrame(tick);
  }

  function updateFsLabel() {
    if (!fsBtn) return;
    fsBtn.textContent = isCrtFullscreen() ? "Exit" : "Maximize";
    fsBtn.setAttribute("aria-pressed", isCrtFullscreen() ? "true" : "false");
  }

  function clearTracks(el) {
    el.querySelectorAll("track").forEach((t) => t.remove());
    if (vttUrl) {
      URL.revokeObjectURL(vttUrl);
      vttUrl = null;
    }
  }

  function applyVtt() {
    clearTracks(videoEl);
    if (!cues.length || mode !== "video") return;
    const vtt = cuesToVtt(cues);
    if (!vtt.includes("-->")) return;
    vttUrl = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.label = "Transcript";
    track.srclang = "en";
    track.src = vttUrl;
    track.default = true;
    videoEl.appendChild(track);
    // Keep native cues hidden — burn-in handles display (incl. crt fullscreen)
    setTimeout(() => {
      const tt = videoEl.textTracks?.[0];
      if (tt) tt.mode = "hidden";
    }, 40);
  }

  async function enterFullscreen() {
    if (!crtEl) return;
    const req =
      crtEl.requestFullscreen ||
      crtEl.webkitRequestFullscreen ||
      crtEl.msRequestFullscreen;
    if (!req) throw new Error("Fullscreen not supported");
    await req.call(crtEl);
  }

  async function exitFullscreen() {
    const exit =
      document.exitFullscreen ||
      document.webkitExitFullscreen ||
      document.msExitFullscreen;
    if (exit) await exit.call(document);
  }

  async function toggleFullscreen() {
    try {
      if (isCrtFullscreen()) await exitFullscreen();
      else await enterFullscreen();
    } catch (e) {
      console.warn("fullscreen failed", e);
    }
    updateFsLabel();
  }

  if (fsBtn) {
    fsBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFullscreen();
    });
  }

  document.addEventListener("fullscreenchange", () => {
    updateFsLabel();
    lastIdx = -1;
    const m = activeMedia();
    if (m) syncBurn(m.currentTime || 0);
  });
  document.addEventListener("webkitfullscreenchange", () => updateFsLabel());

  videoEl.addEventListener("dblclick", (e) => {
    e.preventDefault();
    toggleFullscreen();
  });

  function loadFile(file, isVideo) {
    unload();
    mediaUrl = URL.createObjectURL(file);
    mode = isVideo ? "video" : "audio";
    stageEl.dataset.mode = mode;
    videoEl.hidden = mode !== "video";
    audioEl.hidden = mode !== "audio";
    if (fsBtn) fsBtn.hidden = false;
    if (mode === "video") {
      videoEl.src = mediaUrl;
      videoEl.load();
    } else {
      audioEl.src = mediaUrl;
      audioEl.load();
    }
    cues = [];
    lastIdx = -1;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  function setCues(next) {
    cues = (next || [])
      .filter((c) => c && c.text)
      .map((c) => ({
        start: Number(c.start),
        end: Math.max(Number(c.start) + 0.4, Number(c.end)),
        text: String(c.text),
      }))
      .sort((a, b) => a.start - b.start);
    lastIdx = -1;
    applyVtt();
    const m = activeMedia();
    if (m) syncBurn(m.currentTime || 0);
  }

  function seek(sec) {
    const m = activeMedia();
    if (!m) return;
    m.currentTime = sec;
    m.play().catch(() => {});
  }

  function unload() {
    cancelAnimationFrame(raf);
    clearTracks(videoEl);
    if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    mediaUrl = null;
    videoEl.removeAttribute("src");
    audioEl.removeAttribute("src");
    videoEl.load();
    audioEl.load();
    videoEl.hidden = true;
    audioEl.hidden = true;
    if (fsBtn) fsBtn.hidden = true;
    mode = null;
    cues = [];
    lastIdx = -1;
    if (stageEl) stageEl.dataset.mode = "empty";
    if (timecodeEl) timecodeEl.textContent = "0:00 / 0:00";
    if (burnEl) {
      burnEl.textContent = "";
      burnEl.hidden = true;
    }
    if (isCrtFullscreen()) exitFullscreen().catch(() => {});
  }

  return { loadFile, setCues, seek, unload, activeMedia, toggleFullscreen };
}

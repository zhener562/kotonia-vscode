// @ts-check
// Standalone Ditto avatar player for the dedicated avatar panel. Renders JPEG
// frames to the canvas at 25fps (absolute-time scheduling + frame drop) and
// plays WAV audio via WebAudio, gaplessly scheduled and A/V-synced (audio for a
// sentence starts with its first frame). Fed by postMessage from avatarPanel.ts.
(function () {
  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("avatar"));
  const still = /** @type {HTMLImageElement} */ (document.getElementById("avatar-still"));
  const placeholder = document.getElementById("placeholder");
  const ctx = canvas.getContext("2d");

  const FPS = 25;
  const frameMs = 1000 / FPS;
  let audioCtx = null;
  let frameQueue = [];
  let rendering = false;
  let nextStartTime = 0;
  let pendingAudio = [];
  let waitingFirstFrame = false;
  const unmute = document.getElementById("unmute");

  // The panel opens without focus (preserveFocus), so its document has no user
  // activation and Chromium's autoplay policy keeps the AudioContext suspended
  // — frames render but audio is silent. Show a one-click "enable sound" prompt;
  // the click provides the gesture that lets resume() take effect. After the
  // first successful resume the context stays unlocked for the session.
  function updateUnmute() {
    if (!unmute) return;
    unmute.style.display =
      audioCtx && audioCtx.state === "suspended" ? "block" : "none";
  }
  function unlockAudio() {
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().then(updateUnmute, updateUnmute);
    }
  }
  if (unmute) unmute.addEventListener("click", unlockAudio);
  window.addEventListener("pointerdown", unlockAudio);
  window.addEventListener("keydown", unlockAudio);
  if (still) {
    still.addEventListener("load", () => {
      if (placeholder) placeholder.style.display = "none";
    });
    still.addEventListener("error", () => {
      still.style.display = "none";
      if (placeholder) placeholder.style.display = "block";
    });
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function ensureAudio() {
    if (!audioCtx || audioCtx.state === "closed") {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      nextStartTime = audioCtx.currentTime;
    }
    if (audioCtx.state === "suspended") audioCtx.resume().then(updateUnmute, updateUnmute);
    updateUnmute();
    return audioCtx;
  }

  async function scheduleAudio(wavBytes) {
    try {
      const c = ensureAudio();
      const buf = await c.decodeAudioData(wavBytes.buffer.slice(0));
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(c.destination);
      const startAt = Math.max(nextStartTime, c.currentTime + 0.01);
      src.start(startAt);
      nextStartTime = startAt + buf.duration;
    } catch (e) {
      /* decode failure — skip */
    }
  }

  function showCanvas() {
    if (placeholder) placeholder.style.display = "none";
    if (still) still.style.display = "none";
    canvas.style.display = "block";
  }

  function showStill() {
    canvas.style.display = "none";
    if (still) still.style.display = "block";
    if (placeholder) placeholder.style.display = "none";
  }

  function renderFrames() {
    if (rendering) return;
    rendering = true;
    showCanvas();
    let t0 = -1;
    let idx = 0;
    const drawNext = () => {
      if (frameQueue.length === 0) {
        rendering = false;
        return;
      }
      const now = performance.now();
      if (t0 < 0) t0 = now;
      const target = Math.floor((now - t0) / frameMs);
      while (idx < target && frameQueue.length > 1) {
        frameQueue.shift();
        idx++;
      }
      const blob = frameQueue.shift();
      idx++;
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        if (canvas.width !== img.width || canvas.height !== img.height) {
          canvas.width = img.width;
          canvas.height = img.height;
        }
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        const nextMs = t0 + idx * frameMs;
        setTimeout(drawNext, Math.max(0, nextMs - performance.now()));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        setTimeout(drawNext, 0);
      };
      img.src = url;
    };
    drawNext();
  }

  function begin() {
    frameQueue = [];
    rendering = false;
    pendingAudio = [];
    waitingFirstFrame = false;
    ensureAudio();
    nextStartTime = audioCtx.currentTime;
    // Keep Eve's bundled portrait visible until the first generated frame is
    // decoded. Slow TTS/Ditto startup should never turn the panel blank.
  }

  function chunk(type, b64) {
    const payload = b64ToBytes(b64);
    if (type === 0) {
      pendingAudio.push(payload);
      waitingFirstFrame = true;
    } else if (type === 1) {
      if (waitingFirstFrame) {
        waitingFirstFrame = false;
        for (const a of pendingAudio.splice(0)) void scheduleAudio(a);
      }
      frameQueue.push(new Blob([payload], { type: "image/jpeg" }));
      if (!rendering) renderFrames();
    }
  }

  function end() {
    if (pendingAudio.length) {
      for (const a of pendingAudio.splice(0)) void scheduleAudio(a);
      waitingFirstFrame = false;
    }
  }

  function stop() {
    frameQueue = [];
    rendering = false;
    pendingAudio = [];
    waitingFirstFrame = false;
    showStill();
  }

  window.addEventListener("message", (event) => {
    const d = event.data;
    if (d.kind === "avatarBegin") begin();
    else if (d.kind === "avatarChunk") chunk(d.chunkType, d.data);
    else if (d.kind === "avatarEnd") end();
    else if (d.kind === "avatarStop") stop();
  });
})();

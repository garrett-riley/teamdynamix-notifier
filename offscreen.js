// Offscreen document — handles all audio playback for the extension.
// Runs a continuous loop when the alarm is active, stops when silenced.
// Selectable alarm sounds + volume, live-updatable mid-alarm, one-shot test.

let loopInterval  = null;
let ctx           = null;
let currentSound  = "chord";
let currentVolume = 0.6;

chrome.runtime.onMessage.addListener((msg, sender) => {
  // Only accept messages from our own extension's privileged contexts (background).
  // sender.tab being set means it came from a content-script / web page — reject.
  if (!sender || sender.id !== chrome.runtime.id || sender.tab) return;

  switch (msg.action) {
    case "playSound":
      if (typeof msg.sound === "string")  currentSound  = msg.sound;
      if (Number.isFinite(msg.volume))    currentVolume = msg.volume;
      startLoop();
      break;
    case "stopSound":
      stopLoop();
      break;
    case "updateSound":
      // Live change while (possibly) alarming — takes effect on the next loop tick.
      if (typeof msg.sound === "string")  currentSound  = msg.sound;
      if (Number.isFinite(msg.volume))    currentVolume = msg.volume;
      break;
    case "playTestSound":
      // One-shot preview forwarded by the BACKGROUND (the popup sends
      // "requestTestSound", which this document ignores — that split prevents the
      // popup's broadcast and the background's forward from double-playing).
      // Does not start or stop the alarm loop.
      playOnce(
        typeof msg.sound === "string" ? msg.sound  : currentSound,
        Number.isFinite(msg.volume)   ? msg.volume : currentVolume
      );
      break;
  }
});

function ensureCtx() {
  if (!ctx || ctx.state === "closed") ctx = new AudioContext();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
}

function startLoop() {
  if (loopInterval) return;            // already looping
  ensureCtx();
  playCurrent();                       // play immediately
  loopInterval = setInterval(playCurrent, 3000);
}

function stopLoop() {
  if (loopInterval) {
    clearInterval(loopInterval);
    loopInterval = null;
  }
  if (ctx) {
    ctx.close().catch(() => {});
    ctx = null;
  }
}

function playCurrent() { renderSound(currentSound, currentVolume); }

function playOnce(sound, volume) {
  ensureCtx();
  renderSound(sound, volume);
}

// One enveloped oscillator note. Fade-in/out ramps avoid start/stop clicks.
function note(freq, type, t, dur, peak) {
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.frequency.value = freq;
  osc.type            = type;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(peak, t + 0.03);
  gain.gain.linearRampToValueAtTime(0,    t + dur - 0.03);
  osc.start(t);
  osc.stop(t + dur);
}

// The sound library. Each renders ONE iteration (≤ ~1.2s); the 3s loop repeats it.
// `volume` (0–1) sets the peak gain directly — 0.6 matches the historical loudness.
function renderSound(name, volume) {
  if (!ctx || ctx.state === "closed") return;
  const v = Math.max(0, Math.min(1, Number(volume)));
  if (v === 0) return;                 // volume zero = intentionally silent
  const t = ctx.currentTime;

  switch (name) {
    case "beep":     // one clean sine beep
      note(880, "sine", t, 0.35, v);
      break;

    case "klaxon":   // harsh alternating two-tone, sawtooth — hard to ignore
      note(600, "sawtooth", t,        0.22, v * 0.55);
      note(820, "sawtooth", t + 0.24, 0.22, v * 0.55);
      note(600, "sawtooth", t + 0.48, 0.22, v * 0.55);
      note(820, "sawtooth", t + 0.72, 0.22, v * 0.55);
      break;

    case "chime":    // descending three-note chime (inverse of the chord)
      note(1319, "sine", t,        0.2, v);
      note(1047, "sine", t + 0.2,  0.2, v);
      note(880,  "sine", t + 0.4,  0.2, v);
      break;

    case "buzzer":   // low square-wave double buzz
      note(160, "square", t,        0.32, v * 0.45);
      note(160, "square", t + 0.42, 0.32, v * 0.45);
      break;

    case "chord":    // the original rising three-note chord
    default:
      note(880,  "sine", t,        0.2, v);
      note(1047, "sine", t + 0.2,  0.2, v);
      note(1319, "sine", t + 0.4,  0.2, v);
      break;
  }
}

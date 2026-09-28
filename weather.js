// ==== WEATHER + DAY/NIGHT ====
// Time of day interpolates 4 keyframes (midnight / dawn / noon / dusk); the
// midnight keyframe reproduces the original static night look exactly (sky
// coefficients, haze, star threshold, ambience all match byte-for-byte).
// main.js reads: todNight, todAmb, todLift, todStar, todGA/todGB/todC0/todC1
// (via buildSkyTable), HAZE_* (lets in main), and calls weatherFrame() each
// frame plus drawWeather() inside render.
let tod = 0.0;                 // 0 = midnight, 0.25 = dawn, 0.5 = noon, 0.75 = dusk
let todAuto = true;            // settings-backed: advance through the cycle
let weather = 0;               // 0 none, 1 rain, 2 snow

// Per-frame derived values (set by computeTod)
let todC0r = 50, todC0g = 60, todC0b = 120;   // sky gradient at row 0
let todC1r = 170, todC1g = 150, todC1b = 270; // sky gradient at the horizon
let todGA = 0.4, todGB = 0.6;                 // glyph brightness ramp
let todStar = 0.987, todNight = 1, todAmb = 1, todLift = 0;
let lastSkyB = -1, simNow = 0;

const TOD_KEYS = [
  { c0: [50, 60, 120], c1: [170, 150, 270], gA: 0.40, gB: 0.60, haze: [110, 130, 175], star: 0.987, night: 1.0, amb: 1.00 },  // midnight
  { c0: [70, 55, 105], c1: [245, 165, 130], gA: 0.50, gB: 0.62, haze: [175, 135, 145], star: 1.02, night: 0.35, amb: 1.10 },  // dawn
  { c0: [105, 155, 225], c1: [175, 210, 248], gA: 0.78, gB: 0.52, haze: [185, 205, 235], star: 1.05, night: 0.0, amb: 1.25 }, // noon
  { c0: [62, 55, 108], c1: [250, 155, 95], gA: 0.50, gB: 0.62, haze: [195, 130, 120], star: 1.02, night: 0.45, amb: 1.10 },  // dusk
];

function computeTod() {
  const tt = ((tod % 1) + 1) % 1;
  const seg = tt * 4;
  const i0 = Math.floor(seg) % 4, f = seg - Math.floor(seg);
  const a = TOD_KEYS[i0], b = TOD_KEYS[(i0 + 1) % 4];
  todC0r = a.c0[0] + (b.c0[0] - a.c0[0]) * f;
  todC0g = a.c0[1] + (b.c0[1] - a.c0[1]) * f;
  todC0b = a.c0[2] + (b.c0[2] - a.c0[2]) * f;
  todC1r = a.c1[0] + (b.c1[0] - a.c1[0]) * f;
  todC1g = a.c1[1] + (b.c1[1] - a.c1[1]) * f;
  todC1b = a.c1[2] + (b.c1[2] - a.c1[2]) * f;
  todGA = a.gA + (b.gA - a.gA) * f;
  todGB = a.gB + (b.gB - a.gB) * f;
  todStar = a.star + (b.star - a.star) * f;
  todNight = a.night + (b.night - a.night) * f;
  todAmb = a.amb + (b.amb - a.amb) * f;
  todLift = (1 - todNight) * 0.4;
  HAZE_R = a.haze[0] + (b.haze[0] - a.haze[0]) * f;
  HAZE_G = a.haze[1] + (b.haze[1] - a.haze[1]) * f;
  HAZE_B = a.haze[2] + (b.haze[2] - a.haze[2]) * f;
}

function fmtClock(t) {
  const h = (((t * 24) % 24) + 24) % 24;
  const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
  return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
}

// --- Screen-space particles (flat arrays, allocated lazily at frame time) ---
const P_RAIN = 380, P_SNOW = 300, P_MAX = 380;
const pX = new Float32Array(P_MAX), pY = new Float32Array(P_MAX);
const pS = new Float32Array(P_MAX), pP = new Float32Array(P_MAX);
let pReady = false;
function ensureParticles() {
  if (pReady) return;
  pReady = true;
  for (let i = 0; i < P_MAX; i++) {
    pX[i] = Math.random() * Math.max(1, canvasW);
    pY[i] = Math.random() * Math.max(1, canvasH);
    pS[i] = 0.7 + Math.random() * 0.6;
    pP[i] = Math.random() * 6.283;
  }
}

// Called once per frame from main.js before render().
function weatherFrame(dt) {
  computeTod();
  if (todAuto) tod = (tod + dt / 240) % 1;             // full cycle: 4 minutes
  const b = Math.floor(tod * 64);
  if (b !== lastSkyB) { lastSkyB = b; buildSkyTable(); } // sky palette rebuild ~ every 3.75 s
  if (!weather) return;
  simNow = performance.now() / 1000;
  ensureParticles();
  const vs = canvasH / 720;
  if (weather === 1) {
    for (let i = 0; i < P_RAIN; i++) {
      pY[i] += pS[i] * 1100 * dt * vs;
      if (pY[i] >= canvasH) { pY[i] -= canvasH; pX[i] = Math.random() * canvasW; }
    }
  } else {
    for (let i = 0; i < P_SNOW; i++) {
      pY[i] += pS[i] * 75 * dt * vs;
      pX[i] += Math.sin(simNow * 1.4 + pP[i]) * 40 * dt;
      if (pY[i] >= canvasH) { pY[i] -= canvasH; pX[i] = Math.random() * canvasW; }
      if (pX[i] < 0) pX[i] += canvasW; else if (pX[i] >= canvasW) pX[i] -= canvasW;
    }
  }
}

// Called inside render() after the billboard pass: screen-space overlay in front
// of everything (rain/snow fall between the camera and the city).
function drawWeather() {
  if (weather === 1) {
    const keyA = packRGB(135, 165, 215), keyB = packRGB(95, 120, 170);
    for (let i = 0; i < P_RAIN; i++) {
      const c = (pX[i] / CHAR_W) | 0;
      if (c < 0 || c >= COLS) continue;
      const r = (pY[i] / CHAR_H) | 0;
      for (let k = 0; k < 3; k++) {
        const rr = r + k;
        if (rr < 0 || rr >= ROWS) continue;
        const idx = rr * COLS + c;
        charBuf[idx] = 9;                               // '|'
        colBuf[idx] = k === 0 ? keyA : keyB;
      }
    }
  } else if (weather === 2) {
    const key = packRGB(235, 240, 250);
    for (let i = 0; i < P_SNOW; i++) {
      const c = (pX[i] / CHAR_W) | 0, r = (pY[i] / CHAR_H) | 0;
      if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue;
      const idx = r * COLS + c;
      charBuf[idx] = 1;                                 // '.'
      colBuf[idx] = key;
    }
  }
}

// NOTE: no computeTod() call here — main.js's HAZE_* lets aren't declared yet at
// this load point (TDZ). The tod=0 initializers above already match the midnight
// keyframe, and weatherFrame() re-derives everything before the first render.

Settings.define('tod', { label: 'Time of day', type: 'range', min: 0, max: 1, step: 0.01, default: 0, fmt: fmtClock },
  v => { tod = v; todAuto = false; Settings.set('dayCycle', false, { silent: true }); lastSkyB = -1; needRender = true; });
Settings.define('dayCycle', { label: 'Day cycle (4 min)', type: 'checkbox', default: true },
  v => { todAuto = v; needRender = true; });
Settings.define('weather', { label: 'Weather', type: 'select', options: [0, 1, 2], default: 0, coerce: Number,
  fmt: v => (v === 1 ? 'rain' : v === 2 ? 'snow' : 'none') },
  v => { weather = v; needRender = true; });

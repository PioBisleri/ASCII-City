// ==== ASCII CITY RAYCASTER (night, lit windows) ====
const CANVAS = document.getElementById('screen');
const CTX = CANVAS.getContext('2d');
const HUD = document.getElementById('hud');
const DEBUG = location.search.indexOf('debug') >= 0;

let FONT_SIZE = 9;          // settings-backed (fontSize select)
const SKY_BSTEP = 4;             // topWallRow quantization for the sky gradient table
let CHAR_W, CHAR_H, COLS, ROWS, canvasW, canvasH;

// --- Flat cell buffers (row-major, index = r * COLS + c) ---
// charBuf: 0 = background, 1..8 = density ramp ('*' lives at 4), 9 = lamp post '|'
// colBuf: packed quantized RGB (0xRRGGBB & ~3 per channel); only valid where charBuf != 0.
// Run-merging in the draw pass is a plain integer compare against these two buffers.
const CHARSET = ' .:!*%#$@|';
const CHARS = Array.from(CHARSET);
const C_SPACE = 0, C_STAR = 4, C_POST = 9;
let charBuf = new Uint8Array(1);
let colBuf = new Uint32Array(1);

let skyStar = null, skyDither = null;   // precomputed sky noise (rebuilt on resize)
let skyG = null, skyKey = null, skyBuckets = 0; // sky gradient table [bucket * ROWS + row]
let rowDist, rowDens;                   // per-row floor invariants (rebuilt per frame)
let rowHazeCh, rowHazeKey;              // horizon haze row style
let PK_PARK, PK_LANE, PK_CURB, PK_ASPH, PK_DIRT; // per-row floor surface colors
let colDepth = null;                    // per-column nearest-wall depth (for lamp occlusion)
let needRender = true;                  // dirty flag: scene is fully static, render only on change

const RAMP = '.:!*%#$@';
const RMAX = RAMP.length - 1;

function shadeI(b, hiCap = 1) { // brightness 0..1 -> ramp index 0..RMAX
  const t = b < 0 ? 0 : b > 1 ? 1 : b;
  const cap = hiCap < 0 ? 0 : hiCap > 1 ? 1 : hiCap;
  const idx = Math.floor(t * RMAX * cap + 1e-6);
  return idx > RMAX ? RMAX : idx;
}

// Deterministic per-window light hash
function hash3(a, b, c) {
  let n = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 1274126177)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n = n ^ (n >>> 16);
  return ((n >>> 0) % 1000) / 1000;
}

let FOV = 0.66;             // settings-backed
const MAX_DIST = 220;
let FOG = 120;              // long-range color fade (haze)   [settings-backed]
let FOG_MIN = 0.45;         // keep distant surfaces visible  [settings-backed]
let NEAR = 35;              // short-range CHARACTER density falloff [settings-backed]
let FOGE = 120, FMINE = 0.45; // per-frame effective fog (weather modulates; set at render start)
let HAZE_R = 110, HAZE_G = 130, HAZE_B = 175; // atmospheric blend target (weather.js sets per time-of-day)

// Curated building-facade palette (per-building, picked by hash) — architectural,
// muted tints that read clearly against the coloured window glow.
const FACADE_PAL = [[255, 122, 92], [255, 232, 154], [120, 150, 200], [190, 192, 210], [250, 154, 106], [96, 170, 170], [170, 120, 184]];
// Lit-window palettes per building type
const WPAL = [[255, 240, 205], [255, 188, 105], [165, 222, 255], [255, 170, 205], [205, 255, 185]];

// --- Color packing: quantize to /4 rgb so identical colors share one cached string.
// The draw pass resolves packed keys -> 'rgb(r,g,b)' strings, which also lets the
// run-merge fire across columns (same key => same string => fewer fillText calls).
const _cc = new Map();
function packRGB(r, g, b) {
  r = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
  g = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
  b = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
  return ((r & ~3) << 16) | ((g & ~3) << 8) | (b & ~3);
}
function colorOf(key) {
  let s = _cc.get(key);
  if (s === undefined) {
    s = 'rgb(' + ((key >>> 16) & 255) + ',' + ((key >>> 8) & 255) + ',' + (key & 255) + ')';
    if (_cc.size < 65536) _cc.set(key, s);
  }
  return s;
}
// Blend a surface color toward a bluish haze by (1 - fog) so distance reads as atmosphere
function fogKey(r, g, b, f, i1f) {
  return packRGB(r * f + HAZE_R * i1f, g * f + HAZE_G * i1f, b * f + HAZE_B * i1f);
}
const KEY_STAR = packRGB(220, 225, 255);

// Floor surface mean brightness factors (noise/checker dither lives in the glyph,
// not the color, so floor colors stay coherent across columns => long draw runs)
const AL_PARK = 0.82 * (0.82 + 0.3 * 0.5);
const AL_ASPH = 0.34 * (0.82 + 0.4 * 0.5);
const AL_DIRT = 0.68 * (0.82 + 0.3 * 0.5);
const AL_CURB = 0.62;
const CH_LANE = 1 + shadeI(0.92);

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvasW = window.innerWidth;
  canvasH = window.innerHeight;
  CANVAS.width = Math.floor(canvasW * dpr);
  CANVAS.height = Math.floor(canvasH * dpr);
  CANVAS.style.width = canvasW + 'px';
  CANVAS.style.height = canvasH + 'px';
  CTX.setTransform(dpr, 0, 0, dpr, 0, 0);
  CTX.font = FONT_SIZE + 'px monospace';
  CTX.textBaseline = 'top';
  CHAR_W = Math.max(1, CTX.measureText('M').width || FONT_SIZE * 0.6); // exact glyph advance: column spacing must match it or runs leave gaps at their right edge
  CHAR_H = FONT_SIZE;
  COLS = Math.floor(canvasW / CHAR_W);
  ROWS = Math.floor(canvasH / CHAR_H);
  const n = COLS * ROWS;
  charBuf = new Uint8Array(n);
  colBuf = new Uint32Array(n);
  rowDist = new Float32Array(ROWS); rowDens = new Float32Array(ROWS);
  rowHazeCh = new Uint8Array(ROWS); rowHazeKey = new Uint32Array(ROWS);
  PK_PARK = new Uint32Array(ROWS); PK_LANE = new Uint32Array(ROWS); PK_CURB = new Uint32Array(ROWS);
  PK_ASPH = new Uint32Array(ROWS); PK_DIRT = new Uint32Array(ROWS);
  colDepth = new Float32Array(COLS);
  buildSkyNoise();
  needRender = true;
}
window.addEventListener('resize', resize);

// Precompute camera-independent sky star/dither noise plus the sky gradient
// table (color depends only on row + quantized topWallRow bucket, so sky rows
// draw as a handful of long runs instead of one run per cell).
function buildSkyNoise() {
  const n = COLS * ROWS;
  skyStar = new Float32Array(n);
  skyDither = new Float32Array(n);
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const i = r * COLS + c;
    skyStar[i] = hash3(c * 131 + 7, r * 17 + 3, 99);
    skyDither[i] = hash3(c * 13, r * 29, 5);
  }
  skyBuckets = Math.ceil(ROWS / SKY_BSTEP) + 2;
  skyG = new Float32Array(skyBuckets * ROWS);
  skyKey = new Uint32Array(skyBuckets * ROWS);
  buildSkyTable();
}

// Sky gradient colours follow the time-of-day keyframes (weather.js globals);
// rebuilt only when the tod bucket changes (~every 3.75 s) or on resize.
function buildSkyTable() {
  for (let b = 0; b < skyBuckets; b++) {
    const tw = Math.max(1, b * SKY_BSTEP);
    for (let r = 0; r < ROWS; r++) {
      const t = r < tw ? r / tw : 1;
      const g = todGA + t * todGB;
      const o = b * ROWS + r;
      skyG[o] = g;
      skyKey[o] = packRGB((todC0r + (todC1r - todC0r) * t) * g,
                          (todC0g + (todC1g - todC0g) * t) * g,
                          (todC0b + (todC1b - todC0b) * t) * g);
    }
  }
}
resize();

// Static per-cell grass variation (camera-independent) — precomputed once so the
// floor loop never recomputes hash3 per frame.
const grassNoise = new Float32Array(256 * 256);
for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++)
  grassNoise[y * 256 + x] = hash3(x * 3 + 1, y * 3 + 7, 0);

// --- Road surface types, derived locally from WORLD so this file never depends on a
//     cross-script global (a stale cached city-generator.js must not break the page).
//     0 = asphalt, 1 = lane center line (ridge crest), 2 = curb / road edge.
const ROADTYPE = new Uint8Array(256 * 256);
(function buildRoadTypes() {
  let perlin = null;
  try { perlin = new Perlin(0xC0FFEE); } catch (e) { perlin = null; }
  const ridge = (x, y) => perlin ? 1 - Math.abs(perlin.ridge(x / 32, y / 32)) : 0;
  const _d = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    if (WORLD[y * 256 + x] !== 0) continue;
    const r = ridge(x, y);
    let edge = false, crest = true;
    for (let k = 0; k < 4; k++) {
      const nx = x + _d[k][0], ny = y + _d[k][1];
      if (nx < 0 || ny < 0 || nx >= 256 || ny >= 256 || WORLD[ny * 256 + nx] !== 0) { edge = true; continue; }
      if (ridge(nx, ny) > r) crest = false;          // a road neighbour rises higher -> not the crest
    }
    if (perlin && crest) ROADTYPE[y * 256 + x] = 1;
    else if (edge) ROADTYPE[y * 256 + x] = 2;
    else ROADTYPE[y * 256 + x] = 0;
  }
})();

// --- Per-building style constants (window grid, facade tint, lit threshold).
// Computed once so the raycaster inner loop only does typed-array reads instead of
// hash3 + branching + palette allocation per hit.
const B_WC = new Float32Array(256 * 256);
const B_WR = new Float32Array(256 * 256);
const B_FAC = new Uint8Array(256 * 256);
const B_WPI = new Uint8Array(256 * 256);
const B_THR = new Float32Array(256 * 256);
(function buildBuildingStyles() {
  for (let i = 0; i < 256 * 256; i++) {
    const c = WORLD[i];
    if (c !== 1 && c !== 2 && c !== 3) continue;
    const mx = i & 255, my = i >> 8;
    let WC, WR, thr;
    if (c === 1)      { WC = 6.0;  WR = 2.2; thr = 0.54; }   // residential: many small windows
    else if (c === 2) { WC = 3.4;  WR = 1.3; thr = 0.46; }   // commercial: big glass panes
    else              { WC = 8.0;  WR = 1.0; thr = 0.40; }   // downtown: tall strip windows
    WC += (hash3(mx * 23 + 1, my * 11 + 3, 7) - 0.5) * 1.2;  // per-building jitter
    B_WC[i] = WC; B_WR[i] = WR; B_THR[i] = thr;
    B_FAC[i] = Math.floor(hash3(mx * 17 + 5, my * 31 + 9, 2) * FACADE_PAL.length) % FACADE_PAL.length;
    B_WPI[i] = Math.floor(hash3(mx * 13 + 2, my * 29 + 5, 3) * WPAL.length) % WPAL.length;
  }
})();

// Spawn on a road near the center
let spawn = { x: 128.5, y: 128.5 };
outer:
for (let r = 0; r < 90; r++)
  for (let dx = -r; dx <= r; dx++)
    for (let dy = -r; dy <= r; dy++) {
      const nx = 128 + dx, ny = 128 + dy;
      if (nx >= 1 && ny >= 1 && nx < 255 && ny < 255 && WORLD[ny * 256 + nx] === 0) {
        spawn = { x: nx + 0.5, y: ny + 0.5 }; break outer;
      }
    }

// Streetlamps line the roads: for each road-edge cell, drop a lamp onto the curb
// (just off the road toward the sidewalk) so lamps run parallel to the road on both
// sides, spaced evenly (~every 4 cells along the road).
const LAMPS = [];
const _ld = [[1, 0], [-1, 0], [0, 1], [0, -1]];
for (let y = 1; y < 255; y++) for (let x = 1; x < 255; x++) {
  if (WORLD[y * 256 + x] !== 0) continue;
  if (((x + y) & 3) !== 0) continue;              // spacing along the road
  for (let d = 0; d < 4; d++) {
    const dx = _ld[d][0], dy = _ld[d][1];
    const nx = x + dx, ny = y + dy;
    if (nx < 1 || ny < 1 || nx >= 255 || ny >= 255) continue;
    if (WORLD[ny * 256 + nx] === 0) continue;     // neighbor is also road -> not an edge
    LAMPS.push({ x: x + dx * 0.5 + 0.5, y: y + dy * 0.5 + 0.5 }); // sit on the curb
    break;                                       // one lamp per edge cell (first non-road side)
  }
}
let lampsOn = true;

const P = { x: spawn.x, y: spawn.y };
let angle = 0.6;
const DIR = { x: Math.cos(angle), y: Math.sin(angle) };
const PLANE = { x: -DIR.y * FOV, y: DIR.x * FOV };
let pitch = 0;
let camZ = 0.5;             // camera altitude in cells (fly mode raises this; 0.5 = street eye level)
let flyMode = false;        // F: no-clip + Space/Shift altitude
let mapLayout = { x0: 0, y0: 0, size: 0 };  // world-map panel geometry (for click teleport)

const KEYS = {};
let mapMode = 0;            // 0 none, 1 minimap (local), 2 world map (full city)
let mHeld = false, lHeld = false, fHeld = false;
addEventListener('keydown', e => {
  const tgt = e.target;
  if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || tgt.tagName === 'TEXTAREA')) return; // settings panel owns its inputs
  const k = e.key.toLowerCase();
  KEYS[k] = true;
  if (k === 'm' && !mHeld) { mapMode = (mapMode + 1) % 3; mHeld = true; }
  if (k === 'l' && !lHeld) { Settings.set('lamps', !Settings.get('lamps')); lHeld = true; }
  if (k === 'f' && !fHeld) {
    flyMode = !flyMode;
    if (!flyMode) {                          // touched down: don't leave the camera inside a building
      const spot = nearestWalkable(P.x, P.y, 6);
      if (spot) { P.x = spot.x; P.y = spot.y; }
    }
    fHeld = true;
  }
  if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', ' ', 'm', 'l', 'f'].includes(k)) e.preventDefault();
});
addEventListener('keyup', e => { const k = e.key.toLowerCase(); KEYS[k] = false; if (k === 'm') mHeld = false; if (k === 'l') lHeld = false; if (k === 'f') fHeld = false; });

// Click the full world map to teleport: land on the clicked cell, or the nearest
// walkable cell if it's inside a building. Closes the map so you see the arrival.
addEventListener('pointerdown', e => {
  if (mapMode !== 2 || mapLayout.size <= 0) return;
  if (e.target != null && e.target !== CANVAS) return;   // clicks on the settings panel don't teleport
  const lx = e.clientX - mapLayout.x0, ly = e.clientY - mapLayout.y0;
  if (lx < 0 || ly < 0 || lx > mapLayout.size || ly > mapLayout.size) return;
  const spot = nearestWalkable(lx / mapLayout.size * 256, ly / mapLayout.size * 256, 12);
  if (!spot) return;
  P.x = spot.x; P.y = spot.y;
  mapMode = 0;
  needRender = true;
});

function isWall(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= 256 || iy >= 256) return true;
  const c = WORLD[iy * 256 + ix];
  return c !== 0 && c !== 4; // buildings block; road & park are walkable
}

// Nearest walkable cell center to (x, y), searched outward in rings.
function nearestWalkable(x, y, maxR) {
  const ix = Math.floor(x), iy = Math.floor(y);
  if (!isWall(ix + 0.5, iy + 0.5)) return { x: ix + 0.5, y: iy + 0.5 };
  for (let r = 1; r <= maxR; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;  // ring cells only
        const nx = ix + dx, ny = iy + dy;
        if (nx < 0 || ny < 0 || nx >= 256 || ny >= 256) continue;
        if (!isWall(nx + 0.5, ny + 0.5)) return { x: nx + 0.5, y: ny + 0.5 };
      }
  return null;
}

// Draw a streetlamp billboard into the grid at screen column cx (float) and depth tY.
// Caller has already confirmed it is not occluded in its center column (colDepth).
function drawLamp(cx, tY, horizon) {
  const fog = Math.max(FMINE, 1 - tY / FOGE);
  const i1f = 1 - fog;
  const ls = 0.3 + 0.7 * todNight;                        // lamps dim in daylight
  const LAMP_H = 3.0;                                       // post height in cells
  const horizonR = horizon / CHAR_H;                        // horizon expressed in ROWS
  const baseRow = (horizon + (camZ * canvasH) / tY) / CHAR_H;         // ground-contact row
  const bulbRow = (horizon + (camZ - LAMP_H) * canvasH / tY) / CHAR_H; // bulb row
  const c0 = Math.round(cx);
  if (c0 < 0 || c0 >= COLS) return;

  // Apparent height in screen rows -> bulb + post thickness scale with proximity, so
  // lamps grow as you approach (closer = bigger bulb) instead of shrinking.
  const lampRows = (LAMP_H * canvasH / tY) / CHAR_H;
  const BR = Math.max(1, Math.min(5, Math.round(lampRows * 0.18)));  // bulb radius (rows & cols)
  let PH = 0; if (tY < 14) PH = 1; if (tY < 5) PH = 2;             // post half-thickness in cols

  const cr = Math.round(bulbRow);
  // ---- bulb: bright warm disc around (c0, bulbRow) ----
  const bulbKey = packRGB(255 * fog + 130 * i1f * ls, 240 * fog + 130 * i1f * ls, 180 * fog + 120 * i1f * ls);
  for (let dr = -BR; dr <= BR; dr++) {
    const r = cr + dr;
    if (r < 0 || r >= ROWS) continue;
    const halfW = Math.round(BR * Math.sqrt(Math.max(0, 1 - (dr * dr) / (BR * BR))));
    for (let dc = -halfW; dc <= halfW; dc++) {
      const cc = c0 + dc;
      if (cc < 0 || cc >= COLS) continue;
      if (tY > colDepth[cc]) continue;                      // occluded by a building here
      const i = r * COLS + cc;
      charBuf[i] = C_STAR;
      colBuf[i] = bulbKey;
    }
  }

  // ---- post: thicker vertical bar from just below the bulb down to the base ----
  const postTop = cr + BR + 1;
  const postBot = Math.min(ROWS - 1, Math.round(baseRow));
  const postKey = packRGB(120 * fog + 50, 110 * fog + 45, 90 * fog + 40);
  for (let r = postTop; r <= postBot; r++) {
    if (r < 0 || r >= ROWS) continue;
    for (let dc = -PH; dc <= PH; dc++) {
      const cc = c0 + dc;
      if (cc < 0 || cc >= COLS) continue;
      if (tY > colDepth[cc]) continue;
      const i = r * COLS + cc;
      charBuf[i] = C_POST;
      colBuf[i] = postKey;
    }
  }

  // ---- ground pool: subtle warm tint spilling on the floor around the base ----
  // (keeps the floor's own glyph so it never reads as a bright bulb at the bottom)
  const R = 3;
  for (let dr = -R; dr <= R; dr++) {
    const r = Math.round(baseRow) + dr;
    if (r <= horizonR || r < 0 || r >= ROWS) continue;
    for (let dc = -R; dc <= R; dc++) {
      const cc = c0 + dc;
      if (cc < 0 || cc >= COLS) continue;
      if (cc === c0) continue;                              // leave the post visible
      if (tY > colDepth[cc]) continue;                      // occluded by a building here
      const d2 = (dr * dr + dc * dc) / (R * R);
      if (d2 > 1) continue;
      const glow = (1 - d2) * 0.22 * fog * ls;
      if (glow <= 0.02) continue;
      const i = r * COLS + cc;
      if (charBuf[i] === C_SPACE) continue;
      const k = colBuf[i];                                  // unpack quantized rgb, add glow, repack
      const rr = ((k >>> 16) & 255) + glow * 150;
      const gg = ((k >>> 8) & 255) + glow * 110;
      const bb = (k & 255) + glow * 50;
      colBuf[i] = packRGB(rr, gg, bb);
    }
  }
}

// --- Map overlay (press M) ---
function cellColor(c) {
  if (c === 0) return '#26262e';   // road
  if (c === 4) return '#2f6e34';   // park
  if (c === 1) return '#b06048';   // residential
  if (c === 2) return '#5a78a0';   // commercial
  if (c === 3) return '#8a5aa0';   // downtown
  return '#444';
}
function cellRGB(c) {
  if (c === 0) return [38, 38, 46];
  if (c === 4) return [47, 110, 52];
  if (c === 1) return [176, 96, 72];
  if (c === 2) return [90, 120, 160];
  if (c === 3) return [138, 90, 160];
  return [68, 68, 68];
}
let worldCanvas = null;
function getWorldCanvas() {
  if (worldCanvas) return worldCanvas;
  try {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 256;
    const c = cv.getContext('2d');
    const img = c.createImageData(256, 256);               // one ImageData instead of 65k fillRects
    const d = img.data;
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const rgb = cellRGB(WORLD[y * 256 + x]);
      const o = (y * 256 + x) * 4;
      d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
    }
    c.putImageData(img, 0, 0);
    worldCanvas = cv;
  } catch (e) { worldCanvas = null; }
  return worldCanvas;
}
function drawPlayer(px, py, sc) {
  const len = sc * 9;                              // frustum length in panel px
  const lx = DIR.x - PLANE.x, ly = DIR.y - PLANE.y; // left FOV edge (camX = -1)
  const rx = DIR.x + PLANE.x, ry = DIR.y + PLANE.y; // right FOV edge (camX = +1)
  // filled view cone
  CTX.fillStyle = 'rgba(255,225,77,0.18)';
  CTX.beginPath();
  CTX.moveTo(px, py);
  CTX.lineTo(px + lx * len, py + ly * len);
  CTX.lineTo(px + rx * len, py + ry * len);
  CTX.closePath();
  CTX.fill();
  // frustum edge lines
  CTX.strokeStyle = 'rgba(255,225,77,0.7)';
  CTX.lineWidth = Math.max(1, sc * 0.3);
  CTX.beginPath();
  CTX.moveTo(px, py); CTX.lineTo(px + lx * len, py + ly * len);
  CTX.moveTo(px, py); CTX.lineTo(px + rx * len, py + ry * len);
  CTX.stroke();
  // center facing line + dot
  CTX.strokeStyle = '#ffe14d';
  CTX.lineWidth = Math.max(1, sc * 0.5);
  CTX.beginPath();
  CTX.moveTo(px, py);
  CTX.lineTo(px + DIR.x * sc * 6, py + DIR.y * sc * 6);
  CTX.stroke();
  CTX.fillStyle = '#ffe14d';
  CTX.beginPath();
  CTX.arc(px, py, Math.max(2, sc * 1.1), 0, Math.PI * 2);
  CTX.fill();
}
function drawMap() {
  if (mapMode === 0) return;
  if (mapMode === 1) {                                   // local minimap
    const R = 18, size = Math.min(canvasW, canvasH) * 0.22;
    const x0 = canvasW - size - 16, y0 = 16;
    CTX.fillStyle = 'rgba(8,10,18,0.82)';
    CTX.fillRect(x0 - 6, y0 - 6, size + 12, size + 12);
    const sc = size / (R * 2);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const cx = Math.floor(P.x) + dx, cy = Math.floor(P.y) + dy;
      if (cx < 0 || cy < 0 || cx >= 256 || cy >= 256) continue;
      CTX.fillStyle = cellColor(WORLD[cy * 256 + cx]);
      CTX.fillRect(x0 + (dx + R) * sc, y0 + (dy + R) * sc, Math.ceil(sc), Math.ceil(sc));
    }
    drawPlayer(x0 + R * sc, y0 + R * sc, sc);
    CTX.fillStyle = '#cfd6e6';
    CTX.fillText('MINIMAP (M)', x0, y0 - 8);
  } else {                                               // full world map
    const size = Math.min(canvasW, canvasH) * 0.82;
    const x0 = (canvasW - size) / 2, y0 = (canvasH - size) / 2;
    CTX.fillStyle = 'rgba(8,10,18,0.9)';
    CTX.fillRect(x0 - 8, y0 - 8, size + 16, size + 16);
    const wc = getWorldCanvas(), sc = size / 256;
    if (wc) { CTX.imageSmoothingEnabled = false; CTX.drawImage(wc, x0, y0, size, size); }
    else { for (let y = 0; y < 256; y += 2) for (let x = 0; x < 256; x += 2) { CTX.fillStyle = cellColor(WORLD[y * 256 + x]); CTX.fillRect(x0 + x * sc, y0 + y * sc, Math.ceil(2 * sc), Math.ceil(2 * sc)); } }
    drawPlayer(x0 + P.x * sc, y0 + P.y * sc, sc * 3);
    mapLayout.x0 = x0; mapLayout.y0 = y0; mapLayout.size = size;   // click-teleport geometry
    CTX.fillStyle = '#cfd6e6';
    CTX.fillText('WORLD MAP (M) · CLICK TO TELEPORT', x0, y0 - 8);
  }
}

// --- Raycaster wall pool (structure-of-arrays, reused every column: zero GC) ---
const MAXW = 256;
const poolPerp = new Float32Array(MAXW);
const poolWallX = new Float32Array(MAXW);
const poolYTop = new Float32Array(MAXW);
const poolTop = new Int32Array(MAXW);
const poolIdx = new Int32Array(MAXW);
const poolSide = new Uint8Array(MAXW);

// --- Billboard list: lampObjs / carObjs hold one reusable record per object
//     (never truncated); visBuf is the per-frame visible prefix that gets sorted.
//     Records are tagged k: 0 = lamp, 1 = car. ---
const lampObjs = [];
for (let i = 0; i < LAMPS.length; i++) lampObjs.push({ c: 0, tY: 0, k: 0 });
const visBuf = [];
const byDepthDesc = (a, b) => b.tY - a.tY;        // far first (painter's order)

const runBuf = new Array(4096);   // reusable run-string builder for the draw pass
let tRay = 0, tDraw = 0;          // debug phase timers (ms)

// Per-row floor invariants: fog/density/haze depend only on the row, never the column.
function buildFloorRows(horizon) {
  const posZ = camZ * canvasH;
  const amb = todAmb;
  for (let r = 0; r < ROWS; r++) {
    const p = r * CHAR_H + CHAR_H * 0.5 - horizon;
    let d = 1e9, fog = FMINE, dens = 0.62;
    if (p > 0) {
      d = posZ / p;
      fog = Math.max(FMINE, 1 - d / FOGE);
      dens = Math.max(0.62, 1 - d / NEAR);
    }
    rowDist[r] = d; rowDens[r] = dens;
    const i1f = 1 - fog;
    rowHazeCh[r] = 1 + shadeI(0.5 * dens);
    rowHazeKey[r] = fogKey(60 * 0.5 * amb, 95 * 0.5 * amb, 60 * 0.5 * amb, fog, i1f);
    PK_PARK[r] = fogKey(70 * AL_PARK * amb, 205 * AL_PARK * amb, 85 * AL_PARK * amb, fog, i1f);
    PK_LANE[r] = fogKey(240 * amb, 205 * amb, 80 * amb, fog, i1f);
    PK_CURB[r] = fogKey(132 * AL_CURB * amb, 134 * AL_CURB * amb, 142 * AL_CURB * amb, fog, i1f);
    PK_ASPH[r] = fogKey(64 * AL_ASPH * amb, 66 * AL_ASPH * amb, 74 * AL_ASPH * amb, fog, i1f);
    PK_DIRT[r] = fogKey(125 * AL_DIRT * amb, 110 * AL_DIRT * amb, 72 * AL_DIRT * amb, fog, i1f);
  }
}

function render(horizon) {
  const t0 = DEBUG ? performance.now() : 0;
  FOGE = weather === 1 ? FOG * 0.8 : FOG;               // rain shortens visibility
  FMINE = weather === 1 ? Math.min(0.75, FOG_MIN + 0.15) : FOG_MIN;
  const starT = todStar + (weather === 1 ? 0.04 : 0);    // no stars through rain clouds
  charBuf.fill(C_SPACE);                     // safety net: sky/walls/floor repaint every cell anyway
  buildFloorRows(horizon);
  const wallRowBot = Math.min(ROWS - 1, Math.floor(horizon / CHAR_H));

  for (let c = 0; c < COLS; c++) {
    const camX = 2 * c / COLS - 1;
    const rdx = DIR.x + PLANE.x * camX;
    const rdy = DIR.y + PLANE.y * camX;

    let mapX = Math.floor(P.x), mapY = Math.floor(P.y);
    const ddx = rdx === 0 ? 1e30 : Math.abs(1 / rdx);
    const ddy = rdy === 0 ? 1e30 : Math.abs(1 / rdy);
    let stepX, stepY, sdx, sdy;
    if (rdx < 0) { stepX = -1; sdx = (P.x - mapX) * ddx; }
    else { stepX = 1; sdx = (mapX + 1 - P.x) * ddx; }
    if (rdy < 0) { stepY = -1; sdy = (P.y - mapY) * ddy; }
    else { stepY = 1; sdy = (mapY + 1 - P.y) * ddy; }

    // --- Cast the ray and collect EVERY building hit, so a near short building
    //     reveals taller buildings behind it instead of hiding them in the sky.
    //     Only primitives are stored here; colors are computed lazily at paint time
    //     and only for walls that actually cover visible rows. ---
    let side = 0, wallN = 0;
    for (let i = 0; i < 256; i++) {
      if (sdx < sdy) { sdx += ddx; mapX += stepX; side = 0; }
      else { sdy += ddy; mapY += stepY; side = 1; }
      if (mapX < 0 || mapY < 0 || mapX >= 256 || mapY >= 256) break;
      const mi = mapY * 256 + mapX;
      const cc = WORLD[mi];
      if (cc !== 0 && cc !== 4) {
        let perp = side === 0
          ? (mapX - P.x + (1 - stepX) * 0.5) / rdx
          : (mapY - P.y + (1 - stepY) * 0.5) / rdy;
        if (perp < 0.02) perp = 0.02;
        const wallX = side === 0 ? P.y + perp * rdy : P.x + perp * rdx;
          // orig: horizon - hcells*canvasH/perp (no eye-height term); the +0.5 -camZ
          // keeps that baseline exactly while letting altitude sink tops when flying
          const yTop = horizon - (Math.max(1, HEIGHT[mi] || 1) * 0.5 + 0.5 - camZ) * canvasH / perp;
        if (wallN < MAXW) {
          poolPerp[wallN] = perp;
          poolSide[wallN] = side;
          poolWallX[wallN] = wallX;
          poolYTop[wallN] = yTop;
          poolIdx[wallN] = mi;
          let wt = Math.floor(yTop / CHAR_H);
          poolTop[wallN] = wt < 0 ? 0 : wt;
          wallN++;
        }
        if (yTop <= 0) break;   // nearest wall already reaches screen top: nothing farther can show
        if (perp > MAX_DIST) break;
      }
    }
    colDepth[c] = wallN ? poolPerp[0] : MAX_DIST;

    let topWallRow = wallRowBot + 1;   // default (no buildings): sky down to horizon
    for (let k = 0; k < wallN; k++) if (poolTop[k] < topWallRow) topWallRow = poolTop[k];

    // --- Sky: colored night gradient + stars (above the highest building).
    //     Gradient color comes from a precomputed (row, topWallRow-bucket) table and
    //     per-cell dither only affects the glyph, so sky rows draw as long runs. ---
    let twb = Math.round(topWallRow / SKY_BSTEP);  // gradient table bucket
    if (twb >= skyBuckets) twb = skyBuckets - 1;
    const sBase = twb * ROWS;
    let i = c;
    for (let r = 0; r < topWallRow; r++, i += COLS) {
      if (skyStar[i] > starT) {
        charBuf[i] = C_STAR;
        colBuf[i] = KEY_STAR;
      } else {
        charBuf[i] = 1 + shadeI(skyG[sBase + r] * (0.75 + 0.25 * skyDither[i]));
        colBuf[i] = skyKey[sBase + r];
      }
    }

    // --- Buildings: paint nearest-first, clipping each wall to only the rows not
    //     yet covered by a nearer wall. Every screen row is computed exactly once
    //     while a taller building behind a shorter near one still pokes above its
    //     roof. Styles are built only for walls that actually paint. ---
    let coveredTop = wallRowBot + 1;   // lowest row still unpainted
    for (let k = 0; k < wallN; k++) {
      const top = poolTop[k];
      if (top >= coveredTop) continue;            // fully occluded by nearer walls
      const bot = coveredTop - 1;
      const idx = poolIdx[k];
      const perp = poolPerp[k];
      const fog = Math.max(FMINE, 1 - perp / FOGE);
      const i1f = 1 - fog;
      const dens = Math.max(0.62, 1 - perp / NEAR);
      const farWall = fog < 0.5;                  // distant facades: smooth, no windows
      const ss = poolSide[k] === 1 ? 0.72 : 1;
      const fc = FACADE_PAL[B_FAC[idx]];
      const wt = WPAL[B_WPI[idx]];
      const f0 = fc[0] * todAmb, f1 = fc[1] * todAmb, f2 = fc[2] * todAmb;
      const farCh = 1 + shadeI(0.62 * dens), farKey = fogKey(f0 * 0.88 * ss, f1 * 0.88 * ss, f2 * 0.88 * ss, fog, i1f);
      const mullCh = 1 + shadeI(0.66 * dens), mullKey = fogKey(f0 * 0.95 * ss, f1 * 0.95 * ss, f2 * 0.95 * ss, fog, i1f);
      const darkCh = 1 + shadeI(0.5 * dens), darkKey = fogKey(f0 * 0.475 * ss, f1 * 0.475 * ss, f2 * 0.475 * ss, fog, i1f);
      const litCh = 1 + shadeI(1.0 * dens), litKey = fogKey(wt[0] * 1.7 * ss, wt[1] * 1.7 * ss, wt[2] * 1.7 * ss, fog, i1f);

      const yTop = poolYTop[k];
      const invSpan = 1 / Math.max(1, horizon - yTop);
      const dVT = CHAR_H * invSpan;
      const wallXF = poolWallX[k] - Math.floor(poolWallX[k]);
      const mx = idx & 255, my = idx >> 8;
      const wc = wallXF * B_WC[idx];
      const wcI = Math.floor(wc);
      const wcf = wc - wcI;
      const inWinCol = wcf > 0.16 && wcf < 0.84;
      const thr = B_THR[idx] + todLift;        // day: far fewer windows lit
      const wrScale = Math.max(1, HEIGHT[idx] || 1) * 0.5 * B_WR[idx];
      // Neon sign band (facade.js): constant per wall; rows inside [sR, sR+SIGN_BAND)
      // get the cycling colour (or a dark buzzed-out tube).
      let sR = -1, sKey = 0;
      if (facadeAnim && B_SIGNR[idx] >= 0) {
        sR = B_SIGNR[idx];
        const np = NEON_PAL[B_SIGNC[idx]];
        const ph = Math.floor(simTime * 2 + B_SIGNPH[idx] * 97);
        const buzz = hash3(idx & 255, idx >> 8, ph) < 0.06;
        sKey = buzz ? fogKey(np[0] * 0.14, np[1] * 0.14, np[2] * 0.14, fog, i1f)
                    : fogKey(np[0], np[1], np[2], fog, i1f);
      }
      const invWrScale = sR >= 0 ? 1 / wrScale : 0;
      let wr = (top * CHAR_H + CHAR_H * 0.5 - yTop) * invSpan * wrScale;
      const dWR = dVT * wrScale;
      let ri = top * COLS + c;
      for (let r = top; r <= bot; r++, ri += COLS) {
        const wrI = Math.floor(wr);
        const cyf = wr - wrI;
        let ch, key;
        if (farWall) { ch = farCh; key = farKey; }
        else {
          const inWin = inWinCol && cyf > 0.18 && cyf < 0.82;
          if (inWin) {
            let wkey = wcI * 31 + wrI;
            // blinker windows rehash every 3 s; with facades off the key is
            // byte-identical to the static renderer
            if (facadeAnim && ((wcI * 31 + wrI * 7 + mx + my) & 15) === 0) wkey ^= simTB;
            if (hash3(mx * 7 + 1, my * 13 + 3, wkey) > thr) { ch = litCh; key = litKey; }
            else { ch = darkCh; key = darkKey; }
          } else { ch = mullCh; key = mullKey; }
        }
        if (sR >= 0) {
          const vt = wr * invWrScale;
          if (vt >= sR && vt < sR + SIGN_BAND) { ch = (r & 1) ? 4 : 3; key = sKey; }
        }
        charBuf[ri] = ch;
        colBuf[ri] = key;
        wr += dWR;
      }
      coveredTop = top;
    }

    // --- Floor: perspective surface sampling below the wall base. Surface COLOR is
    //     per (type, row-fog); grass/asphalt noise and the sidewalk checker only
    //     modulate the glyph, keeping color runs long. ---
    i = (wallRowBot + 1) * COLS + c;
    for (let r = wallRowBot + 1; r < ROWS; r++, i += COLS) {
      const rd = rowDist[r];
      let fx, fy;
      if (rd > MAX_DIST || (fx = Math.floor(P.x + rd * rdx), fy = Math.floor(P.y + rd * rdy), fx < 0 || fy < 0 || fx >= 256 || fy >= 256)) {
        charBuf[i] = rowHazeCh[r];                 // far haze at the horizon so the ground stays visible
        colBuf[i] = rowHazeKey[r];
        continue;
      }
      const ci = fy * 256 + fx;
      const cw = WORLD[ci];
      if (cw === 4) {                              // lush park grass
        let al = AL_PARK + 0.82 * 0.3 * (grassNoise[ci] - 0.5);
        if ((fx & 1) ^ (fy & 1)) al *= 0.9;
        charBuf[i] = 1 + shadeI(al * rowDens[r]);
        colBuf[i] = PK_PARK[r];
      } else if (cw === 0) {                       // ROAD: asphalt / lane line / curb
        const rt = ROADTYPE[ci];
        if (rt === 1) {                            // lane center line (yellow)
          charBuf[i] = CH_LANE;
          colBuf[i] = PK_LANE[r];
        } else if (rt === 2) {                     // curb / road edge
          charBuf[i] = 1 + shadeI(AL_CURB * rowDens[r]);
          colBuf[i] = PK_CURB[r];
        } else {                                   // asphalt speckle
          charBuf[i] = 1 + shadeI((AL_ASPH + 0.34 * 0.4 * (grassNoise[ci] - 0.5)) * rowDens[r]);
          colBuf[i] = PK_ASPH[r];
        }
      } else {                                      // dirt / sidewalk at building base
        let al = AL_DIRT + 0.68 * 0.3 * (grassNoise[ci] - 0.5);
        if ((fx & 1) ^ (fy & 1)) al *= 0.9;
        charBuf[i] = 1 + shadeI(al * rowDens[r]);
        colBuf[i] = PK_DIRT[r];
      }
    }
  }

  // --- Billboards: streetlamps + traffic cars, projected once, depth-sorted
  //     together (painter's order: far drawn first, near overwrites) and occluded
  //     per column by colDepth. ---
  let visN = 0;
  const invDet = 1 / (PLANE.x * DIR.y - DIR.x * PLANE.y);
  if (lampsOn) {
    for (let i = 0; i < LAMPS.length; i++) {
      const L = LAMPS[i];
      const dx = L.x - P.x, dy = L.y - P.y;
      const tX = invDet * (DIR.y * dx - DIR.x * dy);
      const tY = invDet * (-PLANE.y * dx + PLANE.x * dy);   // perp depth
      if (tY <= 0.15) continue;
      const cc = (COLS / 2) * (1 + tX / tY);
      if (cc < -3 || cc > COLS + 2) continue;
      if (tY > MAX_DIST) continue;
      const v = lampObjs[i];
      v.c = cc; v.tY = tY;
      visBuf[visN++] = v;
    }
  }
  if (trafficOn) visN = cullTraffic(invDet, visN, visBuf);
  if (visN) {
    visBuf.length = visN;
    visBuf.sort(byDepthDesc);
    for (let i = 0; i < visN; i++) {
      const v = visBuf[i];
      const c0 = Math.round(v.c);
      if (c0 < 0 || c0 >= COLS) continue;
      if (v.tY > colDepth[c0]) continue;                   // behind a building in this column
      if (v.k === 1) drawCar(v.c, v.tY, v.i, v.front, horizon);
      else drawLamp(v.c, v.tY, horizon);
    }
  }

  // --- Weather overlay: screen-space particles in front of everything ---
  if (weather) drawWeather();

  const t1 = DEBUG ? performance.now() : 0;

  // --- Render: merge horizontal runs with identical color (chars may differ) and
  //     emit one fillText per run. Runs compare integer keys: no string work until here. ---
  CTX.fillStyle = '#000';
  CTX.fillRect(0, 0, canvasW, canvasH);
  for (let r = 0; r < ROWS; r++) {
    const base = r * COLS;
    const y = r * CHAR_H;
    let c = 0;
    while (c < COLS) {
      if (charBuf[base + c] === C_SPACE) { c++; continue; }
      const key = colBuf[base + c];
      let cc = c + 1;
      while (cc < COLS && charBuf[base + cc] !== C_SPACE && colBuf[base + cc] === key) cc++;
      CTX.fillStyle = colorOf(key);
      if (cc - c === 1) {
        CTX.fillText(CHARS[charBuf[base + c]], c * CHAR_W, y);
      } else {
        const n = cc - c;
        if (n > runBuf.length) runBuf.length = n;
        for (let k = c, j = 0; k < cc; k++, j++) runBuf[j] = CHARS[charBuf[base + k]];
        runBuf.length = n;
        CTX.fillText(runBuf.join(''), c * CHAR_W, y);
      }
      c = cc;
    }
  }
  drawMap();

  if (DEBUG) {
    const t2 = performance.now();
    tRay = tRay * 0.9 + (t1 - t0) * 0.1;
    tDraw = tDraw * 0.9 + (t2 - t1) * 0.1;
  }
}

let last = performance.now(), fps = 0, fpsAcc = 0, fpsN = 0, fc = 0;
const pv = { x: NaN, y: NaN, angle: NaN, pitch: NaN, mapMode: -1, lampsOn: null, camZ: NaN, flyMode: null };
function updateHUD() {
  HUD.textContent =
    `FPS ${fps} · WASD move · ←→ turn · ↑↓ look · M map · L lamps(${lampsOn ? 'on' : 'off'}) · F fly${flyMode ? '(on)' : ''} · P settings · ${fmtClock(tod)}${weather ? ' ' + (weather === 1 ? 'rain' : 'snow') : ''} · ${P.x.toFixed(0)},${P.y.toFixed(0)} · ${angle.toFixed(2)}` +
    (DEBUG ? ` · ray ${tRay.toFixed(1)}ms · draw ${tDraw.toFixed(1)}ms` : '');
}
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  fpsAcc += dt; fpsN++;
  if (fpsAcc >= 0.5) { fps = Math.round(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0; }
  fc++;

  // --- Input ---
  const rot = 2.2 * dt;
  if (KEYS['arrowleft']) angle -= rot;
  if (KEYS['arrowright']) angle += rot;
  DIR.x = Math.cos(angle); DIR.y = Math.sin(angle);
  PLANE.x = -DIR.y * FOV; PLANE.y = DIR.x * FOV;

  const pitchSpd = 220 * dt;
  if (KEYS['arrowup']) pitch = Math.min(canvasH * 0.45, pitch + pitchSpd);
  if (KEYS['arrowdown']) pitch = Math.max(-canvasH * 0.45, pitch - pitchSpd);

  const mv = 6.0 * dt;
  let mx = 0, my = 0;
  if (KEYS['w']) { mx += DIR.x * mv; my += DIR.y * mv; }
  if (KEYS['s']) { mx -= DIR.x * mv; my -= DIR.y * mv; }
  if (KEYS['a']) { mx += DIR.y * mv; my -= DIR.x * mv; }
  if (KEYS['d']) { mx -= DIR.y * mv; my += DIR.x * mv; }
  if (flyMode) { P.x += mx; P.y += my; }        // no-clip
  else {
    if (!isWall(P.x + mx, P.y)) P.x += mx;
    if (!isWall(P.x, P.y + my)) P.y += my;
  }
  P.x = Math.max(0.5, Math.min(255.5, P.x));
  P.y = Math.max(0.5, Math.min(255.5, P.y));

  // --- Altitude: Space/Shift while flying; ease back to eye level on touch-down ---
  if (flyMode) {
    const vz = 8.0 * dt;
    if (KEYS[' ']) camZ += vz;
    if (KEYS['shift']) camZ -= vz;
    camZ = Math.max(0.08, Math.min(30, camZ));
  } else if (camZ !== 0.5) {
    camZ += (0.5 - camZ) * Math.min(1, dt * 8);
    if (Math.abs(camZ - 0.5) < 0.004) camZ = 0.5;
  }

  // --- Animators ---
  AudioAPI.step(dt, mx !== 0 || my !== 0, flyMode, weather);
  weatherFrame(dt);
  if (trafficOn) updateTraffic(dt);
  facadeFrame();

  // --- Dirty-frame skip: when no animator is running, a scene with unchanged
  //     camera/toggles keeps the last frame on the canvas untouched. ---
  if (P.x !== pv.x || P.y !== pv.y || angle !== pv.angle || pitch !== pv.pitch ||
      mapMode !== pv.mapMode || lampsOn !== pv.lampsOn || camZ !== pv.camZ || flyMode !== pv.flyMode ||
      trafficOn || facadeAnim || todAuto || weather > 0) needRender = true;

  if (needRender) {
    render(Math.floor(canvasH / 2 + pitch));
    pv.x = P.x; pv.y = P.y; pv.angle = angle; pv.pitch = pitch;
    pv.mapMode = mapMode; pv.lampsOn = lampsOn; pv.camZ = camZ; pv.flyMode = flyMode;
    needRender = false;
  }
  if (fc % 10 === 0) updateHUD();
// --- Settings registration (panel is the single source of truth; L key and the
//     panel checkbox both go through Settings.set so they never desync) ---
Settings.define('fontSize', { label: 'Font size', type: 'select', options: [7, 9, 11, 13], default: 9, fmt: v => v + 'px', coerce: Number },
  v => { FONT_SIZE = v; resize(); });
Settings.define('fov', { label: 'Field of view', type: 'range', min: 0.4, max: 1.0, step: 0.02, default: 0.66 },
  v => { FOV = v; needRender = true; });
Settings.define('fogRange', { label: 'Fog range', type: 'range', min: 60, max: 200, step: 5, default: 120 },
  v => { FOG = v; needRender = true; });
Settings.define('fogMin', { label: 'Fog floor', type: 'range', min: 0, max: 0.7, step: 0.05, default: 0.45 },
  v => { FOG_MIN = v; needRender = true; });
Settings.define('nearRange', { label: 'Near falloff', type: 'range', min: 15, max: 50, step: 1, default: 35 },
  v => { NEAR = v; needRender = true; });
Settings.define('lamps', { label: 'Streetlamps', type: 'checkbox', default: true },
  v => { lampsOn = v; needRender = true; });
Settings.define('showHud', { label: 'Show HUD', type: 'checkbox', default: true },
  v => { HUD.style.display = v ? '' : 'none'; });
Settings.init();
requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

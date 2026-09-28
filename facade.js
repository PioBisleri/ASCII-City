// ==== FACADE: animated windows + neon signs ====
// Window animation: ~1/16 of windows ("blinkers", cheap slot arithmetic) rehash
// every 3 seconds so distant facades twinkle; the other 15/16 are byte-identical
// to the static look. Neon: a hashed subset of commercial/downtown buildings gets
// a sign band whose colour cycles and occasionally buzzes off.
// main.js's wall loop reads these globals at render time (facadeAnim, simTB,
// simTime, SIGN_BAND, B_SIGN*, NEON_PAL).
let facadeAnim = true;                 // settings-backed (default on)
let simTB = 0;                         // window blink time bucket (3 s)
let simTime = 0;                       // seconds, drives neon cycling

const SIGN_BAND = 0.055;               // sign height as a fraction of facade height
const NEON_PAL = [
  [255, 60, 120], [60, 255, 200], [255, 210, 50],
  [120, 140, 255], [255, 90, 60], [205, 85, 255],
];

// Per-building sign placement (own hash so this file never depends on main.js)
const B_SIGNR = new Float32Array(256 * 256).fill(-1);
const B_SIGNC = new Uint8Array(256 * 256);
const B_SIGNPH = new Float32Array(256 * 256);
(function buildSigns() {
  const h = (a, b, c) => {
    let n = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 1274126177)) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    n = n ^ (n >>> 16);
    return ((n >>> 0) % 1000) / 1000;
  };
  for (let i = 0; i < 256 * 256; i++) {
    const c = WORLD[i];
    if (c !== 2 && c !== 3) continue;                    // commercial & downtown only
    const mx = i & 255, my = i >> 8;
    if (h(mx * 19 + 6, my * 7 + 2, 11) >= 0.35) continue; // ~35% get a sign
    B_SIGNR[i] = 0.15 + h(mx * 5 + 3, my * 9 + 4, 12) * 0.4;
    B_SIGNC[i] = Math.floor(h(mx * 3 + 8, my * 13 + 6, 13) * NEON_PAL.length) % NEON_PAL.length;
    B_SIGNPH[i] = h(mx * 11 + 9, my * 17 + 5, 14);
  }
})();

// Called once per frame from main.js before render().
function facadeFrame() {
  simTime = performance.now() / 1000;
  simTB = Math.floor(simTime / 3);
}

Settings.define('facades', { label: 'Animated facades', type: 'checkbox', default: true },
  v => { facadeAnim = v; needRender = true; });

// ==== TRAFFIC: ASCII cars driving the road grid ====
// Cars commit cell-to-cell along road cells (WORLD === 0) with a right-hand lane
// offset, prefer going straight at intersections, and render as depth-sorted
// billboards in main.js's lamp pass (shared painter order + colDepth occlusion).
let trafficOn = true;                   // settings-backed (default on)

const N_TRAFFIC = 160;
const carPX = new Float32Array(N_TRAFFIC);   // position in cells (float)
const carPY = new Float32Array(N_TRAFFIC);
const carTX = new Float32Array(N_TRAFFIC);   // current segment target
const carTY = new Float32Array(N_TRAFFIC);
const carMX = new Uint8Array(N_TRAFFIC);     // cell the car is committed to
const carMY = new Uint8Array(N_TRAFFIC);
const carDIR = new Uint8Array(N_TRAFFIC);    // 0=E 1=S 2=W 3=N
const carSPD = new Float32Array(N_TRAFFIC);  // cells / second
const carCOL = new Uint8Array(N_TRAFFIC);    // palette index

const TRAFFIC_PAL = [[235, 235, 238], [150, 155, 165], [245, 200, 70], [205, 70, 60], [90, 130, 190], [80, 85, 95]];
const TDIR = [[1, 0], [0, 1], [-1, 0], [0, -1]];   // E S W N

// Billboard records (pooled; k=1 tags a car in main.js's unified visBuf)
const carObjs = new Array(N_TRAFFIC);
for (let i = 0; i < N_TRAFFIC; i++) carObjs[i] = { c: 0, tY: 0, k: 1, i: i, front: 1 };

function pickNextCar(i) {
  const cx = carMX[i], cy = carMY[i], d = carDIR[i];
  const o = [0, 0, 0, 0];
  let open = 0;
  for (let nd = 0; nd < 4; nd++) {
    const nx = cx + TDIR[nd][0], ny = cy + TDIR[nd][1];
    if (nx >= 1 && ny >= 1 && nx < 255 && ny < 255 && WORLD[ny * 256 + nx] === 0) o[open++] = nd;
  }
  const rev = (d + 2) & 3;
  let nd;
  if (open === 0) nd = rev;
  else {
    let pick = -1;
    if (Math.random() < 0.65) {                             // usually continue straight
      for (let k = 0; k < open; k++) if (o[k] === d) { pick = d; break; }
    }
    if (pick < 0) {
      for (let t = 0; t < 8 && pick < 0; t++) {             // otherwise random, avoid reversing
        const cand = o[(Math.random() * open) | 0];
        if (cand !== rev || open === 1) pick = cand;
      }
      if (pick < 0) pick = o[0];
    }
    nd = pick;
  }
  carDIR[i] = nd;
  const nx = cx + TDIR[nd][0], ny = cy + TDIR[nd][1];
  if (WORLD[ny * 256 + nx] !== 0) {                         // safety: never commit off-road
    carTX[i] = cx + 0.5; carTY[i] = cy + 0.5; return;
  }
  carMX[i] = nx; carMY[i] = ny;
  const rx = -TDIR[nd][1] * 0.22, ry = TDIR[nd][0] * 0.22;  // right-hand lane offset
  carTX[i] = nx + 0.5 + rx;
  carTY[i] = ny + 0.5 + ry;
}

(function initTraffic() {
  const cand = [];
  for (let y = 1; y < 255; y++) for (let x = 1; x < 255; x++) {
    if (WORLD[y * 256 + x] !== 0) continue;
    for (let d = 0; d < 4; d++) {
      const nx = x + TDIR[d][0], ny = y + TDIR[d][1];
      if (WORLD[ny * 256 + nx] === 0) { cand.push(y * 256 + x); break; }
    }
  }
  for (let i = 0; i < N_TRAFFIC; i++) {
    const ci = cand[(Math.random() * cand.length) | 0];
    const x = ci & 255, y = ci >> 8;
    carMX[i] = x; carMY[i] = y;
    carPX[i] = x + 0.5; carPY[i] = y + 0.5;
    carDIR[i] = (Math.random() * 4) | 0;
    carSPD[i] = 3.5 + Math.random() * 3.0;
    carCOL[i] = (Math.random() * TRAFFIC_PAL.length) | 0;
    pickNextCar(i);                    // commit first segment; pos stays at the start cell
  }
})();

function updateTraffic(dt) {
  for (let i = 0; i < N_TRAFFIC; i++) {
    const dx = carTX[i] - carPX[i], dy = carTY[i] - carPY[i];
    const d2 = dx * dx + dy * dy;
    const step = carSPD[i] * dt;
    if (d2 <= step * step || d2 < 1e-12) {
      carPX[i] = carTX[i]; carPY[i] = carTY[i];
      pickNextCar(i);
    } else {
      const inv = step / Math.sqrt(d2);
      carPX[i] += dx * inv; carPY[i] += dy * inv;
    }
  }
}

// Project visible cars into main.js's visBuf; also resolves the headlight side
// by projecting a point 0.6 cells ahead of the car.
function cullTraffic(invDet, visN, visBuf) {
  for (let i = 0; i < N_TRAFFIC; i++) {
    const dx = carPX[i] - P.x, dy = carPY[i] - P.y;
    const tX = invDet * (DIR.y * dx - DIR.x * dy);
    const tY = invDet * (-PLANE.y * dx + PLANE.x * dy);
    if (tY <= 0.15 || tY > MAX_DIST) continue;
    const cc = (COLS / 2) * (1 + tX / tY);
    const margin = 1.5 + (0.6 * canvasH / tY) / CHAR_W;
    if (cc < -margin || cc > COLS + margin) continue;
    const v = carObjs[i];
    v.c = cc; v.tY = tY;
    const ax = dx + TDIR[carDIR[i]][0] * 0.6, ay = dy + TDIR[carDIR[i]][1] * 0.6;
    const tX2 = invDet * (DIR.y * ax - DIR.x * ay);
    const tY2 = invDet * (-PLANE.y * ax + PLANE.x * ay);
    v.front = (COLS / 2) * (1 + tX2 / Math.max(0.2, tY2)) >= cc ? 1 : -1;
    visBuf[visN++] = v;
  }
  return visN;
}

// Draw one car billboard: roof row(s), body row with headlight '*' at the front
// end and taillight ':' at the rear. Chars are CHARSET ramp indices.
function drawCar(cx, tY, i, front, horizon) {
  const fog = Math.max(FMINE, 1 - tY / FOGE);
  const i1f = 1 - fog;
  const hpx = canvasH / tY;
  const baseR = (horizon + camZ * canvasH / tY) / CHAR_H;
  const halfCols = Math.round((0.95 * hpx) / (2 * CHAR_W));
  let r0 = Math.ceil(baseR - (0.5 * hpx) / CHAR_H);
  let r1 = Math.floor(baseR);
  if (r0 < 0) r0 = 0;
  if (r0 >= ROWS || c0Off(cx, halfCols)) return;
  if (r1 < r0) r1 = r0;
  if (r1 >= ROWS) r1 = ROWS - 1;
  const c0 = Math.round(cx);
  const pal = TRAFFIC_PAL[carCOL[i]];
  const bodyKey = packRGB(pal[0] * fog + 40 * i1f, pal[1] * fog + 40 * i1f, pal[2] * fog + 45 * i1f);
  const roofKey = packRGB(pal[0] * fog + 90 * i1f, pal[1] * fog + 90 * i1f, pal[2] * fog + 95 * i1f);
  const headKey = packRGB(255 * fog + 140 * i1f, 245 * fog + 138 * i1f, 195 * fog + 115 * i1f);
  const tailKey = packRGB(215 * fog + 75 * i1f, 45 * fog + 25 * i1f, 45 * fog + 25 * i1f);
  const single = r0 === r1;
  for (let r = r0; r <= r1; r++) {
    const isTop = r === r0, isBot = r === r1;
    for (let dc = -halfCols; dc <= halfCols; dc++) {
      const cc = c0 + dc;
      if (cc < 0 || cc >= COLS) continue;
      if (tY > colDepth[cc]) continue;
      let ch, key;
      if (single) { ch = 5; key = bodyKey; }                          // '%'
      else if (isTop) { ch = halfCols >= 1 ? 5 : 3; key = roofKey; }  // '%' / '!'
      else if (isBot && Math.abs(dc) === halfCols) {
        if (dc * front > 0) { ch = 4; key = headKey; }                // '*'
        else if (dc * front < 0) { ch = 2; key = tailKey; }           // ':'
        else { ch = 4; key = headKey; }
      } else if (isBot) { ch = 6; key = bodyKey; }                    // '#'
      else { ch = 6; key = bodyKey; }
      const idx = r * COLS + cc;
      charBuf[idx] = ch;
      colBuf[idx] = key;
    }
  }
}

function c0Off(cx, halfCols) {
  const c0 = Math.round(cx);
  return c0 + halfCols < 0 || c0 - halfCols >= COLS;
}

Settings.define('traffic', { label: 'Traffic', type: 'checkbox', default: true },
  v => { trafficOn = v; needRender = true; });

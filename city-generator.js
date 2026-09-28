// ==== PRNG ====
function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ==== PERLIN NOISE (2D, improved) ====
class Perlin {
  constructor(seed) {
    this.perm = new Uint8Array(512);
    const rng = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }
  fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  lerp(a, b, t) { return a + t * (b - a); }
  grad(hash, x, y) {
    const h = hash & 3;
    const u = h < 2 ? x : y;
    const v = h < 2 ? y : x;
    return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
  }
  noise(x, y) {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    x -= Math.floor(x); y -= Math.floor(y);
    const u = this.fade(x), v = this.fade(y);
    const A = this.perm[X] + Y, B = this.perm[X + 1] + Y;
    return this.lerp(
      this.lerp(this.grad(this.perm[A], x, y), this.grad(this.perm[B], x - 1, y), u),
      this.lerp(this.grad(this.perm[A + 1], x, y - 1), this.grad(this.perm[B + 1], x - 1, y - 1), u),
      v
    );
  }
  ridge(x, y) { return 1 - Math.abs(this.noise(x, y)); }
}

// ==== CITY GENERATOR ====
const W = 256, H = 256;
const WORLD = new Uint8Array(W * H);   // 0=road, 1=res, 2=comm, 3=downtown, 4=park
const HEIGHT = new Uint16Array(W * H); // 0..60 stories
const IDX = (x, y) => y * W + x;

function generateCity(seed = 0xC0FFEE) {
  const n = new Perlin(seed);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = (n.noise(x / 64, y / 64) + 1) * 0.5;
      const h = (n.noise(x / 16, y / 16) + 1) * 0.5;
      const r = n.ridge(x / 32, y / 32);
      const dtl = n.noise(x / 4, y / 4);

      if (r > 0.68) { WORLD[IDX(x, y)] = 0; HEIGHT[IDX(x, y)] = 0; continue; }

      let zone, baseH;
      if (d < 0.25) { zone = 4; baseH = 0; }
      else if (d < 0.45) { zone = 1; baseH = 2 + Math.floor(h * 6); }
      else if (d < 0.70) { zone = 2; baseH = 10 + Math.floor(h * 20); }
      else { zone = 3; baseH = 30 + Math.floor(h * 30); }

      let finalH = Math.floor(baseH * (0.5 + h * 0.5) + dtl * 2);
      if (zone === 3) finalH = Math.max(0, Math.min(finalH, 60));
      else if (zone === 2) finalH = Math.max(0, Math.min(finalH, 30));
      else if (zone === 1) finalH = Math.max(0, Math.min(finalH, 8));
      else finalH = 0;

      WORLD[IDX(x, y)] = zone;
      HEIGHT[IDX(x, y)] = finalH;
    }
  }
}

// ==== DEBUG: ASCII OVERHEAD DUMP ====
function dumpOverhead() {
  const chars = [' ', '░', '▒', '▓', '█', '█'];
  let out = '';
  for (let y = 0; y < H; y += 4) {
    let line = '';
    for (let x = 0; x < W; x += 4) {
      const w = WORLD[IDX(x, y)];
      line += chars[w] || '?';
    }
    out += line + '\n';
  }
  console.log(out);
}

// Run
generateCity();
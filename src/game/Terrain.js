import { mulberry32 } from '../engine/geometry.js';

/**
 * Landscape generator: the world comes first and the track is laid onto it. Each theme gets its
 * own terrain — rolling hills with tall round peaks, desert mesas with sheer cliffs, jagged snowy
 * ranges, a giant volcano with lava lakes… The road then follows this ground (see Track), with
 * tunnels where mountains are in the way, viaducts over valleys and cliff cuttings on slopes.
 *
 * `height(x, z)` is a pure function of the seed, so every peer builds the same world.
 */
const PROFILES = {
  // amp/scale: fractal noise; peaks: [count, minH, maxH, minR, maxR, sharpness]
  meadow: { amp: 16, scale: 190, peaks: [6, 30, 75, 60, 130, 1.3], water: -5, snow: Infinity },
  desert: { amp: 20, scale: 230, peaks: [7, 28, 58, 55, 120, 2.6], terrace: 13, water: -Infinity, snow: Infinity },
  snow: { amp: 26, scale: 210, peaks: [9, 55, 125, 80, 170, 1.1], ridged: true, water: -7, snow: 38 },
  mushroom: { amp: 18, scale: 180, peaks: [7, 35, 85, 50, 110, 1.6], water: -5, snow: Infinity },
  beach: { amp: 9, scale: 200, peaks: [3, 22, 45, 60, 120, 1.4], water: -Infinity, snow: Infinity },
  volcano: { amp: 18, scale: 200, peaks: [4, 35, 70, 60, 120, 1.2], volcano: true, lava: -4, water: -Infinity, snow: Infinity },
  ghost: { amp: 15, scale: 170, peaks: [5, 30, 65, 60, 120, 1.5], water: -4, snow: Infinity },
};

const smooth = (t) => t * t * (3 - 2 * t);

export class Terrain {
  constructor(theme, seed) {
    this.theme = theme;
    this.p = PROFILES[theme.id] || PROFILES.meadow;
    const rand = mulberry32((seed ^ 0x7e44a1c3) >>> 0);
    // Random lattice for value noise.
    this.perm = new Uint8Array(512);
    const base = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [base[i], base[j]] = [base[j], base[i]];
    }
    for (let i = 0; i < 512; i++) this.perm[i] = base[i & 255];
    this.vals = new Float32Array(256);
    for (let i = 0; i < 256; i++) this.vals[i] = rand() * 2 - 1;

    const [count, hMin, hMax, rMin, rMax, sharp] = this.p.peaks;
    this.peaks = [];
    for (let k = 0; k < count; k++) {
      this.peaks.push({
        x: (rand() - 0.5) * 1500, z: (rand() - 0.5) * 1500,
        h: hMin + rand() * (hMax - hMin), r: rMin + rand() * (rMax - rMin), sharp,
      });
    }
    if (this.p.volcano) {
      // One giant volcano with a crater, somewhere off to the side.
      const a = rand() * Math.PI * 2, d = 260 + rand() * 200;
      this.volcano = { x: Math.cos(a) * d, z: Math.sin(a) * d, h: 150 + rand() * 30, r: 250 + rand() * 50 };
    }
    // Where the landscape sits under the track; Track tries a few and keeps the best fit.
    this.ox = 0;
    this.oz = 0;
    this.waterLevel = this.p.water;
    this.lavaLevel = this.p.lava ?? -Infinity;
    this.snowLine = this.p.snow;
  }

  setOffset(ox, oz) {
    this.ox = ox;
    this.oz = oz;
  }

  _lattice(ix, iz) {
    return this.vals[this.perm[(this.perm[ix & 255] + iz) & 511]];
  }

  _value(x, z) {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = smooth(x - ix), fz = smooth(z - iz);
    const a = this._lattice(ix, iz), b = this._lattice(ix + 1, iz);
    const c = this._lattice(ix, iz + 1), d = this._lattice(ix + 1, iz + 1);
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
  }

  _fbm(x, z) {
    let sum = 0, amp = 1, f = 1, norm = 0;
    for (let o = 0; o < 4; o++) {
      let v = this._value(x * f + o * 17.3, z * f - o * 9.1);
      if (this.p.ridged) v = 1 - Math.abs(v) * 2; // sharp ridges
      sum += v * amp;
      norm += amp;
      amp *= 0.5;
      f *= 2.03;
    }
    return sum / norm;
  }

  /** Raw landscape height at world (x, z), before the road carves into it. */
  height(x, z) {
    const X = x + this.ox, Z = z + this.oz;
    const p = this.p;
    let h = this._fbm(X / p.scale, Z / p.scale) * p.amp;
    for (const pk of this.peaks) {
      const dx = X - pk.x, dz = Z - pk.z;
      const q = (dx * dx + dz * dz) / (pk.r * pk.r);
      if (q < 9) h += pk.h * Math.exp(-q * pk.sharp);
    }
    if (p.terrace) {
      // Mesas: flatten into steps with steep risers.
      const s = p.terrace;
      const k = Math.floor(h / s), f = h / s - k;
      h = (k + smooth(Math.min(1, Math.max(0, (f - 0.72) / 0.28)))) * s;
    }
    const v = this.volcano;
    if (v) {
      const d = Math.hypot(X - v.x, Z - v.z) / v.r;
      if (d < 1.6) {
        const cone = v.h * Math.max(0, 1 - d) ** 1.5 + v.h * 0.12 * Math.max(0, 1.6 - d) / 1.6;
        const crater = d < 0.14 ? v.h * 0.28 * (1 - (d / 0.14) ** 2) : 0;
        h = Math.max(h, cone - crater);
      }
    }
    return h;
  }

  /** Is (x, z) on the volcano, and how far round its slope (for lava streaks)? */
  volcanoAngle(x, z) {
    const v = this.volcano;
    if (!v) return null;
    const X = x + this.ox, Z = z + this.oz;
    const d = Math.hypot(X - v.x, Z - v.z) / v.r;
    return d < 0.95 ? { d, a: Math.atan2(Z - v.z, X - v.x) } : null;
  }
}

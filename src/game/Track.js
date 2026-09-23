import * as THREE from 'three';
import { RibbonBuilder, box, cylinder, merge, mulberry32, paint } from '../engine/geometry.js';
import { THEMES, rainbowColor, buildScenery, buildGrandstand, buildTireStacks, buildNightSky } from './TrackDecor.js';

// Moving hazard per theme (see Movers.js).
const MOVER_KIND = { meadow: 'cow', desert: 'tumbleweed', snow: 'snowball', mushroom: 'hopper', beach: 'crab', volcano: 'firebar', ghost: 'ghost', rainbow: 'star' };
const WATER_THEMES = new Set(['meadow', 'mushroom', 'beach', 'ghost']);

const S = 1080; // centre-line samples (~2 m apart)
const BASE_WIDTH = 9; // road half-width where width is pinned (start, bridges, tunnels)
const WIDTH_VAR = 1.6; // +/- half-width variation elsewhere
const MAX_HALF_WIDTH = BASE_WIDTH + WIDTH_VAR;
const CURB_WIDTH = 1.6;
const BARRIER_GAP = 1.0; // curb edge → barrier
const MAX_BARRIER = MAX_HALF_WIDTH + CURB_WIDTH + BARRIER_GAP;
const EDGE_STD = BASE_WIDTH + CURB_WIDTH + BARRIER_GAP + 0.7; // deck edge where width is pinned
const BARRIER_STEP = 3; // samples per barrier segment
const CHECKPOINTS = 18; // one every 60 samples
const SHORTCUT_HALF = 3.4; // dirt shortcut half-width
const GROUND_SIZE = 1400;
const OVERPASS_RISE = 7.5;
const BRIDGE_RISE = 5.5;

// Hand-made fallback layout, used if the generator can't find a valid circuit.
const CLASSIC_LAYOUT = [
  [0, -120], [70, -122], [120, -95], [130, -40], [95, -5], [50, 5], [35, 45], [65, 85],
  [55, 125], [5, 135], [-45, 112], [-60, 65], [-105, 45], [-130, -5], [-115, -70], [-65, -112],
].map(([x, z]) => [x * 2.2, z * 2.2]);

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const circ = (i) => ((i % S) + S) % S;
const circDist = (a, b) => {
  const d = Math.abs(circ(a) - circ(b));
  return Math.min(d, S - d);
};
const smooth01 = (t) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};
const TUNNEL_HILL = { width: 26, height: 13 }; // half-width at ground, peak height

/** Layout family from one roll: grid circuits, organic loops, switchbacks, figure-8s. */
const styleFor = (r) => (r < 0.36 ? 'circuit' : r < 0.72 ? 'flowing' : r < 0.93 ? 'switchback' : 'figure8');

/** Box blur on a circular array (used to soften masks). */
function blurCircular(arr, radius, passes) {
  const tmp = new Float32Array(arr.length);
  const n = arr.length;
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let o = -radius; o <= radius; o++) s += arr[(i + o + n) % n];
      tmp[i] = s / (radius * 2 + 1);
    }
    arr.set(tmp);
  }
}

/**
 * Procedurally generated circuit. The layout, terrain, width, features (bridges, overpasses,
 * tunnels, jumps, boost pads, hazards) and scenery all come from one seed, so the host only
 * sends a number and every peer builds the identical track. Also answers progress queries.
 */
export class Track {
  constructor(renderer, physics, seed = 1) {
    this.renderer = renderer;
    this.physics = physics;
    this.samples = S;
    this.halfWidth = BASE_WIDTH;

    this.px = new Float32Array(S);
    this.pz = new Float32Array(S);
    this.tx = new Float32Array(S);
    this.tz = new Float32Array(S);
    this.yaw = new Float32Array(S);
    this.width = new Float32Array(S).fill(BASE_WIDTH); // road half-width per sample
    this.height = new Float32Array(S); // final road elevation
    this.baseHeight = new Float32Array(S); // rolling terrain under the road (no bridges/jumps)
    this.slope = new Float32Array(S); // banking: road rise per metre to the right (tan of bank angle)
    this.checkpointIdx = new Int32Array(CHECKPOINTS);
    for (let k = 0; k < CHECKPOINTS; k++) this.checkpointIdx[k] = Math.round((k * S) / CHECKPOINTS);
    this.checkpointCount = CHECKPOINTS;
    this.lastLateral = 0;
    this.bridges = [];
    this.tunnels = [];
    this.jumps = [];
    this.pads = [];
    this.hazards = [];
    this.movers = [];
    this.shortcuts = [];
    this.crossings = [];

    this.group = null;
    this.wallColliders = [];
    physics.addGround(GROUND_SIZE / 2);
    this.generate(seed);
  }

  // ================================================================== generation

  /** Tear down the current circuit and build a new one from `seed`. */
  generate(seed) {
    this.seed = seed >>> 0;
    const rand = mulberry32(this.seed);
    this.theme = THEMES[Math.floor(rand() * THEMES.length)];
    const t = this.theme;
    this.name = `${t.words[Math.floor(rand() * t.words.length)]} ${t.nouns[Math.floor(rand() * t.nouns.length)]}`;

    // Layout families, loosely modelled on classic kart tracks.
    this.style = styleFor(rand());
    let ok = false;
    for (let attempt = 0; attempt < 160 && !ok; attempt++) {
      const style = attempt < 120 ? this.style : 'circuit';
      const layout = style === 'circuit' ? this._gridLayout(rand)
        : style === 'figure8' ? this._figure8Layout(rand)
          : style === 'switchback' ? this._switchbackLayout(rand)
            : this._randomLayout(rand);
      if (!layout) continue;
      this._computeCenterLine(this._wiggle(layout, rand));
      ok = this._isValid(rand);
      if (ok) this.style = style;
    }
    if (!ok) {
      this._computeCenterLine(CLASSIC_LAYOUT);
      this.crossings = [];
      this.style = 'classic';
    }
    this._planFeatures(rand);

    this._dispose();
    this.group = new THREE.Group();
    this.renderer.scene.add(this.group);
    this._pickMood();
    this.renderer.setAtmosphere(this.sky);
    this._prepareTerrain(rand);
    this._planShortcuts();
    if (!t.space) this._buildGround();
    this._buildRoad();
    this._buildRoadCollider();
    this._buildBarriers();
    this._buildShortcuts();
    this._buildGantry();
    this._buildArches();
    this._buildFeatures();
    this._buildScenery(rand);
    this._computeMinimap();
    this.itemBoxSpots = this._itemBoxSpots();
    this.coinSpots = this._coinSpots();
  }

  /**
   * Cheaply predict a seed's theme and layout family (mirrors the first rolls of generate()),
   * so the host can pick seeds that don't repeat the previous round.
   */
  static peek(seed) {
    const rand = mulberry32(seed >>> 0);
    const theme = THEMES[Math.floor(rand() * THEMES.length)];
    rand(); rand(); // name rolls
    return { theme: theme.id, style: styleFor(rand()) };
  }

  /** Time of day and weather: day / sunset / night, and rain or snowfall on some tracks. */
  _pickMood() {
    const t = this.theme;
    const r = mulberry32(this.seed ^ 0x6d6f6f64);
    const moody = ['meadow', 'desert', 'snow', 'mushroom', 'beach'].includes(t.id);
    const m = r();
    this.mood = moody ? (m < 0.6 ? 'day' : m < 0.8 ? 'sunset' : 'night') : 'day';
    const w = r();
    this.weather = t.id === 'snow' ? (w < 0.5 ? 'snow' : 'none')
      : ['meadow', 'mushroom', 'beach', 'ghost'].includes(t.id) && w < 0.25 ? 'rain' : 'none';
    let sky = { ...t.sky };
    if (this.mood === 'sunset') sky = { ...sky, top: 0x2b3a8f, horizon: 0xff9966, hemi: sky.hemi * 0.8, sun: sky.sun * 0.7 };
    if (this.mood === 'night') sky = { ...sky, top: 0x03050f, horizon: 0x16213f, fogNear: 80, fogFar: 330, hemi: 0.6, sun: 0.45 };
    if (this.weather === 'rain') sky = { ...sky, horizon: 0x7d8a99, top: 0x4a5566, fogNear: sky.fogNear * 0.7, fogFar: sky.fogFar * 0.75, hemi: sky.hemi * 0.85, sun: sky.sun * 0.6 };
    this.sky = sky;
    this.moodLabel = [this.mood !== 'day' ? this.mood[0].toUpperCase() + this.mood.slice(1) : '', this.weather !== 'none' ? this.weather[0].toUpperCase() + this.weather.slice(1) : ''].filter(Boolean).join(' · ');
  }

  _dispose() {
    for (const c of this.wallColliders) this.physics.world.removeCollider(c, false);
    this.wallColliders.length = 0;
    if (!this.group) return;
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.isInstancedMesh) o.dispose();
    });
    this.renderer.scene.remove(this.group);
    this.group = null;
  }

  // ------------------------------------------------------------------ layouts

  /**
   * "Circuit" layout: grow a random polyomino on a coarse grid, trace its outline and round
   * the corners. This produces real straights, 90° corners, U-shaped hairpins and notches.
   */
  _gridLayout(rand) {
    const cols = 4 + Math.floor(rand() * 3); // 4..6
    const rows = 3 + Math.floor(rand() * 2); // 3..4
    const cell = 100 + rand() * 30;
    const key = (x, y) => x + ',' + y;

    const target = Math.max(3, Math.round(cols * rows * (0.45 + rand() * 0.35)));
    const cells = new Set([key(Math.floor(rand() * cols), Math.floor(rand() * rows))]);
    for (let guard = 0; cells.size < target && guard < 400; guard++) {
      const list = [...cells];
      const [cx, cy] = list[Math.floor(rand() * list.length)].split(',').map(Number);
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const [dx, dy] = dirs[Math.floor(rand() * 4)];
      const nx = cx + dx, ny = cy + dy;
      if (nx >= 0 && ny >= 0 && nx < cols && ny < rows) cells.add(key(nx, ny));
    }
    const has = (x, y) => cells.has(key(x, y));

    const next = new Map();
    let edges = 0;
    const addEdge = (ax, ay, bx, by) => {
      const k = key(ax, ay);
      if (next.has(k)) next.set(k, null);
      else next.set(k, [bx, by]);
      edges++;
    };
    for (const c of cells) {
      const [x, y] = c.split(',').map(Number);
      if (!has(x, y - 1)) addEdge(x, y, x + 1, y);
      if (!has(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
      if (!has(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
      if (!has(x - 1, y)) addEdge(x, y + 1, x, y);
    }
    for (const v of next.values()) if (v === null) return null;

    const start = next.keys().next().value.split(',').map(Number);
    const loop = [start];
    let cur = start;
    for (let i = 0; i < edges; i++) {
      const nxt = next.get(key(cur[0], cur[1]));
      if (!nxt) return null;
      if (nxt[0] === start[0] && nxt[1] === start[1]) break;
      loop.push(nxt);
      cur = nxt;
    }
    if (loop.length !== edges) return null;

    const corners = [];
    const n = loop.length;
    for (let i = 0; i < n; i++) {
      const p = loop[(i - 1 + n) % n], c = loop[i], q = loop[(i + 1) % n];
      if ((c[0] - p[0]) * (q[1] - c[1]) - (c[1] - p[1]) * (q[0] - c[0]) !== 0) corners.push(c);
    }
    if (corners.length < 6) return null;

    const rot = rand() * Math.PI * 2;
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const world = corners.map(([x, y]) => {
      const wx = (x - cols / 2) * cell, wz = (y - rows / 2) * cell;
      return [wx * cr - wz * sr, wx * sr + wz * cr];
    });
    return this._roundCorners(world, rand);
  }

  /**
   * Round a polygon's corners with 3-point arcs and fill straights with collinear points.
   * Returns points starting in the middle of the longest straight (start/finish).
   */
  _roundCorners(world, rand, rMin = 18, rVar = 10) {
    const pts = [];
    let bestStraight = -1, bestLen = 0;
    const m = world.length;
    const segLen = (i) => {
      const a = world[i], b = world[(i + 1) % m];
      return Math.hypot(b[0] - a[0], b[1] - a[1]);
    };
    const radii = world.map((_, i) => Math.min(segLen((i - 1 + m) % m) / 2 - 2, segLen(i) / 2 - 2, rMin + rand() * rVar));
    for (let i = 0; i < m; i++) {
      const p = world[(i - 1 + m) % m], c = world[i], q = world[(i + 1) % m];
      const inLen = Math.hypot(c[0] - p[0], c[1] - p[1]);
      const outLen = Math.hypot(q[0] - c[0], q[1] - c[1]);
      const din = [(c[0] - p[0]) / inLen, (c[1] - p[1]) / inLen];
      const dout = [(q[0] - c[0]) / outLen, (q[1] - c[1]) / outLen];
      const r = radii[i];
      pts.push([c[0] - din[0] * r, c[1] - din[1] * r]);
      pts.push([c[0] + (dout[0] - din[0]) * r * 0.293, c[1] + (dout[1] - din[1]) * r * 0.293]);
      pts.push([c[0] + dout[0] * r, c[1] + dout[1] * r]);
      const sx = c[0] + dout[0] * r, sz = c[1] + dout[1] * r;
      const len = outLen - r - radii[(i + 1) % m];
      const steps = Math.floor(len / 35);
      for (let k = 1; k <= steps; k++) {
        const t = (k / (steps + 1)) * len;
        pts.push([sx + dout[0] * t, sz + dout[1] * t]);
        if (k === Math.ceil(steps / 2) && len > bestLen) {
          bestLen = len;
          bestStraight = pts.length - 1;
        }
      }
    }
    if (bestStraight > 0) return pts.slice(bestStraight).concat(pts.slice(0, bestStraight));
    return pts;
  }

  /** Figure-8 (lemniscate) with uneven lobes; the crossing becomes an overpass. */
  _figure8Layout(rand) {
    const A = 245 + rand() * 90;
    const B = 125 + rand() * 60;
    const lobeL = 0.7 + rand() * 0.45; // left lobe scale
    const n = 18;
    const pts = [];
    for (let k = 0; k < n; k++) {
      const t = (k / n) * Math.PI * 2 + 0.28 * Math.PI; // start on a leg, not at the crossing
      let x = A * Math.sin(t);
      let z = B * Math.sin(t) * Math.cos(t) * 2;
      if (x < 0) { x *= lobeL; z *= lobeL; }
      // Bumpy lobes, but keep the crossing region clean.
      const far = Math.min(1, Math.abs(Math.sin(t)) * 1.6);
      const bump = 1 + (rand() - 0.5) * 0.22 * far;
      pts.push([x * bump, z * bump]);
    }
    const rot = rand() * Math.PI * 2;
    const cr = Math.cos(rot), sr = Math.sin(rot);
    return pts.map(([x, z]) => [x * cr - z * sr, x * sr + z * cr]);
  }

  /**
   * Mountain-pass switchbacks: three zig-zag legs joined by semicircular hairpins, then a wide
   * sweeping return leg back to the start (think of the hairpin climbs on classic kart tracks).
   */
  _switchbackLayout(rand) {
    const legs = rand() < 0.5 ? 3 : 5; // odd, so the last leg heads away from the start
    const r = 28 + rand() * 6; // hairpin radius
    const spacing = r * 2;
    const L = legs === 3 ? 230 + rand() * 80 : 170 + rand() * 60;
    const R2 = 100 + rand() * 30; // return-leg clearance
    const pts = [];
    for (let k = 0; k < legs; k++) {
      const z = k * spacing;
      const dir = k % 2 === 0 ? 1 : -1;
      const x0 = dir > 0 ? 0 : L, x1 = dir > 0 ? L : 0;
      const jog = (rand() - 0.5) * 12;
      pts.push([x0 + dir * L * 0.2, z]);
      pts.push([x0 + dir * L * 0.5, z + jog]);
      pts.push([x0 + dir * L * 0.8, z]);
      pts.push([x1, z]);
      if (k < legs - 1) {
        for (const ang of [Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4]) {
          pts.push([x1 + dir * r * Math.sin(ang), z + r - r * Math.cos(ang)]);
        }
        pts.push([x1, z + spacing]);
      }
    }
    // After the last leg we're at (L, top) heading +x: sweep round the right and bottom.
    const top = (legs - 1) * spacing;
    pts.push([L + R2 * 0.6, top + 12]);
    pts.push([L + R2, top * 0.5]);
    pts.push([L + R2 * 0.85, -R2 * 0.45]);
    pts.push([L * 0.5, -R2 * 0.95]);
    pts.push([-R2 * 0.7, -R2 * 0.5]);
    pts.push([-R2 * 0.55, 0]);
    const cx = L / 2, cz = top / 2;
    const rot = rand() * Math.PI * 2;
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const mirror = rand() < 0.5 ? -1 : 1;
    return pts.map(([x, z]) => {
      const X = (x - cx) * mirror, Z = z - cz;
      return [X * cr - Z * sr, X * sr + Z * cr];
    });
  }

  /** Organic loop: points at increasing angles with strongly varying radii (bays, bulges, pinches). */
  _randomLayout(rand) {
    const n = 14 + Math.floor(rand() * 7);
    const baseR = 210 + rand() * 70;
    const sx = 0.7 + rand() * 0.6;
    const sz = 0.7 + rand() * 0.45;
    const radii = [];
    for (let k = 0; k < n; k++) radii.push(rand() < 0.25 ? 0.3 + rand() * 0.2 : 0.65 + rand() * 0.5);
    const smooth = radii.map((r, k) => 0.7 * r + 0.15 * (radii[(k + n - 1) % n] + radii[(k + 1) % n]));
    const rot = rand() * Math.PI * 2;
    const pts = [];
    for (let k = 0; k < n; k++) {
      const a = rot + ((k + (rand() - 0.5) * 0.45) / n) * Math.PI * 2;
      const r = baseR * smooth[k];
      pts.push([Math.cos(a) * r * sx, Math.sin(a) * r * sz]);
    }
    return pts;
  }

  /** Occasionally turn a long straight into an S-wiggle (never the start straight). */
  _wiggle(pts, rand) {
    if (rand() < 0.35) return pts;
    const out = [];
    const n = pts.length;
    let done = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      out.push(a);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (done < 2 && i > 1 && i < n - 2 && len > 90 && rand() < 0.5) {
        const dx = (b[0] - a[0]) / len, dz = (b[1] - a[1]) / len;
        const amp = 8 + rand() * 7;
        for (let k = 1; k <= 3; k++) {
          const t = k / 4;
          const off = Math.sin(t * Math.PI * 2) * amp;
          out.push([a[0] + dx * len * t - dz * off, a[1] + dz * len * t + dx * off]);
        }
        done++;
      }
    }
    return out;
  }

  _computeCenterLine(layout) {
    const pts = layout.map(([x, z]) => new THREE.Vector3(x, 0, z));
    const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
    const spaced = curve.getSpacedPoints(S);
    for (let i = 0; i < S; i++) {
      this.px[i] = spaced[i].x;
      this.pz[i] = spaced[i].z;
    }
    for (let i = 0; i < S; i++) {
      const a = (i - 1 + S) % S;
      const b = (i + 1) % S;
      let dx = this.px[b] - this.px[a];
      let dz = this.pz[b] - this.pz[a];
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      this.tx[i] = dx;
      this.tz[i] = dz;
      this.yaw[i] = Math.atan2(dx, dz);
    }
    this.length = curve.getLength();
    this.segmentLength = this.length / S;
  }

  /**
   * Validate a layout: sensible length, no turn tighter than the road allows, and no two parts
   * of the track too close — except genuine crossings, which become overpasses (at most two).
   */
  _isValid(rand) {
    this.crossings = [];
    if (this.length < 1450 || this.length > 2600) return false;
    const seg = this.segmentLength;
    const half = GROUND_SIZE / 2 - 45;
    for (let i = 0; i < S; i++) {
      if (Math.abs(this.px[i]) > half || Math.abs(this.pz[i]) > half) return false;
      const dyaw = Math.abs(wrap(this.yaw[(i + 4) % S] - this.yaw[(i - 4 + S) % S]));
      if (dyaw > 1e-4 && (8 * seg) / dyaw < 17) return false;
    }

    const minDist = 2 * MAX_BARRIER + 10;
    const minDist2 = minDist * minDist;
    const minGap = Math.ceil(80 / seg);
    const close = [];
    for (let i = 0; i < S; i += 2) {
      for (let j = i + minGap; j < S; j += 2) {
        if (S - (j - i) < minGap) break;
        const dx = this.px[i] - this.px[j], dz = this.pz[i] - this.pz[j];
        const d2 = dx * dx + dz * dz;
        if (d2 < minDist2) close.push([i, j, d2]);
      }
    }
    if (close.length === 0) return true;

    // Cluster close pairs into crossing zones.
    const zones = [];
    for (const [i, j, d2] of close) {
      let z = zones.find((c) => circDist(c.i, i) < 90 && circDist(c.j, j) < 90);
      if (!z) { z = { i, j, d2, pairs: [] }; zones.push(z); }
      z.pairs.push([i, j]);
      if (d2 < z.d2) { z.i = i; z.j = j; z.d2 = d2; }
    }
    if (zones.length > 2) return false;

    const startZone = Math.ceil(70 / seg);
    for (const z of zones) {
      if (z.d2 > 25) return false; // near-miss, not a crossing
      const ang = Math.abs(wrap(this.yaw[z.i] - this.yaw[z.j]));
      const cross = Math.min(ang, Math.PI - ang);
      if (cross < 0.6) return false; // too shallow to bridge cleanly
      // Lift the branch that's further from the start line.
      const di = circDist(z.i, 0), dj = circDist(z.j, 0);
      const upper = di > dj ? z.i : z.j;
      const lower = upper === z.i ? z.j : z.i;
      const deckHalf = Math.ceil(((2 * MAX_BARRIER + 8) / Math.sin(cross) + 8) / seg);
      const ramp = Math.ceil(55 / seg);
      const span = deckHalf + ramp;
      if (circDist(upper, 0) < span + startZone || circDist(lower, 0) < startZone) return false;
      // Every close pair must be covered by the raised deck.
      for (const [i, j] of z.pairs) {
        const u = circDist(i, upper) < circDist(j, upper) ? i : j;
        if (circDist(u, upper) > deckHalf) return false;
      }
      this.crossings.push({ upper, lower, deckHalf, ramp });
    }
    // Overpass spans must not overlap each other.
    if (this.crossings.length === 2) {
      const [a, b] = this.crossings;
      const reach = a.deckHalf + a.ramp + b.deckHalf + b.ramp;
      if (circDist(a.upper, b.upper) < reach || circDist(a.upper, b.lower) < a.deckHalf + a.ramp + 40
        || circDist(b.upper, a.lower) < b.deckHalf + b.ramp + 40) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ features

  /**
   * Plan bridges/overpasses, tunnels, jumps, width variation, rolling hills, boost pads and
   * hazards, then compose the final height profile.
   */
  _planFeatures(rand) {
    const t = this.theme;
    const seg = this.segmentLength;
    const range = ([a, b]) => a + Math.floor(rand() * (b - a + 1));
    this.bridges = [];
    this.tunnels = [];
    this.jumps = [];
    this.pads = [];
    this.hazards = [];
    this.movers = [];

    const blocked = [];
    const reserve = (a, b) => blocked.push([a, b]);
    const overlaps = (a, b) => blocked.some(([c, d]) => {
      for (const shift of [-S, 0, S]) if (a <= d + shift && b >= c + shift) return true;
      return false;
    });
    const maxBend = (a, b) => {
      let m = 0;
      for (let i = a; i <= b; i++) m = Math.max(m, Math.abs(wrap(this.yaw[circ(i)] - this.yaw[circ(a)])));
      return m;
    };
    const startA = S - Math.ceil(60 / seg), startB = S + Math.ceil(50 / seg);
    reserve(startA, startB);
    reserve(startA - S, startB - S);
    // Item box rows: roughly one every 200 m (4–7 per lap), spread around the lap with a little
    // jitter and a random formation each. Reserved so jumps and tunnels keep clear of them.
    const rowCount = Math.max(6, Math.min(10, Math.round(this.length / 210)));
    const skip = Math.ceil(80 / seg), tail = Math.ceil(40 / seg);
    const usable = S - skip - tail;
    const formations = ['line4', 'line5', 'line3', 'stagger', 'pairs'];
    this.boxRows = [];
    for (let k = 0; k < rowCount; k++) {
      const i = skip + Math.round(usable * (k + 0.5) / rowCount + (rand() - 0.5) * usable * 0.08);
      const formation = formations[Math.floor(rand() * formations.length)];
      this.boxRows.push({ i, formation });
      reserve(i - 12, i + 16);
    }

    // Overpasses at the crossings found during validation.
    for (const c of this.crossings) {
      const a = c.upper - c.deckHalf - c.ramp, b = c.upper + c.deckHalf + c.ramp;
      this.bridges.push({ type: 'overpass', a, b, deckA: c.upper - c.deckHalf, deckB: c.upper + c.deckHalf, rise: OVERPASS_RISE, lower: c.lower });
      reserve(a - 8, b + 8);
      reserve(c.lower - 40, c.lower + 40);
    }

    const clear = (a, b, dist) => {
      const margin = Math.ceil(40 / seg);
      for (let i = a; i <= b; i += 2) {
        const x = this.px[circ(i)], z = this.pz[circ(i)];
        for (let j = 0; j < S; j += 2) {
          if (circDist(j, i) < (b - a) / 2 + margin) continue;
          if ((x - this.px[j]) ** 2 + (z - this.pz[j]) ** 2 < dist * dist) return false;
        }
      }
      return true;
    };
    const place = (count, lengthM, bend, list, extra, clearance = 0) => {
      const span = Math.round(lengthM / seg);
      for (let tries = 0; tries < 60 && list.length < count; tries++) {
        const a = Math.floor(rand() * S);
        const b = a + span;
        if (overlaps(a - 8, b + 8) || maxBend(a, b) > bend) continue;
        if (clearance && !clear(a, b, clearance)) continue;
        reserve(a - 8, b + 8);
        list.push({ a, b, ...extra });
      }
    };
    const bridgeCount = this.crossings.length ? (rand() < 0.3 ? 1 : 0) : (rand() < 0.6 ? 1 : 0) + (rand() < 0.25 ? 1 : 0);
    place(bridgeCount, 120, 0.9, this.bridges, { type: t.space ? 'span' : 'water', rise: BRIDGE_RISE });
    if (!t.space) place(rand() < 0.5 ? 1 : rand() < 0.5 ? 2 : 0, 75, 0.8, this.tunnels, {}, TUNNEL_HILL.width + MAX_BARRIER + 3);
    place(range(t.jumps), 11, 0.25, this.jumps, {});
    // Moving hazards (cows, snowballs, fire bars…) on fairly straight bits.
    place(3 + Math.floor(rand() * 4), 10, 0.5, this.movers, { kind: MOVER_KIND[t.id] });
    for (const m of this.movers) {
      m.i = Math.round((m.a + m.b) / 2);
      m.period = 3 + rand() * 2.5;
      m.phase = rand() * Math.PI * 2;
      m.side = rand() < 0.5 ? -1 : 1;
    }
    this._waters = [];
    if (WATER_THEMES.has(t.id) && rand() < 0.7) place(1 + Math.floor(rand() * 2), 12, 0.6, this._waters, {});
    for (const br of this.bridges) {
      if (br.type === 'overpass') continue;
      const ramp = Math.round(38 / seg);
      br.deckA = br.a + ramp;
      br.deckB = br.b - ramp;
    }

    // Mask: 0 where the road must stay flat and standard width, blended smoothly.
    const mask = new Float32Array(S).fill(1);
    const zero = (a, b) => { for (let i = a; i <= b; i++) mask[circ(i)] = 0; };
    zero(startA - 10, startB + 10);
    for (const br of this.bridges) zero(br.a - 6, br.b + 6);
    for (const c of this.crossings) zero(c.lower - 40, c.lower + 40);
    for (const tu of this.tunnels) zero(tu.a - 10, tu.b + 10);
    blurCircular(mask, 14, 2);
    for (const br of this.bridges) for (let i = br.a; i <= br.b; i++) mask[circ(i)] = 0;
    for (const tu of this.tunnels) for (let i = tu.a - 4; i <= tu.b + 4; i++) mask[circ(i)] = 0;
    for (const c of this.crossings) for (let i = c.lower - 30; i <= c.lower + 30; i++) mask[circ(i)] = 0;

    // Width: wide sweepers and narrow technical bits.
    const wf = [1 + Math.floor(rand() * 3), 3 + Math.floor(rand() * 4)];
    const wp = [rand() * 6.28, rand() * 6.28];
    for (let i = 0; i < S; i++) {
      const u = (i / S) * Math.PI * 2;
      const g = (Math.sin(u * wf[0] + wp[0]) * 0.65 + Math.sin(u * wf[1] + wp[1]) * 0.35);
      this.width[i] = BASE_WIDTH + WIDTH_VAR * g * mask[i];
    }

    // Rolling hills under the road.
    const amp = t.hills[0] + rand() * (t.hills[1] - t.hills[0]);
    const hf = [2 + Math.floor(rand() * 2), 3 + Math.floor(rand() * 3), 6 + Math.floor(rand() * 3)];
    const hp = [rand() * 6.28, rand() * 6.28, rand() * 6.28];
    const raw = new Float32Array(S);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < S; i++) {
      const u = (i / S) * Math.PI * 2;
      raw[i] = Math.sin(u * hf[0] + hp[0]) + 0.6 * Math.sin(u * hf[1] + hp[1]) + 0.25 * Math.sin(u * hf[2] + hp[2]);
      lo = Math.min(lo, raw[i]); hi = Math.max(hi, raw[i]);
    }
    for (let i = 0; i < S; i++) this.baseHeight[i] = amp * ((raw[i] - lo) / (hi - lo || 1)) * mask[i];
    // Keep slopes drivable (≤ ~16%).
    let maxSlope = 0;
    for (let i = 0; i < S; i++) maxSlope = Math.max(maxSlope, Math.abs(this.baseHeight[(i + 1) % S] - this.baseHeight[i]) / seg);
    if (maxSlope > 0.16) {
      const k = 0.16 / maxSlope;
      for (let i = 0; i < S; i++) this.baseHeight[i] *= k;
    }

    // Final height = hills + bridge/overpass rises + jump ramps.
    this.height.set(this.baseHeight);
    for (const br of this.bridges) {
      const span = br.b - br.a;
      const ramp = br.deckA - br.a;
      for (let j = 0; j <= span; j++) {
        let s = 1;
        if (j < ramp) s = j / ramp;
        else if (j > span - (br.b - br.deckB)) s = (span - j) / (br.b - br.deckB);
        this.height[circ(br.a + j)] = br.rise * s * s * (3 - 2 * s);
      }
    }
    const jumpH = t.id === 'snow' || t.id === 'rainbow' ? 2.4 : 1.9;
    for (const jp of this.jumps) {
      const n = jp.b - jp.a;
      for (let j = 0; j <= n; j++) this.height[circ(jp.a + j)] += jumpH * Math.pow(j / n, 1.3);
    }

    // Banking: tilt corners towards their inside, proportional to curvature. Flat on the start,
    // bridges, tunnels, jumps and where another road passes underneath an overpass.
    const bankMask = new Float32Array(S).fill(1);
    const flat = (a, b) => { for (let i = a; i <= b; i++) bankMask[circ(i)] = 0; };
    flat(startA - 6, startB + 6);
    for (const br of this.bridges) flat(br.a - 4, br.b + 4);
    for (const tu of this.tunnels) flat(tu.a - 8, tu.b + 8);
    for (const jp of this.jumps) flat(jp.a - 10, jp.b + 12);
    for (const c of this.crossings) flat(c.lower - 36, c.lower + 36);
    blurCircular(bankMask, 8, 2);
    for (const tu of this.tunnels) for (let i = tu.a - 2; i <= tu.b + 2; i++) bankMask[circ(i)] = 0;
    for (const br of this.bridges) for (let i = br.a; i <= br.b; i++) bankMask[circ(i)] = 0;
    // Real banking tilts the road about its centre line: the outside edge rises, the inside
    // edge drops (the terrain is shaped to meet both), so corners never become humps.
    // Fast sweepers get the most bank; tight hairpins, taken slowly, only a little.
    const bankFactor = (t.id === 'rainbow' ? 1.25 : 0.8) + rand() * 0.4;
    const maxBank = t.id === 'rainbow' ? 0.29 : 0.21; // tan of ~16° / ~12°
    for (let i = 0; i < S; i++) {
      const curv = wrap(this.yaw[circ(i + 4)] - this.yaw[circ(i - 4)]) / (8 * seg); // rad/m, + = left turn
      const radius = 1 / Math.max(1e-4, Math.abs(curv));
      const hairpinEase = 0.3 + 0.7 * smooth01((radius - 22) / 30); // slow corners: less bank
      this.slope[i] = Math.max(-maxBank, Math.min(maxBank, curv * 11 * bankFactor * hairpinEase));
    }
    blurCircular(this.slope, 6, 2); // build the bank up gradually into and out of the corner
    for (let i = 0; i < S; i++) this.slope[i] *= bankMask[i];

    // Boost pads only on straights: the pad and the next ~40 m must be free of bends and
    // banking, so a boost never throws you into a corner (a pad right after a corner is fine).
    const padLen = Math.max(3, Math.round(6 / seg));
    const ahead = Math.ceil(40 / seg);
    const straight = (a, b) => {
      const ref = this.yaw[circ(a)];
      for (let i = a; i <= b + ahead; i++) {
        if (Math.abs(wrap(this.yaw[circ(i)] - ref)) > 0.08) return false; // no bend before or after
        if (Math.abs(this.slope[circ(i)]) > 0.02) return false; // no banking (= no corner)
      }
      return true;
    };
    for (const jp of this.jumps) {
      const a = jp.a - Math.round(16 / seg);
      if (straight(a, a + padLen)) this.pads.push({ a, b: a + padLen, lat: 0, half: 1.9 });
    }
    const wantPads = range(t.pads);
    const target = wantPads + this.pads.length;
    for (let tries = 0; tries < 150 && this.pads.length < target; tries++) {
      const a = Math.floor(rand() * S);
      if (circDist(a, 0) < Math.ceil(50 / seg)) continue;
      if (this.pads.some((p) => circDist(p.a, a) < 25)) continue;
      if (!straight(a, a + padLen)) continue;
      const w = this.width[circ(a)] - 2.4;
      this.pads.push({ a, b: a + padLen, lat: (rand() * 2 - 1) * w, half: 1.9 });
    }

    // Water crossings run across the whole road.
    for (const wtr of this._waters) {
      const w = this.width[circ(wtr.a)] + CURB_WIDTH;
      this.hazards.push({ type: 'water', a: wtr.a, b: wtr.b, lo: -w, hi: w });
    }

    // Surface hazards (ice / sand).
    if (t.hazard) {
      const n = 5 + Math.floor(rand() * 3);
      for (let tries = 0; tries < 50 && this.hazards.length < n; tries++) {
        const a = Math.floor(rand() * S);
        const b = a + Math.round((14 + rand() * 18) / seg);
        if (a < Math.ceil(50 / seg) || b > S - Math.ceil(40 / seg)) continue;
        if (this.pads.some((p) => circDist(p.a, a) < b - a + 6)) continue;
        const w = this.width[a];
        const half = 2.5 + rand() * 3.5;
        const mid = (rand() - 0.5) * (w * 2 - half * 2);
        this.hazards.push({ type: t.hazard, a, b, lo: mid - half, hi: mid + half });
      }
    }
  }

  _deckAt(i) {
    for (const br of this.bridges) {
      for (const shift of [0, S, -S]) if (i + shift >= br.deckA && i + shift < br.deckB) return br;
    }
    return null;
  }

  _inRange(idx, a, b) {
    return (idx >= a && idx < b) || (idx + S >= a && idx + S < b) || (idx - S >= a && idx - S < b);
  }

  /** 'ice' | 'sand' | null for a sample / lateral offset. */
  hazardAt(idx, lat) {
    const hz = this.hazards;
    for (let k = 0; k < hz.length; k++) {
      const p = hz[k];
      if (lat >= p.lo && lat <= p.hi && this._inRange(idx, p.a, p.b)) return p.type;
    }
    return null;
  }

  isIce(idx, lat) {
    return this.hazardAt(idx, lat) === 'ice';
  }

  /** True when a kart at this sample / lateral offset is on a boost pad. */
  padAt(idx, lat) {
    const pads = this.pads;
    for (let k = 0; k < pads.length; k++) {
      const p = pads[k];
      if (Math.abs(lat - p.lat) <= p.half + 0.4 && this._inRange(idx, p.a, p.b)) return true;
    }
    return false;
  }

  /** Road surface height at a sample and lateral offset (includes banking). */
  roadY(idx, lat) {
    const i = circ(idx);
    return this.height[i] + this.slope[i] * lat;
  }

  /** Banking at a sample: height gain per metre to the right. */
  slopeAt(idx) {
    return this.slope[circ(idx)];
  }

  /** Grade along the track at a sample: height gain per metre forward. */
  gradeAt(idx) {
    return (this.height[circ(idx + 1)] - this.height[circ(idx - 1)]) / (2 * this.segmentLength);
  }

  heightAt(idx) {
    return this.height[circ(idx)];
  }

  widthAt(idx) {
    return this.width[circ(idx)];
  }

  /** Beyond this lateral offset a kart is off the tarmac. */
  roadLimitAt(idx) {
    return this.width[circ(idx)] + CURB_WIDTH;
  }

  barrierOffset(idx) {
    return this.width[circ(idx)] + CURB_WIDTH + BARRIER_GAP;
  }

  /** World position at sample i shifted `lat` metres to the kart's right and `fwd` metres forward. */
  pointAt(i, lat, fwd = 0, out = { x: 0, z: 0 }) {
    const j = circ(i);
    const tx = this.tx[j], tz = this.tz[j];
    out.x = this.px[j] - tz * lat + tx * fwd;
    out.z = this.pz[j] + tx * lat + tz * fwd;
    return out;
  }

  // ------------------------------------------------------------------ terrain

  _prepareTerrain(rand) {
    this._noisePhase = [rand() * 100, rand() * 100, rand() * 100];
    let r = 0;
    for (let i = 0; i < S; i++) r = Math.max(r, Math.hypot(this.px[i], this.pz[i]));
    this.oceanRadius = r + 60;
  }

  _noise(x, z) {
    const [a, b, c] = this._noisePhase;
    return Math.sin(x * 0.021 + a) * Math.cos(z * 0.017 + b) + 0.5 * Math.sin((x + z) * 0.037 + c) + 0.25 * Math.cos((x - z) * 0.06 + a);
  }

  /**
   * Ground height at (x, z): rises to meet the road's rolling hills near the track and has its
   * own gentle undulation further away. Returns { y, d } (d = distance past the barriers).
   */
  terrainAt(x, z, out = { y: 0, d: 0, j: 0 }) {
    let best = Infinity, j = 0;
    for (let i = 0; i < S; i += 2) {
      const dx = x - this.px[i], dz = z - this.pz[i];
      const d = dx * dx + dz * dz;
      if (d < best) { best = d; j = i; }
    }
    const edgeOff = this.barrierOffset(j) + 0.7;
    const d = Math.sqrt(best) - edgeOff;
    const lat = -(x - this.px[j]) * this.tz[j] + (z - this.pz[j]) * this.tx[j];
    // Banked road height at this lateral position (capped at the edge), ignoring bridge/jump
    // rises (those get side walls). Under the road the ground stays just below the tarmac.
    const clampedLat = Math.max(-edgeOff, Math.min(edgeOff, lat));
    const edgeY = this.baseHeight[j] + this.slope[j] * clampedLat - (d < 0 ? 0.6 : 0);
    const near = 1 - smooth01(d / 38);
    const far = Math.max(0, this._noise(x, z)) * (this.theme.groundNoise || 0) * smooth01((d - 8) / 40);
    let y = edgeY * near + far;
    if (this.theme.ocean) {
      const r = Math.hypot(x, z);
      if (r > this.oceanRadius) y = -1.5;
      else if (r > this.oceanRadius - 30) y *= (this.oceanRadius - r) / 30;
    }
    for (const sc of this.shortcuts) {
      const sd = this._shortcutDist(sc, x, z, this._sd || (this._sd = { dist: 0, d: 0 }));
      if (sd.dist < 12) {
        const py = this._shortcutY(sc, sc.ax + sc.ux * sd.d, sc.az + sc.uz * sd.d, sd.d) - 0.5;
        y += (py - y) * (1 - smooth01(sd.dist / 12));
      }
    }
    out.y = y; out.d = d; out.j = j;
    return out;
  }

  // ================================================================== building

  _buildGround() {
    const t = this.theme;
    const size = GROUND_SIZE;
    const seg = 140;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const rand = mulberry32(this.seed ^ 0x9e3779b9);
    paint(geo, t.ground);
    const pos = geo.attributes.position;
    const col = geo.attributes.color;
    const base = new THREE.Color(t.ground);
    const c = new THREE.Color();
    const tr = { y: 0, d: 0, j: 0 };
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      this.terrainAt(x, z, tr);
      pos.setY(i, tr.y - 0.05);
      c.copy(base).multiplyScalar(0.9 + rand() * 0.14);
      if (t.ocean) {
        const r = Math.hypot(x, z);
        if (r > this.oceanRadius) c.setHex(t.ocean).multiplyScalar(0.95 + rand() * 0.1);
        else if (r > this.oceanRadius - 12) c.setHex(0xfff1c7);
      }
      if (t.lava && tr.d > 18 && this._noise(x * 1.7, z * 1.7) > 0.95) c.setHex(rand() < 0.5 ? 0xff5a1f : 0xff8c1a);
      col.setXYZ(i, c.r, c.g, c.b);
    }
    geo.computeVertexNormals();
    const mat = t.lava ? this.renderer.toon({ vertexColors: true, emissive: 0x220800 }) : this.renderer.toon({ vertexColors: true });
    this.group.add(new THREE.Mesh(geo, mat));
  }

  _buildRoad() {
    const t = this.theme;
    const R = t.road;
    const rb = new RibbonBuilder();
    const H = this.height;
    const a = { x: 0, z: 0 }, b = { x: 0, z: 0 }, c = { x: 0, z: 0 }, d = { x: 0, z: 0 };
    const hAt = (i) => H[circ(i)];
    const W = (i) => this.width[circ(i)];
    // Band between lateral offsets computed per end from the local half-width.
    const RY = (i, lat) => this.roadY(i, lat);
    const band = (i, fLo, fHi, yOff, hex) => {
      const w0 = W(i), w1 = W(i + 1);
      const hi0 = fHi(w0), hi1 = fHi(w1), lo0 = fLo(w0), lo1 = fLo(w1);
      this.pointAt(i, hi0, 0, a);
      this.pointAt(i + 1, hi1, 0, b);
      this.pointAt(i + 1, lo1, 0, c);
      this.pointAt(i, lo0, 0, d);
      rb.quad(a.x, RY(i, hi0) + yOff, a.z, b.x, RY(i + 1, hi1) + yOff, b.z, c.x, RY(i + 1, lo1) + yOff, c.z, d.x, RY(i, lo0) + yOff, d.z, hex);
    };
    const skirt = (i, fLat, bottom0, bottom1, hex) => {
      const l0 = fLat(W(i)), l1 = fLat(W(i + 1));
      const y0 = RY(i, l0), y1 = RY(i + 1, l1);
      this.pointAt(i, l0, 0, a);
      this.pointAt(i + 1, l1, 0, b);
      rb.quad(a.x, y0, a.z, b.x, y1, b.z, b.x, Math.min(bottom1, y1), b.z, a.x, Math.min(bottom0, y0), a.z, hex);
    };
    const edge = (w) => w + CURB_WIDTH + BARRIER_GAP + 0.7;
    const inJump = (i) => this.jumps.some((jp) => this._inRange(i, jp.a, jp.b + 1));

    for (let i = 0; i < S; i++) {
      let asphalt = Math.floor(i / 8) % 2 === 0 ? R.a : R.b;
      if (R.rainbow) asphalt = rainbowColor(Math.floor(i / 4));
      if (R.planks) asphalt = i % 2 === 0 ? R.a : R.b;
      band(i, (w) => -w, (w) => w, 0.05, asphalt);
      const curb = Math.floor(i / 3) % 2 === 0 ? R.curbA : R.curbB;
      band(i, (w) => w, (w) => w + CURB_WIDTH, 0.07, curb);
      band(i, (w) => -w - CURB_WIDTH, (w) => -w, 0.07, curb);
      if (R.line) {
        band(i, (w) => w - 0.5, (w) => w - 0.2, 0.08, R.line);
        band(i, (w) => -w + 0.2, (w) => -w + 0.5, 0.08, R.line);
      }
      if (R.center && Math.floor(i / 5) % 2 === 0) band(i, () => -0.18, () => 0.18, 0.08, R.center);

      // Shoulders out to the railings, and side walls wherever the road is raised.
      const deck = this._deckAt(i);
      // Raised above the terrain (bridges, overpasses, jumps); banking itself is met by the ground.
      const raised = hAt(i) - this.baseHeight[i] > 0.02 || hAt(i + 1) - this.baseHeight[circ(i + 1)] > 0.02;
      const shoulder = raised ? 0x9aa0a8 : R.shoulder;
      band(i, (w) => w + CURB_WIDTH, edge, 0.045, shoulder);
      band(i, (w) => -edge(w), (w) => -w - CURB_WIDTH, 0.045, shoulder);
      if (raised || t.space) {
        const slab = t.space || deck;
        const hex = t.space ? rainbowColor(Math.floor(i / 4)) : slab ? 0x7d828a : 0xa08c74;
        const thick = t.space ? 1.2 : 0.9;
        for (const sgn of [1, -1]) {
          // Bottom follows this side's edge: a thin slab under decks, down to the terrain otherwise.
          const l0 = sgn * edge(W(i)), l1 = sgn * edge(W(i + 1));
          const b0 = slab ? RY(i, l0) - thick : this.baseHeight[i] + this.slope[circ(i)] * l0 - 0.4;
          const b1 = slab ? RY(i + 1, l1) - thick : this.baseHeight[circ(i + 1)] + this.slope[circ(i + 1)] * l1 - 0.4;
          skirt(i, sgn > 0 ? edge : (w) => -edge(w), b0, b1, hex);
        }
        if (t.space) band(i, (w) => -edge(w), edge, -1.2, 0x2a1f5c); // underside
      }
      // Jump ramps get hazard chevrons.
      if (inJump(i)) band(i, (w) => -w, (w) => w, 0.085, i % 2 === 0 ? 0xf4c20d : 0x222222);
    }

    // Hazard patches.
    for (const p of this.hazards) {
      for (let i = p.a; i < p.b; i++) {
        const shade = p.type === 'ice'
          ? ((i - p.a) % 4 < 2 ? 0xd6f1ff : 0xc4e8fb)
          : p.type === 'water'
            ? ((i - p.a) % 3 === 0 ? 0x5bb8ef : 0x3a9ad9)
            : ((i - p.a) % 3 === 0 ? 0xc9a063 : 0xd9b26f);
        band(i, () => p.lo, () => p.hi, p.type === 'water' ? 0.095 : 0.075, shade);
      }
    }

    // Boost pads: orange base with yellow chevrons pointing forward.
    for (const p of this.pads) {
      for (let i = p.a; i < p.b; i++) band(i, () => p.lat - p.half, () => p.lat + p.half, 0.09, 0xff7f11);
      const n = p.b - p.a;
      for (let k = 0; k < n; k += 2) {
        const i = p.a + k;
        const y = RY(i, p.lat) + 0.1;
        const L = this.segmentLength * 1.6;
        const tip = { x: 0, z: 0 }, l0 = { x: 0, z: 0 }, l1 = { x: 0, z: 0 }, t1 = { x: 0, z: 0 };
        for (const sgn of [-1, 1]) {
          this.pointAt(i, p.lat, L * 0.9, tip);
          this.pointAt(i, p.lat, L * 0.4, t1);
          this.pointAt(i, p.lat + sgn * p.half * 0.85, 0, l0);
          this.pointAt(i, p.lat + sgn * p.half * 0.85, L * 0.5, l1);
          rb.quad(tip.x, y, tip.z, l1.x, y, l1.z, l0.x, y, l0.z, t1.x, y, t1.z, 0xffe156);
        }
      }
    }

    // Chequered start/finish line across the road at sample 0.
    const cols = 12, rows = 2, cell = (BASE_WIDTH * 2) / cols;
    for (let r = 0; r < rows; r++) {
      for (let k = 0; k < cols; k++) {
        const lo = -BASE_WIDTH + k * cell, hi = lo + cell;
        const f0 = -cell + r * cell, f1 = f0 + cell;
        this.pointAt(0, hi, f0, a);
        this.pointAt(0, hi, f1, b);
        this.pointAt(0, lo, f1, c);
        this.pointAt(0, lo, f0, d);
        const hex = (r + k) % 2 === 0 ? 0x111111 : 0xffffff;
        const y = hAt(0) + 0.095;
        rb.quad(a.x, y, a.z, b.x, y, b.z, c.x, y, c.z, d.x, y, d.z, hex);
      }
    }
    const mat = t.space
      ? this.renderer.basic({ vertexColors: true })
      : this.renderer.toon({ vertexColors: true, side: THREE.DoubleSide });
    if (t.space) mat.side = THREE.DoubleSide;
    this.group.add(new THREE.Mesh(rb.build(), mat));
  }

  /** One triangle-mesh collider for the whole driving surface (hills, ramps, decks). */
  _buildRoadCollider() {
    const verts = new Float32Array(S * 2 * 3);
    const idx = new Uint32Array(S * 6);
    const p = { x: 0, z: 0 };
    for (let i = 0; i < S; i++) {
      const e = this.barrierOffset(i) + 0.7;
      this.pointAt(i, -e, 0, p);
      verts[i * 6] = p.x; verts[i * 6 + 1] = this.roadY(i, -e); verts[i * 6 + 2] = p.z;
      this.pointAt(i, e, 0, p);
      verts[i * 6 + 3] = p.x; verts[i * 6 + 4] = this.roadY(i, e); verts[i * 6 + 5] = p.z;
      const n = (i + 1) % S;
      idx.set([i * 2, i * 2 + 1, n * 2, i * 2 + 1, n * 2 + 1, n * 2], i * 6);
    }
    this.wallColliders.push(this.physics.addTrimesh(verts, idx));
  }

  _buildBarriers() {
    const segments = Math.floor(S / BARRIER_STEP);
    const count = segments * 2;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = this.theme.space ? this.renderer.basic({ color: 0xffffff }) : this.renderer.toon({ color: 0xffffff });
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const [ca, cb, cc] = this.theme.barrier.map((h) => new THREE.Color(h));
    const a = { x: 0, z: 0 }, b = { x: 0, z: 0 };
    const height = this.theme.space ? 0.8 : 1.3, thick = 0.9;
    let n = 0;
    for (const side of [1, -1]) {
      for (let k = 0; k < segments; k++) {
        if (this._barrierCut(side, k)) continue;
        const i = k * BARRIER_STEP;
        this.pointAt(i, side * this.barrierOffset(i), 0, a);
        this.pointAt(i + BARRIER_STEP, side * this.barrierOffset(i + BARRIER_STEP), 0, b);
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz) + 0.35;
        const yaw = Math.atan2(dx, dz);
        const cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2;
        const cy = (this.roadY(i, side * this.barrierOffset(i)) + this.roadY(i + BARRIER_STEP, side * this.barrierOffset(i + BARRIER_STEP))) / 2 + height / 2;
        q.setFromAxisAngle(up, yaw);
        m.compose(p.set(cx, cy, cz), q, s.set(thick, height, len));
        mesh.setMatrixAt(n, m);
        mesh.setColorAt(n, this.theme.space ? new THREE.Color(rainbowColor(k)) : k % 2 === 0 ? (side > 0 ? ca : cc) : cb);
        // Collider is taller than the visual barrier so Mega-sized karts can't climb over.
        this.wallColliders.push(this.physics.addWall(cx, cy + 1.6, cz, thick / 2, 1.3 + 1.6, len / 2, yaw));
        n++;
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
  }

  // ------------------------------------------------------------------ shortcuts

  /**
   * Corner-cutting dirt paths through the infield of tight corners: a gap in the inside
   * barrier opens onto a fenced dirt track that rejoins at the corner exit. The dirt is a bit
   * slower than tarmac, but the path is much shorter (a mushroom makes it a steal).
   */
  _planShortcuts() {
    this.shortcuts = [];
    const t = this.theme;
    if (t.space) return;
    const rand = mulberry32(this.seed ^ 0x5c0f7c07);
    if (rand() < 0.2) return;
    const want = rand() < 0.35 ? 2 : 1;
    const seg = this.segmentLength;
    const busy = [];
    const startA = S - Math.ceil(70 / seg), startB = S + Math.ceil(60 / seg);
    busy.push([startA, startB], [startA - S, startB - S]);
    for (const br of this.bridges) busy.push([br.a - 10, br.b + 10]);
    for (const tu of this.tunnels) busy.push([tu.a - 14, tu.b + 14]);
    for (const jp of this.jumps) busy.push([jp.a - 8, jp.b + 8]);
    for (const c of this.crossings) busy.push([c.lower - 45, c.lower + 45]);
    const isBusy = (a, b) => busy.some(([c, d]) => [-S, 0, S].some((sh) => a <= d + sh && b >= c + sh));
    const minL = Math.ceil(30 / seg), maxL = Math.min(100, Math.floor(160 / seg));
    const pa = { x: 0, z: 0 }, pb = { x: 0, z: 0 }, q = { x: 0, z: 0 };
    // Cumulative length along each road edge, for quick arc lengths.
    const edgeLen = {};
    for (const side of [-1, 1]) {
      const acc = new Float64Array(2 * S + 1);
      this.pointAt(0, side * this.roadLimitAt(0), 0, q);
      let lx = q.x, lz = q.z;
      for (let i = 1; i <= 2 * S; i++) {
        this.pointAt(i, side * this.roadLimitAt(i), 0, q);
        acc[i] = acc[i - 1] + Math.hypot(q.x - lx, q.z - lz);
        lx = q.x; lz = q.z;
      }
      edgeLen[side] = acc;
    }
    const cands = [];
    for (let a = 0; a < S; a += 3) {
      for (let L = minL; L <= maxL; L += 2) {
        const b = a + L;
        if (isBusy(a, b)) continue;
        const m = circ(a + (L >> 1));
        const cx = (this.px[circ(a)] + this.px[circ(b)]) / 2, cz = (this.pz[circ(a)] + this.pz[circ(b)]) / 2;
        const midLat = -(cx - this.px[m]) * this.tz[m] + (cz - this.pz[m]) * this.tx[m];
        if (Math.abs(midLat) < this.barrierOffset(m) + SHORTCUT_HALF + 3) continue; // gentle bend: nothing to cut
        const side = Math.sign(midLat);
        const la = side * this.roadLimitAt(a), lb = side * this.roadLimitAt(b);
        this.pointAt(a, la, 0, pa);
        this.pointAt(b, lb, 0, pb);
        const dx = pb.x - pa.x, dz = pb.z - pa.z;
        const chord = Math.hypot(dx, dz);
        if (chord < 14 || chord > 90) continue;
        const arc = edgeLen[side][b] - edgeLen[side][a];
        if (arc - chord < 12 || arc - chord > 60 || arc / chord > 2.2) continue; // worth it, not a lap-breaker
        if (Math.abs(this.roadY(a, la) - this.roadY(b, lb)) / chord > 0.12) continue;
        const ux = dx / chord, uz = dz / chord;
        const sinA = Math.abs(this.tx[circ(a)] * uz - this.tz[circ(a)] * ux);
        const sinB = Math.abs(this.tx[circ(b)] * uz - this.tz[circ(b)] * ux);
        if (Math.min(sinA, sinB) < 0.45) continue;
        cands.push({ a, b, side, saving: arc - chord });
      }
    }
    cands.sort((u, v) => v.saving - u.saving);
    let tries = 0;
    for (const c of cands) {
      if (this.shortcuts.length >= want || tries > 60) break;
      if (this.shortcuts.some((s) => circDist(s.a, c.a) < 80 || circDist(s.b, c.b) < 80)) continue;
      tries++;
      const sc = this._shortcutPlan(c);
      if (sc) this.shortcuts.push(sc);
    }
  }

  _shortcutPlan({ a, b, side }) {
    const HALF = SHORTCUT_HALF;
    const la = side * this.roadLimitAt(a), lb = side * this.roadLimitAt(b);
    const A = this.pointAt(a, la, 0, { x: 0, z: 0 });
    const B = this.pointAt(b, lb, 0, { x: 0, z: 0 });
    const len = Math.hypot(B.x - A.x, B.z - A.z);
    const ux = (B.x - A.x) / len, uz = (B.z - A.z) / len;
    const sc = {
      a, b, side, ax: A.x, az: A.z, ux, uz, nx: -uz, nz: ux, len,
      ya: this.roadY(a, la), yb: this.roadY(b, lb), dStart: 0, dEnd: len, cut: new Set(), fences: [],
    };
    const at = (d, off) => ({ x: A.x + ux * d + sc.nx * off, z: A.z + uz * d + sc.nz * off });

    // Where each fence line leaves the road (crosses the inside barrier line) at both ends.
    const cross = (off, fromEnd) => {
      for (let k = 0; k <= 80; k++) {
        const d = fromEnd ? len + 6 - k * 0.25 : -6 + k * 0.25;
        const p = at(d, off);
        const j = this.nearestIndex(p.x, p.z, circ(fromEnd ? b : a));
        const out = this.lastLateral * side >= this.barrierOffset(j);
        if (k === 0 && out) return null;
        if (out) return { d, j, x: p.x, z: p.z };
      }
      return null;
    };
    const X = [];
    for (const e of [-1, 1]) {
      const xa = cross(e * (HALF + 0.4), false), xb = cross(e * (HALF + 0.4), true);
      if (!xa || !xb || xb.d - xa.d < 6) return null;
      X.push({ e, xa, xb });
    }
    sc.dStart = Math.min(X[0].xa.d, X[1].xa.d) - 1.5;
    sc.dEnd = Math.max(X[0].xb.d, X[1].xb.d) + 1.5;

    // The middle of the corridor must stay clear of other track parts and features (the
    // corner's own barrier is checked below, once we know which segments get cut).
    const mA = Math.max(X[0].xa.d, X[1].xa.d) + 1, mB = Math.min(X[0].xb.d, X[1].xb.d) - 1;
    for (let d = mA; d <= mB; d += 1.5) {
      const p = at(d, 0);
      if (this._nearFeature(p.x, p.z)) return null;
      if (this.theme.ocean && Math.hypot(p.x, p.z) > this.oceanRadius - 25) return null;
      for (let j = 0; j < S; j += 2) {
        if (this._inRange(j, a - 25, b + 25)) continue;
        const r = this.barrierOffset(j) + HALF + 10;
        if ((p.x - this.px[j]) ** 2 + (p.z - this.pz[j]) ** 2 < r * r) return null;
      }
    }

    // Inside-barrier segments the corridor passes through get removed.
    const P0 = { x: 0, z: 0 }, P1 = { x: 0, z: 0 };
    const inCorridor = (p) => {
      const d = (p.x - A.x) * ux + (p.z - A.z) * uz;
      const l = (p.x - A.x) * sc.nx + (p.z - A.z) * sc.nz;
      return Math.abs(l) < HALF + 0.6 && d > sc.dStart - 2 && d < sc.dEnd + 2;
    };
    const segs = Math.floor(S / BARRIER_STEP);
    const ranges = [];
    for (const end of [a, b]) {
      let k0 = Infinity, k1 = -Infinity;
      for (let k = 0; k < segs; k++) {
        const i = k * BARRIER_STEP;
        if (circDist(i, end) > 30) continue;
        this.pointAt(i, side * this.barrierOffset(i), 0, P0);
        this.pointAt(i + BARRIER_STEP, side * this.barrierOffset(i + BARRIER_STEP), 0, P1);
        const mid = { x: (P0.x + P1.x) / 2, z: (P0.z + P1.z) / 2 };
        if (inCorridor(P0) || inCorridor(P1) || inCorridor(mid)) {
          sc.cut.add(k);
          // Unwrap around the start line so the range stays contiguous.
          const ku = k + (end - i > S / 2 ? segs : i - end > S / 2 ? -segs : 0);
          k0 = Math.min(k0, ku); k1 = Math.max(k1, ku);
        }
      }
      if (k0 > k1) return null;
      ranges.push([k0, k1]);
    }
    // Every barrier we keep must stay outside the corridor.
    for (let j = a - 25; j <= b + 25; j++) {
      const i = circ(j);
      if (sc.cut.has(Math.floor(i / BARRIER_STEP))) continue;
      this.pointAt(i, side * this.barrierOffset(i), 0, P0);
      const d = (P0.x - A.x) * ux + (P0.z - A.z) * uz;
      const l = (P0.x - A.x) * sc.nx + (P0.z - A.z) * sc.nz;
      if (Math.abs(l) < HALF + 0.5 && d > sc.dStart && d < sc.dEnd) return null;
    }

    // Fences along both sides, joined to the cut barrier ends so there are no holes.
    const barrierEnd = (k) => {
      const i = k * BARRIER_STEP;
      const p = this.pointAt(i, side * this.barrierOffset(i), 0, { x: 0, z: 0 });
      return { x: p.x, z: p.z, y: this.roadY(i, side * this.barrierOffset(i)) };
    };
    const [ra, rb] = ranges;
    const endsA = [barrierEnd(ra[0]), barrierEnd(ra[1] + 1)]; // upstream, downstream
    const endsB = [barrierEnd(rb[0]), barrierEnd(rb[1] + 1)];
    const lowA = circDist(X[0].xa.j, a - 60) < circDist(X[1].xa.j, a - 60) ? 0 : 1;
    const lowB = circDist(X[0].xb.j, b - 60) < circDist(X[1].xb.j, b - 60) ? 0 : 1;
    for (let n = 0; n < 2; n++) {
      const { xa, xb } = X[n];
      const ea = endsA[n === lowA ? 0 : 1], eb = endsB[n === lowB ? 0 : 1];
      const pts = [ea];
      for (let d = xa.d; d < xb.d; d += 3) {
        const p = at(d, X[n].e * (HALF + 0.4));
        pts.push({ x: p.x, z: p.z, y: this._shortcutY(sc, p.x, p.z, d) });
      }
      pts.push({ x: xb.x, z: xb.z, y: this._shortcutY(sc, xb.x, xb.z, xb.d) }, eb);
      sc.fences.push(pts);
    }
    return sc;
  }

  /** Height of the dirt path; blends into the road surface at both ends. */
  _shortcutY(sc, x, z, d) {
    const t = Math.max(0, Math.min(1, d / sc.len));
    let y = sc.ya + (sc.yb - sc.ya) * t;
    const endDist = Math.min(d, sc.len - d);
    if (endDist < 8) {
      const j = this.nearestIndex(x, z, circ(d < sc.len / 2 ? sc.a : sc.b));
      const e = this.barrierOffset(j) + 0.7;
      const ry = this.roadY(j, Math.max(-e, Math.min(e, this.lastLateral)));
      y += (ry - y) * smooth01(1 - Math.max(0, endDist) / 8);
    }
    return y;
  }

  /** Distance from (x, z) to a shortcut corridor (0 inside), and the path height there. */
  _shortcutDist(sc, x, z, out) {
    const d = (x - sc.ax) * sc.ux + (z - sc.az) * sc.uz;
    const l = (x - sc.ax) * sc.nx + (z - sc.az) * sc.nz;
    const along = Math.max(0, sc.dStart - d, d - sc.dEnd);
    const across = Math.max(0, Math.abs(l) - SHORTCUT_HALF);
    out.dist = Math.hypot(along, across);
    out.d = Math.max(sc.dStart, Math.min(sc.dEnd, d));
    return out;
  }

  /** True when (x, z) is on a shortcut's dirt path. */
  shortcutAt(x, z) {
    for (const sc of this.shortcuts) {
      const d = (x - sc.ax) * sc.ux + (z - sc.az) * sc.uz;
      if (d < sc.dStart - 1 || d > sc.dEnd + 1) continue;
      if (Math.abs((x - sc.ax) * sc.nx + (z - sc.az) * sc.nz) <= SHORTCUT_HALF + 0.6) return true;
    }
    return false;
  }

  /** Is barrier segment k on this side cut open for a shortcut? */
  _barrierCut(side, k) {
    for (const sc of this.shortcuts) if (sc.side === side && sc.cut.has(k)) return true;
    return false;
  }

  _buildShortcuts() {
    if (!this.shortcuts.length) return;
    const t = this.theme;
    const DIRT = { meadow: 0xa47a4e, desert: 0xb88a52, snow: 0xdfe8f0, mushroom: 0x9a6b45, beach: 0xe3cc94, volcano: 0x4e3a33, ghost: 0x5a4a3c };
    const WOOD = { volcano: 0x2e2626, ghost: 0x3e3448 };
    const dirt = new THREE.Color(DIRT[t.id] ?? 0xa47a4e);
    const rut = dirt.clone().multiplyScalar(0.82).getHex();
    const edge = new THREE.Color(t.ground).multiplyScalar(0.8).getHex();
    const wood = WOOD[t.id] ?? 0x8a5a2b;
    const rand = mulberry32(this.seed ^ 0xd1e7);
    const rb = new RibbonBuilder();
    const fence = [];
    const H = SHORTCUT_HALF;
    // Lateral stops across the path: grass edge, dirt, wheel ruts, dirt, grass edge.
    const stops = [-H - 0.5, -H, -1.7, -0.9, 0.9, 1.7, H, H + 0.5];
    const shade = (k) => (k === 0 || k === 6 ? edge : k === 2 || k === 4 ? rut : 0);
    for (const sc of this.shortcuts) {
      const rows = [];
      const n = Math.max(2, Math.ceil((sc.dEnd - sc.dStart) / 1.5));
      for (let r = 0; r <= n; r++) {
        const d = sc.dStart + ((sc.dEnd - sc.dStart) * r) / n;
        const cx = sc.ax + sc.ux * d, cz = sc.az + sc.uz * d;
        rows.push({ d, cx, cz, y: this._shortcutY(sc, cx, cz, d) });
      }
      const P = (row, off, yOff = 0.07) => [row.cx + sc.nx * off, row.y + yOff, row.cz + sc.nz * off];
      for (let r = 0; r < n; r++) {
        const r0 = rows[r], r1 = rows[r + 1];
        const base = dirt.clone().multiplyScalar(0.92 + rand() * 0.12).getHex();
        for (let k = 0; k < stops.length - 1; k++) {
          const lo = stops[k], hi = stops[k + 1];
          const a = P(r0, hi), b = P(r1, hi), c = P(r1, lo), d = P(r0, lo);
          rb.quad(...a, ...b, ...c, ...d, shade(k) || base);
        }
        // Skirts down the sides so the path never floats above the ground.
        for (const s of [-1, 1]) {
          const off = s * (H + 0.5);
          const a = P(r0, off), b = P(r1, off);
          const a2 = [a[0], a[1] - 1.6, a[2]], b2 = [b[0], b[1] - 1.6, b[2]];
          rb.quad(...a, ...b, ...b2, ...a2, edge);
          rb.quad(...b, ...a, ...a2, ...b2, edge);
        }
      }
      // Driving surface: one trimesh strip a bit wider than the dirt (fences keep karts on it).
      const verts = new Float32Array(rows.length * 6);
      const idx = new Uint32Array((rows.length - 1) * 6);
      rows.forEach((row, i) => {
        const e = H + 1.4;
        verts.set([row.cx - sc.nx * e, row.y, row.cz - sc.nz * e, row.cx + sc.nx * e, row.y, row.cz + sc.nz * e], i * 6);
        if (i < rows.length - 1) idx.set([i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2], i * 6);
      });
      this.wallColliders.push(this.physics.addTrimesh(verts, idx));

      // Wooden fences: posts, two rails, and a wall collider per piece.
      for (const pts of sc.fences) {
        for (let k = 0; k < pts.length - 1; k++) {
          const p = pts[k], q = pts[k + 1];
          const dx = q.x - p.x, dz = q.z - p.z;
          const len = Math.hypot(dx, dz);
          if (len < 0.05) continue;
          const yaw = Math.atan2(dx, dz);
          const mx = (p.x + q.x) / 2, mz = (p.z + q.z) / 2, my = (p.y + q.y) / 2;
          fence.push(box(0.24, 1.2, 0.24, p.x, p.y + 0.6, p.z, wood));
          fence.push(box(0.1, 0.14, len + 0.1, mx, my + 0.45, mz, wood, 0, yaw, 0));
          fence.push(box(0.1, 0.14, len + 0.1, mx, my + 0.95, mz, wood, 0, yaw, 0));
          this.wallColliders.push(this.physics.addWall(mx, my + 1.2, mz, 0.2, 2.2, len / 2 + 0.15, yaw));
        }
        const last = pts[pts.length - 1];
        fence.push(box(0.24, 1.2, 0.24, last.x, last.y + 0.6, last.z, wood));
      }
    }
    this.group.add(new THREE.Mesh(rb.build(), this.renderer.toon({ vertexColors: true })));
    if (fence.length) this.group.add(new THREE.Mesh(merge(fence), this.renderer.toon({ vertexColors: true })));
  }

  _buildGantry() {
    const W = this.barrierOffset(0) + 0.8;
    const parts = [
      box(1.2, 8, 1.2, -W, 4, 0, 0x2b2d42),
      box(1.2, 8, 1.2, W, 4, 0, 0x2b2d42),
      box(W * 2 + 1.2, 1.4, 1.0, 0, 8.2, 0, 0x2b2d42),
    ];
    const cols = 16, cell = (W * 2) / cols;
    for (let r = 0; r < 2; r++) {
      for (let k = 0; k < cols; k++) {
        const hex = (r + k) % 2 === 0 ? 0x111111 : 0xffffff;
        parts.push(box(cell, 0.65, 1.1, -W + cell * (k + 0.5), 7.85 + r * 0.7, 0, hex));
      }
    }
    parts.push(cylinder(0.08, 0.08, 2.4, 6, -W, 10, 0, 0xdddddd));
    parts.push(cylinder(0.08, 0.08, 2.4, 6, W, 10, 0, 0xdddddd));
    parts.push(box(0.05, 0.9, 1.4, -W, 10.7, 0.75, 0xe63946));
    parts.push(box(0.05, 0.9, 1.4, W, 10.7, 0.75, 0x2a9df4));
    const mesh = new THREE.Mesh(merge(parts), this.renderer.toon({ vertexColors: true }));
    mesh.position.set(this.px[0], this.height[0], this.pz[0]);
    mesh.rotation.y = this.yaw[0];
    this.group.add(mesh);
  }

  _buildArches() {
    const W = EDGE_STD - 0.7;
    const geo = merge([
      box(0.6, 6, 0.6, -W, 3, 0, 0xffffff),
      box(0.6, 6, 0.6, W, 3, 0, 0xffffff),
      box(W * 2 + 0.6, 0.8, 0.5, 0, 6.2, 0, 0xffffff),
      box(W * 2 - 1, 0.35, 0.55, 0, 5.5, 0, 0x222222),
    ]);
    const archCps = [];
    for (let k = 2; k < CHECKPOINTS; k += 3) {
      const idx = this.checkpointIdx[k];
      if (!this.tunnels.some((tu) => this._inRange(idx, tu.a - 6, tu.b + 6))) archCps.push(idx);
    }
    const mesh = new THREE.InstancedMesh(geo, this.renderer.toon({ vertexColors: true }), Math.max(1, archCps.length));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const e = new THREE.Euler(0, 0, 0, 'YXZ');
    const p = new THREE.Vector3();
    const palette = [0x2a9df4, 0xf4c20d, 0x2ec27e, 0x9b5de5];
    const c = new THREE.Color();
    archCps.forEach((idx, n) => {
      // Local +x is the road's left, so roll by -atan(slope) to match the bank.
      q.setFromEuler(e.set(0, this.yaw[idx], -Math.atan(this.slope[idx])));
      m.compose(p.set(this.px[idx], this.height[idx], this.pz[idx]), q, s.set(this.barrierOffset(idx) / W, 1, 1));
      mesh.setMatrixAt(n, m);
      mesh.setColorAt(n, c.setHex(palette[n % palette.length]));
    });
    mesh.count = archCps.length;
    if (mesh.count === 0) return;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
  }

  /** Bridge/overpass pillars, ponds, tunnel shells, portals and hills (one merged draw call). */
  _buildFeatures() {
    const parts = [];
    const p = { x: 0, z: 0 }, q = { x: 0, z: 0 };
    const edge = EDGE_STD;
    const t = this.theme;

    for (const br of this.bridges) {
      // Pillars under the deck (kept clear of any road passing underneath).
      const pillarStep = Math.max(4, Math.round(9 / this.segmentLength));
      for (let i = br.deckA; i <= br.deckB; i += pillarStep) {
        const h = this.heightAt(i);
        for (const side of [-1, 1]) {
          this.pointAt(i, side * (edge - 0.6), 0, p);
          if (br.type === 'overpass' && this._nearOtherRoad(p.x, p.z, br, 2.5)) continue;
          if (t.space) continue;
          parts.push(box(1.1, h, 1.1, p.x, h / 2 - 0.3, p.z, 0x8b9099));
        }
      }
      if (br.type === 'water') {
        const mid = circ(Math.round((br.deckA + br.deckB) / 2));
        const lenHalf = ((br.deckB - br.deckA) * this.segmentLength) / 2 + 2;
        const pond = new THREE.CircleGeometry(1, 28);
        pond.rotateX(-Math.PI / 2);
        pond.scale(20, 1, lenHalf);
        pond.rotateY(this.yaw[mid]);
        pond.translate(this.px[mid], 0.03, this.pz[mid]);
        parts.push(paint(pond.toNonIndexed(), t.water));
      }
    }

    for (const tu of this.tunnels) {
      const R = edge + 0.4, RY = 7.2;
      const SEG = 8;
      const step = 2;
      const ring = (i, out) => {
        for (let k = 0; k <= SEG; k++) {
          const th = (k / SEG) * Math.PI;
          this.pointAt(i, Math.cos(th) * R, 0, p);
          out.push([p.x, this.heightAt(i) + Math.sin(th) * RY, p.z]);
        }
      };
      const shell = new RibbonBuilder();
      let prev = [];
      ring(tu.a, prev);
      for (let i = tu.a + step; i <= tu.b; i += step) {
        const cur = [];
        ring(i, cur);
        const hex = ((i / step) | 0) % 2 === 0 ? 0x8a8279 : 0x7f776e;
        for (let k = 0; k < SEG; k++) {
          const a0 = prev[k], a1 = prev[k + 1], b1 = cur[k + 1], b0 = cur[k];
          shell.quad(a0[0], a0[1], a0[2], a1[0], a1[1], a1[2], b1[0], b1[1], b1[2], b0[0], b0[1], b0[2], hex);
        }
        if (((i / step) | 0) % 3 === 0) {
          this.pointAt(i, 0, 0, p);
          parts.push(box(3.2, 0.2, 0.8, p.x, this.heightAt(i) + RY - 0.25, p.z, 0xfff3b0, 0, this.yaw[circ(i)], 0));
        }
        prev = cur;
      }
      const shellGeo = shell.build();
      shellGeo.computeVertexNormals();
      parts.push(shellGeo);
      const frameRb = new RibbonBuilder();
      const FW = 1.5, DEPTH = 1.4, FSEG = 20;
      const archPt = (i, th, grow, fwd) => {
        this.pointAt(i, Math.cos(th) * (R + grow), fwd, p);
        return [p.x, this.heightAt(i) + Math.sin(th) * (RY + grow), p.z];
      };
      for (const [i, dir] of [[tu.a, -1], [tu.b, 1]]) {
        for (let k = 0; k < FSEG; k++) {
          const t0 = (k / FSEG) * Math.PI, t1 = ((k + 1) / FSEG) * Math.PI;
          const hex = k % 2 === 0 ? 0x5d554d : 0x685f56;
          for (const [g0, g1, f0, f1] of [
            [0, FW, dir * DEPTH, dir * DEPTH],
            [0, FW, 0, 0],
            [FW, FW, 0, dir * DEPTH],
            [0, 0, 0, dir * DEPTH],
          ]) {
            const q0 = archPt(i, t0, g0, f0), q1 = archPt(i, t1, g0, f0);
            const q2 = archPt(i, t1, g1, f1), q3 = archPt(i, t0, g1, f1);
            frameRb.quad(q0[0], q0[1], q0[2], q1[0], q1[1], q1[2], q2[0], q2[1], q2[2], q3[0], q3[1], q3[2], hex);
          }
        }
      }
      const frameGeo = frameRb.build();
      frameGeo.computeVertexNormals();
      parts.push(frameGeo);
      parts.push(this._tunnelHill(tu, R, RY, t.hillColor));
    }

    if (parts.length === 0) return;
    for (const g of parts) {
      for (const name of Object.keys(g.attributes)) {
        if (name !== 'position' && name !== 'normal' && name !== 'color') g.deleteAttribute(name);
      }
      if (!g.attributes.normal) g.computeVertexNormals();
    }
    this.group.add(new THREE.Mesh(merge(parts), this.renderer.toon({ vertexColors: true, side: THREE.DoubleSide })));
  }

  /** Is (x, z) on or beside a part of the road that isn't this bridge's own span? */
  _nearOtherRoad(x, z, br, margin) {
    for (let i = 0; i < S; i += 2) {
      if (this._inRange(i, br.a - 4, br.b + 4)) continue;
      const dx = x - this.px[i], dz = z - this.pz[i];
      const r = this.barrierOffset(i) + margin;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  /** Hill swept along the tunnel with arch-shaped portal faces at both ends. */
  _tunnelHill(tu, R, RY, hex) {
    const rb = new RibbonBuilder();
    const { width: HW, height: HH } = TUNNEL_HILL;
    const N = 16;
    const p = { x: 0, z: 0 };
    const col = new THREE.Color();
    const base = new THREE.Color(hex);
    const outer = (u) => {
      const lat = -HW + 2 * HW * u;
      const t = 1 - (lat / HW) ** 2;
      return [lat, HH * Math.pow(Math.max(0, t), 0.6)];
    };
    const inner = (u) => {
      const lat = -HW + 2 * HW * u;
      if (Math.abs(lat) >= R) return [lat, 0];
      return [lat, RY * Math.sqrt(1 - (lat / R) ** 2)];
    };
    const at = (i, lat, y) => {
      this.pointAt(i, lat, 0, p);
      return [p.x, this.heightAt(i) + y, p.z];
    };
    const shade = (k, i) => col.copy(base).multiplyScalar(0.9 + 0.1 * Math.sin(k * 1.7 + i * 0.9)).getHex();
    const step = 2;
    for (let i = tu.a; i < tu.b; i += step) {
      const j = Math.min(i + step, tu.b);
      for (let k = 0; k < N; k++) {
        const [l0, y0] = outer(k / N), [l1, y1] = outer((k + 1) / N);
        const a0 = at(i, l0, y0), a1 = at(i, l1, y1), b1 = at(j, l1, y1), b0 = at(j, l0, y0);
        rb.quad(a0[0], a0[1], a0[2], b0[0], b0[1], b0[2], b1[0], b1[1], b1[2], a1[0], a1[1], a1[2], shade(k, i));
      }
    }
    for (const i of [tu.a, tu.b]) {
      for (let k = 0; k < N * 2; k++) {
        const u0 = k / (N * 2), u1 = (k + 1) / (N * 2);
        const [lo0, yo0] = outer(u0), [lo1, yo1] = outer(u1);
        const [li0, yi0] = inner(u0), [li1, yi1] = inner(u1);
        const o0 = at(i, lo0, yo0), o1 = at(i, lo1, yo1), n1 = at(i, li1, yi1), n0 = at(i, li0, yi0);
        rb.quad(n0[0], n0[1], n0[2], n1[0], n1[1], n1[2], o1[0], o1[1], o1[2], o0[0], o0[1], o0[2], col.copy(base).multiplyScalar(0.8).getHex());
      }
    }
    const g = rb.build();
    g.computeVertexNormals();
    return g;
  }

  /** Keep scenery out of ponds, overpasses and tunnel hills. */
  _nearFeature(x, z) {
    for (const sc of this.shortcuts) {
      if (this._shortcutDist(sc, x, z, this._sd || (this._sd = { dist: 0, d: 0 })).dist < 6) return true;
    }
    for (const list of [this.bridges, this.tunnels]) {
      for (const f of list) {
        const mid = circ(Math.round((f.a + f.b) / 2));
        const r = ((f.b - f.a) * this.segmentLength) / 2 + TUNNEL_HILL.width + 6;
        if ((x - this.px[mid]) ** 2 + (z - this.pz[mid]) ** 2 < r * r) return true;
      }
    }
    return false;
  }

  _buildScenery(rand) {
    const t = this.theme;
    const tr = { y: 0, d: 0, j: 0 };
    // Random ground spot `minD..maxD` metres beyond the barriers, clear of features/ocean.
    const spot = (minD, maxD) => {
      for (let tries = 0; tries < 12; tries++) {
        const x = (rand() - 0.5) * (GROUND_SIZE - 80);
        const z = (rand() - 0.5) * (GROUND_SIZE - 80);
        this.terrainAt(x, z, tr);
        if (tr.d < minD || tr.d > maxD) continue;
        if (this._nearFeature(x, z)) continue;
        if (t.ocean && Math.hypot(x, z) > this.oceanRadius - 18) continue;
        return { x, y: tr.y, z };
      }
      return null;
    };
    buildScenery({ track: this, theme: t, rand, group: this.group, renderer: this.renderer, spot });
    if (this.mood === 'night') buildNightSky(this.group, rand);
    if (!t.space) {
      buildGrandstand(this, this.renderer, this.group, rand);
      buildTireStacks(this, this.renderer, this.group);
    }

    // Distant mountains ring (one instanced draw call).
    if (t.mountains) {
      const mountGeo = new THREE.ConeGeometry(1, 1, 6);
      mountGeo.translate(0, 0.5, 0);
      const mountains = new THREE.InstancedMesh(mountGeo, this.renderer.toon({ color: 0xffffff }), 28);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      const p = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      const c = new THREE.Color();
      for (let k = 0; k < 28; k++) {
        const ang = (k / 28) * Math.PI * 2 + rand() * 0.1;
        const r = GROUND_SIZE / 2 + 30 + rand() * 50;
        const h = 60 + rand() * 90;
        const w = 50 + rand() * 40;
        q.setFromAxisAngle(up, rand() * Math.PI);
        m.compose(p.set(Math.cos(ang) * r, -2, Math.sin(ang) * r), q, s.set(w, h, w));
        mountains.setMatrixAt(k, m);
        mountains.setColorAt(k, c.setHex(t.mountains[k % t.mountains.length]));
      }
      mountains.instanceMatrix.needsUpdate = true;
      mountains.instanceColor.needsUpdate = true;
      mountains.computeBoundingSphere();
      this.group.add(mountains);
    }
  }

  _computeMinimap() {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < S; i++) {
      minX = Math.min(minX, this.px[i]); maxX = Math.max(maxX, this.px[i]);
      minZ = Math.min(minZ, this.pz[i]); maxZ = Math.max(maxZ, this.pz[i]);
    }
    this.bounds = { minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
  }

  /** Map world XZ to minimap pixels. */
  toMinimap(x, z, size, pad, out) {
    const b = this.bounds;
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    const scale = (size - pad * 2) / span;
    out.x = size / 2 - (x - b.cx) * scale;
    out.y = size / 2 - (z - b.cz) * scale;
    return out;
  }

  /** Item box positions for every planned row, laid out in the row's formation. */
  _itemBoxSpots() {
    const spots = [];
    const tmp = { x: 0, z: 0 };
    const add = (i, f) => {
      const w = this.width[circ(i)];
      this.pointAt(i, f * w, 0, tmp);
      spots.push({ x: tmp.x, z: tmp.z, y: this.roadY(i, f * w) });
    };
    const gap = Math.max(3, Math.round(6 / this.segmentLength)); // second line of a stagger
    for (const row of this.boxRows) {
      switch (row.formation) {
        case 'line5': for (const f of [-0.72, -0.36, 0, 0.36, 0.72]) add(row.i, f); break;
        case 'line3': for (const f of [-0.55, 0, 0.55]) add(row.i, f); break;
        case 'stagger':
          for (const f of [-0.6, 0, 0.6]) add(row.i, f);
          for (const f of [-0.3, 0.3]) add(row.i + gap, f);
          break;
        case 'pairs':
          for (const f of [-0.7, -0.45]) add(row.i, f);
          for (const f of [0.45, 0.7]) add(row.i + gap, f);
          break;
        default: for (const f of [-0.66, -0.22, 0.22, 0.66]) add(row.i, f);
      }
    }
    return spots;
  }

  /** Coins scattered as singles and small clusters (seeded: identical on every peer). */
  _coinSpots() {
    const rand = mulberry32(this.seed ^ 0xc01c0);
    const spots = [];
    const tmp = { x: 0, z: 0 };
    const TOTAL = 45;
    const boxRows = this.boxRows.map((r) => r.i);
    for (const sc of this.shortcuts) {
      for (const f of [0.35, 0.5, 0.65]) {
        const d = sc.len * f, x = sc.ax + sc.ux * d, z = sc.az + sc.uz * d;
        spots.push({ x, z, y: this._shortcutY(sc, x, z, d) });
      }
    }
    while (spots.length < TOTAL) {
      const i = 30 + Math.floor(rand() * (S - 50));
      if (boxRows.some((r) => Math.abs(r - i) < 8)) continue;
      const size = Math.min(TOTAL - spots.length, 1 + Math.floor(rand() * rand() * 4));
      const w = this.width[i] - 1.5;
      const lat = (rand() * 2 - 1) * w;
      for (let k = 0; k < size; k++) {
        const j = i + k * 2;
        const l = Math.max(-w, Math.min(w, lat + (rand() - 0.5) * 3));
        this.pointAt(j, l, 0, tmp);
        spots.push({ x: tmp.x, z: tmp.z, y: this.roadY(j, l) });
      }
    }
    return spots;
  }

  /**
   * Nearest centre-line sample, searched locally around `hint` (or globally when hint < 0).
   * Also stores the signed lateral offset (positive = right of centre) in `lastLateral`.
   */
  nearestIndex(x, z, hint = -1) {
    let best = -1, bestD = Infinity;
    if (hint < 0) {
      for (let i = 0; i < S; i++) {
        const dx = x - this.px[i], dz = z - this.pz[i];
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
    } else {
      for (let o = -30; o <= 30; o++) {
        const i = (hint + o + S) % S;
        const dx = x - this.px[i], dz = z - this.pz[i];
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
      if (bestD > 60 * 60) return this.nearestIndex(x, z, -1);
    }
    const dx = x - this.px[best], dz = z - this.pz[best];
    this.lastLateral = -dx * this.tz[best] + dz * this.tx[best];
    return best;
  }

  /** Grid slot behind the start line: two staggered columns. */
  gridSlot(slot, out = { x: 0, z: 0, yaw: 0, idx: 0 }) {
    const row = Math.floor(slot / 2);
    const col = slot % 2;
    const back = 7 + row * 6 + col * 2.5;
    const idx = (S - Math.round(back / this.segmentLength)) % S;
    this.pointAt(idx, col === 0 ? -4 : 4, 0, out);
    out.yaw = this.yaw[idx];
    out.idx = idx;
    return out;
  }
}

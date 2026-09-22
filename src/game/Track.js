import * as THREE from 'three';
import { RibbonBuilder, box, cylinder, merge, mulberry32, paint } from '../engine/geometry.js';

const S = 720; // centre-line samples
const HALF_WIDTH = 9;
const CURB_WIDTH = 1.6;
const BARRIER_OFFSET = HALF_WIDTH + CURB_WIDTH + 1.0;
const BARRIER_STEP = 3; // samples per barrier segment
const CHECKPOINTS = 12;
const GROUND_SIZE = 900;

// Hand-made fallback layout, used if the generator can't find a valid circuit.
const CLASSIC_LAYOUT = [
  [0, -120], [70, -122], [120, -95], [130, -40], [95, -5], [50, 5], [35, 45], [65, 85],
  [55, 125], [5, 135], [-45, 112], [-60, 65], [-105, 45], [-130, -5], [-115, -70], [-65, -112],
].map(([x, z]) => [x * 1.35, z * 1.35]);

const THEMES = [
  {
    id: 'meadow', ground: 0x6fbf4a, leaves: [0x2d8a3e, 0x3fa34d, 0x1f6f35, 0x5bb450],
    mountains: [0x7d9c6b, 0x8fae7a, 0x6d8a60, 0x9fb7a0],
    words: ['Clover', 'Sunny', 'Daisy', 'Meadow', 'Willow', 'Honey'],
  },
  {
    id: 'desert', ground: 0xe0bd72, leaves: [0x5f8f3a, 0x7aa04a, 0x6b8e23],
    mountains: [0xc9895a, 0xd9a066, 0xb87447, 0xe0b07a],
    words: ['Dusty', 'Cactus', 'Mirage', 'Canyon', 'Sunbaked', 'Mesa'],
  },
  {
    id: 'snow', ground: 0xe9f1f7, leaves: [0x1f5f3a, 0x2c6e46, 0x245c3c],
    mountains: [0xdfe8ef, 0xc5d3dd, 0xaebfcc, 0xf2f6f9],
    words: ['Frosty', 'Glacier', 'Blizzard', 'Snowcap', 'Polar', 'Icicle'],
  },
  {
    id: 'autumn', ground: 0x9cbf4f, leaves: [0xe07a2b, 0xd9480f, 0xf2b134, 0xb5361c],
    mountains: [0x9c7b5b, 0xae8c63, 0x8a6b4e, 0xbf9d72],
    words: ['Amber', 'Harvest', 'Pumpkin', 'Rusty', 'Maple', 'Cider'],
  },
];
const TRACK_NOUNS = ['Circuit', 'Loop', 'Raceway', 'Speedway', 'Ring', 'Grand Prix', 'Park'];

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const TUNNEL_HILL = { width: 26, height: 13 }; // half-width at ground, peak height

/**
 * Procedurally generated closed spline circuit: road ribbon, curbs, barriers (instanced +
 * Rapier colliders), start gantry, checkpoint arches and scenery. The layout is fully
 * determined by a seed, so the host only has to send one number for every peer to build
 * the identical track. Also answers progress queries.
 */
export class Track {
  constructor(renderer, physics, seed = 1) {
    this.renderer = renderer;
    this.physics = physics;
    this.samples = S;
    this.halfWidth = HALF_WIDTH;
    this.roadLimit = HALF_WIDTH + CURB_WIDTH; // beyond this we're off-road

    this.px = new Float32Array(S);
    this.pz = new Float32Array(S);
    this.tx = new Float32Array(S);
    this.tz = new Float32Array(S);
    this.yaw = new Float32Array(S);
    this.checkpointIdx = new Int32Array(CHECKPOINTS);
    for (let k = 0; k < CHECKPOINTS; k++) this.checkpointIdx[k] = Math.round((k * S) / CHECKPOINTS);
    this.checkpointCount = CHECKPOINTS;
    this.lastLateral = 0;
    this.height = new Float32Array(S); // road elevation per sample (bridges)
    this.bridges = [];
    this.tunnels = [];
    this.ice = [];

    this.group = null;
    this.wallColliders = [];
    physics.addGround(GROUND_SIZE / 2);
    this.generate(seed);
  }

  /** Tear down the current circuit and build a new one from `seed`. */
  generate(seed) {
    this.seed = seed >>> 0;
    const rand = mulberry32(this.seed);
    this.theme = THEMES[Math.floor(rand() * THEMES.length)];
    this.name = `${this.theme.words[Math.floor(rand() * this.theme.words.length)]} ${TRACK_NOUNS[Math.floor(rand() * TRACK_NOUNS.length)]}`;

    let ok = false;
    // Two layout families: structured grid circuits (most rounds) and flowing loops.
    this.style = rand() < 0.8 ? 'circuit' : 'flowing';
    for (let attempt = 0; attempt < 120 && !ok; attempt++) {
      const layout = this.style === 'circuit' ? this._gridLayout(rand) : this._randomLayout(rand);
      if (!layout) continue;
      this._computeCenterLine(layout);
      ok = this._isValid();
    }
    if (!ok) this._computeCenterLine(CLASSIC_LAYOUT);
    this._planFeatures(rand);

    this._dispose();
    this.group = new THREE.Group();
    this.renderer.scene.add(this.group);
    this._buildGround();
    this._buildRoad();
    this._buildBarriers();
    this._buildGantry();
    this._buildArches();
    this._buildFeatures();
    this._buildScenery(rand);
    this._computeMinimap();
    this.itemBoxSpots = this._itemBoxSpots();
    this.coinSpots = this._coinSpots();
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

  /**
   * "Circuit" layout: grow a random polyomino on a coarse grid, trace its outline and round
   * the corners. This produces real straights, 90° corners, U-shaped hairpins and notches
   * (L, U, T, S shapes …) instead of blobby loops. Returns null if the shape is unusable.
   */
  _gridLayout(rand) {
    const cols = 3 + Math.floor(rand() * 3); // 3..5
    const rows = 2 + Math.floor(rand() * 3); // 2..4
    const cell = 58 + rand() * 24;
    const key = (x, y) => x + ',' + y;

    // Grow a connected set of cells.
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

    // Boundary edges, oriented so the shape is on the left (counter-clockwise walk).
    const next = new Map();
    let edges = 0;
    const addEdge = (ax, ay, bx, by) => {
      const k = key(ax, ay);
      if (next.has(k)) next.set(k, null); // vertex used twice = pinch point → reject later
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

    // Walk the single loop; a hole or disjoint outline shows up as a short walk.
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

    // Keep only the corners.
    const corners = [];
    const n = loop.length;
    for (let i = 0; i < n; i++) {
      const p = loop[(i - 1 + n) % n], c = loop[i], q = loop[(i + 1) % n];
      if ((c[0] - p[0]) * (q[1] - c[1]) - (c[1] - p[1]) * (q[0] - c[0]) !== 0) corners.push(c);
    }
    if (corners.length < 6) return null; // plain rectangles are boring: need at least one notch

    // World space, centred, randomly rotated.
    const rot = rand() * Math.PI * 2;
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const world = corners.map(([x, y]) => {
      const wx = (x - cols / 2) * cell, wz = (y - rows / 2) * cell;
      return [wx * cr - wz * sr, wx * sr + wz * cr];
    });

    // Round each corner with a 3-point arc; fill long straights with collinear points so the
    // spline stays straight, and occasionally drop in a chicane.
    const pts = [];
    let bestStraight = -1, bestLen = 0;
    const m = world.length;
    const segLen = (i) => {
      const a = world[i], b = world[(i + 1) % m];
      return Math.hypot(b[0] - a[0], b[1] - a[1]);
    };
    // Corner radii first, so straights know exactly where the next corner begins.
    const radii = world.map((_, i) => Math.min(segLen((i - 1 + m) % m) / 2 - 2, segLen(i) / 2 - 2, 18 + rand() * 10));
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

      // Straight from this corner's exit to the next corner's entry.
      const sx = c[0] + dout[0] * r, sz = c[1] + dout[1] * r;
      const rNext = radii[(i + 1) % m];
      const len = outLen - r - rNext;
      const steps = Math.floor(len / 35);
      const chicane = len > 110 && rand() < 0.35;
      const side = [-dout[1], dout[0]];
      for (let k = 1; k <= steps; k++) {
        const t = (k / (steps + 1)) * len;
        let off = 0;
        if (chicane) {
          const u = k / (steps + 1);
          if (u > 0.3 && u < 0.7) off = Math.sin(((u - 0.3) / 0.4) * Math.PI * 2) * 7;
        }
        pts.push([sx + dout[0] * t + side[0] * off, sz + dout[1] * t + side[1] * off]);
        if (!chicane && k === Math.ceil(steps / 2) && len > bestLen) {
          bestLen = len;
          bestStraight = pts.length - 1;
        }
      }
    }
    // Start/finish in the middle of the longest clean straight.
    if (bestStraight > 0) return pts.slice(bestStraight).concat(pts.slice(0, bestStraight));
    return pts;
  }

  /** Random star-shaped loop: points at increasing angles with noisy, smoothed radii. */
  _randomLayout(rand) {
    const n = 8 + Math.floor(rand() * 6);
    const baseR = 115 + rand() * 45;
    const sx = 0.75 + rand() * 0.55;
    const sz = 0.75 + rand() * 0.45;
    const radii = [];
    for (let k = 0; k < n; k++) radii.push(0.45 + rand() * 0.6);
    const smooth = radii.map((r, k) => 0.5 * r + 0.25 * (radii[(k + n - 1) % n] + radii[(k + 1) % n]));
    const rot = rand() * Math.PI * 2;
    const pts = [];
    for (let k = 0; k < n; k++) {
      const a = rot + ((k + (rand() - 0.5) * 0.45) / n) * Math.PI * 2;
      const r = baseR * smooth[k];
      pts.push([Math.cos(a) * r * sx, Math.sin(a) * r * sz]);
    }
    return pts;
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

  /** Reject layouts that are too short/long, have hairpins tighter than the road allows, or overlap. */
  _isValid() {
    if (this.length < 700 || this.length > 1500) return false;
    const seg = this.segmentLength;
    const half = GROUND_SIZE / 2 - 40;
    for (let i = 0; i < S; i++) {
      if (Math.abs(this.px[i]) > half || Math.abs(this.pz[i]) > half) return false;
      const dyaw = Math.abs(wrap(this.yaw[(i + 4) % S] - this.yaw[(i - 4 + S) % S]));
      if (dyaw > 1e-4 && (8 * seg) / dyaw < 17) return false; // min turn radius
    }
    const minDist = 2 * BARRIER_OFFSET + 10;
    const minDist2 = minDist * minDist;
    const minGap = Math.ceil(70 / seg);
    for (let i = 0; i < S; i += 3) {
      for (let j = i + minGap; j < S; j += 3) {
        if (S - (j - i) < minGap) break;
        const dx = this.px[i] - this.px[j], dz = this.pz[i] - this.pz[j];
        if (dx * dx + dz * dz < minDist2) return false;
      }
    }
    return true;
  }

  /** World position at sample i shifted `lat` metres to the kart's right and `fwd` metres forward. */
  pointAt(i, lat, fwd = 0, out = { x: 0, z: 0 }) {
    const j = ((i % S) + S) % S;
    const tx = this.tx[j], tz = this.tz[j];
    out.x = this.px[j] - tz * lat + tx * fwd;
    out.z = this.pz[j] + tx * lat + tz * fwd;
    return out;
  }

  _buildGround() {
    const size = GROUND_SIZE;
    const geo = new THREE.PlaneGeometry(size, size, 40, 40);
    geo.rotateX(-Math.PI / 2);
    const rand = mulberry32(this.seed ^ 0x9e3779b9);
    paint(geo, this.theme.ground);
    const col = geo.attributes.color;
    for (let i = 0; i < col.count; i++) {
      const v = 0.9 + rand() * 0.14;
      col.setXYZ(i, col.getX(i) * v, col.getY(i) * v, col.getZ(i) * v);
    }
    const mesh = new THREE.Mesh(geo, this.renderer.toon({ vertexColors: true }));
    this.group.add(mesh);
  }

  _buildRoad() {
    const rb = new RibbonBuilder();
    const H = this.height;
    const a = { x: 0, z: 0 }, b = { x: 0, z: 0 }, c = { x: 0, z: 0 }, d = { x: 0, z: 0 };
    const hAt = (i) => H[((i % S) + S) % S];
    // Horizontal strip between lateral offsets lo..hi, following the road elevation.
    const strip = (i, lo, hi, yOff, hex) => {
      const y0 = hAt(i) + yOff, y1 = hAt(i + 1) + yOff;
      this.pointAt(i, hi, 0, a);
      this.pointAt(i + 1, hi, 0, b);
      this.pointAt(i + 1, lo, 0, c);
      this.pointAt(i, lo, 0, d);
      rb.quad(a.x, y0, a.z, b.x, y1, b.z, c.x, y1, c.z, d.x, y0, d.z, hex);
    };
    // Vertical wall at lateral offset `lat` from the deck down to `bottom` (material is double-sided).
    const skirt = (i, lat, bottom, hex) => {
      const y0 = hAt(i), y1 = hAt(i + 1);
      this.pointAt(i, lat, 0, a);
      this.pointAt(i + 1, lat, 0, b);
      rb.quad(a.x, y0, a.z, b.x, y1, b.z, b.x, Math.min(bottom, y1), b.z, a.x, Math.min(bottom, y0), a.z, hex);
    };
    const edge = BARRIER_OFFSET + 0.7;

    for (let i = 0; i < S; i++) {
      const band = Math.floor(i / 8) % 2 === 0;
      strip(i, -HALF_WIDTH, HALF_WIDTH, 0.05, band ? 0x464a52 : 0x4d525b);
      const curb = Math.floor(i / 3) % 2 === 0 ? 0xe63946 : 0xf5f5f5;
      strip(i, HALF_WIDTH, HALF_WIDTH + CURB_WIDTH, 0.07, curb);
      strip(i, -HALF_WIDTH - CURB_WIDTH, -HALF_WIDTH, 0.07, curb);
      // white edge lines and dashed centre line
      strip(i, HALF_WIDTH - 0.5, HALF_WIDTH - 0.2, 0.08, 0xeaeaea);
      strip(i, -HALF_WIDTH + 0.2, -HALF_WIDTH + 0.5, 0.08, 0xeaeaea);
      if (Math.floor(i / 5) % 2 === 0) strip(i, -0.18, 0.18, 0.08, 0xf2d64b);

      // Elevated sections (bridges): concrete shoulders out to the railings plus side walls.
      if (H[i] > 0.02 || H[(i + 1) % S] > 0.02) {
        strip(i, HALF_WIDTH + CURB_WIDTH, edge, 0.06, 0x9aa0a8);
        strip(i, -edge, -HALF_WIDTH - CURB_WIDTH, 0.06, 0x9aa0a8);
        const overWater = this._isOverWater(i);
        const bottom = overWater ? hAt(i) - 0.9 : 0;
        skirt(i, edge, bottom, overWater ? 0x7d828a : 0xa08c74);
        skirt(i, -edge, bottom, overWater ? 0x7d828a : 0xa08c74);
      }
    }

    // Ice patches (snow theme): pale slick quads just above the asphalt.
    for (const p of this.ice) {
      for (let i = p.a; i < p.b; i++) {
        const shade = (i - p.a) % 4 < 2 ? 0xd6f1ff : 0xc4e8fb;
        strip(i, p.lo, p.hi, 0.075, shade);
      }
    }

    // Chequered start/finish line across the road at sample 0.
    const cols = 12, rows = 2, cell = (HALF_WIDTH * 2) / cols;
    for (let r = 0; r < rows; r++) {
      for (let k = 0; k < cols; k++) {
        const lo = -HALF_WIDTH + k * cell, hi = lo + cell;
        const f0 = -cell + r * cell, f1 = f0 + cell;
        this.pointAt(0, hi, f0, a);
        this.pointAt(0, hi, f1, b);
        this.pointAt(0, lo, f1, c);
        this.pointAt(0, lo, f0, d);
        const hex = (r + k) % 2 === 0 ? 0x111111 : 0xffffff;
        rb.quad(a.x, 0.09, a.z, b.x, 0.09, b.z, c.x, 0.09, c.z, d.x, 0.09, d.z, hex);
      }
    }
    const mesh = new THREE.Mesh(rb.build(), this.renderer.toon({ vertexColors: true, side: THREE.DoubleSide }));
    this.group.add(mesh);
  }

  // ------------------------------------------------------------------ features

  /** Pick bridge, tunnel and ice locations deterministically from the seed. */
  _planFeatures(rand) {
    this.height.fill(0);
    this.bridges = [];
    this.tunnels = [];
    this.ice = [];
    const seg = this.segmentLength;
    const blocked = [];
    const reserve = (a, b) => blocked.push([a, b]);
    const overlaps = (a, b) => blocked.some(([c, d]) => {
      for (const shift of [-S, 0, S]) if (a <= d + shift && b >= c + shift) return true;
      return false;
    });
    const maxBend = (a, b) => {
      let m = 0;
      for (let i = a; i <= b; i++) m = Math.max(m, Math.abs(wrap(this.yaw[i % S] - this.yaw[a % S])));
      return m;
    };
    reserve(S - Math.ceil(60 / seg), S + Math.ceil(50 / seg)); // start straight & grid
    reserve(-Math.ceil(60 / seg), Math.ceil(50 / seg));
    for (const f of [0.2, 0.48, 0.77]) reserve(Math.round(f * S) - 12, Math.round(f * S) + 12); // item boxes

    // Minimum distance from the feature's centre line to any unrelated part of the track.
    const clear = (a, b, dist) => {
      const margin = Math.ceil(40 / seg);
      for (let i = a; i <= b; i += 2) {
        const x = this.px[i % S], z = this.pz[i % S];
        for (let j = 0; j < S; j += 2) {
          const gap = Math.min(Math.abs(j - (i % S)), S - Math.abs(j - (i % S)));
          if (gap < (b - a) / 2 + margin) continue;
          if ((x - this.px[j]) ** 2 + (z - this.pz[j]) ** 2 < dist * dist) return false;
        }
      }
      return true;
    };
    const place = (count, lengthM, bend, list, clearance = 0) => {
      const span = Math.round(lengthM / seg);
      for (let tries = 0; tries < 60 && list.length < count; tries++) {
        const a = Math.floor(rand() * S);
        const b = a + span;
        if (overlaps(a - 8, b + 8) || maxBend(a, b) > bend) continue;
        if (clearance && !clear(a, b, clearance)) continue;
        reserve(a - 8, b + 8);
        list.push({ a, b });
      }
    };
    place(rand() < 0.45 ? 2 : 1, 120, 0.9, this.bridges);
    place(rand() < 0.35 ? 2 : 1, 75, 0.8, this.tunnels, TUNNEL_HILL.width + BARRIER_OFFSET + 3);

    // Arched elevation profile for each bridge: smooth ramps up to a flat deck.
    const RISE = 5.5;
    for (const br of this.bridges) {
      const span = br.b - br.a;
      const ramp = Math.round(38 / seg);
      br.deckA = br.a + ramp;
      br.deckB = br.b - ramp;
      for (let j = 0; j <= span; j++) {
        let t = 1;
        if (j < ramp) t = j / ramp;
        else if (j > span - ramp) t = (span - j) / ramp;
        this.height[(br.a + j) % S] = RISE * t * t * (3 - 2 * t);
      }
    }

    if (this.theme.id === 'snow') {
      const n = 5 + Math.floor(rand() * 3);
      for (let tries = 0; tries < 40 && this.ice.length < n; tries++) {
        const a = Math.floor(rand() * S);
        const b = a + Math.round((14 + rand() * 18) / seg);
        if (a < Math.ceil(50 / seg) || b > S - Math.ceil(40 / seg)) continue; // keep the grid clear
        const half = 2.5 + rand() * 3.5;
        const mid = (rand() - 0.5) * (HALF_WIDTH * 2 - half * 2);
        this.ice.push({ a, b, lo: mid - half, hi: mid + half });
      }
    }
  }

  _isOverWater(i) {
    for (const br of this.bridges) {
      for (const shift of [0, S]) if (i + shift >= br.deckA && i + shift < br.deckB) return true;
    }
    return false;
  }

  /** True if the given track sample / lateral offset lies on an ice patch. */
  isIce(idx, lat) {
    const ice = this.ice;
    for (let k = 0; k < ice.length; k++) {
      const p = ice[k];
      if (lat >= p.lo && lat <= p.hi && ((idx >= p.a && idx < p.b) || (idx + S >= p.a && idx + S < p.b))) return true;
    }
    return false;
  }

  heightAt(idx) {
    return this.height[((idx % S) + S) % S];
  }

  /** Bridge colliders, pillars, water, tunnel shells and hills (one merged draw call). */
  _buildFeatures() {
    const parts = [];
    const p = { x: 0, z: 0 }, q = { x: 0, z: 0 };
    const edge = BARRIER_OFFSET + 0.7;
    const hillColor = { meadow: 0x6f8f55, desert: 0xc48a55, snow: 0xf1f5f9, autumn: 0x8a7a55 }[this.theme.id];
    const waterColor = this.theme.id === 'snow' ? 0xa8dcf5 : 0x3a9ad9;

    for (const br of this.bridges) {
      // Physics deck: a trimesh strip following the elevation profile, as wide as the railings.
      const n = br.b - br.a + 1;
      const verts = new Float32Array(n * 2 * 3);
      const idx = new Uint32Array((n - 1) * 6);
      for (let j = 0; j < n; j++) {
        const i = br.a + j;
        const y = this.heightAt(i);
        this.pointAt(i, -edge, 0, p);
        this.pointAt(i, edge, 0, q);
        verts.set([p.x, y, p.z, q.x, y, q.z], j * 6);
        if (j < n - 1) idx.set([j * 2, j * 2 + 1, j * 2 + 2, j * 2 + 1, j * 2 + 3, j * 2 + 2], j * 6);
      }
      this.wallColliders.push(this.physics.addTrimesh(verts, idx));

      // Pillars under the deck.
      const pillarStep = Math.max(4, Math.round(9 / this.segmentLength));
      for (let i = br.deckA; i <= br.deckB; i += pillarStep) {
        const h = this.heightAt(i);
        for (const side of [-1, 1]) {
          this.pointAt(i, side * (edge - 0.6), 0, p);
          parts.push(box(1.1, h, 1.1, p.x, h / 2 - 0.3, p.z, 0x8b9099));
        }
      }
      // Pond under the deck, oriented along the road.
      const mid = Math.round((br.deckA + br.deckB) / 2) % S;
      const lenHalf = ((br.deckB - br.deckA) * this.segmentLength) / 2 + 2;
      const pond = new THREE.CircleGeometry(1, 28);
      pond.rotateX(-Math.PI / 2);
      pond.scale(20, 1, lenHalf);
      pond.rotateY(this.yaw[mid]);
      pond.translate(this.px[mid], 0.03, this.pz[mid]);
      parts.push(paint(pond.toNonIndexed(), waterColor));
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
        // ceiling light strip
        if (((i / step) | 0) % 3 === 0) {
          this.pointAt(i, 0, 0, p);
          parts.push(box(3.2, 0.2, 0.8, p.x, this.heightAt(i) + RY - 0.25, p.z, 0xfff3b0, 0, this.yaw[i % S], 0));
        }
        prev = cur;
      }
      const shellGeo = shell.build();
      shellGeo.computeVertexNormals();
      parts.push(shellGeo);
      // Portal frames: a continuous stone band that follows the (elliptical) arch, with a
      // front face, back face and outer rim so it reads as a solid collar.
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
            [0, FW, dir * DEPTH, dir * DEPTH], // outward face
            [0, FW, 0, 0], // inner face (flush with the hill)
            [FW, FW, 0, dir * DEPTH], // outer rim
            [0, 0, 0, dir * DEPTH], // inner rim
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
      parts.push(this._tunnelHill(tu, R, RY, hillColor));
    }

    if (parts.length === 0) return;
    for (const g of parts) {
      for (const name of Object.keys(g.attributes)) {
        if (name !== 'position' && name !== 'normal' && name !== 'color') g.deleteAttribute(name);
      }
      if (!g.attributes.normal) g.computeVertexNormals();
    }
    const mesh = new THREE.Mesh(merge(parts), this.renderer.toon({ vertexColors: true, side: THREE.DoubleSide }));
    this.group.add(mesh);
  }

  /**
   * Hill swept along the (possibly curved) tunnel: one cross-section per sample, so the rock
   * always encloses the arch and follows the road. Each end gets a vertical portal face with
   * an arch-shaped opening, so nothing pokes through and the hill meets the ground at its sides.
   */
  _tunnelHill(tu, R, RY, hex) {
    const rb = new RibbonBuilder();
    const { width: HW, height: HH } = TUNNEL_HILL;
    const N = 16;
    const p = { x: 0, z: 0 };
    const col = new THREE.Color();
    const base = new THREE.Color(hex);
    // Outer profile: lateral offset + height for u in [0,1] across the hill.
    const outer = (u) => {
      const lat = -HW + 2 * HW * u;
      const t = 1 - (lat / HW) ** 2;
      return [lat, HH * Math.pow(Math.max(0, t), 0.6)];
    };
    // Inner profile (portal opening): ground outside the arch, arch curve inside it.
    const inner = (u) => {
      const lat = -HW + 2 * HW * u;
      if (Math.abs(lat) >= R) return [lat, 0];
      return [lat, RY * Math.sqrt(1 - (lat / R) ** 2)];
    };
    const at = (i, lat, y) => {
      this.pointAt(i, lat, 0, p);
      return [p.x, this.heightAt(i) + y, p.z];
    };
    const shade = (k, i) => {
      const v = 0.9 + 0.1 * Math.sin(k * 1.7 + i * 0.9);
      return col.copy(base).multiplyScalar(v).getHex();
    };
    // Surface.
    const step = 2;
    for (let i = tu.a; i < tu.b; i += step) {
      const j = Math.min(i + step, tu.b);
      for (let k = 0; k < N; k++) {
        const [l0, y0] = outer(k / N), [l1, y1] = outer((k + 1) / N);
        const a0 = at(i, l0, y0), a1 = at(i, l1, y1), b1 = at(j, l1, y1), b0 = at(j, l0, y0);
        rb.quad(a0[0], a0[1], a0[2], b0[0], b0[1], b0[2], b1[0], b1[1], b1[2], a1[0], a1[1], a1[2], shade(k, i));
      }
    }
    // Portal faces.
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

  /** Keep scenery out of bridge ponds and tunnel hills. */
  _nearFeature(x, z) {
    const lists = [this.bridges, this.tunnels];
    for (const list of lists) {
      for (const f of list) {
        const mid = Math.round((f.a + f.b) / 2) % S;
        const r = ((f.b - f.a) * this.segmentLength) / 2 + TUNNEL_HILL.width + 6;
        if ((x - this.px[mid]) ** 2 + (z - this.pz[mid]) ** 2 < r * r) return true;
      }
    }
    return false;
  }

  _buildBarriers() {
    const segments = Math.floor(S / BARRIER_STEP);
    const count = segments * 2;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mesh = new THREE.InstancedMesh(geo, this.renderer.toon({ color: 0xffffff }), count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const colA = new THREE.Color(0xd62828), colB = new THREE.Color(0xf1f1f1), colC = new THREE.Color(0x1d4ed8);
    const a = { x: 0, z: 0 }, b = { x: 0, z: 0 };
    const height = 1.3, thick = 0.9;
    let n = 0;
    for (const side of [1, -1]) {
      for (let k = 0; k < segments; k++) {
        const i = k * BARRIER_STEP;
        this.pointAt(i, side * BARRIER_OFFSET, 0, a);
        this.pointAt(i + BARRIER_STEP, side * BARRIER_OFFSET, 0, b);
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz) + 0.35;
        const yaw = Math.atan2(dx, dz);
        const cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2;
        const cy = (this.heightAt(i) + this.heightAt(i + BARRIER_STEP)) / 2 + height / 2;
        q.setFromAxisAngle(up, yaw);
        m.compose(p.set(cx, cy, cz), q, s.set(thick, height, len));
        mesh.setMatrixAt(n, m);
        mesh.setColorAt(n, k % 2 === 0 ? (side > 0 ? colA : colC) : colB);
        // Collider is much taller than the visual barrier so Mega-sized karts can't climb over.
        this.wallColliders.push(this.physics.addWall(cx, cy + 1.6, cz, thick / 2, height + 1.6, len / 2, yaw));
        n++;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
  }

  _buildGantry() {
    const W = BARRIER_OFFSET + 0.8;
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
    // flag poles on top
    parts.push(cylinder(0.08, 0.08, 2.4, 6, -W, 10, 0, 0xdddddd));
    parts.push(cylinder(0.08, 0.08, 2.4, 6, W, 10, 0, 0xdddddd));
    parts.push(box(0.05, 0.9, 1.4, -W, 10.7, 0.75, 0xe63946));
    parts.push(box(0.05, 0.9, 1.4, W, 10.7, 0.75, 0x2a9df4));
    const mesh = new THREE.Mesh(merge(parts), this.renderer.toon({ vertexColors: true }));
    mesh.position.set(this.px[0], 0, this.pz[0]);
    mesh.rotation.y = this.yaw[0];
    this.group.add(mesh);
  }

  _buildArches() {
    const W = BARRIER_OFFSET;
    const geo = merge([
      box(0.6, 6, 0.6, -W, 3, 0, 0xffffff),
      box(0.6, 6, 0.6, W, 3, 0, 0xffffff),
      box(W * 2 + 0.6, 0.8, 0.5, 0, 6.2, 0, 0xffffff),
      box(W * 2 - 1, 0.35, 0.55, 0, 5.5, 0, 0x222222),
    ]);
    const archCps = [];
    for (let k = 2; k < CHECKPOINTS; k += 3) archCps.push(this.checkpointIdx[k]);
    const mesh = new THREE.InstancedMesh(geo, this.renderer.toon({ vertexColors: true }), archCps.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    const palette = [0x2a9df4, 0xf4c20d, 0x2ec27e, 0x9b5de5];
    const c = new THREE.Color();
    archCps.forEach((idx, n) => {
      q.setFromAxisAngle(up, this.yaw[idx]);
      m.compose(p.set(this.px[idx], this.height[idx], this.pz[idx]), q, one);
      mesh.setMatrixAt(n, m);
      mesh.setColorAt(n, c.setHex(palette[n % palette.length]));
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
  }

  /** Brute-force distance to the centre line; only used at build time. */
  _distanceToCenter(x, z) {
    let best = Infinity;
    for (let i = 0; i < S; i += 2) {
      const dx = x - this.px[i], dz = z - this.pz[i];
      const d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  _buildScenery(rand) {
    const trunkGeo = cylinder(0.35, 0.5, 2.2, 5, 0, 1.1, 0, 0x7a4b2a);
    const leafGeo = merge([
      cylinder(0, 2.6, 4.2, 7, 0, 4.0, 0, 0xffffff),
      cylinder(0, 2.0, 3.2, 7, 0, 5.8, 0, 0xffffff),
    ]);
    const treeCount = 240;
    const trunks = new THREE.InstancedMesh(trunkGeo, this.renderer.toon({ vertexColors: true }), treeCount);
    const leaves = new THREE.InstancedMesh(leafGeo, this.renderer.toon({ vertexColors: true }), treeCount);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const c = new THREE.Color();
    const greens = this.theme.leaves;
    let placed = 0, attempts = 0;
    while (placed < treeCount && attempts < 5000) {
      attempts++;
      const x = (rand() - 0.5) * 640;
      const z = (rand() - 0.5) * 640;
      if (this._distanceToCenter(x, z) < BARRIER_OFFSET + 7 || this._nearFeature(x, z)) continue;
      const sc = 0.8 + rand() * 0.9;
      q.setFromAxisAngle(up, rand() * Math.PI * 2);
      m.compose(p.set(x, 0, z), q, s.set(sc, sc * (0.9 + rand() * 0.4), sc));
      trunks.setMatrixAt(placed, m);
      leaves.setMatrixAt(placed, m);
      leaves.setColorAt(placed, c.setHex(greens[Math.floor(rand() * greens.length)]));
      placed++;
    }
    trunks.count = leaves.count = placed;
    for (const mesh of [trunks, leaves]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
    }

    // Distant low-poly mountains ring (one instanced draw call).
    const mountGeo = new THREE.ConeGeometry(1, 1, 6);
    mountGeo.translate(0, 0.5, 0);
    const mountains = new THREE.InstancedMesh(mountGeo, this.renderer.toon({ color: 0xffffff }), 28);
    const mc = this.theme.mountains;
    for (let k = 0; k < 28; k++) {
      const ang = (k / 28) * Math.PI * 2 + rand() * 0.1;
      const r = 360 + rand() * 50;
      const h = 60 + rand() * 90;
      const w = 50 + rand() * 40;
      q.setFromAxisAngle(up, rand() * Math.PI);
      m.compose(p.set(Math.cos(ang) * r, -2, Math.sin(ang) * r), q, s.set(w, h, w));
      mountains.setMatrixAt(k, m);
      mountains.setColorAt(k, c.setHex(mc[k % mc.length]));
    }
    mountains.instanceMatrix.needsUpdate = true;
    mountains.instanceColor.needsUpdate = true;
    mountains.computeBoundingSphere();
    this.group.add(mountains);
  }

  _computeMinimap() {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < S; i++) {
      minX = Math.min(minX, this.px[i]); maxX = Math.max(maxX, this.px[i]);
      minZ = Math.min(minZ, this.pz[i]); maxZ = Math.max(maxZ, this.pz[i]);
    }
    this.bounds = { minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
  }

  /** Map world XZ to minimap pixels. North-up with +X to the right; flip X so it matches the camera handedness. */
  toMinimap(x, z, size, pad, out) {
    const b = this.bounds;
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    const scale = (size - pad * 2) / span;
    out.x = size / 2 - (x - b.cx) * scale;
    out.y = size / 2 - (z - b.cz) * scale;
    return out;
  }

  _itemBoxSpots() {
    const spots = [];
    const tmp = { x: 0, z: 0 };
    for (const frac of [0.2, 0.48, 0.77]) {
      const i = Math.round(frac * S);
      for (const lat of [-6, -2, 2, 6]) {
        this.pointAt(i, lat, 0, tmp);
        spots.push({ x: tmp.x, z: tmp.z, y: this.heightAt(i) });
      }
    }
    return spots;
  }

  _coinSpots() {
    const spots = [];
    const tmp = { x: 0, z: 0 };
    const lines = [[0.07, 4], [0.3, -4.5], [0.4, 0], [0.62, 5], [0.87, -3]];
    for (const [frac, lat] of lines) {
      const start = Math.round(frac * S);
      for (let k = 0; k < 6; k++) {
        this.pointAt(start + k * 3, lat, 0, tmp);
        spots.push({ x: tmp.x, z: tmp.z, y: this.heightAt(start + k * 3) });
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
      // Lost track (respawn / teleport): fall back to a global search.
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

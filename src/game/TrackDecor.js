import * as THREE from 'three';
import { box, cylinder, sphere, merge, paint } from '../engine/geometry.js';

// Track themes, each built around a classic kart-racer course archetype. A theme sets the sky,
// terrain, road surface, hazards, how hilly/jumpy the layout is, and which scenery is placed.

const RAINBOW = [0xff5d8f, 0xffa24c, 0xffe156, 0x6bdc7a, 0x4cc3ff, 0x7b7bff, 0xc77dff];

export const THEMES = [
  {
    id: 'meadow',
    words: ['Cowbell', 'Clover', 'Buttercup', 'Haybale', 'Moo-Moo', 'Daisy'],
    nouns: ['Meadows', 'Farm', 'Pastures', 'Fields'],
    sky: { top: 0x3d8bff, horizon: 0xbfe6ff, fogNear: 150, fogFar: 430, hemi: 1.4, sun: 2.2 },
    ground: 0x6fbf4a, groundNoise: 5,
    road: { a: 0x464a52, b: 0x4d525b, line: 0xeaeaea, center: 0xf2d64b, curbA: 0xe63946, curbB: 0xf5f5f5, shoulder: 0x5aa43c },
    barrier: [0xd62828, 0xf1f1f1, 0x1d4ed8],
    hills: [4, 8], jumps: [1, 2], pads: [3, 5], hazard: null,
    plant: 'round', plantColors: [0x2d8a3e, 0x3fa34d, 0x5bb450, 0x1f6f35], plantCount: 170,
    rock: 0x9aa39a, rockCount: 25, decor: 'cows',
    mountains: [0x7d9c6b, 0x8fae7a, 0x6d8a60, 0x9fb7a0], hillColor: 0x6f8f55, water: 0x3a9ad9,
  },
  {
    id: 'desert',
    words: ['Dune', 'Scorpion', 'Mirage', 'Pharaoh', 'Sandy', 'Sunbaked'],
    nouns: ['Dash', 'Ruins', 'Canyon', 'Oasis'],
    sky: { top: 0x4d9be6, horizon: 0xffe3b0, fogNear: 140, fogFar: 420, hemi: 1.5, sun: 2.4 },
    ground: 0xe0bd72, groundNoise: 6,
    road: { a: 0x7a6a55, b: 0x84735c, line: 0xf4e3c1, center: 0xffffff, curbA: 0xc2410c, curbB: 0xfde68a, shoulder: 0xcfa45c },
    barrier: [0xc2410c, 0xfde68a, 0x92400e],
    hills: [2, 6], jumps: [1, 2], pads: [3, 5], hazard: 'sand',
    plant: 'cactus', plantColors: [0x4d7c35, 0x5f8f3a, 0x3f6e2c], plantCount: 110,
    rock: 0xb07a4a, rockCount: 45, decor: 'pyramids',
    mountains: [0xc9895a, 0xd9a066, 0xb87447, 0xe0b07a], hillColor: 0xc48a55, water: 0x2fb5c9,
  },
  {
    id: 'snow',
    words: ['Frosty', 'Glacier', 'Blizzard', 'Snowcap', 'Polar', 'Sherbet'],
    nouns: ['Summit', 'Peak', 'Slopes', 'Pass'],
    sky: { top: 0x6aa7e8, horizon: 0xe8f3ff, fogNear: 120, fogFar: 380, hemi: 1.5, sun: 2.0 },
    ground: 0xe9f1f7, groundNoise: 7,
    road: { a: 0x4a5160, b: 0x535a6a, line: 0xeaeaea, center: 0x9ad0ff, curbA: 0x2a9df4, curbB: 0xf5f5f5, shoulder: 0xdbe6ee },
    barrier: [0x2a9df4, 0xf1f1f1, 0x1e3a8a],
    hills: [4, 9], jumps: [2, 3], pads: [2, 4], hazard: 'ice',
    plant: 'snowpine', plantColors: [0x1f5f3a, 0x2c6e46, 0x245c3c], plantCount: 180,
    rock: 0xaab4bf, rockCount: 30, decor: 'snowmen',
    mountains: [0xdfe8ef, 0xc5d3dd, 0xaebfcc, 0xf2f6f9], hillColor: 0xf1f5f9, water: 0xa8dcf5,
  },
  {
    id: 'mushroom',
    words: ['Toadstool', 'Spore', 'Fungus', 'Morel', 'Truffle', 'Puffball'],
    nouns: ['Gorge', 'Grove', 'Hollow', 'Woods'],
    sky: { top: 0x5b8def, horizon: 0xffe0c2, fogNear: 130, fogFar: 400, hemi: 1.4, sun: 2.1 },
    ground: 0x8fbf4f, groundNoise: 6,
    road: { a: 0x5a4a42, b: 0x64524a, line: 0xf5e6c8, center: 0xffd166, curbA: 0xe63946, curbB: 0xfff1e6, shoulder: 0x7aa844 },
    barrier: [0xe63946, 0xfff1e6, 0x8a5a44],
    hills: [5, 9], jumps: [1, 3], pads: [3, 5], hazard: null,
    plant: 'mushroom', plantColors: [0xe63946, 0xff7f11, 0x9b5de5, 0x2a9df4, 0xf4c20d], plantCount: 120,
    rock: 0x8d7b6a, rockCount: 25, decor: 'none',
    mountains: [0x9c7b5b, 0xae8c63, 0x8a6b4e, 0xbf9d72], hillColor: 0x7a9a4a, water: 0x3a9ad9,
  },
  {
    id: 'beach',
    words: ['Coconut', 'Seashell', 'Lagoon', 'Starfish', 'Tiki', 'Coral'],
    nouns: ['Cove', 'Beach', 'Bay', 'Island'],
    sky: { top: 0x1f9bff, horizon: 0xc8f3ff, fogNear: 160, fogFar: 460, hemi: 1.5, sun: 2.4 },
    ground: 0xf2d99a, groundNoise: 3, ocean: 0x1fa3d6,
    road: { a: 0x55606b, b: 0x5e6a76, line: 0xffffff, center: 0xffe156, curbA: 0x00c2c7, curbB: 0xffffff, shoulder: 0xe9cf8c },
    barrier: [0x00c2c7, 0xffffff, 0xff7f11],
    hills: [1, 4], jumps: [1, 2], pads: [3, 6], hazard: null,
    plant: 'palm', plantColors: [0x2e9e45, 0x3fb553, 0x278a3b], plantCount: 110,
    rock: 0xc9b38a, rockCount: 20, decor: 'umbrellas',
    mountains: null, hillColor: 0x8fb56a, water: 0x2bb3e0,
  },
  {
    id: 'volcano',
    words: ['Magma', 'Cinder', 'Brimstone', 'Obsidian', 'Inferno', 'Ember'],
    nouns: ['Keep', 'Fortress', 'Crater', 'Citadel'],
    sky: { top: 0x2a0f12, horizon: 0xb4462a, fogNear: 110, fogFar: 380, hemi: 0.9, sun: 1.4 },
    ground: 0x3a3236, groundNoise: 6, lava: true,
    road: { a: 0x2b2b30, b: 0x333339, line: 0xff8a3d, center: 0xffb703, curbA: 0x9d0208, curbB: 0x2b2b2b, shoulder: 0x4a3f44 },
    barrier: [0x6c6c72, 0x4a4a50, 0x9d0208],
    hills: [3, 7], jumps: [1, 2], pads: [3, 5], hazard: null,
    plant: 'dead', plantColors: [0x2b2226], plantCount: 60,
    rock: 0x4a4046, rockCount: 60, decor: 'volcano',
    mountains: [0x2b2226, 0x3a2e33, 0x1f1a1c, 0x4a3a3f], hillColor: 0x3f3539, water: 0xff5a1f,
  },
  {
    id: 'rainbow',
    words: ['Star', 'Rainbow', 'Cosmic', 'Galaxy', 'Nebula', 'Comet'],
    nouns: ['Road', 'Highway', 'Circuit', 'Loop'],
    sky: { top: 0x05030f, horizon: 0x1b1147, fogNear: 300, fogFar: 900, hemi: 1.1, sun: 1.6 },
    space: true,
    road: { rainbow: true, a: 0x000000, b: 0x000000, line: 0xffffff, center: null, curbA: 0xffffff, curbB: 0xc77dff, shoulder: 0x2a1f5c },
    barrier: [0xffffff, 0xc77dff, 0x4cc3ff],
    hills: [6, 12], jumps: [1, 2], pads: [4, 7], hazard: null,
    plant: null, plantCount: 0, rock: 0x000000, rockCount: 0, decor: 'stars',
    mountains: null, hillColor: 0x2a1f5c, water: 0x7b7bff,
  },
  {
    id: 'ghost',
    words: ['Spooky', 'Boo', 'Haunted', 'Gloomy', 'Phantom', 'Creaky'],
    nouns: ['Hollow', 'Valley', 'Manor', 'Marsh'],
    sky: { top: 0x0d0a24, horizon: 0x4b3a6e, fogNear: 90, fogFar: 330, hemi: 0.85, sun: 1.1 },
    ground: 0x3b4a3a, groundNoise: 5,
    road: { planks: true, a: 0x7a5534, b: 0x6b4a2d, line: null, center: null, curbA: 0x3b2a1a, curbB: 0x2a1d12, shoulder: 0x33402f },
    barrier: [0x5b4a3a, 0x3b2f25, 0x7b5bb5],
    hills: [2, 6], jumps: [1, 2], pads: [2, 4], hazard: null,
    plant: 'dead', plantColors: [0x2a2530], plantCount: 130,
    rock: 0x55586a, rockCount: 30, decor: 'ghosts',
    mountains: [0x2a2540, 0x322b4b, 0x241f38, 0x3a3155], hillColor: 0x3b4a3a, water: 0x3b2f6e,
  },
];

export const rainbowColor = (i) => RAINBOW[((i % RAINBOW.length) + RAINBOW.length) % RAINBOW.length];

// ------------------------------------------------------------------ plants

/** Each plant is { fixed, tint }: fixed keeps vertex colours, tint takes a per-instance colour. */
function plantGeometry(kind) {
  const W = 0xffffff;
  switch (kind) {
    case 'pine':
    case 'snowpine': {
      const fixed = [cylinder(0.35, 0.5, 2.2, 5, 0, 1.1, 0, 0x7a4b2a)];
      if (kind === 'snowpine') {
        fixed.push(cylinder(0, 1.1, 1.3, 7, 0, 6.9, 0, 0xffffff));
        fixed.push(cylinder(0.9, 1.9, 0.35, 7, 0, 4.2, 0, 0xffffff));
      }
      return {
        fixed: merge(fixed),
        tint: merge([cylinder(0, 2.6, 4.2, 7, 0, 4.0, 0, W), cylinder(0, 2.0, 3.2, 7, 0, 5.8, 0, W)]),
      };
    }
    case 'round':
      return {
        fixed: cylinder(0.3, 0.45, 2.6, 6, 0, 1.3, 0, 0x7a4b2a),
        tint: merge([sphere(2.3, 7, 5, 0, 4.2, 0, W), sphere(1.6, 6, 4, 1.2, 3.6, 0.6, W), sphere(1.5, 6, 4, -1.1, 3.8, -0.5, W)]),
      };
    case 'cactus':
      return {
        fixed: null,
        tint: merge([
          cylinder(0.5, 0.55, 5, 8, 0, 2.5, 0, W),
          sphere(0.5, 8, 4, 0, 5, 0, W),
          cylinder(0.32, 0.32, 1.4, 6, 0.9, 2.3, 0, W, 0, 0, Math.PI / 2),
          cylinder(0.32, 0.32, 1.8, 6, 1.5, 3.1, 0, W),
          cylinder(0.3, 0.3, 1.2, 6, -0.8, 2.9, 0, W, 0, 0, Math.PI / 2),
          cylinder(0.3, 0.3, 1.4, 6, -1.3, 3.5, 0, W),
        ]),
      };
    case 'palm': {
      const trunk = [];
      for (let k = 0; k < 6; k++) trunk.push(cylinder(0.32 - k * 0.02, 0.38 - k * 0.02, 1.3, 6, k * 0.22, 0.65 + k * 1.2, 0, 0x9c6b3c, 0, 0, -0.18));
      trunk.push(sphere(0.35, 6, 4, 1.25, 7.2, 0.2, 0x6b4423));
      trunk.push(sphere(0.35, 6, 4, 1.45, 7.1, -0.2, 0x6b4423));
      const leaves = [];
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * Math.PI * 2;
        const g = new THREE.BoxGeometry(3.6, 0.08, 0.9);
        g.translate(1.8, 0, 0);
        g.rotateZ(-0.35);
        g.rotateY(a);
        g.translate(1.3, 7.6, 0);
        leaves.push(paint(g.toNonIndexed(), W));
      }
      for (const g of leaves) g.deleteAttribute('uv');
      return { fixed: merge(trunk), tint: merge(leaves) };
    }
    case 'dead':
      return {
        fixed: null,
        tint: merge([
          cylinder(0.25, 0.45, 4.5, 5, 0, 2.25, 0, W),
          cylinder(0.12, 0.18, 2.2, 4, 0.8, 4.2, 0, W, 0, 0, -0.8),
          cylinder(0.1, 0.16, 2, 4, -0.7, 3.6, 0, W, 0, 0, 0.9),
          cylinder(0.08, 0.12, 1.4, 4, 0.2, 4.9, 0.5, W, 0.7, 0, 0),
        ]),
      };
    case 'mushroom': {
      const dots = [];
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * Math.PI * 2;
        dots.push(sphere(0.55, 6, 4, Math.cos(a) * 2.3, 5.9, Math.sin(a) * 2.3, 0xffffff, 1, 0.5, 1));
      }
      dots.push(sphere(0.6, 6, 4, 0, 7.2, 0, 0xffffff, 1, 0.5, 1));
      return {
        fixed: merge([cylinder(0.9, 1.2, 5.5, 10, 0, 2.75, 0, 0xfdf0d5), ...dots]),
        tint: sphere(3.4, 12, 6, 0, 5.6, 0, W, 1, 0.55, 1),
      };
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------------ helpers

function instanced(renderer, geo, count, mat) {
  const mesh = new THREE.InstancedMesh(geo, mat || renderer.toon({ vertexColors: true }), Math.max(1, count));
  mesh.count = 0;
  return mesh;
}

function finish(mesh, group) {
  if (mesh.count === 0) { mesh.geometry.dispose(); return; }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  group.add(mesh);
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

function put(mesh, x, y, z, yaw, sx, sy = sx, sz = sx, color = null) {
  _q.setFromAxisAngle(UP, yaw);
  _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
  mesh.setMatrixAt(mesh.count, _m);
  if (color !== null) mesh.setColorAt(mesh.count, _c.setHex(color));
  mesh.count++;
}

// ------------------------------------------------------------------ scenery entry point

/**
 * Build theme scenery around the track. `spot(minDist, maxDist)` returns a random ground
 * position that far from the road (and away from bridges/tunnels), or null.
 */
export function buildScenery({ track, theme, rand, group, renderer, spot }) {
  const pick = (list) => list[Math.floor(rand() * list.length)];

  // Plants
  const plant = theme.plant ? plantGeometry(theme.plant) : null;
  if (plant) {
    const count = theme.plantCount;
    const fixed = plant.fixed ? instanced(renderer, plant.fixed, count) : null;
    const tint = plant.tint ? instanced(renderer, plant.tint, count) : null;
    for (let n = 0, tries = 0; n < count && tries < count * 20; tries++) {
      const s = spot(4, 300);
      if (!s) continue;
      const sc = 0.75 + rand() * 0.9;
      const yaw = rand() * Math.PI * 2;
      const color = pick(theme.plantColors);
      if (fixed) put(fixed, s.x, s.y, s.z, yaw, sc, sc * (0.9 + rand() * 0.3));
      if (tint) {
        if (fixed) tint.setMatrixAt(tint.count, _m);
        else _m.compose(_p.set(s.x, s.y, s.z), _q.setFromAxisAngle(UP, yaw), _s.set(sc, sc, sc));
        tint.setMatrixAt(tint.count, _m);
        tint.setColorAt(tint.count, _c.setHex(color));
        tint.count++;
      }
      n++;
    }
    if (fixed) finish(fixed, group);
    if (tint) finish(tint, group);
  }

  // Rocks
  if (theme.rockCount > 0) {
    const rocks = instanced(renderer, new THREE.DodecahedronGeometry(1, 0), theme.rockCount, renderer.toon({ color: 0xffffff }));
    for (let n = 0; n < theme.rockCount; n++) {
      const s = spot(3, 280);
      if (!s) continue;
      const sc = 0.6 + rand() * 2.2;
      _c.setHex(theme.rock).multiplyScalar(0.85 + rand() * 0.3);
      put(rocks, s.x, s.y + sc * 0.3, s.z, rand() * 6, sc, sc * (0.6 + rand() * 0.5), sc * (0.8 + rand() * 0.4));
      rocks.setColorAt(rocks.count - 1, _c);
    }
    finish(rocks, group);
  }

  const decor = DECOR[theme.decor];
  if (decor) decor({ track, theme, rand, group, renderer, spot, pick });
}

// ------------------------------------------------------------------ theme decorations

const DECOR = {
  cows({ rand, group, renderer, spot }) {
    const cow = merge([
      box(1.1, 0.8, 1.9, 0, 1.1, 0, 0xffffff),
      box(0.5, 0.4, 0.7, 0.3, 1.35, 0.3, 0x222222),
      box(0.45, 0.35, 0.6, -0.3, 1.0, -0.4, 0x222222),
      box(0.6, 0.55, 0.6, 0, 1.4, 1.15, 0xffffff),
      box(0.62, 0.3, 0.2, 0, 1.25, 1.5, 0xf4a3b4),
      box(0.12, 0.2, 0.12, 0.25, 1.75, 1.1, 0xe8dcc8),
      box(0.12, 0.2, 0.12, -0.25, 1.75, 1.1, 0xe8dcc8),
      box(0.22, 0.75, 0.22, 0.35, 0.37, 0.65, 0xffffff),
      box(0.22, 0.75, 0.22, -0.35, 0.37, 0.65, 0xffffff),
      box(0.22, 0.75, 0.22, 0.35, 0.37, -0.65, 0xffffff),
      box(0.22, 0.75, 0.22, -0.35, 0.37, -0.65, 0xffffff),
    ]);
    const mesh = instanced(renderer, cow, 18);
    for (let n = 0; n < 18; n++) {
      const s = spot(4, 60);
      if (s) put(mesh, s.x, s.y, s.z, rand() * 6.28, 1.3);
    }
    finish(mesh, group);
  },

  pyramids({ rand, group, renderer, spot }) {
    const parts = [];
    for (let n = 0; n < 3; n++) {
      const s = spot(60, 200);
      if (!s) continue;
      const size = 30 + rand() * 25;
      const g = new THREE.ConeGeometry(size, size * 0.8, 4, 1);
      g.rotateY(Math.PI / 4 + rand());
      g.translate(s.x, s.y + size * 0.4 - 1, s.z);
      parts.push(paint(g.toNonIndexed(), 0xd9b26f));
      // capstone
      const cap = new THREE.ConeGeometry(size * 0.12, size * 0.1, 4, 1);
      cap.rotateY(Math.PI / 4);
      cap.translate(s.x, s.y + size * 0.8 - 1 - size * 0.05, s.z);
      parts.push(paint(cap.toNonIndexed(), 0xffd23f));
    }
    for (const g of parts) g.deleteAttribute('uv');
    if (parts.length) group.add(new THREE.Mesh(merge(parts), renderer.toon({ vertexColors: true })));
  },

  snowmen({ rand, group, renderer, spot }) {
    const man = merge([
      sphere(1.1, 10, 8, 0, 1.0, 0, 0xffffff),
      sphere(0.8, 10, 8, 0, 2.5, 0, 0xffffff),
      sphere(0.55, 10, 8, 0, 3.6, 0, 0xffffff),
      cylinder(0.02, 0.1, 0.5, 6, 0, 3.6, 0.7, 0xff7f11, Math.PI / 2, 0, 0),
      cylinder(0.45, 0.45, 0.12, 10, 0, 4.05, 0, 0x222222),
      cylinder(0.3, 0.3, 0.5, 10, 0, 4.35, 0, 0x222222),
      box(1.1, 0.18, 0.2, 0, 3.05, 0.35, 0xe63946),
    ]);
    const mesh = instanced(renderer, man, 14);
    for (let n = 0; n < 14; n++) {
      const s = spot(4, 70);
      if (s) put(mesh, s.x, s.y, s.z, rand() * 6.28, 0.9 + rand() * 0.5);
    }
    finish(mesh, group);
  },

  umbrellas({ rand, group, renderer, spot, pick }) {
    const pole = merge([cylinder(0.07, 0.07, 3, 5, 0, 1.5, 0, 0xdddddd), box(1.6, 0.1, 0.8, 0.9, 0.05, 0, 0xffffff)]);
    const canopy = merge([cylinder(0.05, 1.8, 0.8, 8, 0, 3.2, 0, 0xffffff)]);
    const poles = instanced(renderer, pole, 16);
    const tops = instanced(renderer, canopy, 16);
    const colors = [0xe63946, 0xf4c20d, 0x2a9df4, 0xf15bb5, 0x2ec27e];
    for (let n = 0; n < 16; n++) {
      const s = spot(4, 45);
      if (!s) continue;
      const yaw = rand() * 6.28;
      put(poles, s.x, s.y, s.z, yaw, 1);
      put(tops, s.x, s.y, s.z, yaw, 1, 1, 1, pick(colors));
    }
    finish(poles, group);
    finish(tops, group);
  },

  volcano({ rand, group, renderer, spot, track }) {
    // Giant volcano on the horizon with a glowing crater.
    const ang = rand() * Math.PI * 2;
    const r = 330;
    const cx = Math.cos(ang) * r, cz = Math.sin(ang) * r;
    const cone = new THREE.CylinderGeometry(22, 130, 150, 12, 1, true);
    cone.translate(cx, 72, cz);
    const lava = new THREE.CylinderGeometry(21, 21, 3, 12);
    lava.translate(cx, 147, cz);
    const parts = [paint(cone.toNonIndexed(), 0x2b2226), paint(lava.toNonIndexed(), 0xff5a1f)];
    for (const g of parts) g.deleteAttribute('uv');
    group.add(new THREE.Mesh(merge(parts), renderer.toon({ vertexColors: true, side: THREE.DoubleSide })));

    // Fire torches along the barriers.
    const torch = merge([
      box(0.4, 3, 0.4, 0, 1.5, 0, 0x3a3236),
      box(0.8, 0.3, 0.8, 0, 3.1, 0, 0x2b2226),
      sphere(0.45, 6, 4, 0, 3.6, 0, 0xffb703, 1, 1.4, 1),
      sphere(0.28, 6, 4, 0, 3.9, 0, 0xfff1a8, 1, 1.4, 1),
    ]);
    const mesh = instanced(renderer, torch, 60, renderer.basic({ vertexColors: true }));
    const p = { x: 0, z: 0 };
    for (let i = 0; i < track.samples && mesh.count < 60; i += 24) {
      const side = (i / 24) % 2 === 0 ? 1 : -1;
      track.pointAt(i, side * (track.barrierOffset(i) + 1.2), 0, p);
      put(mesh, p.x, track.heightAt(i), p.z, 0, 1);
    }
    finish(mesh, group);
  },

  stars({ rand, group, renderer }) {
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
    const star = paint(new THREE.OctahedronGeometry(1, 0).toNonIndexed(), 0xffffff);
    star.deleteAttribute('uv');
    const stars = instanced(renderer, star, 500, mat);
    for (let n = 0; n < 500; n++) {
      const u = rand() * 2 - 1, a = rand() * Math.PI * 2;
      const rr = Math.sqrt(1 - u * u);
      const d = 600 + rand() * 120;
      put(stars, Math.cos(a) * rr * d, u * d * 0.8 + 60, Math.sin(a) * rr * d, rand() * 6, 0.8 + rand() * 2.2, undefined, undefined, rand() < 0.2 ? 0xffe156 : 0xffffff);
    }
    finish(stars, group);
    // A couple of planets.
    const planets = [];
    const ringed = new THREE.TorusGeometry(60, 6, 6, 40);
    ringed.rotateX(1.2);
    ringed.translate(-380, 180, -260);
    planets.push(paint(ringed.toNonIndexed(), 0xffd6a5));
    planets.push(sphere(40, 20, 14, -380, 180, -260, 0xff8fab));
    planets.push(sphere(26, 16, 12, 420, 120, 300, 0x7bdff2));
    for (const g of planets) if (g.attributes.uv) g.deleteAttribute('uv');
    group.add(new THREE.Mesh(merge(planets), new THREE.MeshBasicMaterial({ vertexColors: true, fog: false })));
  },

  ghosts({ rand, group, renderer, spot }) {
    const ghost = merge([
      sphere(1, 10, 8, 0, 3.2, 0, 0xf5f3ff),
      cylinder(1, 0.6, 1.6, 10, 0, 2.3, 0, 0xf5f3ff),
      sphere(0.14, 6, 4, 0.35, 3.35, 0.88, 0x1b1530),
      sphere(0.14, 6, 4, -0.35, 3.35, 0.88, 0x1b1530),
      sphere(0.22, 6, 4, 0, 2.9, 0.9, 0x1b1530, 1, 1.3, 0.6),
    ]);
    const ghosts = instanced(renderer, ghost, 16, renderer.basic({ vertexColors: true }));
    for (let n = 0; n < 16; n++) {
      const s = spot(3, 60);
      if (s) put(ghosts, s.x, s.y + rand() * 3, s.z, rand() * 6.28, 0.9 + rand() * 0.6);
    }
    finish(ghosts, group);
    // Jack-o'-lanterns (emissive look via basic material)
    const pumpkin = merge([
      sphere(0.9, 10, 8, 0, 0.8, 0, 0xff7f11, 1, 0.8, 1),
      cylinder(0.08, 0.12, 0.35, 5, 0, 1.55, 0, 0x2e6b2e),
      box(0.25, 0.2, 0.1, 0.3, 0.95, 0.85, 0xfff1a8),
      box(0.25, 0.2, 0.1, -0.3, 0.95, 0.85, 0xfff1a8),
      box(0.7, 0.12, 0.1, 0, 0.6, 0.86, 0xfff1a8),
    ]);
    const pumpkins = instanced(renderer, pumpkin, 24, renderer.basic({ vertexColors: true }));
    for (let n = 0; n < 24; n++) {
      const s = spot(2, 30);
      if (s) put(pumpkins, s.x, s.y, s.z, rand() * 6.28, 0.8 + rand() * 0.6);
    }
    finish(pumpkins, group);
  },
};

// ------------------------------------------------------------------ trackside dressing

/** Grandstand with a crowd beside the start straight (one merged mesh). */
export function buildGrandstand(track, renderer, group, rand) {
  const S = track.samples;
  const mid = S - Math.round(24 / track.segmentLength);
  const side = rand() < 0.5 ? 1 : -1;
  const parts = [];
  const LEN = 34, TIERS = 5;
  for (let t = 0; t < TIERS; t++) {
    parts.push(box(LEN, 0.6, 1.6, 0, 0.3 + t * 0.9, t * 1.6, 0x8d99ae));
    parts.push(box(LEN, 0.9 + t * 0.9, 0.2, 0, (0.9 + t * 0.9) / 2, t * 1.6 - 0.8, 0x6b7280));
  }
  const crowd = [0xe63946, 0x2a9df4, 0xf4c20d, 0x2ec27e, 0xf15bb5, 0xff7f11, 0xffffff, 0x9b5de5];
  for (let t = 0; t < TIERS; t++) {
    for (let k = 0; k < 22; k++) {
      if (rand() < 0.2) continue;
      const x = -LEN / 2 + 1 + k * ((LEN - 2) / 21) + (rand() - 0.5) * 0.4;
      parts.push(box(0.55, 0.7, 0.45, x, 0.95 + t * 0.9, t * 1.6, crowd[Math.floor(rand() * crowd.length)]));
      parts.push(sphere(0.22, 5, 4, x, 1.5 + t * 0.9, t * 1.6, 0xf1c27d));
    }
  }
  parts.push(box(LEN + 1, 0.3, TIERS * 1.6 + 1, 0, TIERS * 0.9 + 3.2, (TIERS - 1) * 0.8, 0xe63946));
  parts.push(box(0.4, TIERS * 0.9 + 3.2, 0.4, -LEN / 2, (TIERS * 0.9 + 3.2) / 2, (TIERS - 1) * 1.6, 0x444444));
  parts.push(box(0.4, TIERS * 0.9 + 3.2, 0.4, LEN / 2, (TIERS * 0.9 + 3.2) / 2, (TIERS - 1) * 1.6, 0x444444));
  const g = merge(parts);
  // Local x runs along the road, local +z steps away from it. Rotating by (yaw - 90°) maps
  // local x onto the road tangent and local +z onto the road's right-hand side.
  const p = { x: 0, z: 0 };
  track.pointAt(mid, side * (track.barrierOffset(mid) + 3.5), 0, p);
  const yaw = track.yaw[mid];
  g.rotateY(side > 0 ? yaw - Math.PI / 2 : yaw + Math.PI / 2);
  const mesh = new THREE.Mesh(g, renderer.toon({ vertexColors: true }));
  mesh.position.set(p.x, track.heightAt(mid), p.z);
  group.add(mesh);
  return { x: p.x, z: p.z };
}

/** Tire stacks on the outside of sharp corners (one instanced mesh). */
export function buildTireStacks(track, renderer, group) {
  const tire = merge([
    cylinder(0.55, 0.55, 0.4, 10, 0, 0.2, 0, 0x1c1c1c),
    cylinder(0.55, 0.55, 0.4, 10, 0, 0.62, 0, 0x262626),
    cylinder(0.55, 0.55, 0.4, 10, 0, 1.04, 0, 0x1c1c1c),
    cylinder(0.3, 0.3, 1.26, 8, 0, 0.63, 0, 0x3a3a3a),
  ]);
  const mesh = instanced(renderer, tire, 90);
  const S = track.samples;
  const p = { x: 0, z: 0 };
  for (let i = 0; i < S && mesh.count < 88; i += 3) {
    const bend = Math.atan2(Math.sin(track.yaw[(i + 6) % S] - track.yaw[(i - 6 + S) % S]), Math.cos(track.yaw[(i + 6) % S] - track.yaw[(i - 6 + S) % S]));
    if (Math.abs(bend) < 0.55) continue;
    const side = bend > 0 ? 1 : -1; // outside of the turn
    for (let k = 0; k < 2; k++) {
      track.pointAt(i, side * (track.barrierOffset(i) + 1.2 + k * 1.15), (k - 0.5) * 0.6, p);
      put(mesh, p.x, track.heightAt(i), p.z, 0, 1);
    }
  }
  finish(mesh, group);
}

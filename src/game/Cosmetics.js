import { box, cylinder, sphere, merge } from '../engine/geometry.js';

// Kart customisation catalogue. Parts are purely visual; geometry is built once and shared by
// every kart through a single BatchedMesh (see KartRenderer).
//
// Colour convention: vertex colour WHITE (0xffffff) is tinted per kart (paint or accent),
// every other vertex colour is kept as-is.

const W = 0xffffff;
const DARK = 0x2a2a2e;
const METAL = 0x9aa0a6;
const SKIN = 0xf1c27d;

export const PAINTS = [
  0xe63946, 0x2a9df4, 0x2ec27e, 0xf4c20d, 0x9b5de5, 0xff7f11,
  0xf15bb5, 0x00c2c7, 0xf5f5f5, 0x2b2d42, 0x8d6e4a, 0x84cc16,
];

/**
 * Body variants. `mount` gives where the spoiler (y, z) and the driver's head (headY, headZ)
 * attach, relative to the body origin (ground level under the kart centre).
 */
export const BODIES = [
  {
    id: 'classic', name: 'Classic', price: 0,
    mount: { spoilerY: 0.95, spoilerZ: -1.15, headY: 1.52, headZ: -0.25 },
    wheelX: 0.75,
    build: () => merge([
      box(1.3, 0.32, 1.9, 0, 0.42, 0, W),
      box(1.0, 0.25, 0.7, 0, 0.42, 1.2, W),
      box(1.5, 0.18, 0.35, 0, 0.35, 1.5, DARK),
      box(1.45, 0.2, 0.3, 0, 0.4, -1.05, DARK),
      box(0.8, 0.45, 0.55, 0, 0.72, -0.55, DARK),
      box(0.9, 0.35, 0.5, 0, 0.62, -0.95, METAL),
      cylinder(0.12, 0.14, 0.35, 6, 0.28, 0.72, -1.25, METAL, Math.PI / 2, 0, 0),
      cylinder(0.12, 0.14, 0.35, 6, -0.28, 0.72, -1.25, METAL, Math.PI / 2, 0, 0),
      cylinder(0.05, 0.05, 0.5, 5, 0, 0.9, 0.35, DARK, -0.9, 0, 0),
      cylinder(0.24, 0.24, 0.06, 10, 0, 1.05, 0.2, DARK, -0.9, 0, 0),
      box(0.62, 0.55, 0.45, 0, 0.98, -0.3, W),
    ]),
  },
  {
    id: 'racer', name: 'Formula', price: 10,
    mount: { spoilerY: 0.8, spoilerZ: -1.35, headY: 1.28, headZ: -0.35 },
    wheelX: 0.8,
    build: () => merge([
      box(0.9, 0.26, 2.3, 0, 0.36, -0.1, W),
      cylinder(0.05, 0.42, 1.1, 4, 0, 0.36, 1.5, W, Math.PI / 2, Math.PI / 4, 0),
      box(1.7, 0.08, 0.4, 0, 0.26, 1.85, DARK), // front wing
      box(0.35, 0.3, 1.2, 0.62, 0.36, -0.25, W), // side pods
      box(0.35, 0.3, 1.2, -0.62, 0.36, -0.25, W),
      box(0.7, 0.3, 0.5, 0, 0.55, -0.85, METAL),
      cylinder(0.1, 0.12, 0.3, 6, 0, 0.6, -1.3, METAL, Math.PI / 2, 0, 0),
      cylinder(0.22, 0.22, 0.06, 10, 0, 0.78, 0.2, DARK, -1.1, 0, 0),
      box(0.55, 0.45, 0.45, 0, 0.72, -0.4, W),
    ]),
  },
  {
    id: 'buggy', name: 'Buggy', price: 12,
    mount: { spoilerY: 1.9, spoilerZ: -0.85, headY: 1.6, headZ: -0.2 },
    wheelX: 0.85,
    build: () => merge([
      box(1.25, 0.3, 1.8, 0, 0.55, 0, W),
      box(1.1, 0.2, 0.5, 0, 0.5, 1.15, DARK), // bull bar base
      box(1.2, 0.5, 0.08, 0, 0.8, 1.4, METAL),
      box(1.2, 0.35, 0.5, 0, 0.8, -1.0, METAL),
      // roll cage
      box(0.08, 1.2, 0.08, 0.55, 1.25, -0.75, DARK),
      box(0.08, 1.2, 0.08, -0.55, 1.25, -0.75, DARK),
      box(0.08, 1.1, 0.08, 0.55, 1.15, 0.35, DARK, -0.35, 0, 0),
      box(0.08, 1.1, 0.08, -0.55, 1.15, 0.35, DARK, -0.35, 0, 0),
      box(1.18, 0.08, 0.08, 0, 1.85, -0.75, DARK),
      box(0.08, 0.08, 1.05, 0.55, 1.85, -0.25, DARK),
      box(0.08, 0.08, 1.05, -0.55, 1.85, -0.25, DARK),
      cylinder(0.24, 0.24, 0.06, 10, 0, 1.12, 0.25, DARK, -0.9, 0, 0),
      box(0.62, 0.55, 0.45, 0, 1.08, -0.25, W),
    ]),
  },
];

/** Spoilers are built around their mount point. */
export const SPOILERS = [
  { id: 'none', name: 'None', price: 0, build: null },
  {
    id: 'wing', name: 'Wing', price: 0,
    build: () => merge([
      box(1.5, 0.08, 0.35, 0, 0.17, 0, W),
      box(0.08, 0.4, 0.2, 0.55, -0.05, 0.05, DARK),
      box(0.08, 0.4, 0.2, -0.55, -0.05, 0.05, DARK),
    ]),
  },
  {
    id: 'twin', name: 'Twin Deck', price: 6,
    build: () => merge([
      box(1.6, 0.08, 0.4, 0, 0.2, 0, W),
      box(1.6, 0.08, 0.35, 0, 0.5, -0.05, W),
      box(0.1, 0.12, 0.5, 0.8, 0.35, 0, DARK),
      box(0.1, 0.12, 0.5, -0.8, 0.35, 0, DARK),
      box(0.08, 0.6, 0.2, 0.6, 0.05, 0.05, DARK),
      box(0.08, 0.6, 0.2, -0.6, 0.05, 0.05, DARK),
    ]),
  },
  {
    id: 'ducktail', name: 'Ducktail', price: 5,
    build: () => merge([
      box(1.3, 0.1, 0.45, 0, -0.1, 0.1, W, -0.45, 0, 0),
      box(1.35, 0.14, 0.12, 0, -0.02, -0.08, DARK),
    ]),
  },
  {
    id: 'fin', name: 'Shark Fin', price: 8,
    build: () => merge([
      box(0.08, 0.8, 0.6, 0, 0.35, 0.1, W, -0.35, 0, 0),
      box(1.2, 0.07, 0.3, 0, 0.2, -0.05, W),
      box(0.08, 0.3, 0.15, 0.45, 0.05, 0, DARK),
      box(0.08, 0.3, 0.15, -0.45, 0.05, 0, DARK),
    ]),
  },
];

/** Wheels are built around their hub centre; `radius` lifts the body accordingly. */
export const WHEELS = [
  {
    id: 'standard', name: 'Standard', price: 0, radius: 0.3,
    build: () => merge([
      cylinder(0.3, 0.3, 0.3, 10, 0, 0, 0, 0x1c1c1c, 0, 0, Math.PI / 2),
      cylinder(0.16, 0.16, 0.32, 8, 0, 0, 0, 0xd0d0d0, 0, 0, Math.PI / 2),
      box(0.33, 0.07, 0.5, 0, 0, 0, 0x3a3a3a),
    ]),
  },
  {
    id: 'slick', name: 'Racing Slicks', price: 6, radius: 0.32,
    build: () => merge([
      cylinder(0.32, 0.32, 0.44, 12, 0, 0, 0, 0x151515, 0, 0, Math.PI / 2),
      cylinder(0.325, 0.325, 0.06, 12, 0.12, 0, 0, 0xe63946, 0, 0, Math.PI / 2),
      cylinder(0.18, 0.18, 0.46, 8, 0, 0, 0, 0x777777, 0, 0, Math.PI / 2),
      box(0.47, 0.06, 0.4, 0, 0, 0, 0x444444),
    ]),
  },
  {
    id: 'monster', name: 'Monster', price: 12, radius: 0.48,
    build: () => {
      const parts = [
        cylinder(0.48, 0.48, 0.46, 12, 0, 0, 0, 0x1a1a1a, 0, 0, Math.PI / 2),
        cylinder(0.24, 0.24, 0.48, 8, 0, 0, 0, 0xf4c20d, 0, 0, Math.PI / 2),
      ];
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        parts.push(box(0.5, 0.12, 0.16, 0, Math.sin(a) * 0.48, Math.cos(a) * 0.48, 0x2a2a2a, a, 0, 0));
      }
      return merge(parts);
    },
  },
  {
    id: 'retro', name: 'Whitewall', price: 7, radius: 0.31,
    build: () => merge([
      cylinder(0.31, 0.31, 0.28, 12, 0, 0, 0, 0x1c1c1c, 0, 0, Math.PI / 2),
      cylinder(0.24, 0.24, 0.3, 12, 0, 0, 0, 0xf5f5f5, 0, 0, Math.PI / 2),
      cylinder(0.14, 0.14, 0.32, 10, 0, 0, 0, 0xc0c0c8, 0, 0, Math.PI / 2),
      box(0.33, 0.05, 0.25, 0, 0, 0, 0x888888),
    ]),
  },
  {
    id: 'star', name: 'Gold Stars', price: 10, radius: 0.31,
    build: () => {
      const parts = [
        cylinder(0.31, 0.31, 0.3, 12, 0, 0, 0, 0x1c1c1c, 0, 0, Math.PI / 2),
        cylinder(0.08, 0.08, 0.34, 8, 0, 0, 0, 0xffd23f, 0, 0, Math.PI / 2),
      ];
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        parts.push(box(0.33, 0.06, 0.22, 0, Math.sin(a) * 0.12, Math.cos(a) * 0.12, 0xffd23f, a, 0, 0));
      }
      return merge(parts);
    },
  },
];

/** Headgear includes the head itself; `tint` = coloured with the accent paint. */
export const HATS = [
  {
    id: 'helmet', name: 'Helmet', price: 0, tint: true,
    build: () => merge([
      sphere(0.36, 10, 8, 0, 0, 0, W),
      box(0.5, 0.16, 0.12, 0, 0, 0.32, 0x1b263b),
    ]),
  },
  {
    id: 'cap', name: 'Cap', price: 4, tint: false,
    build: () => merge([
      sphere(0.3, 10, 8, 0, -0.04, 0, SKIN),
      sphere(0.31, 10, 6, 0, 0.02, 0, 0xe63946, 1, 0.6, 1),
      box(0.36, 0.05, 0.3, 0, 0.05, 0.36, 0xe63946),
      box(0.18, 0.06, 0.04, 0, -0.02, 0.29, 0x222222),
    ]),
  },
  {
    id: 'crown', name: 'Crown', price: 15, tint: false,
    build: () => {
      const parts = [
        sphere(0.3, 10, 8, 0, -0.05, 0, SKIN),
        cylinder(0.28, 0.28, 0.16, 10, 0, 0.3, 0, 0xffd23f),
        box(0.18, 0.06, 0.04, 0, -0.02, 0.29, 0x222222),
      ];
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        parts.push(cylinder(0, 0.08, 0.2, 4, Math.sin(a) * 0.24, 0.47, Math.cos(a) * 0.24, 0xffd23f));
        parts.push(sphere(0.04, 5, 4, Math.sin(a) * 0.28, 0.3, Math.cos(a) * 0.28, 0xe63946));
      }
      return merge(parts);
    },
  },
  {
    id: 'cone', name: 'Traffic Cone', price: 6, tint: false,
    build: () => merge([
      sphere(0.3, 10, 8, 0, -0.05, 0, SKIN),
      cylinder(0.05, 0.3, 0.75, 10, 0, 0.5, 0, 0xff7f11),
      cylinder(0.14, 0.2, 0.12, 10, 0, 0.55, 0, 0xffffff),
      box(0.62, 0.05, 0.62, 0, 0.14, 0, 0xff7f11),
      box(0.18, 0.06, 0.04, 0, -0.02, 0.29, 0x222222),
    ]),
  },
  {
    id: 'horns', name: 'Viking', price: 9, tint: true,
    build: () => merge([
      sphere(0.36, 10, 8, 0, 0, 0, W),
      box(0.5, 0.14, 0.1, 0, -0.02, 0.32, 0x1b263b),
      cylinder(0.02, 0.09, 0.45, 6, 0.42, 0.22, 0, 0xf5f0dc, 0, 0, -0.9),
      cylinder(0.02, 0.09, 0.45, 6, -0.42, 0.22, 0, 0xf5f0dc, 0, 0, 0.9),
    ]),
  },
];

export const PART_SLOTS = [
  { key: 'body', label: 'Body', list: BODIES },
  { key: 'spoiler', label: 'Spoiler', list: SPOILERS },
  { key: 'wheels', label: 'Wheels', list: WHEELS },
  { key: 'hat', label: 'Headgear', list: HATS },
];

export const DEFAULT_LOOK = Object.freeze({
  body: 'classic', spoiler: 'wing', wheels: 'standard', hat: 'helmet', color: PAINTS[0], accent: PAINTS[8],
});

const pick = (list, id) => list.find((p) => p.id === id) || list[0];
export const getBody = (id) => pick(BODIES, id);
export const getSpoiler = (id) => pick(SPOILERS, id);
export const getWheels = (id) => pick(WHEELS, id);
export const getHat = (id) => pick(HATS, id);

/** Validate a look received from the network or storage. */
export function sanitizeLook(look) {
  const l = look && typeof look === 'object' ? look : {};
  const color = Number.isInteger(l.color) && l.color >= 0 && l.color <= 0xffffff ? l.color : DEFAULT_LOOK.color;
  const accent = Number.isInteger(l.accent) && l.accent >= 0 && l.accent <= 0xffffff ? l.accent : DEFAULT_LOOK.accent;
  return {
    body: getBody(l.body).id,
    spoiler: getSpoiler(l.spoiler).id,
    wheels: getWheels(l.wheels).id,
    hat: getHat(l.hat).id,
    color,
    accent,
  };
}

export function randomLook(rand = Math.random) {
  const any = (list) => list[Math.floor(rand() * list.length)].id;
  return {
    body: any(BODIES), spoiler: any(SPOILERS), wheels: any(WHEELS), hat: any(HATS),
    color: PAINTS[Math.floor(rand() * PAINTS.length)],
    accent: PAINTS[Math.floor(rand() * PAINTS.length)],
  };
}

/** Parts owned for free. */
export function defaultOwned() {
  const owned = new Set();
  for (const slot of PART_SLOTS) for (const p of slot.list) if (p.price === 0) owned.add(`${slot.key}:${p.id}`);
  return owned;
}

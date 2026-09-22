import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _color = new THREE.Color();

/** Paint every vertex of a geometry one colour (adds a `color` attribute). */
export function paint(geo, hex) {
  _color.setHex(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = _color.r;
    arr[i * 3 + 1] = _color.g;
    arr[i * 3 + 2] = _color.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Normalise a primitive to non-indexed position/normal/color so any mix can be merged. */
function normalise(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'color') g.deleteAttribute(name);
  }
  return g;
}

export function box(w, h, d, x, y, z, hex, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx || ry || rz) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
  g.translate(x, y, z);
  return paint(normalise(g), hex);
}

export function cylinder(rTop, rBottom, h, seg, x, y, z, hex, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, seg);
  if (rx || ry || rz) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
  g.translate(x, y, z);
  return paint(normalise(g), hex);
}

export function sphere(r, wSeg, hSeg, x, y, z, hex, sx = 1, sy = 1, sz = 1) {
  const g = new THREE.SphereGeometry(r, wSeg, hSeg);
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return paint(normalise(g), hex);
}

export function merge(parts) {
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Accumulates flat, vertex-coloured triangles (used for the road ribbon and decals)
 * and emits a single BufferGeometry.
 */
export class RibbonBuilder {
  constructor() {
    this.positions = [];
    this.colors = [];
  }

  /** Quad a-b-c-d given in counter-clockwise order when seen from above (+Y). */
  quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, hex) {
    _color.setHex(hex);
    const p = this.positions;
    p.push(ax, ay, az, bx, by, bz, cx, cy, cz, ax, ay, az, cx, cy, cz, dx, dy, dz);
    for (let i = 0; i < 6; i++) this.colors.push(_color.r, _color.g, _color.b);
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    const n = new Float32Array(this.positions.length);
    for (let i = 1; i < n.length; i += 3) n[i] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** Deterministic PRNG so every peer builds identical scenery. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

import * as THREE from 'three';
import { box, cylinder, merge } from '../engine/geometry.js';
import { KART } from './constants.js';

// Time-trial ghosts: your best run on a track, replayed as a see-through kart. Recorded at
// 10 Hz (x, y, z, yaw) and kept in localStorage per track seed.
const STEP = 0.1;
const KEY = 'mkbros:ghost:';
const INDEX = 'mkbros:ghosts';
const MAX_GHOSTS = 12;

export class GhostRecorder {
  constructor() {
    this.reset();
  }

  reset() {
    this.frames = [];
    this.laps = [];
    this.next = 0;
  }

  /** Call every frame with the race time (seconds). */
  sample(t, k) {
    while (t >= this.next) {
      this.frames.push(k.x, k.y, k.z, k.yaw);
      this.next += STEP;
    }
  }
}

function toBase64(f32) {
  const bytes = new Uint8Array(f32.buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export function saveGhost(seed, time, laps, frames) {
  seed >>>= 0;
  try {
    localStorage.setItem(KEY + seed, JSON.stringify({ time, laps, frames: toBase64(new Float32Array(frames)) }));
    // Keep only the most recent ghosts so storage never fills up.
    let index = JSON.parse(localStorage.getItem(INDEX) || '[]').filter((s) => s !== seed);
    index.push(seed);
    while (index.length > MAX_GHOSTS) localStorage.removeItem(KEY + index.shift());
    localStorage.setItem(INDEX, JSON.stringify(index));
    return true;
  } catch {
    return false; // storage full or blocked
  }
}

export function loadGhost(seed) {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY + (seed >>> 0)) || 'null');
    if (!raw || !raw.frames) return null;
    return { time: raw.time, laps: raw.laps || [], frames: fromBase64(raw.frames) };
  } catch {
    return null;
  }
}

/** A translucent kart that replays a saved ghost. */
export class GhostKart {
  constructor(renderer) {
    const geo = merge([
      box(1.5, 0.45, 2.3, 0, 0.45, 0, 0xffffff),
      box(1.1, 0.3, 0.7, 0, 0.4, 1.35, 0xffffff),
      box(0.95, 0.65, 0.5, 0, 0.9, -0.45, 0xffffff),
      box(0.6, 0.6, 0.6, 0, 1.45, -0.2, 0xffffff),
      box(1.6, 0.12, 0.5, 0, 1.05, -1.2, 0xffffff),
      cylinder(0.36, 0.36, 0.34, 12, 0.88, 0.36, 0.8, 0xffffff, 0, 0, Math.PI / 2),
      cylinder(0.36, 0.36, 0.34, 12, -0.88, 0.36, 0.8, 0xffffff, 0, 0, Math.PI / 2),
      cylinder(0.4, 0.4, 0.4, 12, 0.9, 0.4, -0.85, 0xffffff, 0, 0, Math.PI / 2),
      cylinder(0.4, 0.4, 0.4, 12, -0.9, 0.4, -0.85, 0xffffff, 0, 0, Math.PI / 2),
    ]);
    const mat = new THREE.MeshBasicMaterial({ color: 0x7fdcff, transparent: true, opacity: 0.6, depthWrite: false });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.scale.setScalar(1.25);
    this.mesh.visible = false;
    renderer.scene.add(this.mesh);
  }

  show(v) {
    this.mesh.visible = v;
  }

  /** Pose the ghost at race time t (seconds). */
  update(t, ghost) {
    const f = ghost.frames;
    const n = f.length / 4;
    if (!n) return;
    const u = Math.max(0, Math.min(n - 1, t / STEP));
    const i = Math.min(n - 2, Math.floor(u)), a = Math.max(0, i) * 4, b = Math.min(n - 1, i + 1) * 4;
    const w = n > 1 ? u - i : 0;
    const dy = Math.atan2(Math.sin(f[b + 3] - f[a + 3]), Math.cos(f[b + 3] - f[a + 3]));
    this.mesh.position.set(f[a] + (f[b] - f[a]) * w, f[a + 1] + (f[b + 1] - f[a + 1]) * w - KART.radius, f[a + 2] + (f[b + 2] - f[a + 2]) * w);
    this.mesh.rotation.y = f[a + 3] + dy * w;
    // Fade out once the ghost has finished its run.
    this.mesh.material.opacity = u >= n - 1 ? 0.25 : 0.6;
  }
}

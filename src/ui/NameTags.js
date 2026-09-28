import * as THREE from 'three';

const FADE_START = 55; // metres: fully visible closer than this...
const FADE_END = 110; // ...and gone beyond this

const hex = (c) => '#' + (c >>> 0).toString(16).padStart(6, '0');

/**
 * Floating nametags above every other kart (not the one the camera follows): position badge in
 * the kart's colour plus the driver's name, fading out with distance. DOM elements projected
 * from 3D each frame; text and colours are only touched when they change.
 */
export class NameTags {
  constructor() {
    this.layer = document.getElementById('nametag-layer');
    this.tags = new Map(); // slot -> { el, badge, label, key }
    this._v = new THREE.Vector3();
  }

  clear() {
    for (const t of this.tags.values()) t.el.remove();
    this.tags.clear();
  }

  _tag(k) {
    let t = this.tags.get(k.slot);
    if (!t) {
      const el = document.createElement('div');
      el.className = 'nametag';
      const badge = document.createElement('b');
      const label = document.createElement('span');
      el.append(badge, label);
      this.layer.appendChild(el);
      t = { el, badge, label, key: '', shown: true };
      this.tags.set(k.slot, t);
    }
    return t;
  }

  update(karts, viewed, camera) {
    const w = window.innerWidth, h = window.innerHeight;
    const cam = camera.position;
    const seen = new Set();
    for (const k of karts) {
      if (k === viewed) continue;
      seen.add(k.slot);
      const t = this._tag(k);
      const x = k.renderX ?? k.x, y = k.renderY ?? k.y, z = k.renderZ ?? k.z;
      const dist = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
      const v = this._v.set(x, y + 2.3 * (k.megaScale || 1) + (k.rocketTimer > 0 ? 0.8 : 0), z).project(camera);
      const show = dist < FADE_END && v.z < 1 && v.z > -1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
      if (show !== t.shown) {
        t.shown = show;
        t.el.style.display = show ? '' : 'none';
      }
      if (!show) continue;
      const key = `${k.rank}|${k.name}|${k.color}|${k.finished ? 1 : 0}`;
      if (key !== t.key) {
        t.key = key;
        t.badge.textContent = String(k.rank || '');
        t.badge.style.background = hex(k.color ?? 0xffffff);
        t.label.textContent = k.name;
      }
      const fade = dist < FADE_START ? 1 : 1 - (dist - FADE_START) / (FADE_END - FADE_START);
      const scale = Math.max(0.7, Math.min(1.05, 26 / Math.max(1, dist) + 0.62));
      t.el.style.opacity = (k.finished ? 0.55 : 1) * fade;
      t.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%) scale(${scale.toFixed(2)})`;
    }
    // Karts that left, or the kart the camera now follows.
    for (const [slot, t] of this.tags) {
      if (!seen.has(slot) && t.shown) {
        t.shown = false;
        t.el.style.display = 'none';
      }
    }
  }
}

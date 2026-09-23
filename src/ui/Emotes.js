import * as THREE from 'three';

export const EMOTES = ['👋', '😂', '😤', '🏆'];
const SHOW_FOR = 2.6; // seconds a bubble stays up

/**
 * Emote bubbles floating above karts (DOM elements projected from 3D each frame) and the
 * clickable emote bar in the HUD. Keys 1–4 send the same emotes.
 */
export class Emotes {
  constructor(onPick) {
    this.layer = document.getElementById('emote-layer');
    this.bubbles = new Map(); // slot -> { el, t }
    this._v = new THREE.Vector3();
    for (const btn of document.querySelectorAll('[data-emote]')) {
      btn.addEventListener('click', () => onPick(Number(btn.dataset.emote)));
    }
  }

  show(slot, idx) {
    const emoji = EMOTES[idx];
    if (!emoji) return;
    let b = this.bubbles.get(slot);
    if (!b) {
      // Outer element is positioned every frame; the inner bubble does the pop animation.
      const el = document.createElement('div');
      el.className = 'emote-anchor';
      const inner = document.createElement('div');
      inner.className = 'emote-bubble';
      el.appendChild(inner);
      this.layer.appendChild(el);
      b = { el, inner, t: 0 };
      this.bubbles.set(slot, b);
    }
    b.inner.textContent = emoji;
    b.inner.classList.remove('emote-pop');
    void b.inner.offsetWidth; // restart the pop animation
    b.inner.classList.add('emote-pop');
    b.t = SHOW_FOR;
  }

  clear() {
    for (const b of this.bubbles.values()) b.el.remove();
    this.bubbles.clear();
  }

  update(dt, kartBySlot, camera) {
    if (!this.bubbles.size) return;
    const w = window.innerWidth, h = window.innerHeight;
    for (const [slot, b] of this.bubbles) {
      b.t -= dt;
      const k = kartBySlot[slot];
      if (b.t <= 0 || !k) {
        b.el.remove();
        this.bubbles.delete(slot);
        continue;
      }
      const v = this._v.set(k.renderX, k.renderY + 2.4 * (k.megaScale || 1), k.renderZ).project(camera);
      const hidden = v.z > 1 || v.z < -1;
      b.el.style.display = hidden ? 'none' : '';
      if (hidden) continue;
      b.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
      b.el.style.opacity = String(Math.min(1, b.t / 0.4));
    }
  }
}

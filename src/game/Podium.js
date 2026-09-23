import * as THREE from 'three';
import { box, cylinder, merge } from '../engine/geometry.js';
import { KART } from './constants.js';
import { escapeHtml } from '../ui/HUD.js';

// The stage floats high above the map, like the garage showroom (but somewhere else).
const P = { x: 0, y: 400, z: 70 };
// Step layout: 1st in the middle, 2nd on the viewer's left, 3rd on the right.
const STEPS = {
  1: { x: 0, top: 3.0, z: 0, color: 0xffd23f, medal: '#ffd23f', label: '1st' },
  2: { x: -5.4, top: 2.0, z: 0.4, color: 0xcfd8e3, medal: '#cfd8e3', label: '2nd' },
  3: { x: 5.4, top: 1.3, z: 0.6, color: 0xcd7f32, medal: '#e3a15f', label: '3rd' },
};
const REVEAL_AT = { 3: 0.9, 2: 3.2, 1: 5.6 }; // seconds into the ceremony
const REVEAL_TIME = 1.7; // spin-in duration
const FINALE_AT = 8.2; // camera pulls back to all three
const END_AT = 11.5; // hand over to the results screen
const CONFETTI = [0xff595e, 0xffca3a, 0x8ac926, 0x1982c4, 0x6a4c93, 0xffffff, 0xf15bb5];

const easeOutCubic = (u) => 1 - (1 - u) ** 3;
const easeOutBack = (u) => {
  const c1 = 1.7, c3 = c1 + 1;
  return 1 + c3 * (u - 1) ** 3 + c1 * (u - 1) ** 2;
};

/**
 * End-of-race podium ceremony: reveals 3rd, then 2nd, then 1st on a stepped podium. Each kart
 * arcs onto its step spinning fast and slows to face the camera, with confetti and a name card.
 */
export class PodiumCeremony {
  constructor(renderer, particles, audio, onDone) {
    this.renderer = renderer;
    this.particles = particles;
    this.audio = audio;
    this.onDone = onDone;
    this.active = false;
    this.list = []; // karts currently shown (for KartRenderer)
    this._buildStage();

    this.ui = document.getElementById('podium-ui');
    this.namesEl = document.getElementById('podium-names');
    this.titleEl = document.getElementById('podium-title');
    document.getElementById('btn-podium-skip').addEventListener('click', () => this.finish());

    this._camPos = new THREE.Vector3();
    this._camLook = new THREE.Vector3();
  }

  _buildStage() {
    const parts = [
      cylinder(12, 12.5, 0.6, 40, 0, -0.3, 0, 0x2b2d42),
      cylinder(12.3, 12.3, 0.25, 40, 0, 0.02, 0, 0xffd23f),
    ];
    for (const [place, s] of Object.entries(STEPS)) {
      parts.push(box(5, s.top, 5, s.x, s.top / 2, s.z, s.color));
      parts.push(box(5.2, 0.25, 5.2, s.x, s.top + 0.12, s.z, 0xffffff)); // top trim
      // Front plate with roman-numeral bars (I, II, III).
      parts.push(box(2.6, Math.min(1.6, s.top * 0.7), 0.1, s.x, s.top * 0.5, s.z + 2.53, 0x1b1f33));
      const n = Number(place);
      for (let b = 0; b < n; b++) {
        const bx = s.x + (b - (n - 1) / 2) * 0.45;
        parts.push(box(0.22, Math.min(1.1, s.top * 0.5), 0.12, bx, s.top * 0.5, s.z + 2.6, 0xffffff));
      }
    }
    // Chequered banner behind the podium.
    const cols = 16, rows = 4, cell = 1.3;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        parts.push(box(cell, cell, 0.3, (c - cols / 2 + 0.5) * cell, 6.5 + r * cell, -5, (r + c) % 2 === 0 ? 0x111111 : 0xffffff));
      }
    }
    parts.push(box(0.5, 12.5, 0.5, -cols * cell / 2 - 0.4, 6.2, -5, 0x2b2d42));
    parts.push(box(0.5, 12.5, 0.5, cols * cell / 2 + 0.4, 6.2, -5, 0x2b2d42));
    this.stage = new THREE.Mesh(merge(parts), this.renderer.toon({ vertexColors: true }));
    this.stage.position.set(P.x, P.y, P.z);
    this.stage.visible = false;
    this.renderer.scene.add(this.stage);
  }

  /** entries: [{ place: 1..3, name, look }]; opts.title / opts.winText for the Grand Prix. */
  start(entries, opts = {}) {
    this.winText = opts.winText || 'wins!';
    this.active = true;
    this.t = 0;
    this.stage.visible = true;
    this.slots = entries.slice(0, 3).map((e) => {
      const s = STEPS[e.place];
      return {
        place: e.place,
        name: e.name,
        revealed: false,
        kart: {
          preview: true, simulated: false, look: e.look,
          x: P.x + s.x, y: 0, z: P.z + s.z, prevX: P.x + s.x, prevY: 0, prevZ: P.z + s.z,
          yaw: 0, prevYaw: 0, megaScale: 0.001, megaTimer: 0, driftVisual: 0, spinAngle: 0,
          steerVisual: 0, speed: 0, wheelSpin: 0, boostTimer: 0, shieldTimer: 0, ghostTimer: 0,
        },
      };
    });
    this.list = [];
    this.namesEl.innerHTML = '';
    this.titleEl.textContent = opts.title || 'Podium';
    this.ui.classList.remove('hidden');
    const cam = this.renderer.camera;
    this._camPos.set(P.x, P.y + 7, P.z + 30);
    this._camLook.set(P.x, P.y + 2.5, P.z);
    cam.position.copy(this._camPos);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.stage.visible = false;
    this.list = [];
    this.ui.classList.add('hidden');
  }

  finish() {
    if (!this.active) return;
    this.stop();
    if (this.onDone) this.onDone();
  }

  _reveal(slot) {
    slot.revealed = true;
    const s = STEPS[slot.place];
    const x = P.x + s.x, y = P.y + s.top + 0.3, z = P.z + s.z;
    const count = slot.place === 1 ? 70 : 40;
    for (let n = 0; n < count; n++) {
      const a = Math.random() * Math.PI * 2, sp = 3 + Math.random() * 6;
      this.particles.spawn(x, y + 1, z, Math.cos(a) * sp, 6 + Math.random() * 8, Math.sin(a) * sp,
        2 + Math.random() * 1.2, 0.3 + Math.random() * 0.25,
        slot.place === 1 && n % 2 === 0 ? 0xffd23f : CONFETTI[n % CONFETTI.length], -9);
    }
    this.audio.blip(slot.place === 1 ? 'mega' : 'shield');
    const card = document.createElement('div');
    card.className = 'pop flex min-w-36 flex-col items-center rounded-2xl bg-black/55 px-5 py-3 backdrop-blur-sm';
    card.style.order = String(slot.place === 1 ? 2 : slot.place === 2 ? 1 : 3);
    card.innerHTML = `<span class="title text-3xl" style="color:${s.medal}">${s.label}</span><span class="max-w-40 truncate font-extrabold">${escapeHtml(slot.name)}</span>`;
    this.namesEl.appendChild(card);
    if (slot.place === 1) this.titleEl.textContent = `${slot.name} ${this.winText}`;
  }

  update(dt, time) {
    if (!this.active) return;
    this.t += dt;
    const t = this.t;
    this.list.length = 0;
    let focus = null;

    for (const slot of this.slots) {
      const at = REVEAL_AT[slot.place];
      const local = t - at;
      if (local < 0) continue;
      if (!slot.revealed) this._reveal(slot);
      const s = STEPS[slot.place];
      const k = slot.kart;
      const u = Math.min(1, local / REVEAL_TIME);
      const scale = Math.max(0.001, easeOutBack(u));
      // Fast spin that slows to a stop facing the camera, then a gentle idle sway.
      const spin = (1 - easeOutCubic(u)) * Math.PI * 2 * 3;
      const idle = u >= 1 ? Math.sin(time * 0.9 + slot.place) * 0.35 : 0;
      k.yaw = k.prevYaw = spin + idle;
      k.megaScale = scale * 1.25;
      const hop = Math.sin(Math.min(1, u * 1.2) * Math.PI) * 1.6; // arcs onto the step
      k.y = k.prevY = P.y + s.top + 0.25 + hop + KART.radius * k.megaScale;
      k.wheelSpin += dt * 6;
      k.steerVisual = Math.sin(time * 1.3 + slot.place) * 0.4;
      this.list.push(k);
      if (local < REVEAL_TIME + 0.6) focus = slot;
    }

    // Camera: wide intro, close-up on each reveal, then a slow wide finale.
    let px, py, pz, lx, ly, lz;
    if (focus && t < FINALE_AT) {
      const s = STEPS[focus.place];
      px = P.x + s.x * 0.7 + 1.5; py = P.y + s.top + 3.2; pz = P.z + s.z + 10;
      lx = P.x + s.x; ly = P.y + s.top + 1.2; lz = P.z + s.z;
    } else {
      const sway = t >= FINALE_AT ? Math.sin((t - FINALE_AT) * 0.5) * 6 : 0;
      px = P.x + sway; py = P.y + 7.5; pz = P.z + (t >= FINALE_AT ? 21 : 28);
      lx = P.x; ly = P.y + 2.8; lz = P.z;
    }
    const k = 1 - Math.exp(-dt * 2.6);
    this._camPos.lerp({ x: px, y: py, z: pz }, k);
    this._camLook.lerp({ x: lx, y: ly, z: lz }, k);
    const cam = this.renderer.camera;
    cam.up.set(0, 1, 0);
    cam.position.copy(this._camPos);
    cam.lookAt(this._camLook);
    if (cam.fov !== this.renderer.baseFov) {
      cam.fov = this.renderer.baseFov;
      cam.updateProjectionMatrix();
    }
    this.renderer.sky.position.copy(cam.position);

    // Keep the confetti coming for the winner.
    if (t > REVEAL_AT[1] && t < END_AT && Math.random() < 0.25) {
      this.particles.spawn(P.x + (Math.random() - 0.5) * 16, P.y + 12, P.z + (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 2, -1, (Math.random() - 0.5) * 2, 3, 0.3, CONFETTI[(Math.random() * CONFETTI.length) | 0], -3);
    }

    if (t >= END_AT) this.finish();
  }
}

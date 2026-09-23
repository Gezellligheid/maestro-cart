/**
 * On-screen controls for phones and tablets. The kart accelerates by itself; the left pad
 * steers (slide your thumb left/right), the right side has Drift, Item, Brake and Respawn.
 * Writes into Input.touch, which Input.poll merges with keyboard and gamepad.
 */
export function isTouchDevice() {
  return window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window;
}

export class TouchControls {
  constructor(input) {
    this.input = input;
    this.root = document.getElementById('touch');
    this.enabled = isTouchDevice();
    document.body.classList.toggle('touch', this.enabled);
    if (!this.enabled) return;
    input.touch = { active: true, steer: 0, drift: false, brake: false };

    // Steering pad: analog steer from where the thumb is relative to the pad's centre.
    const pad = document.getElementById('touch-steer');
    const knob = document.getElementById('touch-knob');
    let steerId = null;
    const setSteer = (e) => {
      const r = pad.getBoundingClientRect();
      const s = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width * 0.32)));
      input.touch.steer = s;
      knob.style.transform = `translateX(${s * r.width * 0.32}px)`;
    };
    pad.addEventListener('pointerdown', (e) => {
      steerId = e.pointerId;
      try { pad.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      setSteer(e);
    });
    pad.addEventListener('pointermove', (e) => { if (e.pointerId === steerId) setSteer(e); });
    const endSteer = (e) => {
      if (e.pointerId !== steerId) return;
      steerId = null;
      input.touch.steer = 0;
      knob.style.transform = '';
    };
    pad.addEventListener('pointerup', endSteer);
    pad.addEventListener('pointercancel', endSteer);

    // Buttons: hold for drift/brake, tap for item/respawn.
    const hold = (id, on, off) => {
      const el = document.getElementById(id);
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { el.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
        el.classList.add('held');
        on();
      });
      const up = () => { el.classList.remove('held'); off(); };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    };
    hold('touch-drift', () => { input.touch.drift = true; input.state.driftPressed = true; }, () => { input.touch.drift = false; });
    hold('touch-brake', () => { input.touch.brake = true; }, () => { input.touch.brake = false; });
    hold('touch-item', () => { input.state.itemPressed = true; }, () => {});
    hold('touch-respawn', () => { input.state.respawnPressed = true; }, () => {});
    // No page scrolling / zooming while racing.
    this.root.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  }

  show(v) {
    if (!this.enabled) return;
    this.root.classList.toggle('hidden', !v);
    if (!v && this.input.touch) {
      this.input.touch.steer = 0;
      this.input.touch.drift = false;
      this.input.touch.brake = false;
    }
  }
}

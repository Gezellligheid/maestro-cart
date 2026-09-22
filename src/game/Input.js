const KEYS = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  drift: ['Space'],
  item: ['ShiftLeft', 'ShiftRight', 'KeyE'],
  respawn: ['KeyR'],
};

const GAME_KEYS = new Set(Object.values(KEYS).flat());

/**
 * Keyboard (+ standard gamepad) input. Edge-triggered actions are latched until the fixed
 * step consumes them, so a tap shorter than one physics tick is never lost.
 */
export class Input {
  constructor() {
    this.down = new Set();
    this.state = {
      throttle: 0,
      steer: 0, // +1 = right
      drift: false,
      driftPressed: false,
      itemPressed: false,
      respawnPressed: false,
    };
    this._prevPad = { drift: false, item: false };
    this.enabled = true;

    window.addEventListener('keydown', (e) => {
      if (!this.enabled || this._isTyping(e)) return;
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.down.add(e.code);
      if (KEYS.drift.includes(e.code)) this.state.driftPressed = true;
      if (KEYS.item.includes(e.code)) this.state.itemPressed = true;
      if (KEYS.respawn.includes(e.code)) this.state.respawnPressed = true;
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  _isTyping(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
  }

  _any(list) {
    for (let i = 0; i < list.length; i++) if (this.down.has(list[i])) return true;
    return false;
  }

  /** Refresh continuous axes. Call once per frame. */
  poll() {
    const s = this.state;
    let throttle = (this._any(KEYS.up) ? 1 : 0) - (this._any(KEYS.down) ? 1 : 0);
    let steer = (this._any(KEYS.right) ? 1 : 0) - (this._any(KEYS.left) ? 1 : 0);
    let drift = this._any(KEYS.drift);

    const pads = navigator.getGamepads ? navigator.getGamepads() : null;
    const pad = pads && pads[0];
    if (pad && pad.connected) {
      const ax = pad.axes[0] || 0;
      if (Math.abs(ax) > 0.15) steer = ax;
      const rt = pad.buttons[7] ? pad.buttons[7].value : 0;
      const lt = pad.buttons[6] ? pad.buttons[6].value : 0;
      if (pad.buttons[0]?.pressed || rt > 0.1) throttle = Math.max(throttle, pad.buttons[0]?.pressed ? 1 : rt);
      if (pad.buttons[1]?.pressed || lt > 0.1) throttle = -1;
      const padDrift = !!(pad.buttons[5]?.pressed || pad.buttons[4]?.pressed);
      const padItem = !!(pad.buttons[2]?.pressed || pad.buttons[3]?.pressed);
      if (padDrift && !this._prevPad.drift) s.driftPressed = true;
      if (padItem && !this._prevPad.item) s.itemPressed = true;
      this._prevPad.drift = padDrift;
      this._prevPad.item = padItem;
      drift = drift || padDrift;
    }

    s.throttle = throttle;
    s.steer = Math.max(-1, Math.min(1, steer));
    s.drift = drift;
    return s;
  }

  /** Clear latched edges after a fixed step has seen them. */
  consumeEdges() {
    this.state.driftPressed = false;
    this.state.itemPressed = false;
    this.state.respawnPressed = false;
  }
}

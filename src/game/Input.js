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

/** Standard gamepad button indices (Xbox names; PlayStation: A=✕, B=○, X=□, Y=△). */
export const PAD = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7,
  BACK: 8, START: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
};
const STICK_DEAD = 0.15;
const REPEAT_DELAY = 0.38; // held D-pad / stick: first repeat, then every REPEAT_RATE
const REPEAT_RATE = 0.13;

/**
 * Keyboard + gamepad input. Edge-triggered actions are latched until the fixed step consumes
 * them, so a tap shorter than one physics tick is never lost.
 *
 * Controller: A / RT accelerate (RT is analog), B / LT brake & reverse, left stick steers,
 * RB / LB hop & drift, X / Y use item, Back respawns. Every button press is also reported to
 * `onPad(button, repeat)` for menus, emotes and spectating; the D-pad and the stick also send
 * auto-repeating direction events with `repeat` = true (menus use them, racing ignores them).
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
    this.enabled = true;
    this.touch = null; // set by TouchControls on phones / tablets
    this.onPad = null; // (button) => void
    this.usingPad = false; // last input came from a controller (for rumble)
    this._prevBtn = new Array(17).fill(false);
    this._hold = { dir: -1, t: 0 };
    this._lastPoll = performance.now();

    window.addEventListener('keydown', (e) => {
      this.usingPad = false;
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

  /** The controller that was used most recently (any slot, not just the first). */
  _activePad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : null;
    if (!pads) return null;
    let best = null;
    for (const p of pads) if (p && p.connected && (!best || p.timestamp > best.timestamp)) best = p;
    return best;
  }

  /** Refresh continuous axes. Call once per frame. */
  poll() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this._lastPoll) / 1000);
    this._lastPoll = now;
    const s = this.state;
    let throttle = (this._any(KEYS.up) ? 1 : 0) - (this._any(KEYS.down) ? 1 : 0);
    let steer = (this._any(KEYS.right) ? 1 : 0) - (this._any(KEYS.left) ? 1 : 0);
    let drift = this._any(KEYS.drift);

    const pad = this._activePad();
    if (pad) {
      const held = (i) => !!pad.buttons[i] && (pad.buttons[i].pressed || pad.buttons[i].value > 0.5);
      const value = (i) => (pad.buttons[i] ? pad.buttons[i].value : 0);

      // Button edges: race actions, then everything to onPad (menus, emotes, pause…).
      for (let i = 0; i < 16; i++) {
        const d = held(i);
        if (d && !this._prevBtn[i]) {
          this.usingPad = true;
          if (i === PAD.RB || i === PAD.LB) s.driftPressed = true;
          if (i === PAD.X || i === PAD.Y) s.itemPressed = true;
          if (i === PAD.BACK) s.respawnPressed = true;
          if (this.onPad) this.onPad(i);
        }
        this._prevBtn[i] = d;
      }

      // Left stick with a dead zone (rescaled so small tilts still steer gently).
      const ax = pad.axes[0] || 0;
      if (Math.abs(ax) > STICK_DEAD) {
        steer = Math.sign(ax) * (Math.abs(ax) - STICK_DEAD) / (1 - STICK_DEAD);
        this.usingPad = true;
      }
      const rt = value(PAD.RT), lt = value(PAD.LT);
      if (held(PAD.A) || rt > 0.08) throttle = Math.max(throttle, held(PAD.A) ? 1 : Math.min(1, rt * 1.15));
      if (held(PAD.B) || lt > 0.3) throttle = -1;
      drift = drift || held(PAD.RB) || held(PAD.LB);

      // D-pad / stick as a direction with auto-repeat, for menus.
      const ay = pad.axes[1] || 0;
      let dir = -1;
      if (held(PAD.UP) || ay < -0.6) dir = PAD.UP;
      else if (held(PAD.DOWN) || ay > 0.6) dir = PAD.DOWN;
      else if (held(PAD.LEFT) || ax < -0.6) dir = PAD.LEFT;
      else if (held(PAD.RIGHT) || ax > 0.6) dir = PAD.RIGHT;
      const h = this._hold;
      if (dir !== h.dir) {
        // Real D-pad presses were already reported above; only the stick needs a first event.
        if (dir >= 0 && !held(dir) && this.onPad) this.onPad(dir, true);
        h.dir = dir;
        h.t = REPEAT_DELAY;
      } else if (dir >= 0) {
        h.t -= dt;
        if (h.t <= 0) {
          h.t = REPEAT_RATE;
          if (this.onPad) this.onPad(dir, true);
        }
      }
    }

    // Touch controls: the kart drives itself forward once the race is on; brake to slow down.
    const t = this.touch;
    if (t && t.active) {
      if (Math.abs(t.steer) > 0.05) steer = t.steer;
      drift = drift || t.drift;
      if (throttle === 0) throttle = t.brake ? -1 : t.gas ? 1 : 0;
    }

    s.throttle = throttle;
    s.steer = Math.max(-1, Math.min(1, steer));
    s.drift = drift;
    return s;
  }

  /** Controller rumble (ignored when the last input wasn't a controller or it has no motors). */
  rumble(strong, weak, ms) {
    if (!this.usingPad) return;
    const pad = this._activePad();
    const act = pad && pad.vibrationActuator;
    if (!act || !act.playEffect) return;
    act.playEffect('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
  }

  /** Clear latched edges after a fixed step has seen them. */
  consumeEdges() {
    this.state.driftPressed = false;
    this.state.itemPressed = false;
    this.state.respawnPressed = false;
  }
}

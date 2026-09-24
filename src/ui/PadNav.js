import { PAD } from '../game/Input.js';

// Overlays in priority order: the first visible one gets controller focus.
const LAYERS = ['settings', 'stats-panel', 'garage', 'podium-ui', 'results', 'menu'];
const FOCUSABLE = 'button, input, select';
const DIRS = { [PAD.UP]: [0, -1], [PAD.DOWN]: [0, 1], [PAD.LEFT]: [-1, 0], [PAD.RIGHT]: [1, 0] };

const visible = (el) => !!el && !el.classList.contains('hidden') && el.getClientRects().length > 0;

/**
 * Controller navigation for every menu and overlay: D-pad / left stick moves a highlight
 * between buttons (nearest one in that direction), A presses it, B goes back. Sliders move
 * with left / right, checkboxes toggle and dropdowns cycle with A.
 */
export class PadNav {
  constructor({ onBack }) {
    this.onBack = onBack; // (layerId) => void
    this.focus = null;
    // Mouse users shouldn't see a stale controller highlight.
    window.addEventListener('pointerdown', () => this._setFocus(null));
  }

  /** The overlay currently taking input, or null while racing. */
  scope() {
    for (const id of LAYERS) {
      const el = document.getElementById(id);
      if (visible(el)) return el;
    }
    return null;
  }

  _items(scope) {
    return [...scope.querySelectorAll(FOCUSABLE)].filter((el) => !el.disabled && el.getClientRects().length > 0);
  }

  /** Returns true when the button was used for menu navigation. */
  handle(button) {
    const scope = this.scope();
    if (!scope) {
      this._setFocus(null);
      return false;
    }
    if (button === PAD.B) {
      this.onBack(scope.id);
      return true;
    }
    const items = this._items(scope);
    if (!items.length) return false;
    if (!this.focus || !items.includes(this.focus)) {
      if (DIRS[button] || button === PAD.A) {
        this._setFocus(items.find((el) => el.classList.contains('btn-primary')) || items[0]);
        return true;
      }
      return false;
    }
    const el = this.focus;
    if (DIRS[button]) {
      const [dx] = DIRS[button];
      if (el.type === 'range' && dx) {
        el.value = String(Number(el.value) + dx * 5);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      const next = this._nearest(el, items, DIRS[button]);
      if (next) this._setFocus(next);
      return true;
    }
    if (button === PAD.A) {
      if (el.tagName === 'SELECT') {
        el.selectedIndex = (el.selectedIndex + 1) % el.options.length;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.tagName === 'INPUT' && el.type !== 'checkbox') {
        el.focus(); // text boxes / sliders: type or use left / right
      } else {
        el.click();
        // The click may have swapped panels; keep the highlight on something that exists.
        requestAnimationFrame(() => { if (this.focus && !visible(this.focus)) this._setFocus(null); });
      }
      return true;
    }
    return false;
  }

  _nearest(from, items, [dx, dy]) {
    const a = from.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of items) {
      if (el === from) continue;
      const r = el.getBoundingClientRect();
      const ox = r.left + r.width / 2 - ax, oy = r.top + r.height / 2 - ay;
      const along = ox * dx + oy * dy;
      if (along <= 4) continue;
      // Sideways distance is the gap between the two boxes (0 when they line up), so the
      // next row wins over a better-centred button two rows away.
      const across = dx
        ? Math.max(0, r.top - a.bottom, a.top - r.bottom)
        : Math.max(0, r.left - a.right, a.left - r.right);
      const score = along + across * 2.5;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  _setFocus(el) {
    if (this.focus) this.focus.classList.remove('pad-focus');
    this.focus = el;
    if (!el) return;
    el.classList.add('pad-focus');
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

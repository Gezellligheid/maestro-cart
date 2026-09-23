import { ITEM, TOTAL_LAPS, DRIFT_TIERS, KART, BATTLE_MS } from '../game/constants.js';
import { formatTime, ordinal } from '../game/RaceManager.js';

const ICONS = {
  [ITEM.SHELL]: `<svg viewBox="0 0 64 64"><ellipse cx="32" cy="44" rx="26" ry="9" fill="#fff" stroke="#222" stroke-width="3"/><path d="M8 42c0-16 11-28 24-28s24 12 24 28z" fill="#2ec27e" stroke="#14532d" stroke-width="3"/><path d="M24 22l8-4 8 4-2 9h-12zM14 36l7-7 7 3-2 8h-11zM50 36l-7-7-7 3 2 8h11z" fill="#f5f5dc" stroke="#14532d" stroke-width="2"/></svg>`,
  [ITEM.BANANA]: `<svg viewBox="0 0 64 64"><path d="M14 12c-4 18 4 38 26 42 6 1 12-1 14-4-16 0-30-12-32-34z" fill="#ffe135" stroke="#8a6d00" stroke-width="3" stroke-linejoin="round"/><path d="M12 8l6 1-2 5-5-1z" fill="#5c3d1e"/><path d="M20 20c2 14 12 24 26 28" fill="none" stroke="#e0b400" stroke-width="2"/></svg>`,
  [ITEM.MUSHROOM]: `<svg viewBox="0 0 64 64"><path d="M24 36h16v14a6 6 0 0 1-6 6h-4a6 6 0 0 1-6-6z" fill="#fde7c7" stroke="#6b4423" stroke-width="3"/><path d="M6 36C6 20 18 8 32 8s26 12 26 28z" fill="#e63946" stroke="#7a1017" stroke-width="3"/><circle cx="32" cy="20" r="6" fill="#fff"/><circle cx="16" cy="29" r="5" fill="#fff"/><circle cx="48" cy="29" r="5" fill="#fff"/><circle cx="28" cy="44" r="2" fill="#222"/><circle cx="36" cy="44" r="2" fill="#222"/></svg>`,
};
ICONS[ITEM.MEGA] = `<svg viewBox="0 0 64 64"><path d="M22 38h20v14a6 6 0 0 1-6 6h-8a6 6 0 0 1-6-6z" fill="#fde7c7" stroke="#6b4423" stroke-width="3"/><path d="M2 38C2 20 15 6 32 6s30 14 30 32z" fill="#ffd23f" stroke="#8a6d00" stroke-width="3"/><circle cx="32" cy="18" r="6" fill="#e63946"/><circle cx="14" cy="30" r="5" fill="#e63946"/><circle cx="50" cy="30" r="5" fill="#e63946"/><text x="32" y="52" text-anchor="middle" font-size="13" font-weight="900" fill="#6b4423" font-family="sans-serif">x3</text></svg>`;
ICONS[ITEM.RED_SHELL] = ICONS[ITEM.SHELL].replace('#2ec27e', '#e63946').replaceAll('#14532d', '#7a1017').replace('#f5f5dc', '#ffe0e0');
ICONS[ITEM.LIGHTNING] = `<svg viewBox="0 0 64 64"><path d="M38 4L12 36h16l-6 24 28-34H34z" fill="#ffd23f" stroke="#8a6d00" stroke-width="3" stroke-linejoin="round"/></svg>`;
ICONS[ITEM.SHIELD] = `<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="26" fill="#7fdcff" fill-opacity="0.35" stroke="#2a9df4" stroke-width="4"/><path d="M18 22a16 16 0 0 1 14-8" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/><circle cx="32" cy="36" r="8" fill="#2a9df4"/></svg>`;
ICONS[ITEM.MAGNET] = `<svg viewBox="0 0 64 64"><path d="M14 10h12v22a6 6 0 0 0 12 0V10h12v22a18 18 0 0 1-36 0z" fill="#e63946" stroke="#7a1017" stroke-width="3"/><path d="M14 10h12v8H14zM38 10h12v8H38z" fill="#dfe6ee" stroke="#7a1017" stroke-width="3"/><circle cx="52" cy="50" r="5" fill="#ffd23f" stroke="#8a6d00" stroke-width="2"/></svg>`;
ICONS[ITEM.TRIPLE] = `<svg viewBox="0 0 64 64"><g transform="translate(-10 8) scale(0.62)">${ICONS[ITEM.MUSHROOM].replace(/<\/?svg[^>]*>/g, '')}</g><g transform="translate(14 8) scale(0.62)">${ICONS[ITEM.MUSHROOM].replace(/<\/?svg[^>]*>/g, '')}</g><g transform="translate(2 -8) scale(0.62)">${ICONS[ITEM.MUSHROOM].replace(/<\/?svg[^>]*>/g, '')}</g></svg>`;
ICONS[ITEM.OIL] = `<svg viewBox="0 0 64 64"><ellipse cx="32" cy="46" rx="26" ry="10" fill="#1b1a26" stroke="#000" stroke-width="2"/><ellipse cx="24" cy="44" rx="9" ry="3" fill="#5b4b8a" opacity="0.8"/><path d="M32 6c7 10 12 17 12 24a12 12 0 0 1-24 0c0-7 5-14 12-24z" fill="#2b2838" stroke="#000" stroke-width="3"/><path d="M27 26c0 4 2 7 5 8" fill="none" stroke="#8b7fd1" stroke-width="3" stroke-linecap="round"/></svg>`;
ICONS[ITEM.GHOST] = `<svg viewBox="0 0 64 64"><path d="M12 56V28a20 20 0 0 1 40 0v28l-7-6-6 6-7-6-7 6-6-6z" fill="#f5f3ff" stroke="#6b5fa8" stroke-width="3" stroke-linejoin="round"/><circle cx="25" cy="28" r="4" fill="#1b1530"/><circle cx="39" cy="28" r="4" fill="#1b1530"/><ellipse cx="32" cy="40" rx="4" ry="5" fill="#1b1530"/></svg>`;
ICONS[ITEM.ROCKET] = `<svg viewBox="0 0 64 64"><path d="M8 40l10-4v-8l-10-4z" fill="#ffb703"/><path d="M18 22h26c8 0 14 5 14 10s-6 10-14 10H18z" fill="#2b2d42" stroke="#111" stroke-width="3"/><circle cx="46" cy="30" r="3.5" fill="#fff"/><circle cx="47" cy="30" r="1.8" fill="#111"/><path d="M22 22l-4-10h10l6 10zM22 42l-4 10h10l6-10z" fill="#e63946" stroke="#111" stroke-width="2"/></svg>`;
ICONS[ITEM.PAD] = `<svg viewBox="0 0 64 64"><rect x="10" y="8" width="44" height="48" rx="6" fill="#ff7f11" stroke="#9a3f00" stroke-width="3"/><path d="M18 42l14-10 14 10M18 30l14-10 14 10" fill="none" stroke="#ffe156" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
ICONS[ITEM.CLOUD] = `<svg viewBox="0 0 64 64"><path d="M16 38a10 10 0 0 1 2-20 14 14 0 0 1 26-2 10 10 0 0 1 6 19z" fill="#5b6275" stroke="#2b2f3a" stroke-width="3"/><path d="M34 34l-6 12h7l-4 12 12-16h-7l4-8z" fill="#ffd23f" stroke="#8a6d00" stroke-width="2" stroke-linejoin="round"/></svg>`;
const ROLL_ORDER = [ITEM.SHELL, ITEM.BANANA, ITEM.MUSHROOM, ITEM.RED_SHELL, ITEM.SHIELD, ITEM.OIL, ITEM.MAGNET, ITEM.TRIPLE, ITEM.PAD, ITEM.GHOST, ITEM.CLOUD, ITEM.LIGHTNING, ITEM.ROCKET, ITEM.MEGA];
const $ = (id) => document.getElementById(id);

/**
 * DOM HUD overlay. Every setter caches the last value and only touches the DOM when it
 * changes, so per-frame updates don't trigger layout work.
 */
export class HUD {
  constructor(track) {
    this.track = track;
    this.root = $('hud');
    this.el = {
      pos: $('hud-pos'), posSuffix: $('hud-pos-suffix'), posTotal: $('hud-pos-total'),
      board: $('hud-board'), lap: $('hud-lap'), laps: $('hud-laps'), time: $('hud-time'), lastLap: $('hud-lastlap'),
      item: $('hud-item'), itemIcon: $('hud-item-icon'), coins: $('hud-coins'),
      speed: $('hud-speed'), speedArc: $('hud-speed-arc'), drift: $('hud-drift'),
      center: $('hud-center'), sub: $('hud-sub'), stats: $('hud-stats'), minimap: $('minimap'),
      mega: $('hud-mega'), megaN: $('hud-mega-n'),
    };
    this.el.laps.textContent = TOTAL_LAPS;
    this._cache = {};
    this._rollIndex = 0;
    this._rollTick = 0;
    this._centerTimer = 0;
    this._subTimer = 0;

    this.mapCtx = this.el.minimap.getContext('2d');
    this.mapSize = this.el.minimap.width;
    this._pt = { x: 0, y: 0 };
    this._buildMinimapBackground();
  }

  show(v) {
    this.root.classList.toggle('hidden', !v);
  }

  /** Balloon Battle: the lap counter shows your balloons and the clock counts down. */
  setBattle(on) {
    this.battle = on;
    $('hud-lap-label').textContent = on ? '🎈' : 'LAP';
    $('hud-laps-wrap').classList.toggle('hidden', on);
    this._cache.lap = null;
  }

  _set(key, el, value, prop = 'textContent') {
    if (this._cache[key] === value) return;
    this._cache[key] = value;
    el[prop] = value;
  }

  /** Call after the track is regenerated. */
  rebuildMinimap() {
    this._buildMinimapBackground();
  }

  _buildMinimapBackground() {
    const size = this.mapSize, pad = 16;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const tr = this.track;
    const p = this._pt;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const path = () => {
      ctx.beginPath();
      for (let i = 0; i <= tr.samples; i += 3) {
        tr.toMinimap(tr.px[i % tr.samples], tr.pz[i % tr.samples], size, pad, p);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
    };
    path(); ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 11; ctx.stroke();
    path(); ctx.strokeStyle = '#3b3f46'; ctx.lineWidth = 7; ctx.stroke();
    // Shortcuts as dashed dirt lines.
    for (const sc of tr.shortcuts || []) {
      ctx.beginPath();
      tr.toMinimap(sc.ax + sc.ux * sc.dStart, sc.az + sc.uz * sc.dStart, size, pad, p);
      ctx.moveTo(p.x, p.y);
      tr.toMinimap(sc.ax + sc.ux * sc.dEnd, sc.az + sc.uz * sc.dEnd, size, pad, p);
      ctx.lineTo(p.x, p.y);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = '#d19a5b';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // start line
    tr.toMinimap(tr.px[0], tr.pz[0], size, pad, p);
    ctx.fillStyle = '#ffd23f';
    ctx.fillRect(p.x - 4, p.y - 4, 8, 8);
    this.mapBg = c;
  }

  drawMinimap(karts, localKart) {
    const ctx = this.mapCtx, size = this.mapSize, pad = 16;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(this.mapBg, 0, 0);
    const p = this._pt;
    // draw others first so the player's dot sits on top
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < karts.length; i++) {
        const k = karts[i];
        const isLocal = k === localKart;
        if ((pass === 0) === isLocal) continue;
        this.track.toMinimap(k.renderX, k.renderZ, size, pad, p);
        ctx.beginPath();
        ctx.arc(p.x, p.y, isLocal ? 7 : 5, 0, Math.PI * 2);
        ctx.fillStyle = '#' + k.color.toString(16).padStart(6, '0');
        ctx.fill();
        ctx.lineWidth = isLocal ? 3 : 2;
        ctx.strokeStyle = isLocal ? '#fff' : 'rgba(0,0,0,0.6)';
        ctx.stroke();
      }
    }
  }

  update(dt, { kart, standings, raceTime, stats }) {
    const el = this.el;
    const megaVisible = kart.megaTimer > 0;
    if (this._cache.megaVis !== megaVisible) {
      this._cache.megaVis = megaVisible;
      el.mega.classList.toggle('hidden', !megaVisible);
    }
    if (megaVisible) this._set('megaN', el.megaN, `${Math.ceil(kart.megaTimer)}s`);
    const total = standings.length;

    this._set('pos', el.pos, String(kart.rank));
    this._set('posSuffix', el.posSuffix, ordinal(kart.rank).replace(/^\d+/, ''));
    this._set('posTotal', el.posTotal, `/ ${total}`);
    const lap = this.battle ? Math.max(0, kart.balloons || 0) : kart.finished ? TOTAL_LAPS : kart.displayLap;
    this._set('lap', el.lap, String(lap));
    this._set('time', el.time, formatTime(this.battle ? Math.max(0, BATTLE_MS - raceTime) : kart.finished ? kart.finishTime : raceTime));
    this._set('lastLap', el.lastLap, kart.bestLapTime ? `BEST ${formatTime(kart.bestLapTime)}` : '');
    this._set('coins', el.coins, String(kart.coins));

    // Leaderboard (names change rarely; build a key to avoid churn)
    let key = '';
    for (let i = 0; i < standings.length; i++) key += standings[i].slot + (standings[i] === kart ? '*' : '') + ',';
    if (this._cache.board !== key) {
      this._cache.board = key;
      el.board.innerHTML = standings.map((k, i) => {
        const me = k === kart;
        const color = '#' + k.color.toString(16).padStart(6, '0');
        return `<li class="flex items-center gap-2 rounded-lg px-2 py-0.5 ${me ? 'bg-white/25' : 'bg-black/30'}">
          <b class="w-5 text-right tabular-nums">${i + 1}</b>
          <span class="h-2.5 w-2.5 rounded-full" style="background:${color}"></span>
          <span class="max-w-28 truncate ${me ? 'font-extrabold' : 'font-medium text-white/85'}">${escapeHtml(k.name)}</span></li>`;
      }).join('');
    }

    // Speedometer (km/h, arc = 75% of circle)
    const kmh = Math.round(Math.abs(kart.speed) * 3.6);
    this._set('speed', el.speed, String(kmh));
    const frac = Math.min(1, Math.abs(kart.speed) / (KART.maxSpeed * KART.boostMultiplier));
    const dash = `${(frac * 216.8).toFixed(1)} 289`;
    if (this._cache.arc !== dash) {
      this._cache.arc = dash;
      el.speedArc.setAttribute('stroke-dasharray', dash);
    }

    // Drift charge bar, coloured by the mini-turbo tier reached
    const tier = kart.drifting ? kart.driftTier : 0;
    const maxCharge = DRIFT_TIERS[DRIFT_TIERS.length - 1].charge;
    const pct = kart.drifting ? Math.min(100, (kart.driftCharge / maxCharge) * 100) : 0;
    this._set('driftW', el.drift.style, `${pct.toFixed(0)}%`, 'width');
    const tierColor = tier > 0 ? '#' + DRIFT_TIERS[tier].color.toString(16).padStart(6, '0') : '#ffffff';
    this._set('driftC', el.drift.style, tierColor, 'background');

    // Item slot with roulette
    if (kart.rollTimer > 0) {
      this._rollTick -= dt;
      if (this._rollTick <= 0) {
        this._rollTick = 0.08;
        this._rollIndex = (this._rollIndex + 1) % ROLL_ORDER.length;
        this._cache.item = -1;
        el.itemIcon.innerHTML = ICONS[ROLL_ORDER[this._rollIndex]];
        el.item.classList.remove('rolling');
        void el.item.offsetWidth;
        el.item.classList.add('rolling');
      }
    } else if (this._cache.item !== kart.item) {
      this._cache.item = kart.item;
      el.itemIcon.innerHTML = ICONS[kart.item] || '';
      el.item.classList.remove('rolling');
    }
    // Triple mushroom charges badge.
    if (!this._usesEl) {
      this._usesEl = document.createElement('span');
      this._usesEl.className = 'absolute -bottom-2 -right-2 rounded-full bg-amber-300 px-2 text-sm font-black text-[#1b1400] shadow';
      el.item.style.position = 'relative';
      el.item.appendChild(this._usesEl);
    }
    const uses = kart.item === ITEM.TRIPLE && kart.rollTimer <= 0 ? `×${kart.itemUses}` : '';
    this._set('uses', this._usesEl, uses);
    this._usesEl.style.display = uses ? '' : 'none';

    if (this._centerTimer > 0) {
      this._centerTimer -= dt;
      if (this._centerTimer <= 0) this._set('center', el.center, '');
    }
    if (this._subTimer > 0) {
      this._subTimer -= dt;
      if (this._subTimer <= 0) this._set('sub', el.sub, '');
    }
    if (stats) this._set('stats', el.stats, stats);
  }

  /** Big centre text (countdown, FINAL LAP, …). duration 0 = persistent. */
  flash(text, duration = 1.2, color = '#ffffff') {
    const el = this.el.center;
    this._cache.center = text;
    el.textContent = text;
    el.style.color = color;
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
    this._centerTimer = duration;
  }

  subtitle(text, duration = 2) {
    this._cache.sub = text;
    this.el.sub.textContent = text;
    this._subTimer = duration;
  }

  clearCenter() {
    this._set('center', this.el.center, '');
    this._set('sub', this.el.sub, '');
    this._centerTimer = 0;
    this._subTimer = 0;
  }

  resetCache() {
    this._cache = {};
  }
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

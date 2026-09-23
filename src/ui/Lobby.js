import { createIcons, Gauge, Zap, RotateCw, Flame } from 'lucide';
import { UPGRADES, MAX_LEVEL } from '../game/Upgrades.js';
import { PART_SLOTS, PAINTS } from '../game/Cosmetics.js';

const ICONS = { Gauge, Zap, RotateCw, Flame };
import { KART_COLORS, MAX_KARTS } from '../game/constants.js';
import { formatTime } from '../game/RaceManager.js';
import { escapeHtml } from './HUD.js';

const $ = (id) => document.getElementById(id);
const NAME_KEY = 'mkbros:name';

function loadName() {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
}
function saveName(n) {
  try { localStorage.setItem(NAME_KEY, n); } catch { /* storage unavailable */ }
}
const hex = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0');
const colorOf = (slot) => '#' + KART_COLORS[slot % KART_COLORS.length].toString(16).padStart(6, '0');

/** Main menu + P2P lobby screen. */
export class Lobby {
  constructor(handlers) {
    this.h = handlers;
    this.root = $('menu');
    this.main = $('menu-main');
    this.room = $('menu-room');
    this.status = $('menu-status');
    this.nameInput = $('name-input');
    this.joinInput = $('join-input');
    this.buttons = ['btn-solo', 'btn-host', 'btn-join', 'btn-start', 'btn-leave'].map($);

    this.nameInput.value = loadName() || `Racer${Math.floor(100 + Math.random() * 900)}`;
    const params = new URLSearchParams(window.location.search);
    const room = params.get('room');
    if (room) this.joinInput.value = room.toUpperCase().slice(0, 6);

    $('btn-solo').addEventListener('click', () => this.h.onSolo(this.name));
    $('btn-host').addEventListener('click', () => this.h.onHost(this.name));
    $('btn-join').addEventListener('click', () => this._join());
    this.joinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._join(); });
    this.joinInput.addEventListener('input', () => {
      this.joinInput.value = this.joinInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
    $('btn-start').addEventListener('click', () => this.h.onStart());
    $('btn-ready').addEventListener('click', () => this.h.onReady());
    $('cpu-minus').addEventListener('click', () => this.h.onCpu(-1));
    $('cpu-plus').addEventListener('click', () => this.h.onCpu(1));
    $('btn-leave').addEventListener('click', () => this.h.onLeave());
    $('btn-copy').addEventListener('click', () => this._copy());
    $('btn-room-garage').addEventListener('click', () => this.h.onGarage());
  }

  get name() {
    const n = this.nameInput.value.trim().slice(0, 16) || 'Racer';
    saveName(n);
    return n;
  }

  get pendingRoom() {
    return this.joinInput.value.trim();
  }

  _join() {
    const code = this.joinInput.value.trim().toUpperCase();
    if (code.length < 4) {
      this.setStatus('Enter the 6-character room code.', true);
      return;
    }
    this.h.onJoin(code, this.name);
  }

  async _copy() {
    const label = $('btn-copy').querySelector('span');
    try {
      await navigator.clipboard.writeText(this.link);
      label.textContent = 'Copied!';
    } catch {
      label.textContent = 'Copy failed';
    }
    setTimeout(() => { label.textContent = 'Copy link'; }, 1500);
  }

  show(v) {
    this.root.classList.toggle('hidden', !v);
    this.root.classList.toggle('grid', v);
  }

  showMain() {
    this.main.classList.remove('hidden');
    this.room.classList.add('hidden');
    this.room.classList.remove('flex');
    this.nameInput.disabled = false;
  }

  showRoom({ code, isHost, link }) {
    this.link = link;
    this.main.classList.add('hidden');
    this.room.classList.remove('hidden');
    this.room.classList.add('flex');
    this.nameInput.disabled = true;
    $('room-code').textContent = code;
    $('btn-start').classList.toggle('hidden', !isHost);
    $('cup-row').classList.toggle('hidden', !isHost);
  }

  setPlayers(players, localSlot) {
    $('player-count').textContent = `(${players.length}/${MAX_KARTS})`;
    $('player-list').innerHTML = players.map((p) => `
      <li class="flex items-center gap-3 rounded-xl bg-black/25 px-3 py-2">
        <span class="h-3 w-3 rounded-full" style="background:${p.look ? hex(p.look.color) : colorOf(p.slot)}"></span>
        <span class="flex-1 truncate font-bold">${escapeHtml(p.name)}</span>
        ${p.slot === 0 ? '<span class="text-[10px] font-black uppercase tracking-widest text-amber-300">Host</span>' : ''}
        ${p.slot === localSlot ? '<span class="text-[10px] font-black uppercase tracking-widest text-sky-300">You</span>' : ''}
        <span class="rounded-md px-2 py-0.5 text-[10px] font-black uppercase tracking-widest ${p.ready ? 'bg-emerald-400/90 text-[#062b1a]' : 'bg-white/10 text-white/45'}">${p.ready ? 'Ready' : 'Not ready'}</span>
      </li>`).join('');
    const me = players.find((p) => p.slot === localSlot);
    const readyCount = players.filter((p) => p.ready).length;
    const btn = $('btn-ready');
    btn.querySelector('span').textContent = me && me.ready ? 'Ready ✓ (click to cancel)' : 'Ready';
    btn.classList.toggle('btn-primary', !(me && me.ready));
    btn.classList.toggle('btn-secondary', !!(me && me.ready));
    $('ready-status').textContent = `${readyCount}/${players.length} ready — the race starts when everyone is ready`;
  }

  /** CPU racers row: only the host can change it; everyone sees the grid size. */
  setCpu(count, isHost, humans) {
    $('cpu-count').textContent = String(count);
    $('cpu-minus').classList.toggle('hidden', !isHost);
    $('cpu-plus').classList.toggle('hidden', !isHost);
    $('cpu-minus').disabled = count <= 0;
    $('cpu-plus').disabled = humans + count >= MAX_KARTS;
    $('cpu-hint').textContent = `Fill empty slots · grid: ${humans} player${humans === 1 ? '' : 's'} + ${count} CPU`;
  }

  setStatus(text, isError = false) {
    this.status.textContent = text || '';
    this.status.classList.toggle('text-rose-300', isError);
    this.status.classList.toggle('text-white/70', !isError);
  }

  setBusy(busy) {
    for (const b of this.buttons) b.disabled = busy;
  }
}

/** End-of-race results overlay. */
export class Results {
  constructor({ onAgain, onMenu, onGarage, onForceStart }) {
    this.root = $('results');
    this.list = $('results-list');
    this.note = $('results-note');
    this.again = $('btn-again');
    this.again.addEventListener('click', onAgain);
    $('btn-menu').addEventListener('click', onMenu);
    $('btn-results-garage').addEventListener('click', onGarage);
    $('btn-results-start').addEventListener('click', onForceStart);
  }

  show(v) {
    this.root.classList.toggle('hidden', !v);
    this.root.classList.toggle('grid', v);
  }

  get visible() {
    return !this.root.classList.contains('hidden');
  }

  /** entries: [{ slot, name, time|null }] in finishing order; localSlot highlights the player. */
  render(entries, localSlot, { canRestart, note, ready = null, againLabel = null }) {
    this.list.innerHTML = entries.map((e, i) => {
      const me = e.slot === localSlot;
      return `<li class="flex items-center gap-3 rounded-xl px-3 py-2 ${me ? 'bg-amber-300/20 ring-2 ring-amber-300/60' : 'bg-black/25'}">
        <b class="title w-8 text-2xl">${i + 1}</b>
        <span class="h-3 w-3 rounded-full" style="background:${e.color != null ? hex(e.color) : colorOf(e.slot)}"></span>
        <span class="flex-1 truncate font-bold">${escapeHtml(e.name)}</span>
        <span class="font-mono text-sm tabular-nums ${e.time == null ? 'text-white/40' : ''}">${e.time == null ? (e.dnf ? 'DNF' : 'racing…') : formatTime(e.time)}</span>
      </li>`;
    }).join('');
    this.note.textContent = note || '';
    const label = this.again.querySelector('span');
    const readyText = $('results-ready');
    const force = $('btn-results-start');
    if (ready) {
      // Multiplayer: everyone readies up; the host can also skip the wait.
      this.again.classList.remove('hidden');
      this.again.disabled = !ready.canReady;
      label.textContent = ready.me ? 'Ready ✓ (click to cancel)' : 'Ready for next race';
      this.again.classList.toggle('btn-primary', !ready.me);
      this.again.classList.toggle('btn-secondary', ready.me);
      readyText.classList.remove('hidden');
      readyText.textContent = ready.canReady
        ? `${ready.count}/${ready.total} ready — next race starts when everyone is ready`
        : 'Ready-up opens when the race is over';
      force.classList.toggle('hidden', !ready.isHost || !ready.canReady);
    } else {
      this.again.disabled = false;
      label.textContent = againLabel || 'Next Race · New Track';
      this.again.classList.add('btn-primary');
      this.again.classList.remove('btn-secondary');
      this.again.classList.toggle('hidden', !canRestart);
      readyText.classList.add('hidden');
      force.classList.add('hidden');
    }
  }
}

/**
 * Garage overlay: Performance tab (upgrades + Mega charges) and Style tab (body, spoiler,
 * wheels, headgear, paint). Locked style parts are bought with coins on first click.
 */
export class GarageUI {
  constructor(garage, { onChange, onClose }) {
    this.garage = garage;
    this.onChange = onChange;
    this.root = $('garage');
    this.perf = $('garage-perf');
    this.style = $('garage-style');
    this.earned = $('garage-earned');
    this.tab = 'perf';
    this.allowPerf = true;
    this.preview = null; // { slot, part } being tried on but not owned yet
    this.buyBar = $('garage-buybar');
    $('btn-garage-buy').addEventListener('click', () => {
      const pv = this.preview;
      if (pv && this.garage.equip(pv.slot, pv.part)) {
        this.preview = null;
        this._changed();
      }
    });

    for (const t of document.querySelectorAll('.garage-tab')) {
      t.addEventListener('click', () => this.setTab(t.dataset.tab));
    }
    $('btn-garage-done').addEventListener('click', onClose);
    this.perf.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-up]');
      if (!btn) return;
      if (this.garage.buy(btn.dataset.up)) this._changed();
    });
    this.style.addEventListener('click', (e) => {
      const part = e.target.closest('button[data-slot]');
      if (part) {
        const slot = PART_SLOTS.find((s) => s.key === part.dataset.slot);
        const item = slot && slot.list.find((p) => p.id === part.dataset.id);
        if (!item) return;
        if (this.garage.isOwned(slot.key, item.id)) {
          this.garage.equip(slot.key, item); // owned: equip straight away
          this.preview = null;
          this._changed();
        } else {
          this.preview = { slot: slot.key, part: item }; // not owned: try it on first
          this.render();
        }
        return;
      }
      const sw = e.target.closest('button[data-paint]');
      if (sw) {
        this.garage.setPaint(sw.dataset.paint, Number(sw.dataset.hex));
        this._changed();
      }
    });
  }

  _changed() {
    this.render();
    if (this.onChange) this.onChange();
  }

  /** `perf` = false hides the performance tab (e.g. from the main menu, before any round). */
  open({ tab, perf = true } = {}) {
    this.allowPerf = perf;
    this.setTab(tab || (perf ? this.tab : 'style'));
    this.root.classList.remove('hidden');
    this.root.classList.add('flex');
  }

  close() {
    this.preview = null;
    this.root.classList.add('hidden');
    this.root.classList.remove('flex');
  }

  get visible() {
    return !this.root.classList.contains('hidden');
  }

  setTab(tab) {
    if (tab === 'perf' && !this.allowPerf) tab = 'style';
    this.tab = tab;
    for (const t of document.querySelectorAll('.garage-tab')) {
      const active = t.dataset.tab === tab;
      t.classList.toggle('bg-sky-500', active);
      t.classList.toggle('text-white', active);
      t.classList.toggle('text-white/50', !active);
      t.classList.toggle('hidden', t.dataset.tab === 'perf' && !this.allowPerf);
    }
    this.perf.classList.toggle('hidden', tab !== 'perf');
    this.style.classList.toggle('hidden', tab !== 'style');
    this.style.classList.toggle('flex', tab === 'style');
    this.render();
  }

  setEarned(text) {
    this.earned.textContent = text || '';
  }

  /** Look shown on the showroom kart: the equipped look plus any part being previewed. */
  get displayLook() {
    const pv = this.preview;
    return pv ? { ...this.garage.look, [pv.slot]: pv.part.id } : this.garage.look;
  }

  _renderBuyBar() {
    const pv = this.tab === 'style' ? this.preview : null;
    this.buyBar.classList.toggle('hidden', !pv);
    this.buyBar.classList.toggle('flex', !!pv);
    if (!pv) return;
    const g = this.garage;
    const short = pv.part.price - g.wallet;
    $('garage-buy-name').textContent = pv.part.name;
    const btn = $('btn-garage-buy');
    btn.disabled = short > 0;
    btn.innerHTML = short > 0
      ? `Need ${short} more`
      : `Buy <span class="coin"></span>${pv.part.price}`;
  }

  render() {
    const g = this.garage;
    for (const el of document.querySelectorAll('.wallet-amount')) el.textContent = String(g.wallet);
    this._renderBuyBar();
    if (this.tab === 'perf') this._renderPerf();
    else this._renderStyle();
  }

  _renderPerf() {
    const g = this.garage;
    const rows = UPGRADES.map((u) => {
      const lvl = g.levels[u.id];
      const maxed = lvl >= MAX_LEVEL;
      const pips = Array.from({ length: MAX_LEVEL }, (_, i) =>
        `<span class="h-2 w-3 rounded-full ${i < lvl ? 'bg-sky-400' : 'bg-white/15'}"></span>`).join('');
      return this._row(u.icon, u.name, u.desc, pips, u.id, maxed ? 'MAX' : g.cost(u.id), !maxed && g.canBuy(u.id));
    });
    this.perf.innerHTML = rows.join('');
    createIcons({ icons: ICONS, root: this.perf });
  }

  _row(icon, name, desc, pips, id, cost, enabled) {
    const label = typeof cost === 'number' ? `<span class="coin"></span>${cost}` : cost;
    return `<li class="flex items-center gap-3 rounded-xl bg-black/25 px-3 py-2.5">
      <div class="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-sky-500/20 text-sky-300"><i data-lucide="${icon}" class="h-5 w-5"></i></div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center justify-between gap-2"><b class="truncate">${name}</b><span class="flex gap-1">${pips}</span></div>
        <p class="text-xs text-white/50">${desc}</p>
      </div>
      <button data-up="${id}" class="btn ${typeof cost === 'number' ? 'btn-primary' : 'btn-ghost'} shrink-0 px-3 py-2 text-sm" ${enabled ? '' : 'disabled'}>${label}</button>
    </li>`;
  }

  _renderStyle() {
    const g = this.garage;
    const sections = PART_SLOTS.map((slot) => {
      const chips = slot.list.map((p) => {
        const equipped = g.look[slot.key] === p.id;
        const owned = g.isOwned(slot.key, p.id);
        const previewing = this.preview && this.preview.slot === slot.key && this.preview.part.id === p.id;
        const cls = previewing
          ? 'bg-amber-300/30 text-amber-50 ring-2 ring-amber-300'
          : equipped ? 'bg-sky-500 text-white ring-2 ring-sky-300'
          : owned ? 'bg-white/10 hover:bg-white/20' : 'bg-amber-300/10 text-amber-100/80 hover:bg-amber-300/20';
        const price = owned ? '' : `<span class="ml-1 inline-flex items-center gap-1 text-xs"><span class="coin h-3 w-3"></span>${p.price}</span>`;
        return `<button data-slot="${slot.key}" data-id="${p.id}" class="rounded-lg px-3 py-2 text-sm font-bold transition ${cls}">${p.name}${price}</button>`;
      }).join('');
      return `<section><p class="mb-1.5 text-xs font-bold uppercase tracking-widest text-white/50">${slot.label}</p><div class="flex flex-wrap gap-1.5">${chips}</div></section>`;
    });
    const paints = [['color', 'Paint'], ['accent', 'Accent (spoiler & helmet)']];
    for (const [key, label] of paints) {
      const sw = PAINTS.map((hex) => {
        const on = g.look[key] === hex;
        const css = '#' + hex.toString(16).padStart(6, '0');
        return `<button data-paint="${key}" data-hex="${hex}" aria-label="${label} ${css}" class="h-8 w-8 rounded-full border-2 ${on ? 'border-white ring-2 ring-sky-400' : 'border-white/20'}" style="background:${css}"></button>`;
      }).join('');
      sections.push(`<section><p class="mb-1.5 text-xs font-bold uppercase tracking-widest text-white/50">${label}</p><div class="flex flex-wrap gap-1.5">${sw}</div></section>`);
    }
    this.style.innerHTML = sections.join('');
  }
}

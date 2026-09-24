import './style.css';
import * as THREE from 'three';
import { createIcons, Flag, Users, Gamepad2, LogIn, Trophy, RotateCcw, Link, LoaderCircle, House, Wrench, Check, Medal, Eye, ChevronLeft, ChevronRight, Timer, Settings as SettingsIcon } from 'lucide';

import { Renderer } from './engine/Renderer.js';
import { Physics } from './engine/Physics.js';
import { Particles } from './engine/Particles.js';
import { Audio } from './engine/Audio.js';
import { Track } from './game/Track.js';
import { Kart, FLAG } from './game/Kart.js';
import { KartRenderer } from './game/KartRenderer.js';
import { ItemSystem } from './game/ItemSystem.js';
import { Input, PAD } from './game/Input.js';
import { PadNav } from './ui/PadNav.js';
import { AIDriver } from './game/AIDriver.js';
import { RaceManager, formatTime, ordinal } from './game/RaceManager.js';
import { Garage, botLevels, modsFromLevels, PLACEMENT_BONUS } from './game/Upgrades.js';
import { randomLook, sanitizeLook } from './game/Cosmetics.js';
import { NetworkManager } from './network/NetworkManager.js';
import { Interpolator } from './network/Interpolator.js';
import { PacketWriter, KartRecord, readPacket, PKT_CLIENT_STATE, PKT_SNAPSHOT } from './network/Protocol.js';
import { HUD } from './ui/HUD.js';
import { Lobby, Results, GarageUI } from './ui/Lobby.js';
import { Settings } from './ui/Settings.js';
import { PodiumCeremony } from './game/Podium.js';
import { FinishFlag } from './ui/FinishFlag.js';
import { Movers } from './game/Movers.js';
import { Weather } from './engine/Weather.js';
import { Records, seedToCode, codeToSeed } from './game/Records.js';
import { GhostRecorder, GhostKart, saveGhost, loadGhost } from './game/Ghost.js';
import { Cup, CUP_RACES } from './game/Cup.js';
import { Balloons } from './game/Balloons.js';
import { Emotes } from './ui/Emotes.js';
import { TouchControls } from './ui/Touch.js';
import { StatsPanel } from './ui/StatsPanel.js';
import {
  MAX_KARTS, TOTAL_LAPS, SOLO_BOTS, NET_TICK_HZ, KART, CPU_NAMES, ITEM, BATTLE_MS, BALLOONS,
} from './game/constants.js';

const COUNTDOWN_MS = 3600;
const RACE_TIMEOUT_AFTER_FIRST_MS = 30000; // stragglers get a DNF this long after the first human finishes
const ITEM_EVENTS = new Set(['box', 'coin', 'spawn', 'hit', 'despawn', 'zap', 'pad', 'slip', 'cloud', 'steal', 'blast', 'horn']);
const randomSeed = () => (Math.random() * 0xffffffff) >>> 0;
const SHOWROOM = { x: 0, y: 400, z: 0 }; // garage podium floats high above the map

class Game {
  constructor(physics) {
    this.physics = physics;
    this.renderer = new Renderer(document.getElementById('game'));
    this.particles = new Particles(this.renderer, 700);
    this.track = new Track(this.renderer, physics, randomSeed());
    this.kartRenderer = new KartRenderer(this.renderer, this.particles);
    this.items = new ItemSystem({ renderer: this.renderer, physics, track: this.track, particles: this.particles });
    this.input = new Input();
    this.race = new RaceManager(this.track);
    this.hud = new HUD(this.track);
    this.net = new NetworkManager();
    this.audio = new Audio();
    this._sfxState = { rolling: false, coins: 0, boost: false, mega: false, countdown: false };
    this.settings = new Settings(this.audio);
    this.settings.renderer = this.renderer;
    this.records = new Records();
    this.statsPanel = new StatsPanel(this.records);
    this.emotes = new Emotes((i) => this.sendEmote(i));
    this.touch = new TouchControls(this.input);
    this.spectating = false;
    this.spectateSlot = -1;
    // Controller: menus via PadNav, Start = settings, D-pad = emotes, rumble on hits.
    this.padNav = new PadNav({ onBack: (layer) => this._padBack(layer) });
    this.input.onPad = (button, repeat) => this._onPad(button, repeat);
    window.addEventListener('gamepadconnected', (e) => {
      this.toast(`🎮 ${e.gamepad.id.split('(')[0].trim() || 'Controller'} connected: A/RT gas · B/LT brake · RB drift · X item · Start menu`);
    });
    this.ghostKart = new GhostKart(this.renderer);
    this.ghostRec = new GhostRecorder();
    this.ghost = null;
    document.getElementById('btn-trial').addEventListener('click', () => this.startTrial(this.lobby.name));
    document.getElementById('btn-cup').addEventListener('click', () => this.startCup(this.lobby.name));
    document.getElementById('btn-battle').addEventListener('click', () => this.startBattle(this.lobby.name));
    // Grand Prix and Balloon Battle are either/or in a room.
    document.getElementById('cup-toggle').addEventListener('change', (e) => { if (e.target.checked) document.getElementById('battle-toggle').checked = false; });
    document.getElementById('battle-toggle').addEventListener('change', (e) => { if (e.target.checked) document.getElementById('cup-toggle').checked = false; });
    this.battle = false;
    this.balloons = new Balloons(this.renderer, this.particles);
    this.cup = null; // Grand Prix in progress (solo / host)
    this.cupView = null; // { race, table } shown to everyone
    document.getElementById('btn-copy-code').addEventListener('click', () => {
      const code = seedToCode(this.track.seed);
      navigator.clipboard?.writeText(code).catch(() => {});
      this.toast(`Track code ${code} copied: paste it in the menu to race this track again`);
    });
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.code === 'KeyM') {
        this.toast(this.audio.toggleMute() ? 'Sound off (M)' : 'Sound on (M)');
        if (this.settings.visible) this.settings.refresh();
      } else if (e.code === 'Escape') {
        this.settings.toggle();
      } else if (/^Digit[1-4]$/.test(e.code)) {
        this.sendEmote(Number(e.code.slice(5)) - 1);
      } else if (this.spectating && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
        this._cycleSpectate(e.code === 'ArrowRight' ? 1 : -1);
      } else if (e.code === 'Tab' && this._canSpectate()) {
        e.preventDefault();
        if (this.spectating) this._stopSpectate(true);
        else this._startSpectate();
      }
    });
    document.getElementById('btn-spectate').addEventListener('click', () => this._startSpectate());
    document.getElementById('spec-prev').addEventListener('click', () => this._cycleSpectate(-1));
    document.getElementById('spec-next').addEventListener('click', () => this._cycleSpectate(1));
    document.getElementById('spec-results').addEventListener('click', () => this._stopSpectate(true));

    this.mode = 'menu'; // menu | solo | host | client
    this.round = 0;
    this.banked = false;
    this.garage = new Garage();
    this.garageUI = new GarageUI(this.garage, {
      onChange: () => this._onGarageChange(),
      onClose: () => this.closeGarage(),
    });
    this.inRace = false;
    this.karts = [];
    this.kartBySlot = new Array(MAX_KARTS).fill(null);
    this.bots = [];
    this.localKart = null;

    this.interp = Array.from({ length: MAX_KARTS }, () => new Interpolator());
    this.latest = Array.from({ length: MAX_KARTS }, () => new KartRecord());
    this.writer = new PacketWriter();
    this._rec = new KartRecord();
    this.netAccumulator = 0;

    this.now = performance.now();
    this.lastFrame = this.now;
    this.firstFinishAt = 0;
    this.lastCountdown = -1;
    this.resultsTimer = 0;
    this._fpsFrames = 0;
    this._fpsTime = 0;
    this._stats = '';

    this._wireItems();
    this._wireRace();
    this._wireNetwork();

    this.lobby = new Lobby({
      onSolo: (name) => this.startSolo(name),
      onHost: (name) => this.hostRoom(name),
      onJoin: (code, name) => this.joinRoom(code, name),
      onStart: () => this.startHostRace(),
      onReady: () => this.toggleReady(),
      onCpu: (d) => { if (this.mode === 'host') this.net.setCpuWanted(this.net.cpuCount + d); },
      onLeave: () => this.toMenu(),
      onGarage: () => this.openGarage(),
    });
    this.results = new Results({
      onAgain: () => this.raceAgain(),
      onForceStart: () => this.startHostRace(),
      onMenu: () => this.toMenu(),
      onGarage: () => this.openGarage(),
    });
    this._buildShowroom();
    this.podium = new PodiumCeremony(this.renderer, this.particles, this.audio, () => this._podiumDone());
    this.finishFlag = new FinishFlag();
    this.movers = new Movers(this.renderer, this.particles);
    this.movers.setTrack(this.track);
    this.weather = new Weather(this.renderer);
    this.weather.set(this.track.weather);

    // Fixed-step callbacks are created once so the frame loop never allocates closures.
    this._pre = (dt) => this._fixedPre(dt);
    this._post = (dt) => this._fixedPost(dt);
    this._frame = (t) => this.frame(t);

    this.lobby.show(true);
    if (this.lobby.pendingRoom) this.lobby.setStatus('Room link detected — press Join to hop in.');
    this.audio.playMenu(); // starts on the first click/keypress (browser autoplay rules)
    requestAnimationFrame(this._frame);
  }

  // =================================================================== wiring

  _wireItems() {
    const items = this.items;
    items.getKart = (slot) => this.kartBySlot[slot];
    items.getKarts = () => this.karts;
    items.onLocalEffect = (k, kind) => {
      if (k !== this.localKart) return;
      const text = { slip: 'Oil slick!', confused: 'Storm cloud! Steering reversed', robbed: 'Your item was stolen!', stole: 'Stole an item!' }[kind];
      if (text) this.hud.subtitle(text, 1.6);
      if (kind === 'slip' || kind === 'confused') this.renderer.addShake(0.4);
      this.audio.blip(kind === 'stole' ? 'shield' : kind === 'robbed' ? 'hit' : 'zap');
    };
    items.onZap = (slot) => {
      this.audio.blip('zap');
      const lk = this.localKart;
      if (lk && lk.slot !== slot) {
        this.renderer.addShake(0.7);
        this.hud.flash(lk.shrinkTimer > 0 ? 'ZAPPED!' : 'BLOCKED!', 1.1, '#ffd23f');
      }
    };
    items.onEvent = (msg) => { if (this.mode === 'host') this.net.broadcast(msg); };
    items.onRequest = (msg) => this.net.send(msg);
    items.onBlast = (x, z) => {
      this.audio.blip('hit');
      const lk = this.localKart;
      if (lk) {
        const d = Math.hypot(lk.x - x, lk.z - z);
        if (d < 40) this.renderer.addShake(Math.max(0.2, 1 - d / 40));
      }
    };
    items.onHorn = (slot) => {
      this.audio.blip('horn');
      if (this.localKart && this.localKart.slot === slot) this.renderer.addShake(0.4);
    };
    items.onLocalHit = (k) => {
      if (k === this.localKart) {
        this.audio.blip('hit');
        this.renderer.addShake(0.9);
        this.hud.subtitle('Spun out!', 1.2);
      }
    };
  }

  _wireRace() {
    this.race.onLap = (k, lapTime) => {
      if (k !== this.localKart) return;
      if (k.lap === TOTAL_LAPS - 1) this.hud.flash('Final Lap!', 1.6, '#ffd23f');
      const rec = this.records.submitLap(this.track.seed, this.track.name, lapTime);
      if (this.mode === 'trial') {
        const n = this.ghostRec.laps.push(lapTime);
        const g = this.ghost?.laps[n - 1];
        if (g) {
          const diff = (lapTime - g) / 1000;
          this.hud.subtitle(`Lap ${formatTime(lapTime)} · ${diff <= 0 ? '−' : '+'}${Math.abs(diff).toFixed(2)}s vs ghost`, 2.6);
          return;
        }
      }
      if (rec === 'record') {
        this.hud.subtitle(`Lap ${formatTime(lapTime)} · New lap record!`, 2.6);
        this.audio.blip('trick');
      } else {
        this.hud.subtitle(`Lap ${formatTime(lapTime)}`, 2.2);
      }
    };
    this.race.onFinish = (k) => this._onKartFinished(k);
  }

  _wireNetwork() {
    const net = this.net;
    net.on('roster', (players) => {
      this.lobby.setPlayers(players, net.localSlot);
      this.lobby.setCpu(net.cpuCount, this.mode === 'host' || net.isHost, players.length);
      if (this.results.visible) this._refreshResults();
      this._maybeAutoStart();
      if (this.inRace) {
        // Drop karts whose drivers left mid-race.
        const present = new Set(players.map((p) => p.slot));
        for (const k of [...this.karts]) if (k.control === 'remote' && !k.isCpu && !present.has(k.slot)) this._removeKart(k.slot);
      }
    });
    net.on('peer-left', (slot) => {
      const k = this.kartBySlot[slot];
      if (k) this.toast(`${k.name} left the race`);
      this._removeKart(slot);
    });
    net.on('disconnected', (reason) => {
      this.toMenu();
      this.lobby.setStatus(reason, true);
    });
    net.on('error', (err) => console.warn('[net]', err));
    net.on('state', (buf, fromSlot) => this._onStatePacket(buf, fromSlot));
    net.on('message', (msg, fromSlot) => this._onMessage(msg, fromSlot));
  }

  // =================================================================== menu flow

  async hostRoom(name) {
    this.lobby.setBusy(true);
    this.lobby.setStatus('Creating room…');
    try {
      const code = await this.net.host(name, this.garage.look);
      this.mode = 'host';
      this.lobby.showRoom({ code, isHost: true, link: this.net.shareLink() });
      this.lobby.setPlayers(this.net.players, 0);
      this.lobby.setCpu(this.net.cpuCount, true, this.net.players.length);
      this.lobby.setStatus('Share the code or link with friends, then start the race.');
    } catch (err) {
      this.lobby.setStatus(`Couldn't create room: ${err.message || err}`, true);
      this.net.destroy();
    } finally {
      this.lobby.setBusy(false);
    }
  }

  async joinRoom(code, name) {
    this.lobby.setBusy(true);
    this.lobby.setStatus(`Connecting to ${code}…`);
    try {
      await this.net.join(code, name, this.garage.look);
      this.mode = 'client';
      this.lobby.showRoom({ code: this.net.roomCode, isHost: false, link: this.net.shareLink() });
      this.lobby.setPlayers(this.net.players, this.net.localSlot);
      this.lobby.setCpu(this.net.cpuCount, false, this.net.players.length);
      this.lobby.setStatus('');
    } catch (err) {
      this.net.destroy();
      this.mode = 'menu';
      this.lobby.setStatus(err.message || String(err), true);
    } finally {
      this.lobby.setBusy(false);
    }
  }

  toMenu() {
    this.battle = false;
    this.cup = null;
    this.cupView = null;
    this.podium.stop();
    this.finishFlag.cancel();
    clearTimeout(this._menuMusicTimer);
    this.audio.stopCountdown();
    this.audio.stopEngine();
    this.audio.playMenu(1.5);
    this.closeGarage();
    this.net.destroy();
    this._clearRace();
    this.mode = 'menu';
    // Coins, upgrades and kart style last for one room / solo session only, then reset.
    this.round = 0;
    this.garage.reset();
    this.results.show(false);
    this.hud.show(false);
    this.lobby.showMain();
    this.lobby.setStatus('');
    this.lobby.show(true);
  }

  raceAgain() {
    if (this.mode === 'host' || this.mode === 'client') {
      this.toggleReady();
      return;
    }
    if (this.mode === 'solo') this._startSoloRace(this.lobby.name);
    else if (this.mode === 'trial') this.startTrial(this.lobby.name, this.track.seed);
    else if (this.mode === 'host') this.startHostRace();
  }

  // =================================================================== race setup

  /**
   * A seed whose theme and layout family differ from the previous round's, and never a
   * figure-8 within three rounds of the last one (they're special, keep them rare).
   */
  _nextSeed() {
    const recent = this._recentStyles || (this._recentStyles = []);
    const ok = (info) => info.style !== recent[recent.length - 1] && info.theme !== this._lastTheme
      && !(info.style === 'figure8' && recent.includes('figure8'));
    let seed = randomSeed();
    for (let tries = 0; tries < 80 && !ok(Track.peek(seed)); tries++) seed = randomSeed();
    const info = Track.peek(seed);
    recent.push(info.style);
    if (recent.length > 3) recent.shift();
    this._lastTheme = info.theme;
    return seed;
  }

  startSolo(name) {
    this.battle = false;
    this.cup = null;
    this._startSoloRace(name);
  }

  startCup(name) {
    this.battle = false;
    this.cup = new Cup();
    this._startSoloRace(name);
  }

  /** Balloon Battle: three balloons each; hits pop one; the last kart with balloons wins. */
  startBattle(name) {
    this.battle = true;
    this.cup = null;
    this._startSoloRace(name);
  }

  _startSoloRace(name) {
    this.mode = 'solo';
    this._advanceCup();
    const roster = [{ slot: 0, name, control: 'local', look: this.garage.look }];
    for (let i = 1; i <= SOLO_BOTS; i++) roster.push({ slot: i, name: CPU_NAMES[i - 1], control: 'bot', look: randomLook() });
    this._setupRace(roster, COUNTDOWN_MS, this._codeSeed() ?? this._nextSeed());
  }

  /** Time trial: just you, three mushrooms, no item boxes, and your best run as a ghost. */
  startTrial(name, seed = null) {
    this.mode = 'trial';
    this.battle = false;
    this.cup = null;
    this.cupView = null;
    const s = seed ?? this._codeSeed() ?? this._nextSeed();
    this._setupRace([{ slot: 0, name, control: 'local', look: this.garage.look }], COUNTDOWN_MS, s);
    this.items.clearBoxes();
    this.localKart.setItem(ITEM.TRIPLE);
    this.ghost = loadGhost(s);
    this.ghostKart.show(!!this.ghost);
    if (this.ghost) this.ghostKart.update(0, this.ghost);
    this.ghostRec.reset();
    this._ghostSaved = false;
    this.hud.subtitle(`Time Trial · ${this.track.name}${this.ghost ? ' · Ghost ' + formatTime(this.ghost.time) : ''}`, 3.2);
  }

  /** Grand Prix bookkeeping before each race (a finished cup starts over). */
  _advanceCup() {
    if (this.mode === 'host') {
      this.battle = document.getElementById('battle-toggle').checked;
      const wanted = !this.battle && document.getElementById('cup-toggle').checked;
      if (!wanted) this.cup = null;
      else if (!this.cup || this.cup.over) this.cup = new Cup();
    } else if (this.cup && this.cup.over) {
      this.cup = new Cup();
    }
    if (this.cup) this.cup.nextRace();
    this.cupView = this.cup ? { race: this.cup.race, table: this.cup.table() } : null;
  }

  /** Race over: award Grand Prix points (solo / host); the host shares the table. */
  _scoreCup() {
    if (!this.cup || this.mode === 'client') return;
    const order = this.race.finishOrder.map((f) => f.slot);
    const finished = order.length;
    for (const k of this.race.standings) if (!order.includes(k.slot)) order.push(k.slot);
    this.cup.score(order.map((slot) => {
      const k = this.kartBySlot[slot];
      return { slot, name: k ? k.name : `Player ${slot + 1}`, look: k ? k.look : null };
    }), finished);
    this.cupView = { race: this.cup.race, table: this.cup.table() };
    if (this.mode === 'host') this.net.broadcast({ t: 'cup', race: this.cupView.race, table: this.cupView.table.map((r) => ({ slot: r.slot, name: r.name, look: r.look, points: r.points, last: r.last })) });
  }

  _renderCup() {
    const box = document.getElementById('results-cup');
    const cv = this.cupView;
    box.classList.toggle('hidden', !cv);
    if (!cv) return;
    const done = this.race.state === 'done';
    document.getElementById('results-cup-race').textContent = `Race ${cv.race}/${CUP_RACES}${done && cv.race >= CUP_RACES ? ' · Final' : ''}`;
    const me = this.localKart ? this.localKart.slot : -1;
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const rows = cv.table.length ? cv.table : this.race.standings.map((k) => ({ slot: k.slot, name: k.name, points: 0, last: 0 }));
    document.getElementById('results-cup-list').innerHTML = rows.map((r, i) => `
      <li class="flex items-center gap-3 rounded-lg px-3 py-1.5 text-sm ${r.slot === me ? 'bg-amber-300/20 ring-1 ring-amber-300/60' : 'bg-black/25'}">
        <b class="w-5 text-white/70">${i + 1}</b>
        <span class="min-w-0 flex-1 truncate font-bold">${esc(r.name)}</span>
        ${done && r.last ? `<span class="text-xs font-bold text-emerald-300">+${r.last}</span>` : ''}
        <b class="w-8 text-right tabular-nums">${r.points}</b>
      </li>`).join('');
  }

  /** Seed from the menu's track-code box (used once, then cleared). */
  _codeSeed() {
    const input = document.getElementById('track-code');
    const seed = codeToSeed(input.value);
    input.value = '';
    return seed;
  }

  startHostRace() {
    if (this.mode !== 'host') return;
    const players = this.net.players.map((p) => ({ slot: p.slot, name: p.name, look: p.slot === 0 ? this.garage.look : p.look }));
    // Fill the free slots with CPU racers; the host simulates them and streams their state.
    const used = new Set(players.map((p) => p.slot));
    const cpuNames = CPU_NAMES.slice().sort(() => Math.random() - 0.5);
    for (let slot = 0, n = 0; slot < MAX_KARTS && n < this.net.cpuCount; slot++) {
      if (used.has(slot)) continue;
      players.push({ slot, name: cpuNames[n % cpuNames.length], look: randomLook(), cpu: true });
      n++;
    }
    this.net.acceptingPlayers = false;
    clearTimeout(this._autoStart);
    this._autoStart = null;
    this.net.resetReady();
    this._advanceCup();
    const seed = this._nextSeed();
    this.net.broadcast({ t: 'start', players, countdown: COUNTDOWN_MS, seed, cup: this.cup ? this.cup.race : 0, battle: this.battle ? 1 : 0 });
    this._setupRace(players.map((p) => ({ ...p, control: p.cpu ? 'bot' : p.slot === 0 ? 'local' : 'remote' })), COUNTDOWN_MS, seed);
  }

  _startClientRace(msg) {
    const mySlot = this.net.localSlot;
    const roster = msg.players.map((p) => ({
      slot: p.slot,
      name: String(p.name).slice(0, 16),
      control: p.slot === mySlot ? 'local' : 'remote',
      look: p.slot === mySlot ? this.garage.look : sanitizeLook(p.look),
      cpu: !!p.cpu,
    })).filter((p) => p.slot >= 0 && p.slot < MAX_KARTS);
    const cupRace = msg.cup | 0;
    this.battle = !!msg.battle;
    this.cupView = cupRace ? { race: cupRace, table: cupRace > 1 && this.cupView ? this.cupView.table : [] } : null;
    this._setupRace(roster, msg.countdown, msg.seed >>> 0);
  }

  _clearRace() {
    this._stopSpectate(false);
    this.ghost = null;
    this.ghostKart.show(false);
    this.emotes.clear();
    this.touch.show(false);
    for (const k of this.karts) k.destroy();
    this.karts.length = 0;
    this.kartBySlot.fill(null);
    this.bots.length = 0;
    this.localKart = null;
    this.inRace = false;
    this.race.state = 'idle';
    this.items.reset();
    this.particles.clear();
    this.kartRenderer.update(this.karts, 0, 0);
  }

  _setupRace(roster, countdownMs, seed) {
    this.podium.stop();
    this.finishFlag.cancel();
    this.closeGarage();
    this._clearRace();
    this.round++;
    this.banked = false;
    // Every round is a brand-new circuit; all peers build the same one from the shared seed.
    this.track.generate(seed);
    this.movers.setTrack(this.track);
    this.weather.set(this.track.weather);
    this.items.syncWithTrack();
    this.hud.rebuildMinimap();
    const botMods = modsFromLevels(botLevels(this.round));
    roster.sort((a, b) => a.slot - b.slot);
    roster.forEach((entry, gridIndex) => {
      const spawn = this.track.gridSlot(gridIndex);
      const kart = new Kart({
        slot: entry.slot,
        name: entry.name,
        look: { ...sanitizeLook(entry.look) },
        control: entry.control,
        physics: this.physics,
        track: this.track,
        spawn,
      });
      kart.isCpu = !!entry.cpu || entry.control === 'bot';
      this.karts.push(kart);
      this.kartBySlot[entry.slot] = kart;
      if (entry.control === 'local') {
        this.localKart = kart;
        kart.mods = this.garage.mods;
      }
      if (entry.control === 'bot') {
        kart.mods = botMods;
        const skill = 0.35 + (entry.slot / Math.max(1, roster.length - 1)) * 0.6;
        kart.ai = new AIDriver(kart, this.track, skill);
        this.bots.push(kart);
      }
    });
    for (const it of this.interp) it.reset();
    for (const r of this.latest) r.valid = false;
    this.race.battle = this.battle;
    for (const k of this.karts) k.balloons = this.battle ? BALLOONS : null;
    if (this.battle) this.items.disableCoins();
    this.balloons.set(this.battle);
    this.hud.setBattle(this.battle);
    this._battleWarned = false;

    this.items.isAuthority = this.mode !== 'client';
    this.kartRenderer.setColors(this.karts);
    this.race.begin(performance.now(), countdownMs);
    this.audio.init();
    clearTimeout(this._menuMusicTimer);
    this.audio.stopMusic(0.6);
    this.audio.stopEngine();
    this.audio.startEngine();
    this.audio.stopCountdown();
    this._sfxState.countdown = false;
    this.firstFinishAt = 0;
    this.lastCountdown = -1;
    this.resultsTimer = 0;
    this.inRace = true;
    this.physics.accumulator = 0;

    this.lobby.show(false);
    this.results.show(false);
    this.hud.resetCache();
    this.hud.clearCenter();
    this.hud.show(true);
    const head = this.battle ? 'Balloon Battle · pop their balloons!' : this.cupView ? `Grand Prix · Race ${this.cupView.race}/${CUP_RACES}` : `Round ${this.round}`;
    this.hud.subtitle(`${head} · ${this.track.name}${this.track.moodLabel ? ' · ' + this.track.moodLabel : ''}`, 3.2);
    document.getElementById('results-track').textContent = `Round ${this.round} · ${this.track.name} · Track code ${seedToCode(seed)}`;
    const rec = this.records.track(seed);
    if (rec && rec.lap != null) setTimeout(() => { if (this.inRace && this.race.state === 'countdown') this.hud.subtitle(`Your lap record here: ${formatTime(rec.lap)}`, 2.5); }, 3300);
    this.touch.show(true);
    const lk = this.localKart;
    this.renderer.updateChaseCamera(lk.x, lk.y - 0.6, lk.z, lk.yaw, 0, false, 0, true);
  }

  _removeKart(slot) {
    const k = this.kartBySlot[slot];
    if (!k || k === this.localKart) return;
    k.destroy();
    this.kartBySlot[slot] = null;
    this.karts.splice(this.karts.indexOf(k), 1);
    this.interp[slot].reset();
    this.latest[slot].valid = false;
    this.kartRenderer.setColors(this.karts);
  }

  // =================================================================== simulation

  _fixedPre(dt) {
    const input = this.input.state;
    this._kartBumps();
    this._slipstream(dt);
    for (let i = 0; i < this.karts.length; i++) {
      const k = this.karts[i];
      if (!k.simulated) continue;
      const inp = k.control === 'bot' ? k.ai.update(dt) : input;
      k.simulate(dt, inp);
      if (k.controlsEnabled && inp.itemPressed && !k.finished) this.items.useItem(k);
      if (k.controlsEnabled && inp.respawnPressed) k.respawn();
    }
    this.input.consumeEdges();
    this.items.fixedUpdate(dt, this.karts);
  }

  /**
   * Arcade kart-vs-kart collisions. Rapier resolves the overlap, but the grip model would erase
   * the sideways push within a few frames, so each locally simulated kart also gets a decaying
   * knock-back impulse. Each peer handles its own kart, so both sides of a bump feel it.
   */
  /**
   * Slipstream: stay tucked in behind another kart (within ~14 m, nearly straight ahead) at
   * speed and you build up a draft; after about a second you get a speed boost.
   */
  _slipstream(dt) {
    const karts = this.karts;
    for (let i = 0; i < karts.length; i++) {
      const k = karts[i];
      if (!k.simulated) continue;
      let drafting = false;
      if (k.speed > 18 && k.grounded) {
        const sin = Math.sin(k.yaw), cos = Math.cos(k.yaw);
        for (let j = 0; j < karts.length; j++) {
          const o = karts[j];
          if (o === k || o.speed < 14 || o.ghostTimer > 0) continue;
          const dx = o.x - k.x, dz = o.z - k.z;
          const d = Math.hypot(dx, dz);
          if (d < 2.5 || d > 14 || Math.abs(o.y - k.y) > 3) continue;
          if ((dx * sin + dz * cos) / d > 0.97) { drafting = true; break; }
        }
      }
      k.drafting = drafting;
      if (drafting) {
        k.slipCharge += dt;
        if (k.slipCharge > 1.1) {
          k.slipCharge = 0;
          k.boostTimer = Math.max(k.boostTimer, 0.8);
          k.pendingImpulse += 3;
          if (k === this.localKart) this.hud.subtitle('Slipstream!', 1);
        }
      } else {
        k.slipCharge = Math.max(0, k.slipCharge - dt * 2);
      }
    }
  }

  _kartBumps() {
    const karts = this.karts;
    for (let i = 0; i < karts.length; i++) {
      const k = karts[i];
      if (!k.simulated || k.bumpCooldown > 0 || k.ghostTimer > 0) continue;
      for (let j = 0; j < karts.length; j++) {
        const o = karts[j];
        if (o === k || o.ghostTimer > 0) continue;
        const dx = k.x - o.x, dz = k.z - o.z;
        const reach = k.radius + o.radius + 0.15;
        const d2 = dx * dx + dz * dz;
        if (d2 > reach * reach || Math.abs(k.y - o.y) > reach) continue;
        const d = Math.sqrt(d2) || 0.001;
        const nx = dx / d, nz = dz / d;
        // Closing speed along the contact normal (positive = moving into each other).
        const closing = -((k.vx - o.vx) * nx + (k.vz - o.vz) * nz);
        const massRatio = (o.megaScale * o.megaScale) / (k.megaScale * k.megaScale);
        const speed = Math.min(KART.bumpMax, (KART.bumpMin + Math.max(0, closing) * 0.55) * Math.sqrt(massRatio));
        k.applyBump(nx, nz, speed);
        if (k === this.localKart) {
          this.audio.blip('bump');
          this.input.rumble(0.35, 0.25, 120);
          this.renderer.addShake(Math.min(0.5, speed / 30));
        }
        this.particles.burst((k.x + o.x) / 2, Math.min(k.y, o.y) + 0.4, (k.z + o.z) / 2, 6, 5, 0.35, 0.25, 0xffffff, -10);
        break;
      }
    }
  }

  _fixedPost() {
    for (let i = 0; i < this.karts.length; i++) {
      const k = this.karts[i];
      if (!k.simulated) continue;
      k.postStep();
      this.race.trackKart(k, this.now);
    }
  }

  _updateRemoteKarts(dt) {
    for (let i = 0; i < this.karts.length; i++) {
      const k = this.karts[i];
      if (k.simulated) continue;
      k.trackIdx = this.track.nearestIndex(k.x, k.z, k.trackIdx);
      k.trackLateral = this.track.lastLateral;
      const ip = this.interp[k.slot];
      if (ip.sample(this.now)) {
        const o = ip.out;
        k.setRemoteState(o.x, o.y, o.z, o.yaw, o.vx, o.vy, o.vz);
      }
      k.updateRemoteVisuals(dt);
    }
  }

  _onKartFinished(k) {
    const authority = this.mode !== 'client';
    if (authority) {
      this.race.recordFinish(k.slot, k.name, k.finishTime);
      // The DNF countdown only starts once a human finishes, so CPUs can't end a solo race early.
      if (!this.firstFinishAt && k.control !== 'bot') this.firstFinishAt = this.now;
      this._broadcastResults();
    } else {
      this.race.recordFinish(k.slot, k.name, k.finishTime);
      this.net.send({ t: 'finish', s: k.slot, time: k.finishTime });
    }
    if (k.control === 'bot' && k !== this.localKart) {
      if (this.race.finishOrder.length === 1) this._botEmote(k, 3);
      else if (Math.random() < 0.35) this._botEmote(k, 0);
    }
    if (k === this.localKart) {
      const place = this.race.finishOrder.findIndex((f) => f.slot === k.slot) + 1 || k.rank;
      const best = this.records.submitRace(this.track.seed, this.track.name, k.finishTime, place);
      if (best === 'record') setTimeout(() => this.hud.subtitle('New best time on this track!', 2.5), 3000);
      if (this.mode === 'trial' && (!this.ghost || k.finishTime < this.ghost.time)) {
        this._ghostSaved = saveGhost(this.track.seed, k.finishTime, this.ghostRec.laps, this.ghostRec.frames);
      }
      this.audio.stopMusic(0.5);
      this.audio.play('raceEnd');
      const jingle = this.audio.duration('raceEnd') || 2.7;
      clearTimeout(this._menuMusicTimer);
      this._menuMusicTimer = setTimeout(() => this.audio.playAfterRace(2.5), jingle * 1000);
      // A CPU driver takes over your kart for the cool-down laps.
      if (!k.ai) k.ai = new AIDriver(k, this.track, 0.85);
      k.control = 'bot';
      this.hud.flash(k.rank === 1 ? 'You Win!' : 'Finish!', 2.5, k.rank === 1 ? '#ffd23f' : '#ffffff');
      this.hud.subtitle(`${formatTime(k.finishTime)}`, 3);
      this.resultsTimer = 2.2;
    }
  }

  _broadcastResults() {
    if (this.mode === 'host') this.net.broadcast({ t: 'results', list: this.race.finishOrder });
    this._refreshResults();
  }

  _checkRaceOver() {
    if (this.mode === 'client' || this.race.state !== 'racing') return;
    if (this.battle) {
      const alive = this.karts.filter((k) => !k.finished).length;
      if ((this.karts.length > 1 && alive <= 1) || this.race.elapsed(this.now) >= BATTLE_MS) this._endBattle();
      return;
    }
    let all = this.karts.length > 0;
    for (const k of this.karts) if (!k.finished) { all = false; break; }
    const timedOut = this.firstFinishAt && this.now - this.firstFinishAt > RACE_TIMEOUT_AFTER_FIRST_MS;
    if (all || timedOut) this._endRace();
  }

  _endRace() {
    this.race.state = 'done';
    this._scoreCup();
    if (!this.localKart?.finished) this.audio.playAfterRace(2);
    if (this.mode === 'host') {
      this.net.broadcast({ t: 'over' });
      this.net.acceptingPlayers = true;
    }
    for (const k of this.karts) k.controlsEnabled = k === this.localKart; // your kart (CPU-driven once finished) keeps cruising
    this._startPodium();
  }

  /** Race fully finished: run the podium ceremony (top 3), then the results screen. */
  /** Race fully finished: chequered flag for everyone, then fade into the podium ceremony. */
  _startPodium() {
    if (this.podium.active || this.finishFlag.active) return;
    this._stopSpectate(false);
    this.emotes.clear();
    this.touch.show(false);
    this._bankCoins();
    this.closeGarage();
    this.results.show(false);
    this.hud.show(false);
    this.resultsTimer = 0;
    this.audio.stopEngine();
    this.finishFlag.play(() => this._beginPodium());
  }

  _beginPodium() {
    if (this.podium.active || !this.inRace) return;
    if (this.mode === 'trial') {
      this._podiumDone();
      return;
    }
    const cupFinal = this.cupView && this.cupView.race >= CUP_RACES && this.cupView.table.length;
    let entries;
    if (cupFinal) {
      entries = this.cupView.table.slice(0, 3).map((r, i) => ({ place: i + 1, name: r.name, look: this.kartBySlot[r.slot]?.look || r.look }));
    } else {
      const order = this.race.finishOrder.map((f) => f.slot);
      for (const k of this.race.standings) if (!order.includes(k.slot)) order.push(k.slot);
      entries = order.slice(0, 3).map((slot, i) => {
        const k = this.kartBySlot[slot];
        return k ? { place: i + 1, name: k.name, look: k.look } : null;
      }).filter(Boolean);
    }
    this.closeGarage();
    this.results.show(false);
    this.hud.show(false);
    this.resultsTimer = 0;
    this.podium.start(entries, cupFinal ? { title: '🏆 Grand Prix', winText: 'wins the Grand Prix!' } : {});
  }

  _podiumDone() {
    this.hud.show(true);
    this._showResults();
  }

  _showResults() {
    this._bankCoins();
    if (this.spectating) return; // watching the race; Tab / the Results button brings them back
    if (this.podium.active || this.finishFlag.active) return; // the podium shows results when it's done
    this.results.show(true);
    this._refreshResults();
  }

  /** Once per round: coins held at the end plus a placement bonus go into the garage wallet. */
  _bankCoins() {
    const k = this.localKart;
    if (this.banked || !k || this.mode === 'trial') return; // time trials are just for the clock
    this.banked = true;
    const finishIdx = this.race.finishOrder.findIndex((f) => f.slot === k.slot);
    const place = finishIdx >= 0 ? finishIdx + 1 : this.race.standings.length;
    const bonus = PLACEMENT_BONUS[Math.min(place, PLACEMENT_BONUS.length) - 1];
    this.garage.deposit(k.coins + bonus);
    this.records.addCoins(k.coins + bonus);
    this.garageUI.setEarned(`+${k.coins + bonus} coins: ${k.coins} held + ${bonus} for ${finishIdx >= 0 ? ordinal(place) : 'taking part'}`);
    this.garageUI.render();
  }

  _refreshResults() {
    if (!this.results.visible) return;
    const done = this.race.state === 'done';
    const colorOf = (slot) => this.kartBySlot[slot]?.color;
    const entries = this.race.finishOrder.map((f) => ({ slot: f.slot, name: f.name, time: f.time, color: colorOf(f.slot) }));
    const seen = new Set(entries.map((e) => e.slot));
    for (const k of this.race.standings) {
      if (!seen.has(k.slot)) entries.push({ slot: k.slot, name: k.name, time: null, dnf: done, color: k.color });
    }
    let note = '';
    let againLabel = null;
    this._renderCup();
    if (this.battle && this.mode === 'solo') againLabel = 'Next Battle';
    if (this.cup && this.mode === 'solo') againLabel = this.cup.over ? 'New Grand Prix' : `Next Race · ${this.cup.race + 1}/${CUP_RACES}`;
    if (this.mode === 'trial') {
      const rec = this.records.track(this.track.seed);
      againLabel = 'Retry · Race your ghost';
      note = rec && rec.race != null ? `Best time ${formatTime(rec.race)}${this._ghostSaved ? ' · New ghost saved!' : ''}` : '';
    }
    if (this.mode === 'client') note = done ? 'Upgrade your kart while the host starts the next race…' : 'Waiting for other racers to finish…';
    else if (!done) note = 'Other racers are still on track…';
    let ready = null;
    if (this.mode === 'host' || this.mode === 'client') {
      const players = this.net.players;
      const me = players.find((p) => p.slot === this.net.localSlot);
      ready = {
        me: !!(me && me.ready),
        count: players.filter((p) => p.ready).length,
        total: players.length,
        canReady: done,
        isHost: this.mode === 'host',
      };
      if (done) note = '';
    }
    document.getElementById('btn-spectate').classList.toggle('hidden', !this._canSpectate());
    this.results.render(entries, this.localKart ? this.localKart.slot : -1, {
      canRestart: this.mode === 'solo' || this.mode === 'host' || this.mode === 'trial',
      note,
      ready,
      againLabel,
    });
  }

  // =================================================================== emotes & spectating

  sendEmote(idx) {
    if (!this.inRace || !this.localKart || this.podium.active || this.finishFlag.active) return;
    if (this.now - (this._lastEmote || 0) < 1200) return; // no spamming
    this._lastEmote = this.now;
    this._showEmote(this.localKart.slot, idx);
    if (this.mode === 'host') this.net.broadcast({ t: 'emote', s: this.localKart.slot, e: idx });
    else if (this.mode === 'client') this.net.send({ t: 'emote', e: idx });
  }

  _showEmote(slot, idx) {
    if (!this.inRace || !this.kartBySlot[slot] || this.podium.active) return;
    this.emotes.show(slot, idx);
    this.audio.blip('emote');
  }

  /** CPU racers emote too (solo / host decide, the host shares it). */
  _botEmote(k, idx) {
    if (this.mode === 'client') return;
    this._showEmote(k.slot, idx);
    if (this.mode === 'host') this.net.broadcast({ t: 'emote', s: k.slot, e: idx });
  }

  /** Balloon Battle: each peer pops balloons for the karts it simulates. */
  _updateBattle(dt) {
    if (this.race.state !== 'racing') return;
    for (const k of this.karts) {
      if (!k.simulated || k.finished) continue;
      k.balloonGrace = Math.max(0, (k.balloonGrace || 0) - dt);
      // Any spin-out or lightning shrink costs a balloon (with a short grace period).
      const hit = (k.spinTimer > 0 && !k._wasSpin) || (k.shrinkTimer > 0 && !k._wasShrink);
      k._wasSpin = k.spinTimer > 0;
      k._wasShrink = k.shrinkTimer > 0;
      if (!hit || k.balloonGrace > 0) continue;
      k.balloons = Math.max(0, k.balloons - 1);
      k.balloonGrace = 1.5;
      if (k === this.localKart && k.balloons > 0) this.hud.subtitle(`${k.balloons} balloon${k.balloons === 1 ? '' : 's'} left!`, 1.5);
      if (k.balloons === 0) this._eliminate(k);
    }
    const left = BATTLE_MS - this.race.elapsed(this.now);
    if (!this._battleWarned && left < 30000) {
      this._battleWarned = true;
      this.hud.flash('30 seconds!', 1.5, '#ffd23f');
    }
  }

  _eliminate(k) {
    k.finished = true;
    k.finishTime = this.race.elapsed(this.now);
    k.ghostTimer = 1e9; // out of the fight: see-through and untouchable
    k.setItem(ITEM.NONE);
    if (k === this.localKart) {
      this.hud.flash('Popped!', 2, '#ff6b6b');
      this.hud.subtitle('You are out: Tab to watch the others', 3);
      if (!k.ai) k.ai = new AIDriver(k, this.track, 0.85);
      k.control = 'bot';
      this.resultsTimer = 2.2;
    } else if (this.localKart && !this.localKart.finished) {
      this.hud.subtitle(`${k.name} is out!`, 1.6);
    }
  }

  /** Survivors (most balloons first), then the eliminated, last one out first. */
  _endBattle() {
    const t = this.race.elapsed(this.now);
    const alive = this.karts.filter((k) => !k.finished).sort((a, b) => (b.balloons || 0) - (a.balloons || 0) || b.progress - a.progress);
    const out = this.karts.filter((k) => k.finished).sort((a, b) => b.finishTime - a.finishTime);
    this.race.finishOrder = [
      ...alive.map((k) => ({ slot: k.slot, name: k.name, time: t })),
      ...out.map((k) => ({ slot: k.slot, name: k.name, time: k.finishTime })),
    ];
    if (alive[0]) {
      if (alive[0] === this.localKart) this.hud.flash('You Win!', 2.5, '#ffd23f');
      else if (alive[0].control === 'bot') this._botEmote(alive[0], 3);
    }
    this._broadcastResults();
    this._endRace();
  }

  // =================================================================== controller

  _onPad(button, repeat) {
    if (button === PAD.START && !repeat) {
      this.settings.toggle();
      return;
    }
    if (this.padNav.handle(button)) return;
    if (!this.inRace || this.podium.active) return;
    if (this.spectating) {
      if (button === PAD.LEFT || button === PAD.RIGHT) this._cycleSpectate(button === PAD.RIGHT ? 1 : -1);
      else if (button === PAD.Y && !repeat) this._stopSpectate(true);
      return;
    }
    if (repeat) return;
    // D-pad: emotes (up 👋, right 😂, down 😤, left 🏆).
    const emote = { [PAD.UP]: 0, [PAD.RIGHT]: 1, [PAD.DOWN]: 2, [PAD.LEFT]: 3 }[button];
    if (emote != null) this.sendEmote(emote);
  }

  /** B on a controller: close whatever overlay is on top. */
  _padBack(layer) {
    if (layer === 'settings') this.settings.close();
    else if (layer === 'stats-panel') this.statsPanel.close();
    else if (layer === 'garage') this.closeGarage();
    else if (layer === 'podium-ui') document.getElementById('btn-podium-skip').click();
  }

  _canSpectate() {
    return this.inRace && !!this.localKart?.finished && this.race.state !== 'done' && !this.podium.active && !this.finishFlag.active;
  }

  /** After finishing: hide the results and follow the racers still on track. */
  _startSpectate() {
    if (!this._canSpectate()) return;
    const racing = this.race.standings.filter((k) => !k.finished);
    const target = racing[0] || this.race.standings[0] || this.localKart;
    this.spectateSlot = target.slot;
    this.spectating = true;
    this._specSnap = true;
    this.results.show(false);
    this._specLabel = '';
    this._updateSpectateUI();
  }

  _stopSpectate(showResults) {
    if (!this.spectating) return;
    this.spectating = false;
    this._specSnap = true;
    this._updateSpectateUI();
    if (showResults) this._showResults();
  }

  _cycleSpectate(dir) {
    if (!this.spectating) return;
    const list = this.race.standings.length ? this.race.standings : this.karts;
    const i = list.findIndex((k) => k.slot === this.spectateSlot);
    this.spectateSlot = list[(i + dir + list.length) % list.length].slot;
    this._specSnap = true;
    this._updateSpectateUI();
  }

  _updateSpectateUI() {
    const bar = document.getElementById('hud-spectate');
    bar.classList.toggle('hidden', !this.spectating);
    bar.classList.toggle('flex', this.spectating);
    if (!this.spectating) return;
    const k = this.kartBySlot[this.spectateSlot];
    const label = k ? `${k.name} · ${k.finished ? 'finished' : ordinal(k.rank)}` : '';
    if (label !== this._specLabel) {
      this._specLabel = label;
      document.getElementById('spec-name').textContent = label;
    }
  }

  // =================================================================== ready-up

  toggleReady() {
    if (this.mode !== 'host' && this.mode !== 'client') return;
    if (this.inRace && this.race.state !== 'done') return; // only between races
    const me = this.net.players.find((p) => p.slot === this.net.localSlot);
    this.audio.blip('item');
    this.net.setReady(!(me && me.ready));
  }

  /** Host: start the next race shortly after everyone has readied up. */
  _maybeAutoStart() {
    if (this.mode !== 'host') return;
    const between = !this.inRace || this.race.state === 'done';
    if (between && this.net.allReady) {
      if (!this._autoStart) {
        this._autoStart = setTimeout(() => {
          this._autoStart = null;
          if (this.mode === 'host' && this.net.allReady) this.startHostRace();
        }, 900);
      }
    } else if (this._autoStart) {
      clearTimeout(this._autoStart);
      this._autoStart = null;
    }
  }

  // =================================================================== networking

  _onStatePacket(buf, fromSlot) {
    if (!this.inRace) return;
    const now = performance.now();
    readPacket(buf, (rec) => {
      if (this.mode === 'host') {
        if (rec.slot !== fromSlot) return; // clients may only speak for themselves
        this.latest[rec.slot].copyFrom(rec);
      } else if (rec.slot === this.net.localSlot) {
        return;
      }
      const k = this.kartBySlot[rec.slot];
      if (!k || k.simulated) return;
      this.interp[rec.slot].push(rec, now);
      k.netX = rec.x;
      k.netZ = rec.z;
      k.applyRemoteFlags(rec.flags, rec.driftTier & 15, rec.steer);
      k.applyRemoteExtras(rec.driftTier >> 4);
      k.item = rec.item;
      k.applyRemoteItemBits(rec.itemBits);
      k.applyRemoteExtras2(rec.extra2);
      k.rollTimer = rec.flags & FLAG.ROLLING ? 0.1 : 0;
      k.progress = rec.progress;
      k.lap = rec.lap;
      if (this.battle) k.balloons = rec.coins;
      else k.coins = rec.coins;
      const fin = (rec.flags & FLAG.FINISHED) !== 0;
      if (fin && !k.finished) {
        k.finished = true;
        const entry = this.race.finishOrder.find((f) => f.slot === k.slot);
        k.finishTime = entry ? entry.time : this.race.elapsed(now);
      }
    });
  }

  _onMessage(msg, fromSlot) {
    if (msg.t === 'emote') {
      const idx = msg.e | 0;
      if (this.mode === 'host') {
        // Relay a client's emote to everyone (the sender is always the slot it came from).
        this._showEmote(fromSlot, idx);
        this.net.broadcast({ t: 'emote', s: fromSlot, e: idx });
      } else if ((msg.s | 0) !== this.localKart?.slot) {
        this._showEmote(msg.s | 0, idx);
      }
      return;
    }
    if (this.mode === 'host') {
      if (msg.t === 'use') this.items.handleRequest(msg, fromSlot);
      else if (msg.t === 'finish' && msg.s === fromSlot) {
        const k = this.kartBySlot[fromSlot];
        const time = Math.max(0, Number(msg.time) || 0);
        if (k) {
          k.finished = true;
          k.finishTime = time;
        }
        if (this.race.recordFinish(fromSlot, k ? k.name : `Player ${fromSlot + 1}`, time)) {
          if (!this.firstFinishAt) this.firstFinishAt = this.now;
          this._broadcastResults();
        }
      }
      return;
    }

    // client
    if (msg.t === 'start') {
      this._startClientRace(msg);
    } else if (ITEM_EVENTS.has(msg.t)) {
      if (this.inRace) this.items.applyEvent(msg);
    } else if (msg.t === 'results') {
      if (Array.isArray(msg.list)) {
        this.race.finishOrder = msg.list.map((f) => ({ slot: f.slot | 0, name: String(f.name), time: +f.time }));
        for (const f of this.race.finishOrder) {
          const k = this.kartBySlot[f.slot];
          if (k && !k.simulated) { k.finished = true; k.finishTime = f.time; }
        }
        this._refreshResults();
      }
    } else if (msg.t === 'cup') {
      if (Array.isArray(msg.table)) {
        this.cupView = {
          race: msg.race | 0,
          table: msg.table.map((r) => ({ slot: r.slot | 0, name: String(r.name).slice(0, 16), look: sanitizeLook(r.look), points: r.points | 0, last: r.last | 0 })),
        };
        this._refreshResults();
      }
    } else if (msg.t === 'over') {
      this.race.state = 'done';
      if (!this.localKart?.finished) this.audio.playAfterRace(2);
      this._startPodium();
    }
  }

  _sendNetwork(dt) {
    if (this.mode !== 'host' && this.mode !== 'client') return;
    this.netAccumulator += dt;
    const interval = 1 / NET_TICK_HZ;
    if (this.netAccumulator < interval) return;
    this.netAccumulator %= interval;

    const w = this.writer;
    const t = performance.now();
    w.begin();
    if (this.mode === 'client') {
      if (!this.localKart) return;
      w.write(this._rec.fromKart(this.localKart, t));
      this.net.sendState(w.finish(PKT_CLIENT_STATE));
    } else {
      for (let i = 0; i < this.karts.length; i++) {
        const k = this.karts[i];
        if (k.simulated) w.write(this._rec.fromKart(k, t));
        else if (this.latest[k.slot].valid) w.write(this.latest[k.slot]);
      }
      this.net.broadcastState(w.finish(PKT_SNAPSHOT));
    }
  }

  // =================================================================== frame loop

  frame(t) {
    requestAnimationFrame(this._frame);
    const dt = Math.min(0.1, Math.max(0, (t - this.lastFrame) / 1000));
    this.lastFrame = t;
    this.now = performance.now();
    const time = this.now / 1000;
    this.input.poll();

    if (this.inRace) {
      const remaining = this.race.update(this.now, this.karts);
      this._updateCountdown(remaining);
      this.physics.step(dt, this._pre, this._post);
      this._updateRemoteKarts(dt);
      if (this.battle) this._updateBattle(dt);
      this.race.rank(this.karts);
      this._sendNetwork(dt);
      this._checkRaceOver();
      if (this.resultsTimer > 0) {
        this.resultsTimer -= dt;
        if (this.resultsTimer <= 0) this._showResults();
      }
    }

    this.particles.update(dt);
    if (this.podium.active) {
      this.podium.update(dt, time);
      this.kartRenderer.update(this.podium.list, 0, dt);
    } else if (this.garageUI.visible) {
      this._updateShowroom(time);
      this.kartRenderer.update(this._showroomList, 0, dt);
    } else {
      this.kartRenderer.update(this.karts, this.physics.alpha, dt);
    }
    this.items.render(time, this.karts);
    if (this.inRace && !this.podium.active) {
      this.balloons.update(this.karts, time, (k) => { if (k === this.localKart) this.audio.blip('hit'); });
    } else if (this.balloons.enabled) {
      this.balloons.mesh.count = 0;
    }
    // Moving hazards run on the race clock so every peer sees them in the same place.
    this.movers.update(this.inRace ? this.race.elapsed(this.now) / 1000 : time);
    if (this.inRace && !this.podium.active) {
      this.movers.collide(this.karts, (k) => {
        if (k !== this.localKart) return;
        this.audio.blip('hit');
        this.hud.subtitle('Ouch!', 1);
        this.renderer.addShake(0.6);
      });
    }
    this.weather.update(dt, this.renderer.camera.position, !this.podium.active && !this.garageUI.visible);

    const lk = this.localKart;
    if (this.podium.active) {
      // camera driven by the ceremony
    } else if (this.garageUI.visible) {
      this.renderer.updateShowroomCamera(time, SHOWROOM.x, SHOWROOM.y, SHOWROOM.z);
    } else if (this.inRace && lk) {
      const view = (this.spectating && this.kartBySlot[this.spectateSlot]) || lk;
      const zoom = 1 + (view.megaScale - 1) * 0.55;
      this.renderer.updateChaseCamera(view.renderX, view.renderY, view.renderZ, view.renderYaw + view.driftVisual * 0.35, view.speed, view.boostTimer > 0, dt, this._specSnap, zoom, view.visPitch || 0, view.visRoll || 0);
      this._specSnap = false;
      if (this.spectating) this._updateSpectateUI();
      if (this.input.touch) this.input.touch.gas = this.race.state === 'racing';
      if (this.mode === 'trial') {
        const t = this.race.elapsed(this.now) / 1000;
        if (this.race.state === 'racing' && !lk.finished) this.ghostRec.sample(t, lk);
        if (this.ghost) this.ghostKart.update(t, this.ghost);
      }
      this.hud.update(dt, {
        kart: lk,
        standings: this.race.standings,
        raceTime: this.race.elapsed(this.now),
        stats: this._stats,
      });
      this.hud.drawMinimap(this.karts, lk);
      this._localSfx(lk);
      this.audio.updateEngine(lk.speed, lk.control === 'bot' ? 1 : this.input.state.throttle, lk.drifting, lk.boostTimer > 0, lk.grounded);
      if (this.results.visible && this.race.state !== 'done') this._refreshResultsThrottled(dt);
    } else {
      const b = this.track.bounds;
      this.renderer.updateOrbitCamera(time, b.cx, b.cz, Math.max(230, Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 0.6));
    }

    if (this.inRace && !this.podium.active) this.emotes.update(dt, this.kartBySlot, this.renderer.camera);
    this.renderer.trackPerf(dt);
    this.renderer.render();
    this._updateStats(dt);
  }

  // =================================================================== garage

  _buildShowroom() {
    const podium = new THREE.Group();
    const top = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.8, 0.6, 32), this.renderer.toon({ color: 0x2b2d42 }));
    top.position.y = -0.3;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.45, 0.12, 8, 48), this.renderer.toon({ color: 0xffd23f }));
    ring.rotation.x = Math.PI / 2;
    podium.add(top, ring);
    podium.position.set(SHOWROOM.x, SHOWROOM.y, SHOWROOM.z);
    podium.visible = false;
    this.renderer.scene.add(podium);
    this.podium = podium;
    // Minimal kart-shaped object for the renderer (not simulated, no physics body).
    this.previewKart = {
      preview: true, simulated: false, look: this.garage.look,
      x: SHOWROOM.x, y: SHOWROOM.y + KART.radius, z: SHOWROOM.z,
      prevX: SHOWROOM.x, prevY: SHOWROOM.y + KART.radius, prevZ: SHOWROOM.z,
      yaw: 0, prevYaw: 0, megaScale: 1, megaTimer: 0, driftVisual: 0, spinAngle: 0,
      steerVisual: 0, speed: 0, wheelSpin: 0, boostTimer: 0,
    };
    this._showroomList = [this.previewKart];
  }

  _updateShowroom(time) {
    const p = this.previewKart;
    p.look = this.garageUI.displayLook;
    p.yaw = p.prevYaw = Math.sin(time * 0.25) * 0.6 + 0.5;
    p.steerVisual = Math.sin(time * 0.9) * 0.6;
    p.wheelSpin = time * 2;
  }

  openGarage() {
    this.garageUI.open();
    this.podium.visible = true;
    this.lobby.show(false);
    this.results.show(false);
    this.hud.show(false);
  }

  closeGarage() {
    if (!this.garageUI.visible) return;
    this.garageUI.close();
    this.podium.visible = false;
    if (this.inRace) {
      this.hud.show(true);
      if (this.race.state === 'done' || this.localKart?.finished) this._showResults();
    } else {
      this.lobby.show(true);
    }
  }

  _onGarageChange() {
    if (this.mode === 'host' || this.mode === 'client') this.net.setLook(this.garage.look);
    if (this.results.visible) this._refreshResults();
  }

  /** Edge-triggered sound effects for the local kart. */
  _localSfx(k) {
    const s = this._sfxState;
    const spin = k.spinTimer > 0;
    if (spin && !s.spin) this.input.rumble(0.9, 0.5, 380);
    s.spin = spin;
    const trick = k.trickTimer > 0;
    if (trick && !s.trick) { this.audio.blip('trick'); this.hud.subtitle('Trick!', 0.8); }
    s.trick = trick;
    const rolling = k.rollTimer > 0;
    if (rolling && !s.rolling) this.audio.playRoll(k.rollTimer);
    s.rolling = rolling;
    if (k.coins > s.coins) this.audio.blip('coin');
    s.coins = k.coins;
    const boost = k.boostTimer > 0;
    if (boost && !s.boost) {
      this.audio.blip('boost');
      this.input.rumble(0.15, 0.45, 160);
    }
    s.boost = boost;
    const shield = k.shieldTimer > 0;
    if (shield && !s.shield) this.audio.blip('shield');
    s.shield = shield;
    const magnet = k.magnetTimer > 0;
    if (magnet && !s.magnet) this.audio.blip('magnet');
    s.magnet = magnet;
    const star = k.starTimer > 0;
    if (star && !s.star) {
      this.audio.blip('mega');
      this.hud.flash('SUPER STAR!', 1.2, '#ffe156');
      this.input.rumble(0.5, 0.8, 400);
    }
    s.star = star;
    const rocket = k.rocketTimer > 0;
    if (rocket && !s.rocket) {
      this.audio.blip('boost');
      this.hud.flash('BULLET!', 1.2, '#ffffff');
      this.renderer.addShake(0.5);
      this.input.rumble(0.8, 0.8, 500);
    }
    s.rocket = rocket;
    const mega = k.megaTimer > 0;
    if (mega && !s.mega) {
      this.audio.blip('mega');
      this.input.rumble(0.7, 0.7, 450);
      this.hud.flash('MEGA!', 1.2, '#ffd23f');
      this.renderer.addShake(0.6);
    }
    s.mega = mega;
  }

  _refreshResultsThrottled(dt) {
    this._resultsRefresh = (this._resultsRefresh || 0) - dt;
    if (this._resultsRefresh <= 0) {
      this._resultsRefresh = 0.5;
      this._refreshResults();
    }
  }

  _updateCountdown(remaining) {
    if (this.race.state === 'countdown') {
      // Start the countdown clip as soon as it's decoded, aligned so it ends on GO.
      if (!this._sfxState.countdown && this.audio.duration('countdown') > 0) {
        this._sfxState.countdown = true;
        this.audio.playCountdown(remaining * 1000);
      }
      // Start boost: remember when you pressed accelerate (seconds before GO).
      if (this.input.state.throttle > 0) {
        if (this._startPressAt == null) this._startPressAt = remaining;
      } else {
        this._startPressAt = null;
      }
      const n = Math.ceil(remaining);
      if (n !== this.lastCountdown && n <= 3 && n > 0) {
        this.lastCountdown = n;
        this.hud.flash(String(n), 1.1, n === 1 ? '#ffd23f' : '#ffffff');
      }
    } else if (this.race.state === 'racing' && this.lastCountdown > 0) {
      this.lastCountdown = 0;
      this.hud.flash('GO!', 0.9, '#4ade80');
      this.audio.startMusic(this.track.seed % 3); // a different tune per circuit
      this._applyStartBoosts();
    }
  }

  /**
   * Rocket start: press accelerate during "1" (about 1.1–0.25 s before GO) for a boost.
   * Holding it since "2" or earlier floods the engine and it stalls for a moment.
   */
  _applyStartBoosts() {
    const k = this.localKart;
    const at = this._startPressAt;
    this._startPressAt = null;
    if (k && at != null) {
      if (at <= 1.1 && at >= 0.2) {
        k.boostTimer = Math.max(k.boostTimer, 1.2);
        k.pendingImpulse += 10;
        this.hud.subtitle('Rocket start!', 1.5);
      } else if (at > 1.1) {
        k.stallTimer = 0.9;
        this.audio.blip('stall');
        this.hud.subtitle('Engine flooded! Too early', 1.5);
        this.particles.burst(k.x, k.y + 0.6, k.z, 12, 3, 0.8, 0.5, 0x666666, 2);
      }
    }
    // CPUs get a random start too.
    for (const b of this.bots) {
      const r = Math.random();
      if (r < 0.35) { b.boostTimer = 1.2; b.pendingImpulse += 10; } else if (r > 0.92) b.stallTimer = 0.9;
    }
  }

  _updateStats(dt) {
    this._fpsFrames++;
    this._fpsTime += dt;
    if (this._fpsTime >= 0.5) {
      const fps = Math.round(this._fpsFrames / this._fpsTime);
      const net = this.mode === 'host' ? ` · host · ${this.net.clients.size} peer(s)` : this.mode === 'client' ? ' · client' : '';
      this._stats = `${fps} fps · ${this.renderer.drawCalls} draw calls${net}`;
      this._fpsFrames = 0;
      this._fpsTime = 0;
    }
  }

  toast(text) {
    const el = document.getElementById('toast');
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2200);
  }
}

async function boot() {
  createIcons({ icons: { Flag, Users, Gamepad2, LogIn, Trophy, RotateCcw, Link, LoaderCircle, House, Wrench, Check, Medal, Eye, ChevronLeft, ChevronRight, Timer, Settings: SettingsIcon } });
  const loading = document.getElementById('loading');
  try {
    const physics = await Physics.create();
    window.__game = new Game(physics);
    loading.remove();
  } catch (err) {
    console.error(err);
    loading.querySelector('p').textContent = `Failed to start: ${err.message || err}`;
  }
}

boot();

import './style.css';
import * as THREE from 'three';
import { createIcons, Flag, Users, Gamepad2, LogIn, Trophy, RotateCcw, Link, LoaderCircle, House, Wrench, Check, Settings as SettingsIcon } from 'lucide';

import { Renderer } from './engine/Renderer.js';
import { Physics } from './engine/Physics.js';
import { Particles } from './engine/Particles.js';
import { Audio } from './engine/Audio.js';
import { Track } from './game/Track.js';
import { Kart, FLAG } from './game/Kart.js';
import { KartRenderer } from './game/KartRenderer.js';
import { ItemSystem } from './game/ItemSystem.js';
import { Input } from './game/Input.js';
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
import {
  MAX_KARTS, TOTAL_LAPS, SOLO_BOTS, NET_TICK_HZ, KART, CPU_NAMES,
} from './game/constants.js';

const COUNTDOWN_MS = 3600;
const RACE_TIMEOUT_AFTER_FIRST_MS = 30000; // stragglers get a DNF this long after the first human finishes
const ITEM_EVENTS = new Set(['box', 'coin', 'spawn', 'hit', 'despawn', 'zap', 'pad', 'slip', 'cloud', 'steal']);
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
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.code === 'KeyM') {
        this.toast(this.audio.toggleMute() ? 'Sound off (M)' : 'Sound on (M)');
        if (this.settings.visible) this.settings.refresh();
      } else if (e.code === 'Escape') {
        this.settings.toggle();
      }
    });

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

    // Fixed-step callbacks are created once so the frame loop never allocates closures.
    this._pre = (dt) => this._fixedPre(dt);
    this._post = (dt) => this._fixedPost(dt);
    this._frame = (t) => this.frame(t);

    this.lobby.show(true);
    if (this.lobby.pendingRoom) this.lobby.setStatus('Room link detected — press Join to hop in.');
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
      this.hud.subtitle(`Lap ${formatTime(lapTime)}`, 2.2);
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
    this.audio.stopMusic(0.4);
    this.audio.stopCountdown();
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
    if (this.mode === 'solo') this.startSolo(this.lobby.name);
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
    this.mode = 'solo';
    const roster = [{ slot: 0, name, control: 'local', look: this.garage.look }];
    for (let i = 1; i <= SOLO_BOTS; i++) roster.push({ slot: i, name: CPU_NAMES[i - 1], control: 'bot', look: randomLook() });
    this._setupRace(roster, COUNTDOWN_MS, this._nextSeed());
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
    const seed = this._nextSeed();
    this.net.broadcast({ t: 'start', players, countdown: COUNTDOWN_MS, seed });
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
    this._setupRace(roster, msg.countdown, msg.seed >>> 0);
  }

  _clearRace() {
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
    this.closeGarage();
    this._clearRace();
    this.round++;
    this.banked = false;
    // Every round is a brand-new circuit; all peers build the same one from the shared seed.
    this.track.generate(seed);
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

    this.items.isAuthority = this.mode !== 'client';
    this.kartRenderer.setColors(this.karts);
    this.race.begin(performance.now(), countdownMs);
    this.audio.init();
    this.audio.stopMusic(0.3);
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
    this.hud.subtitle(`Round ${this.round} · ${this.track.name}`, 3.2);
    document.getElementById('results-track').textContent = `Round ${this.round} · ${this.track.name}`;
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
    for (let i = 0; i < this.karts.length; i++) {
      const k = this.karts[i];
      if (!k.simulated) continue;
      const inp = k.control === 'bot' ? k.ai.update(dt) : input;
      k.simulate(dt, inp);
      if (k.controlsEnabled && inp.itemPressed) this.items.useItem(k);
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
    if (k === this.localKart) {
      this.audio.stopMusic(0.5);
      this.audio.play('raceEnd');
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
    let all = this.karts.length > 0;
    for (const k of this.karts) if (!k.finished) { all = false; break; }
    const timedOut = this.firstFinishAt && this.now - this.firstFinishAt > RACE_TIMEOUT_AFTER_FIRST_MS;
    if (all || timedOut) this._endRace();
  }

  _endRace() {
    this.race.state = 'done';
    if (!this.localKart?.finished) this.audio.stopMusic(0.8);
    if (this.mode === 'host') {
      this.net.broadcast({ t: 'over' });
      this.net.acceptingPlayers = true;
    }
    for (const k of this.karts) k.controlsEnabled = k.control === 'local';
    this._showResults();
  }

  _showResults() {
    this._bankCoins();
    this.results.show(true);
    this._refreshResults();
  }

  /** Once per round: coins held at the end plus a placement bonus go into the garage wallet. */
  _bankCoins() {
    const k = this.localKart;
    if (this.banked || !k) return;
    this.banked = true;
    const finishIdx = this.race.finishOrder.findIndex((f) => f.slot === k.slot);
    const place = finishIdx >= 0 ? finishIdx + 1 : this.race.standings.length;
    const bonus = PLACEMENT_BONUS[Math.min(place, PLACEMENT_BONUS.length) - 1];
    this.garage.deposit(k.coins + bonus);
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
    this.results.render(entries, this.localKart ? this.localKart.slot : -1, {
      canRestart: this.mode === 'solo' || this.mode === 'host',
      note,
      ready,
    });
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
      k.item = rec.item & 15;
      k.applyRemoteItemBits(rec.item >> 4);
      k.rollTimer = rec.flags & FLAG.ROLLING ? 0.1 : 0;
      k.progress = rec.progress;
      k.lap = rec.lap;
      k.coins = rec.coins;
      const fin = (rec.flags & FLAG.FINISHED) !== 0;
      if (fin && !k.finished) {
        k.finished = true;
        const entry = this.race.finishOrder.find((f) => f.slot === k.slot);
        k.finishTime = entry ? entry.time : this.race.elapsed(now);
      }
    });
  }

  _onMessage(msg, fromSlot) {
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
    } else if (msg.t === 'over') {
      this.race.state = 'done';
      this.audio.stopMusic(0.8);
      this._showResults();
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
      this.race.rank(this.karts);
      this._sendNetwork(dt);
      this._checkRaceOver();
      if (this.resultsTimer > 0) {
        this.resultsTimer -= dt;
        if (this.resultsTimer <= 0) this._showResults();
      }
    }

    this.particles.update(dt);
    if (this.garageUI.visible) {
      this._updateShowroom(time);
      this.kartRenderer.update(this._showroomList, 0, dt);
    } else {
      this.kartRenderer.update(this.karts, this.physics.alpha, dt);
    }
    this.items.render(time, this.karts);

    const lk = this.localKart;
    if (this.garageUI.visible) {
      this.renderer.updateShowroomCamera(time, SHOWROOM.x, SHOWROOM.y, SHOWROOM.z);
    } else if (this.inRace && lk) {
      const zoom = 1 + (lk.megaScale - 1) * 0.55;
      this.renderer.updateChaseCamera(lk.renderX, lk.renderY, lk.renderZ, lk.renderYaw + lk.driftVisual * 0.35, lk.speed, lk.boostTimer > 0, dt, false, zoom, lk.visPitch || 0, lk.visRoll || 0);
      this.hud.update(dt, {
        kart: lk,
        standings: this.race.standings,
        raceTime: this.race.elapsed(this.now),
        stats: this._stats,
      });
      this.hud.drawMinimap(this.karts, lk);
      this._localSfx(lk);
      if (this.results.visible && this.race.state !== 'done') this._refreshResultsThrottled(dt);
    } else {
      const b = this.track.bounds;
      this.renderer.updateOrbitCamera(time, b.cx, b.cz, 230);
    }

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
    const rolling = k.rollTimer > 0;
    if (rolling && !s.rolling) this.audio.playRoll(k.rollTimer);
    s.rolling = rolling;
    if (k.coins > s.coins) this.audio.blip('coin');
    s.coins = k.coins;
    const boost = k.boostTimer > 0;
    if (boost && !s.boost) this.audio.blip('boost');
    s.boost = boost;
    const shield = k.shieldTimer > 0;
    if (shield && !s.shield) this.audio.blip('shield');
    s.shield = shield;
    const magnet = k.magnetTimer > 0;
    if (magnet && !s.magnet) this.audio.blip('magnet');
    s.magnet = magnet;
    const mega = k.megaTimer > 0;
    if (mega && !s.mega) {
      this.audio.blip('mega');
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
      const n = Math.ceil(remaining);
      if (n !== this.lastCountdown && n <= 3 && n > 0) {
        this.lastCountdown = n;
        this.hud.flash(String(n), 1.1, n === 1 ? '#ffd23f' : '#ffffff');
      }
    } else if (this.race.state === 'racing' && this.lastCountdown > 0) {
      this.lastCountdown = 0;
      this.hud.flash('GO!', 0.9, '#4ade80');
      this.audio.startMusic(this.track.seed % 3); // a different tune per circuit
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
  createIcons({ icons: { Flag, Users, Gamepad2, LogIn, Trophy, RotateCcw, Link, LoaderCircle, House, Wrench, Check, Settings: SettingsIcon } });
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

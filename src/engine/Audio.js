import countdownUrl from '../../sound_effects/countdown.mp3';
import rollUrl from '../../sound_effects/powerup_roll.mp3';
import raceEndUrl from '../../sound_effects/race_end.mp3';
import music1Url from '../../sound_effects/track1_music.mp3';
import music2Url from '../../sound_effects/track2_music.mp3';
import music3Url from '../../sound_effects/track3_music.mp3';
import menuUrl from '../../sound_effects/menu_screen.mp3';

const SETTINGS_KEY = 'mkbros:audio';
const MUSIC_BASE = 0.45; // music sits under the effects at 100%
const MUSIC = [music1Url, music2Url, music3Url];
const SFX = { countdown: countdownUrl, roll: rollUrl, raceEnd: raceEndUrl };
// Measured cue points inside the supplied clips (seconds).
const COUNTDOWN_GO_AT = 4.9; // onset of the high "GO" tone; beeps are 1 s apart before it
const ROLL_DING_AT = 3.5; // final "ding" of the item roulette

/**
 * WebAudio sound manager.
 * - Short effects are decoded once into AudioBuffers (instant, overlapping playback).
 * - Music streams through a single <audio> element routed into the graph (no big decode).
 * - A few tiny effects (coin, boost, hit) are synthesised so no extra files are needed.
 * The AudioContext is created on the first user gesture, as browsers require.
 */
export class Audio {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
    // Device preferences (not game progress), so they're remembered in localStorage.
    this.settings = { master: 0.8, music: 0.7, sfx: 0.9, muted: false };
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (saved) for (const k of Object.keys(this.settings)) if (typeof saved[k] === typeof this.settings[k]) this.settings[k] = saved[k];
    } catch { /* storage unavailable */ }
    this.musicEl = null;
    this.musicIndex = -1; // current track: 0..2 race music, 'menu' for the menu loop
    this.wantMenu = false; // menu music requested before audio was unlocked
    this._unlock = () => this.init();
    window.addEventListener('pointerdown', this._unlock, { once: false });
    window.addEventListener('keydown', this._unlock, { once: false });
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.connect(this.master);
    // musicFade handles fade in/out; musicGain holds the user's music volume.
    this.musicFade = this.ctx.createGain();
    this.musicGain = this.ctx.createGain();
    this.musicFade.connect(this.musicGain).connect(this.master);
    this._applyVolumes();

    this.musicEl = document.createElement('audio');
    this.musicEl.loop = true;
    this.musicEl.preload = 'auto';
    this.ctx.createMediaElementSource(this.musicEl).connect(this.musicFade);

    for (const [name, url] of Object.entries(SFX)) this._load(name, url);
    if (this.wantMenu) this.playMenu(1.5);
    window.removeEventListener('pointerdown', this._unlock);
    window.removeEventListener('keydown', this._unlock);
  }

  async _load(name, url) {
    try {
      const res = await fetch(url);
      const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
      this.buffers.set(name, buf);
    } catch (err) {
      console.warn('[audio] failed to load', name, err);
    }
  }

  duration(name) {
    const b = this.buffers.get(name);
    return b ? b.duration : 0;
  }

  /** Play a decoded effect. `when` = seconds from now, `offset` = seconds into the clip. */
  play(name, { volume = 1, when = 0, offset = 0 } = {}) {
    if (!this.ctx) return null;
    const buf = this.buffers.get(name);
    if (!buf) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.sfxGain);
    src.start(this.ctx.currentTime + Math.max(0, when), Math.max(0, Math.min(offset, buf.duration - 0.01)));
    return src;
  }

  /** Line the countdown clip up so its GO tone fires exactly when the race starts. */
  playCountdown(msUntilGo) {
    if (!this.duration('countdown')) return;
    const offset = COUNTDOWN_GO_AT - msUntilGo / 1000;
    this._countdownSrc = offset >= 0
      ? this.play('countdown', { offset })
      : this.play('countdown', { when: -offset });
  }

  /** Item roulette: start partway in so the closing ding lands when the item is revealed. */
  playRoll(rollSeconds) {
    return this.play('roll', { offset: Math.max(0, ROLL_DING_AT - rollSeconds), volume: 0.8 });
  }

  stopCountdown() {
    try { this._countdownSrc?.stop(); } catch { /* already stopped */ }
    this._countdownSrc = null;
  }

  /** Switch the music element to a track and fade it in (0 = instant). */
  _playTrack(key, url, fadeIn) {
    clearTimeout(this._musicStop);
    clearTimeout(this._musicSwitch);
    if (this.musicIndex !== key) {
      this.musicEl.src = url;
      this.musicIndex = key;
    }
    this.musicEl.currentTime = 0;
    const g = this.musicFade.gain, t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(fadeIn > 0 ? 0 : 1, t);
    if (fadeIn > 0) g.linearRampToValueAtTime(1, t + fadeIn);
    this.musicEl.play().catch(() => {});
  }

  /** Race music for a circuit. */
  startMusic(index) {
    this.wantMenu = false;
    if (!this.ctx || !this.musicEl) return;
    const i = ((index % MUSIC.length) + MUSIC.length) % MUSIC.length;
    this._playTrack(i, MUSIC[i], 0);
  }

  /**
   * Looping menu music (menu, lobby, garage and between races). Fades out whatever is playing,
   * then fades the menu track in. Queued until the first user gesture unlocks audio.
   */
  playMenu(fadeIn = 2) {
    this.wantMenu = true;
    if (!this.ctx || !this.musicEl) return;
    if (this.musicIndex === 'menu' && !this.musicEl.paused && !this._musicStopping) return; // already on
    const switchNow = () => this._playTrack('menu', menuUrl, fadeIn);
    if (!this.musicEl.paused && this.musicIndex !== 'menu') {
      this.stopMusic(0.6);
      this._musicSwitch = setTimeout(switchNow, 650);
    } else {
      switchNow();
    }
    this._musicStopping = false;
  }

  stopMusic(fade = 1) {
    this.wantMenu = false;
    clearTimeout(this._musicSwitch);
    if (!this.ctx || !this.musicEl || this.musicEl.paused) return;
    this._musicStopping = true;
    const t = this.ctx.currentTime;
    this.musicFade.gain.cancelScheduledValues(t);
    this.musicFade.gain.setValueAtTime(this.musicFade.gain.value, t);
    this.musicFade.gain.linearRampToValueAtTime(0, t + fade);
    clearTimeout(this._musicStop);
    this._musicStop = setTimeout(() => { this.musicEl.pause(); this._musicStopping = false; }, fade * 1000 + 50);
  }

  /** Tiny synthesised blips for frequent events that have no sample. */
  blip(kind) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.connect(g).connect(this.sfxGain);
    const presets = {
      coin: { type: 'square', f0: 988, f1: 1319, dur: 0.12, vol: 0.12 },
      boost: { type: 'sawtooth', f0: 180, f1: 520, dur: 0.35, vol: 0.12 },
      hit: { type: 'triangle', f0: 520, f1: 90, dur: 0.45, vol: 0.25 },
      item: { type: 'square', f0: 330, f1: 660, dur: 0.1, vol: 0.1 },
      mega: { type: 'sawtooth', f0: 110, f1: 440, dur: 0.9, vol: 0.18 },
      bump: { type: 'triangle', f0: 160, f1: 60, dur: 0.18, vol: 0.3 },
      zap: { type: 'sawtooth', f0: 1800, f1: 70, dur: 0.6, vol: 0.2 },
      shield: { type: 'sine', f0: 400, f1: 900, dur: 0.35, vol: 0.2 },
      magnet: { type: 'square', f0: 220, f1: 330, dur: 0.3, vol: 0.1 },
    };
    const p = presets[kind] || presets.item;
    osc.type = p.type;
    osc.frequency.setValueAtTime(p.f0, t);
    osc.frequency.exponentialRampToValueAtTime(p.f1, t + p.dur);
    g.gain.setValueAtTime(p.vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + p.dur);
    osc.start(t);
    osc.stop(t + p.dur + 0.02);
  }

  get muted() {
    return this.settings.muted;
  }

  /** kind: 'master' | 'music' | 'sfx' (0..1) or 'muted' (boolean). */
  set(kind, value) {
    this.settings[kind] = value;
    this._applyVolumes();
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* storage unavailable */ }
  }

  toggleMute() {
    this.set('muted', !this.settings.muted);
    return this.settings.muted;
  }

  _applyVolumes() {
    if (!this.ctx) return;
    const s = this.settings;
    // Squared curve feels more natural on a linear slider.
    this.master.gain.value = s.muted ? 0 : s.master * s.master;
    this.musicGain.gain.value = MUSIC_BASE * s.music * s.music;
    this.sfxGain.gain.value = s.sfx * s.sfx;
  }
}

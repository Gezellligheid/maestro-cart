const KEY = 'mkbros:records';
const MAX_TRACKS = 60;

/**
 * Personal stats and per-track records, kept in this browser only (localStorage). Tracks are
 * keyed by their seed, so replaying a track code (time trial or a shared code) finds its records.
 */
export class Records {
  constructor() {
    this.data = { stats: { races: 0, wins: 0, podiums: 0, coins: 0, records: 0, bestLap: null }, tracks: {} };
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (raw && raw.stats && raw.tracks) this.data = { stats: { ...this.data.stats, ...raw.stats }, tracks: raw.tracks };
    } catch { /* storage blocked or corrupt: start fresh */ }
  }

  get stats() {
    return this.data.stats;
  }

  track(seed) {
    return this.data.tracks[seed >>> 0] || null;
  }

  _entry(seed, name) {
    const key = seed >>> 0;
    const t = this.data.tracks[key] || (this.data.tracks[key] = { name, lap: null, race: null });
    t.name = name;
    t.at = Date.now();
    return t;
  }

  /** Returns 'record' when this beats a previous best lap on the track, 'first' for a first time. */
  submitLap(seed, trackName, ms) {
    const t = this._entry(seed, trackName);
    const prev = t.lap;
    if (prev != null && ms >= prev) return null;
    t.lap = ms;
    const s = this.stats;
    if (!s.bestLap || ms < s.bestLap.ms) s.bestLap = { ms, track: trackName };
    if (prev != null) s.records++;
    this._save();
    return prev != null ? 'record' : 'first';
  }

  /** Like submitLap, for the full race time; also counts the race in your stats. */
  submitRace(seed, trackName, ms, place) {
    const t = this._entry(seed, trackName);
    const s = this.stats;
    s.races++;
    if (place === 1) s.wins++;
    if (place <= 3) s.podiums++;
    const prev = t.race;
    const better = prev == null || ms < prev;
    if (better) t.race = ms;
    this._save();
    return !better ? null : prev != null ? 'record' : 'first';
  }

  addCoins(n) {
    this.stats.coins += n;
    this._save();
  }

  /** Most recently raced tracks first. */
  recentTracks(n = 8) {
    return Object.entries(this.data.tracks)
      .map(([seed, t]) => ({ seed: Number(seed), ...t }))
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .slice(0, n);
  }

  _save() {
    const entries = Object.entries(this.data.tracks);
    if (entries.length > MAX_TRACKS) {
      entries.sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
      for (const [k] of entries.slice(0, entries.length - MAX_TRACKS)) delete this.data.tracks[k];
    }
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* storage blocked */ }
  }
}

/** Short shareable code for a track seed (and back). */
export function seedToCode(seed) {
  return (seed >>> 0).toString(36).toUpperCase().padStart(7, '0');
}

export function codeToSeed(code) {
  const clean = String(code || '').trim().toLowerCase().replace(/[^0-9a-z]/g, '');
  if (!clean) return null;
  const n = parseInt(clean, 36);
  return Number.isFinite(n) && n <= 0xffffffff ? n >>> 0 : null;
}

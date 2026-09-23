import { TOTAL_LAPS } from './constants.js';

/**
 * Lap / checkpoint tracking and live standings.
 *
 * Checkpoints must be crossed in order; crossing checkpoint 0 (the start line) after the
 * last one completes a lap. Progress = lap * samples + sampleIndex, which is continuous
 * across the start line so standings never jump.
 */
export class RaceManager {
  constructor(track) {
    this.track = track;
    this.state = 'idle'; // idle | countdown | racing | done
    this.countdownEnd = 0;
    this.startTime = 0;
    this.finishOrder = []; // [{ slot, name, time }]
    this.onLap = null; // (kart, lapTime) => void
    this.onFinish = null; // (kart) => void
    this.standings = [];
  }

  begin(now, countdownMs) {
    this.state = 'countdown';
    this.countdownEnd = now + countdownMs;
    this.startTime = this.countdownEnd;
    this.finishOrder.length = 0;
  }

  /** Returns seconds left in the countdown (0 once racing). */
  update(now, karts) {
    if (this.state === 'countdown' && now >= this.countdownEnd) {
      this.state = 'racing';
      for (const k of karts) {
        k.controlsEnabled = true;
        k.lapStart = now;
      }
    }
    return this.state === 'countdown' ? (this.countdownEnd - now) / 1000 : 0;
  }

  elapsed(now) {
    return this.state === 'racing' || this.state === 'done' ? Math.max(0, now - this.startTime) : 0;
  }

  /** Update track index, checkpoints and laps for a locally simulated kart. */
  trackKart(k, now) {
    const tr = this.track;
    k.trackIdx = tr.nearestIndex(k.x, k.z, k.trackIdx);
    k.trackLateral = tr.lastLateral;
    if (k.finished || this.state !== 'racing') {
      k.updateProgressValue();
      return;
    }

    const S = tr.samples;
    // A checkpoint counts once the kart is anywhere in the stretch just past it; the window
    // spans almost two gaps, so a shortcut that skips a checkpoint still counts both of them.
    const window = Math.floor((S / tr.checkpointCount) * 2) - 2;
    for (let guard = 0; guard < 3 && !k.finished; guard++) {
      const cpIdx = tr.checkpointIdx[k.cpNext];
      const rel = (k.trackIdx - cpIdx + S) % S;
      if (rel >= window) break;
      if (k.cpNext === 0) {
        if (k.lap > 0) {
          const lapTime = now - k.lapStart;
          k.lastLapTime = lapTime;
          if (!k.bestLapTime || lapTime < k.bestLapTime) k.bestLapTime = lapTime;
          if (this.onLap) this.onLap(k, lapTime);
        }
        k.lap++;
        k.lapStart = now;
        if (k.lap > TOTAL_LAPS) {
          k.finished = true;
          k.finishTime = now - this.startTime;
          k.lap = TOTAL_LAPS + 1;
          if (this.onFinish) this.onFinish(k);
        }
      }
      k.cpNext = (k.cpNext + 1) % tr.checkpointCount;
    }
    k.updateProgressValue();
  }

  recordFinish(slot, name, time) {
    if (this.finishOrder.some((f) => f.slot === slot)) return false;
    this.finishOrder.push({ slot, name, time });
    this.finishOrder.sort((a, b) => a.time - b.time);
    return true;
  }

  /** Sort karts into standings (finished karts by finish time, then by progress). */
  rank(karts) {
    const st = this.standings;
    st.length = 0;
    for (let i = 0; i < karts.length; i++) st.push(karts[i]);
    st.sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished) return a.finishTime - b.finishTime;
      return b.progress - a.progress;
    });
    for (let i = 0; i < st.length; i++) st[i].rank = i + 1;
    return st;
  }
}

export function formatTime(ms) {
  if (!ms || ms < 0) ms = 0;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

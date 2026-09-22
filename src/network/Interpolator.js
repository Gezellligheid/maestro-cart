import { INTERP_DELAY_MS, MAX_EXTRAPOLATE_MS } from '../game/constants.js';
import { wrapAngle } from '../game/Kart.js';

const CAPACITY = 16;

/**
 * Snapshot buffer for one remote kart.
 *
 * Samples are stamped with the *sender's* clock, so jitter from relaying through the host
 * doesn't distort motion. We estimate the sender→local clock offset, render ~100 ms in the
 * past, and blend neighbouring snapshots with cubic Hermite splines using the transmitted
 * velocities as tangents. When packets stop arriving we dead-reckon along the last velocity.
 */
export class Interpolator {
  constructor() {
    this.t = new Float64Array(CAPACITY);
    this.x = new Float32Array(CAPACITY);
    this.y = new Float32Array(CAPACITY);
    this.z = new Float32Array(CAPACITY);
    this.yaw = new Float32Array(CAPACITY);
    this.vx = new Float32Array(CAPACITY);
    this.vy = new Float32Array(CAPACITY);
    this.vz = new Float32Array(CAPACITY);
    this.head = -1; // index of newest sample
    this.size = 0;
    this.offset = 0; // localTime - senderTime (minimum observed one-way transit)
    this.hasOffset = false;
    this.lastRecv = 0;
    // Output
    this.out = { x: 0, y: 0, z: 0, yaw: 0, vx: 0, vy: 0, vz: 0 };
  }

  reset() {
    this.head = -1;
    this.size = 0;
    this.hasOffset = false;
  }

  push(rec, localNow) {
    const senderT = rec.time;
    if (this.size > 0 && senderT <= this.t[this.head]) return; // stale / duplicate / reordered
    const off = localNow - senderT;
    if (!this.hasOffset) { this.offset = off; this.hasOffset = true; }
    else if (off < this.offset) this.offset = off; // faster path found: snap down
    else this.offset += (off - this.offset) * 0.02; // drift up slowly (clock skew / route change)

    const i = (this.head + 1) % CAPACITY;
    this.t[i] = senderT;
    this.x[i] = rec.x; this.y[i] = rec.y; this.z[i] = rec.z; this.yaw[i] = rec.yaw;
    this.vx[i] = rec.vx; this.vy[i] = rec.vy; this.vz[i] = rec.vz;
    this.head = i;
    if (this.size < CAPACITY) this.size++;
    this.lastRecv = localNow;
  }

  /** Sample the interpolated state at local time `now`. Returns false if no data yet. */
  sample(now) {
    if (this.size === 0) return false;
    const target = now - this.offset - INTERP_DELAY_MS;
    const o = this.out;
    const newest = this.head;

    if (target >= this.t[newest] || this.size === 1) {
      // Dead reckoning past the newest snapshot.
      const dt = Math.min(Math.max(0, target - this.t[newest]), MAX_EXTRAPOLATE_MS) / 1000;
      o.x = this.x[newest] + this.vx[newest] * dt;
      o.y = Math.max(0, this.y[newest] + this.vy[newest] * dt);
      o.z = this.z[newest] + this.vz[newest] * dt;
      o.yaw = this.yaw[newest];
      o.vx = this.vx[newest]; o.vy = this.vy[newest]; o.vz = this.vz[newest];
      return true;
    }

    // Walk back to find samples a (older) and b (newer) bracketing target.
    let b = newest;
    for (let n = 1; n < this.size; n++) {
      const a = (b - 1 + CAPACITY) % CAPACITY;
      if (this.t[a] <= target) {
        this._hermite(a, b, target);
        return true;
      }
      b = a;
    }
    // Target is older than everything we have: clamp to oldest.
    o.x = this.x[b]; o.y = this.y[b]; o.z = this.z[b]; o.yaw = this.yaw[b];
    o.vx = this.vx[b]; o.vy = this.vy[b]; o.vz = this.vz[b];
    return true;
  }

  _hermite(a, b, target) {
    const o = this.out;
    const span = this.t[b] - this.t[a];
    const s = span > 0 ? (target - this.t[a]) / span : 1;
    const dt = span / 1000;
    const s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1;
    const h10 = s3 - 2 * s2 + s;
    const h01 = -2 * s3 + 3 * s2;
    const h11 = s3 - s2;
    o.x = h00 * this.x[a] + h10 * dt * this.vx[a] + h01 * this.x[b] + h11 * dt * this.vx[b];
    o.y = Math.max(0, h00 * this.y[a] + h10 * dt * this.vy[a] + h01 * this.y[b] + h11 * dt * this.vy[b]);
    o.z = h00 * this.z[a] + h10 * dt * this.vz[a] + h01 * this.z[b] + h11 * dt * this.vz[b];
    o.yaw = this.yaw[a] + wrapAngle(this.yaw[b] - this.yaw[a]) * s;
    o.vx = this.vx[a] + (this.vx[b] - this.vx[a]) * s;
    o.vy = this.vy[a] + (this.vy[b] - this.vy[a]) * s;
    o.vz = this.vz[a] + (this.vz[b] - this.vz[a]) * s;
  }
}

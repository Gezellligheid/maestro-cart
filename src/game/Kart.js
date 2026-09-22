import { KART, DRIFT_TIERS, ITEM, TOTAL_LAPS } from './constants.js';
import { baseMods, MEGA } from './Upgrades.js';
import { DEFAULT_LOOK } from './Cosmetics.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const wrapAngle = (a) => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};

// Flag bits shared with the network protocol.
export const FLAG = Object.freeze({
  DRIFTING: 1,
  BOOSTING: 2,
  SPINNING: 4,
  FINISHED: 8,
  DRIFT_RIGHT: 16,
  GROUNDED: 32,
  ROLLING: 64,
  MEGA: 128,
});

/**
 * Arcade kart built on a Rapier rigid-body approximation.
 *
 * The body is a frictionless ball with locked rotations. Each fixed step we read the body's
 * velocity (which already contains wall/kart collision responses), decompose it into
 * forward / lateral components relative to our own heading, apply arcade rules
 * (acceleration curve, grip, drifting, boosts) and write the velocity back.
 *
 * `control` is one of: 'local' (keyboard), 'bot' (AI) or 'remote' (network interpolated, kinematic).
 */
export class Kart {
  constructor({ slot, name, color, look, control, physics, track, spawn }) {
    this.slot = slot;
    this.name = name;
    this.look = look || { ...DEFAULT_LOOK, color };
    this.color = this.look.color;
    this.control = control;
    this.physics = physics;
    this.track = track;
    this.simulated = control !== 'remote';

    this.body = this.simulated
      ? physics.createKartBody(spawn.x, KART.radius + 0.05, spawn.z)
      : physics.createKinematicKartBody(spawn.x, KART.radius + 0.05, spawn.z);
    this.collider = this.body.collider(0);
    this.radius = KART.radius;
    this.megaTimer = 0; // Mega: triple size for a few seconds
    this.megaScale = 1;
    this.megaRemote = false;
    this.steerInput = 0; // smoothed steering
    this.bumpX = 0; this.bumpZ = 0; // knock-back velocity from kart collisions
    this.bumpCooldown = 0;

    // Interpolated render state
    this.x = spawn.x; this.y = KART.radius; this.z = spawn.z;
    this.prevX = this.x; this.prevY = this.y; this.prevZ = this.z;
    this.yaw = spawn.yaw; this.prevYaw = spawn.yaw;
    this.vx = 0; this.vy = 0; this.vz = 0;
    // Latest authoritative-ish position used for host hit tests (== x/z for simulated karts).
    this.netX = this.x; this.netZ = this.z;
    this.renderX = this.x; this.renderY = 0; this.renderZ = this.z; this.renderYaw = this.yaw;

    this.speed = 0; // forward speed (m/s, signed)
    this.lateral = 0;
    this.steerVisual = 0;
    this.grounded = true;
    this.offroad = false;
    this.onIce = false;

    this.drifting = false;
    this.driftDir = 0; // +1 right, -1 left
    this.driftCharge = 0;
    this.driftTier = 0;
    this.driftWindow = 0;
    this.driftVisual = 0;

    this.boostTimer = 0;
    this.pendingImpulse = 0;
    this.spinTimer = 0;
    this.spinAngle = 0;
    this.speedScale = 1; // bots use < 1 for difficulty
    this.mods = baseMods(); // garage upgrades (see Upgrades.js)
    this.wheelSpin = 0;

    this.item = ITEM.NONE;
    this.rollTimer = 0; // item roulette
    this.pendingItem = ITEM.NONE;
    this.coins = 0;

    // Race progress
    this.trackIdx = track.nearestIndex(spawn.x, spawn.z, spawn.idx ?? -1);
    this.trackLateral = track.lastLateral;
    this.cpNext = 0;
    this.lap = 0;
    this.progress = 0;
    this.finished = false;
    this.finishTime = 0;
    this.lapStart = 0;
    this.lastLapTime = 0;
    this.bestLapTime = 0;
    this.rank = slot + 1;
    this.controlsEnabled = false;

    this._vel = { x: 0, y: 0, z: 0 };
    this._pos = { x: 0, y: 0, z: 0 };
    this.updateProgressValue();
  }

  get flags() {
    let f = 0;
    if (this.drifting) f |= FLAG.DRIFTING;
    if (this.boostTimer > 0) f |= FLAG.BOOSTING;
    if (this.spinTimer > 0) f |= FLAG.SPINNING;
    if (this.finished) f |= FLAG.FINISHED;
    if (this.driftDir > 0) f |= FLAG.DRIFT_RIGHT;
    if (this.grounded) f |= FLAG.GROUNDED;
    if (this.rollTimer > 0) f |= FLAG.ROLLING;
    if (this.megaTimer > 0) f |= FLAG.MEGA;
    return f;
  }

  get hasItemSlotFree() {
    return this.item === ITEM.NONE && this.rollTimer <= 0;
  }

  /** Called before world.step with the fixed dt. */
  simulate(dt, input) {
    const C = KART;
    this.prevX = this.x; this.prevY = this.y; this.prevZ = this.z; this.prevYaw = this.yaw;

    const v = this.body.linvel();
    const t = this.body.translation();

    if (this.megaTimer > 0) this.megaTimer -= dt;
    this._updateMegaScale(dt, this.megaTimer > 0);

    const gd = this.physics.groundDistance(t.x, t.y, t.z, this.radius + 0.3);
    this.grounded = gd >= 0 && v.y < 3;

    let sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // Separate out the knock-back component so the arcade model works on the kart's own motion.
    const bvx = v.x - this.bumpX, bvz = v.z - this.bumpZ;
    let fwd = bvx * sin + bvz * cos;
    let lat = bvx * -cos + bvz * sin;
    let vy = v.y;

    this.offroad = Math.abs(this.trackLateral) > this.track.roadLimit;
    this.onIce = !this.offroad && this.track.isIce(this.trackIdx, this.trackLateral);
    const iceGrip = this.onIce ? 0.12 : 1;
    const iceAccel = this.onIce ? 0.6 : 1;
    const iceTurn = this.onIce ? 0.8 : 1;

    const M = this.mods;
    const topSpeed = C.maxSpeed * this.speedScale * M.speed;
    let maxSpeed = topSpeed * (1 + Math.min(this.coins, C.coinBonusCap) * C.coinSpeedBonus);
    if (this.offroad) maxSpeed *= C.offroadFactor;
    const boosting = this.boostTimer > 0;
    if (boosting) {
      maxSpeed = topSpeed * C.boostMultiplier;
      this.boostTimer -= dt;
    }
    if (this.megaTimer > 0) maxSpeed *= 1.12;

    let throttle = this.controlsEnabled ? input.throttle : 0;
    let steer = this.controlsEnabled ? input.steer : 0;
    let driftHeld = this.controlsEnabled && input.drift;
    const driftPressed = this.controlsEnabled && input.driftPressed;
    if (this.finished && this.control === 'local') throttle = Math.min(throttle, 0.4);

    if (this.spinTimer > 0) {
      this.spinTimer -= dt;
      this.spinAngle += dt * (TAU * 1.6);
      throttle = 0; steer = 0; driftHeld = false;
      fwd *= Math.exp(-2.5 * dt);
      if (this.drifting) this._cancelDrift();
    } else {
      this.spinAngle = 0;
    }

    // Steering ramps in gradually (and recentres faster) so turns feel smooth rather than twitchy.
    const rawSteer = steer;
    const growing = Math.abs(steer) > Math.abs(this.steerInput) && steer * this.steerInput >= 0;
    const rate = (growing ? C.steerRise : C.steerFall) * dt;
    this.steerInput += clamp(steer - this.steerInput, -rate, rate);
    steer = this.steerInput;

    if (this.pendingImpulse > 0) {
      fwd = Math.max(fwd, 0) + this.pendingImpulse;
      this.pendingImpulse = 0;
    }

    if (this.driftWindow > 0) this.driftWindow -= dt;
    // A drift engages if steering is held during the hop (or shortly after landing).
    if (!this.drifting && driftHeld && this.driftWindow > 0 && Math.abs(rawSteer) > 0.3 && fwd > C.driftMinSpeed) {
      this.drifting = true;
      this.driftDir = rawSteer > 0 ? 1 : -1;
      this.driftCharge = 0;
      this.driftTier = 0;
    }

    if (this.grounded) {
      // --- longitudinal ---
      if (boosting) {
        fwd = Math.min(maxSpeed, fwd + C.boostAccel * dt);
      } else if (throttle > 0) {
        if (fwd < maxSpeed) {
          const ratio = clamp(fwd / maxSpeed, 0, 1);
          fwd = Math.min(maxSpeed, fwd + C.accel * M.accel * iceAccel * throttle * (1 - 0.55 * ratio * ratio) * dt);
        }
      } else if (throttle < 0) {
        if (fwd > 0.5) fwd = Math.max(0, fwd - C.brake * -throttle * dt);
        else fwd = Math.max(-C.reverseMax, fwd - C.accel * 0.6 * -throttle * dt);
      } else {
        fwd *= Math.exp(-C.coastDrag * dt);
      }
      if (fwd > maxSpeed) fwd = Math.max(maxSpeed, fwd - C.overspeedDecay * dt);
      if (this.offroad) fwd *= Math.exp(-C.offroadDrag * dt * (boosting ? 0.2 : 1));

      // --- hop & drift ---
      if (driftPressed) {
        vy = C.hopVelocity;
        this.grounded = false;
        this.driftWindow = C.driftWindow;
      }
      if (this.drifting && (!driftHeld || fwd < C.driftMinSpeed * 0.6)) {
        fwd += this._releaseDrift();
      }

      // --- steering ---
      const speedFactor = clamp(Math.abs(fwd) / 7, 0, 1) * (1 - C.highSpeedSteerLoss * clamp(Math.abs(fwd) / C.maxSpeed, 0, 1));
      let yawRate;
      if (this.drifting) {
        const into = rawSteer * this.driftDir; // +1 = steering into the drift
        const amount = C.driftTurnBase + C.driftTurnRange * into;
        yawRate = -this.driftDir * amount * C.turnRate * M.turn * iceTurn * C.driftTurnBoost;
        this.driftCharge += dt * (0.55 + 0.9 * Math.max(0, into)) * M.driftCharge;
        let tier = 0;
        for (let k = DRIFT_TIERS.length - 1; k > 0; k--) {
          if (this.driftCharge >= DRIFT_TIERS[k].charge) { tier = k; break; }
        }
        this.driftTier = tier;
        lat += -this.driftDir * fwd * C.driftSlide * dt;
      } else {
        yawRate = -steer * C.turnRate * M.turn * iceTurn * speedFactor * (fwd >= 0 ? 1 : -1);
      }
      this.yaw = wrapAngle(this.yaw + yawRate * dt);

      const grip = (this.drifting ? C.driftGrip : this.offroad ? C.offroadGrip : C.grip) * M.grip * iceGrip;
      lat *= Math.exp(-grip * dt);
    } else {
      // Airborne: limited steering, keep momentum. Drifts can be charged mid-hop.
      this.yaw = wrapAngle(this.yaw - steer * C.turnRate * C.airTurnFactor * dt);
      if (this.drifting && !driftHeld) fwd += this._releaseDrift();
      if (throttle > 0 && fwd < maxSpeed) fwd += C.accel * 0.3 * dt;
    }

    sin = Math.sin(this.yaw); cos = Math.cos(this.yaw);
    const vel = this._vel;
    const decay = Math.exp(-C.bumpDecay * dt);
    this.bumpX *= decay; this.bumpZ *= decay;
    if (this.bumpCooldown > 0) this.bumpCooldown -= dt;
    vel.x = sin * fwd + -cos * lat + this.bumpX;
    vel.y = vy;
    vel.z = cos * fwd + sin * lat + this.bumpZ;
    this.body.setLinvel(vel, true);

    this.speed = fwd;
    this.lateral = lat;

    // Visual helpers
    this.steerVisual += (steer - this.steerVisual) * Math.min(1, dt * 12);
    const driftTarget = this.drifting ? -this.driftDir * 0.26 : 0;
    this.driftVisual += (driftTarget - this.driftVisual) * Math.min(1, dt * 8);
    this.wheelSpin += fwd * dt / 0.3;

    if (this.rollTimer > 0) {
      this.rollTimer -= dt;
      if (this.rollTimer <= 0) {
        this.item = this.pendingItem;
        this.pendingItem = ITEM.NONE;
      }
    }
  }

  /** Called after world.step: sync position from the body, handle falling out of the world. */
  postStep() {
    const t = this.body.translation();
    const v = this.body.linvel();
    this.x = t.x; this.y = t.y; this.z = t.z;
    this.vx = v.x; this.vy = v.y; this.vz = v.z;
    if (this.y < -8) this.respawn();
    this.netX = this.x; this.netZ = this.z;
  }

  _releaseDrift() {
    const tier = DRIFT_TIERS[this.driftTier];
    this.drifting = false;
    this.driftCharge = 0;
    this.driftTier = 0;
    if (tier.duration > 0) {
      this.boostTimer = Math.max(this.boostTimer, tier.duration * this.mods.driftBoost);
      return tier.impulse * this.mods.driftBoost;
    }
    return 0;
  }

  _cancelDrift() {
    this.drifting = false;
    this.driftCharge = 0;
    this.driftTier = 0;
  }

  applyMushroom() {
    this.boostTimer = Math.max(this.boostTimer, KART.mushroomDuration);
    this.pendingImpulse += KART.mushroomImpulse;
  }

  spinOut() {
    if (this.spinTimer > 0 || this.megaTimer > 0) return false;
    this.spinTimer = KART.spinDuration;
    this.boostTimer = 0;
    this._cancelDrift();
    this.coins = Math.max(0, this.coins - 3);
    return true;
  }

  /** Knock the kart along (nx, nz) at `speed` m/s (from a kart-to-kart collision). */
  applyBump(nx, nz, speed) {
    this.bumpX += nx * speed;
    this.bumpZ += nz * speed;
    this.bumpCooldown = 0.2;
    if (this.drifting && speed > 9) this._cancelDrift();
  }

  activateMega() {
    if (this.megaTimer > 0) return false;
    this.megaTimer = MEGA.duration;
    return true;
  }

  /** Smoothly grow/shrink and resize the physics ball to match. */
  _updateMegaScale(dt, on) {
    const target = on ? MEGA.scale : 1;
    this.megaScale += (target - this.megaScale) * Math.min(1, dt * 3);
    if (Math.abs(target - this.megaScale) < 0.01) this.megaScale = target;
    const r = KART.radius * this.megaScale;
    if (Math.abs(r - this.radius) > 0.005) {
      this.radius = r;
      this.collider.setRadius(r);
    }
  }

  giveItem(item, rollTime) {
    if (!this.hasItemSlotFree) return;
    this.pendingItem = item;
    this.rollTimer = rollTime;
  }

  addCoin() {
    if (this.coins < KART.maxCoins) this.coins++;
  }

  /** Put the kart back on the centre line at its last known track sample. */
  respawn() {
    const tr = this.track;
    const i = this.trackIdx;
    const p = this._pos;
    p.x = tr.px[i]; p.y = tr.heightAt(i) + this.radius + 1.5; p.z = tr.pz[i];
    this.body.setTranslation(p, true);
    this._vel.x = 0; this._vel.y = 0; this._vel.z = 0;
    this.body.setLinvel(this._vel, true);
    this.yaw = this.prevYaw = tr.yaw[i];
    this.x = this.prevX = p.x; this.y = this.prevY = p.y; this.z = this.prevZ = p.z;
    this._cancelDrift();
    this.boostTimer = 0;
    this.bumpX = 0; this.bumpZ = 0;
  }

  /** Remote karts: move the kinematic body to the interpolated network state. */
  setRemoteState(x, y, z, yaw, vx, vy, vz) {
    this.prevX = this.x; this.prevY = this.y; this.prevZ = this.z; this.prevYaw = this.yaw;
    this.x = x; this.y = y; this.z = z; this.yaw = yaw;
    this.vx = vx; this.vy = vy; this.vz = vz;
    const p = this._pos;
    p.x = x; p.y = Math.max(y, this.radius); p.z = z;
    this.body.setNextKinematicTranslation(p);
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    this.speed = vx * sin + vz * cos;
  }

  /** Remote karts: apply presentation state received from the network. */
  applyRemoteFlags(flags, driftTier, steer) {
    this.drifting = (flags & FLAG.DRIFTING) !== 0;
    this.driftDir = (flags & FLAG.DRIFT_RIGHT) ? 1 : -1;
    this.boostTimer = (flags & FLAG.BOOSTING) ? 0.1 : 0;
    const spinning = (flags & FLAG.SPINNING) !== 0;
    this.spinTimer = spinning ? Math.max(this.spinTimer, 0.05) : 0;
    this.grounded = (flags & FLAG.GROUNDED) !== 0;
    this.megaRemote = (flags & FLAG.MEGA) !== 0;
    this.megaTimer = this.megaRemote ? 1 : 0;
    this.driftTier = driftTier;
    this.steerVisual = steer;
  }

  /** Advance remote-only visual state each frame. */
  updateRemoteVisuals(dt) {
    this._updateMegaScale(dt, this.megaRemote);
    const driftTarget = this.drifting ? -this.driftDir * 0.26 : 0;
    this.driftVisual += (driftTarget - this.driftVisual) * Math.min(1, dt * 8);
    this.wheelSpin += this.speed * dt / 0.3;
    if (this.spinTimer > 0) this.spinAngle += dt * TAU * 1.6;
    else this.spinAngle = 0;
  }

  updateProgressValue() {
    const S = this.track.samples;
    let idx = this.trackIdx;
    // Just crossed the line backwards: don't count the lap we never completed.
    if (this.cpNext === 1 && idx > S / 2) idx -= S;
    this.progress = this.lap * S + idx;
  }

  get displayLap() {
    return Math.min(TOTAL_LAPS, Math.max(1, this.lap));
  }

  destroy() {
    this.physics.removeBody(this.body);
    this.body = null;
  }
}

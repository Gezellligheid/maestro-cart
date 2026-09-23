import { KART, DRIFT_TIERS, ITEM, ITEMS, TOTAL_LAPS } from './constants.js';
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
    this.megaScale = 1; // current size multiplier (Mega grows, Lightning shrinks)
    this.shrinkTimer = 0;
    this.shieldTimer = 0;
    this.shieldPopped = false; // one-frame flag for the pop effect
    this.magnetTimer = 0;
    this.itemUses = 0; // triple mushroom charges
    this.slipTimer = 0; // oil slick
    this.confusedTimer = 0; // storm cloud: steering reversed
    this.ghostTimer = 0; // intangible, can't be hit
    this.rocketTimer = 0; // autopilot rocket
    this.stallTimer = 0; // botched start: engine stalls
    this.canTrick = false; // launched off a ramp/crest: a hop press in the air does a trick
    this.trickTimer = 0;
    this.trickDone = false;
    this._wasGrounded = true;
    this.slipCharge = 0; // slipstream build-up behind another kart
    this.drafting = false;
    this.inWater = false;
    this.megaRemote = false;
    this.steerInput = 0; // smoothed steering
    this.bumpX = 0; this.bumpZ = 0; // knock-back velocity from kart collisions
    this.bumpCooldown = 0;
    this.padCooldown = 0;
    this.airTimer = 0; // after a hop, ignore ground contact briefly so the hop isn't cancelled
    this._n = { x: 0, y: 1, z: 0 }; // ground normal under the kart

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
    if (this.shrinkTimer > 0) this.shrinkTimer -= dt;
    if (this.shieldTimer > 0) this.shieldTimer -= dt;
    if (this.magnetTimer > 0) this.magnetTimer -= dt;
    if (this.slipTimer > 0) this.slipTimer -= dt;
    if (this.confusedTimer > 0) this.confusedTimer -= dt;
    if (this.ghostTimer > 0) this.ghostTimer -= dt;
    if (this.rocketTimer > 0) this.rocketTimer -= dt;
    this._updateScale(dt);

    // Ground contact: within reach of the surface (slopes/banks included) and not mid-hop.
    if (this.airTimer > 0) this.airTimer -= dt;
    const gd = this.physics.groundProbe(t.x, t.y, t.z, this.radius * 1.3 + 0.35, this._n);
    const rest = this.radius / Math.max(0.5, this._n.y); // centre height above a touching surface
    this.grounded = gd >= 0 && this._n.y > 0.5 && this.airTimer <= 0 && gd <= rest + 0.35;
    this.touching = this.grounded && gd <= rest + 0.08;
    // Tricks: leaving the ground with upward speed (ramp or crest, not a hop) arms a trick;
    // landing after doing one gives a boost.
    if (!this.grounded && this._wasGrounded && this.airTimer <= 0 && v.y > 1.2) this.canTrick = true;
    const justLanded = this.grounded && !this._wasGrounded;
    this._wasGrounded = this.grounded;
    if (this.trickTimer > 0) this.trickTimer -= dt;
    if (justLanded) {
      if (this.trickDone) {
        this.boostTimer = Math.max(this.boostTimer, 0.75);
        this.pendingImpulse += 5;
      }
      this.trickDone = false;
      this.canTrick = false;
    }

    let sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // Separate out the knock-back component so the arcade model works on the kart's own motion.
    const bvx = v.x - this.bumpX, bvz = v.z - this.bumpZ;
    let fwd = bvx * sin + bvz * cos;
    let lat = bvx * -cos + bvz * sin;
    let vy = v.y;

    const hazard = this.track.hazardAt(this.trackIdx, this.trackLateral);
    // Sand traps behave like off-road.
    const beyond = Math.abs(this.trackLateral) > this.track.roadLimitAt(this.trackIdx);
    // Shortcut dirt paths: only a little slower than tarmac (grass is much worse).
    this.onDirt = beyond && this.track.shortcutAt(this.x, this.z);
    this.offroad = (beyond && !this.onDirt) || hazard === 'sand';
    this.onIce = hazard === 'ice';
    this.inWater = hazard === 'water';
    if (this.padCooldown > 0) this.padCooldown -= dt;
    if (this.padCooldown <= 0 && this.grounded && this.track.padAt(this.trackIdx, this.trackLateral)) {
      // Boost pad: short mushroom-style kick.
      this.boostTimer = Math.max(this.boostTimer, 0.9);
      this.pendingImpulse += 5;
      this.padCooldown = 0.6;
    }
    const iceGrip = this.onIce ? 0.12 : 1;
    const iceAccel = this.onIce ? 0.6 : 1;
    const iceTurn = this.onIce ? 0.8 : 1;

    const M = this.mods;
    const topSpeed = C.maxSpeed * this.speedScale * M.speed;
    let maxSpeed = topSpeed * (1 + Math.min(this.coins, C.coinBonusCap) * C.coinSpeedBonus);
    if (this.offroad) maxSpeed *= C.offroadFactor;
    if (this.onDirt) maxSpeed *= 0.85;
    const boosting = this.boostTimer > 0;
    if (boosting) {
      maxSpeed = topSpeed * C.boostMultiplier;
      this.boostTimer -= dt;
    }
    if (this.megaTimer > 0) maxSpeed *= 1.12;
    else if (this.shrinkTimer > 0) maxSpeed *= ITEMS.shrinkSpeed;
    if (this.inWater && !boosting) maxSpeed *= 0.78; // wading through a water crossing
    if (this.rocketTimer > 0) maxSpeed = C.maxSpeed * this.speedScale * ITEMS.rocketSpeed;

    let throttle = this.controlsEnabled ? input.throttle : 0;
    let steer = this.controlsEnabled ? input.steer : 0;
    let driftHeld = this.controlsEnabled && input.drift;
    const driftPressed = this.controlsEnabled && input.driftPressed;
    if (this.finished && this.control === 'local') throttle = Math.min(throttle, 0.4);
    if (this.confusedTimer > 0) steer = -steer; // storm cloud scrambles your steering
    if (this.stallTimer > 0) {
      this.stallTimer -= dt;
      throttle = 0; // engine stalled after a botched start
    }
    if (!this.grounded && this.canTrick && driftPressed) {
      this.trickTimer = 0.5;
      this.trickDone = true;
      this.canTrick = false;
    }
    if (this.rocketTimer > 0) {
      // Rocket autopilot: follow the racing line flat out.
      const p = this._pos;
      this.track.pointAt(this.trackIdx + 14, 0, 0, p);
      const want = Math.atan2(p.x - t.x, p.z - t.z);
      steer = clamp(-wrapAngle(want - this.yaw) * 3, -1, 1);
      throttle = 1;
      driftHeld = false;
    }

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
        this.airTimer = 0.15;
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

      const slipping = this.slipTimer > 0;
      if (slipping) {
        // Oil: tail wags side to side and you lose a little speed.
        lat += Math.sin(this.slipTimer * 14) * 18 * dt;
        fwd *= Math.exp(-0.5 * dt);
      }
      const grip = (this.drifting ? C.driftGrip : this.offroad ? C.offroadGrip : C.grip) * M.grip * iceGrip * (slipping ? 0.1 : 1);
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
    // On the ground, keep the velocity along the surface (hills, banks, ramps) instead of
    // driving horizontally into it — that's what made karts bounce. Off a jump ramp the road
    // drops away, the probe loses contact and the kart flies with its ramp velocity.
    if (this.touching && vy < 3) {
      const n = this._n;
      vel.y = -(n.x * vel.x + n.z * vel.z) / n.y;
    } else if (this.grounded && vy < 3) {
      // Just above the road (small crest): pull down firmly so the kart settles instead of floating.
      vel.y = vy - 30 * dt;
    } else {
      vel.y = vy;
    }
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
        this.itemUses = this.item === ITEM.TRIPLE ? 3 : 1;
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
    if (this.spinTimer > 0 || this.megaTimer > 0 || this.ghostTimer > 0 || this.rocketTimer > 0) return false;
    if (this.shieldTimer > 0) {
      // The bubble absorbs the hit.
      this.shieldTimer = 0;
      this.shieldPopped = true;
      return false;
    }
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
    this.shrinkTimer = 0;
    return true;
  }

  /** Lightning strike from another kart. Returns true if it took effect. */
  /** Oil slick: brief loss of grip. */
  slip() {
    if (this.ghostTimer > 0 || this.rocketTimer > 0 || this.megaTimer > 0 || this.slipTimer > 0) return false;
    if (this.drifting) this._cancelDrift();
    this.slipTimer = ITEMS.slipDuration;
    return true;
  }

  /** Storm cloud: reversed steering. */
  confuse() {
    if (this.ghostTimer > 0 || this.rocketTimer > 0) return false;
    if (this.shieldTimer > 0) { this.shieldTimer = 0; this.shieldPopped = true; return false; }
    this.confusedTimer = ITEMS.cloudDuration;
    return true;
  }

  activateGhost() {
    this.ghostTimer = ITEMS.ghostDuration;
  }

  activateRocket() {
    this.rocketTimer = ITEMS.rocketDuration;
    this.boostTimer = Math.max(this.boostTimer, 0.3);
    this.pendingImpulse += 8;
    this.spinTimer = 0;
    this.slipTimer = 0;
    this.shrinkTimer = 0;
    if (this.drifting) this._cancelDrift();
  }

  /** Dropped boost pad: same kick as a track pad. */
  hitPad() {
    if (this.padCooldown > 0) return false;
    this.boostTimer = Math.max(this.boostTimer, 0.9);
    this.pendingImpulse += 5;
    this.padCooldown = 0.6;
    return true;
  }

  /** Put an item straight into the slot (e.g. stolen with Ghost). */
  setItem(item) {
    this.item = item;
    this.itemUses = item === ITEM.TRIPLE ? 3 : 1;
    this.rollTimer = 0;
    this.pendingItem = ITEM.NONE;
  }

  /** Bits sharing the item byte: 1 = rocket, 2 = slipping, 4 = confused (shifted by 4). */
  get itemBits() {
    return ((this.rocketTimer > 0 ? 1 : 0) | (this.slipTimer > 0 ? 2 : 0) | (this.confusedTimer > 0 ? 4 : 0) | (this.trickTimer > 0 ? 8 : 0)) << 4;
  }

  applyRemoteItemBits(bits) {
    this.rocketTimer = bits & 1 ? 1 : 0;
    this.slipTimer = bits & 2 ? 1 : 0;
    this.confusedTimer = bits & 4 ? 1 : 0;
    if (bits & 8 && this.trickTimer <= 0) this.trickTimer = 0.5;
  }

  zap() {
    if (this.megaTimer > 0 || this.ghostTimer > 0 || this.rocketTimer > 0) return false;
    if (this.shieldTimer > 0) {
      this.shieldTimer = 0;
      this.shieldPopped = true;
      return false;
    }
    this.shrinkTimer = ITEMS.shrinkDuration;
    this.item = ITEM.NONE; // the bolt knocks your held item away
    this.rollTimer = 0;
    this.pendingItem = ITEM.NONE;
    this.boostTimer = 0;
    this._cancelDrift();
    return true;
  }

  activateShield() {
    this.shieldTimer = ITEMS.shieldDuration;
  }

  activateMagnet() {
    this.magnetTimer = ITEMS.magnetDuration;
  }

  /** Bits sent alongside the drift tier: 1 = shrunk, 2 = shield, 4 = magnet. */
  get extraBits() {
    return (this.shrinkTimer > 0 ? 1 : 0) | (this.shieldTimer > 0 ? 2 : 0) | (this.magnetTimer > 0 ? 4 : 0) | (this.ghostTimer > 0 ? 8 : 0);
  }

  applyRemoteExtras(bits) {
    this.shrinkTimer = bits & 1 ? 1 : 0;
    const shield = (bits & 2) !== 0;
    if (!shield && this.shieldTimer > 0) this.shieldPopped = true;
    this.shieldTimer = shield ? 1 : 0;
    this.magnetTimer = bits & 4 ? 1 : 0;
    this.ghostTimer = bits & 8 ? 1 : 0;
  }

  /** Smoothly grow/shrink (Mega / Lightning) and resize the physics ball to match. */
  _updateScale(dt) {
    const target = this.megaTimer > 0 ? MEGA.scale : this.rocketTimer > 0 ? 1.25 : this.shrinkTimer > 0 ? ITEMS.shrinkScale : 1;
    this.megaScale += (target - this.megaScale) * Math.min(1, dt * 3);
    if (Math.abs(target - this.megaScale) < 0.01) this.megaScale = target;
    // Mega, Ghost and Rocket karts don't physically collide with other karts.
    const ghost = this.megaTimer > 0 || this.ghostTimer > 0 || this.rocketTimer > 0;
    if (ghost !== this._ghost) {
      this._ghost = ghost;
      this.collider.setCollisionGroups(this.physics.kartGroups(!ghost));
    }
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
    if (this.trickTimer > 0) this.trickTimer -= dt;
    this._updateScale(dt);
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

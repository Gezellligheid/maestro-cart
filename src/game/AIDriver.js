import { ITEM } from './constants.js';
import { wrapAngle } from './Kart.js';

/**
 * Simple racing-line follower for solo-practice CPU karts. Produces the same input
 * struct as the keyboard so bots run the exact same Kart physics as players.
 */
export class AIDriver {
  constructor(kart, track, skill) {
    this.kart = kart;
    this.track = track;
    this.skill = skill; // 0..1
    this.input = { throttle: 1, steer: 0, drift: false, driftPressed: false, itemPressed: false, respawnPressed: false };
    this.laneOffset = (Math.random() - 0.5) * 8;
    this.laneTimer = 0;
    this.itemDelay = 0;
    this.stuckTimer = 0;
    this.stuckCount = 0;
    this.reverseTimer = 0;
    this._pt = { x: 0, z: 0 };
    kart.speedScale = 0.9 + skill * 0.085;
  }

  update(dt) {
    const k = this.kart;
    const tr = this.track;
    const inp = this.input;
    inp.driftPressed = false;
    inp.itemPressed = false;
    inp.respawnPressed = false;

    this.laneTimer -= dt;
    if (this.laneTimer <= 0) {
      this.laneTimer = 2 + Math.random() * 3;
      this.laneOffset = (Math.random() - 0.5) * 9;
    }

    const look = Math.round(10 + Math.max(0, k.speed) * 0.35);
    tr.pointAt(k.trackIdx + look, this.laneOffset, 0, this._pt);
    const desired = Math.atan2(this._pt.x - k.x, this._pt.z - k.z);
    const diff = wrapAngle(desired - k.yaw);

    // Curvature further ahead decides whether to drift.
    const farYaw = tr.yaw[(k.trackIdx + look * 2) % tr.samples];
    const bend = wrapAngle(farYaw - tr.yaw[k.trackIdx]);

    inp.steer = Math.max(-1, Math.min(1, -diff * 2.6));
    inp.throttle = Math.abs(diff) > 0.9 && k.speed > 15 ? 0 : 1;

    const wantDrift = Math.abs(bend) > 0.55 && k.speed > 18 && this.skill > 0.35;
    if (wantDrift && !k.drifting && k.grounded && Math.abs(inp.steer) > 0.35) {
      inp.driftPressed = true;
      inp.drift = true;
    } else if (k.drifting) {
      inp.drift = Math.abs(bend) > 0.2 || k.driftTier < 1;
      if (k.driftTier >= 2 && Math.abs(bend) < 0.35) inp.drift = false;
    } else {
      inp.drift = false;
    }

    // Items: use after a short, skill-dependent delay.
    if (k.item !== ITEM.NONE && k.rollTimer <= 0) {
      this.itemDelay += dt;
      const quick = k.item === ITEM.MUSHROOM || k.item === ITEM.GOLDEN || k.item === ITEM.FIRE || k.item === ITEM.STAR;
      const wait = quick ? 0.6 : 1.5 + (1 - this.skill) * 3;
      if (this.itemDelay > wait) {
        inp.itemPressed = true;
        this.itemDelay = 0;
      }
    }

    // Stuck against a wall: reverse briefly, respawn if that fails.
    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      // Reversing flips the steering response, so steer away from the target heading.
      inp.throttle = -1;
      inp.steer = diff > 0 ? 1 : -1;
      inp.drift = false;
    } else if (k.controlsEnabled && Math.abs(k.speed) < 2 && k.spinTimer <= 0) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 1) {
        this.reverseTimer = 0.9;
        this.stuckCount++;
        this.stuckTimer = 0;
      }
      if (this.stuckCount >= 3) {
        inp.respawnPressed = true;
        this.stuckCount = 0;
      }
    } else {
      this.stuckTimer = 0;
      if (k.speed > 10) this.stuckCount = 0;
    }
    return inp;
  }
}

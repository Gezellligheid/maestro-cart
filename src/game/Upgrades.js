// Between-round garage: performance upgrades and cosmetic parts, bought with coins.
// Each kart simulates locally, so performance upgrades only apply on the owning peer. Cosmetics
// (the "look") are sent to other players so everyone sees your kart the way you built it.

import { DEFAULT_LOOK, defaultOwned } from './Cosmetics.js';

export const MAX_LEVEL = 5;
const COSTS = [6, 10, 15, 21, 28];

export const UPGRADES = [
  { id: 'speed', name: 'Top Speed', desc: '+3.5% max speed per level', icon: 'gauge' },
  { id: 'accel', name: 'Acceleration', desc: '+9% acceleration per level', icon: 'zap' },
  { id: 'handling', name: 'Handling', desc: '+6% steering & grip per level', icon: 'rotate-cw' },
  { id: 'drift', name: 'Drift Boost', desc: '+15% mini-turbo power, faster charge', icon: 'flame' },
];

/** Mega Mushroom item (from item boxes only): triple size for 10 seconds. */
export const MEGA = { duration: 10, scale: 3 };

/** Placement bonus coins awarded at the end of a round (1st, 2nd, 3rd, rest). */
export const PLACEMENT_BONUS = [8, 5, 3, 1];

/** Neutral modifier set; Kart reads these every step. */
export function baseMods() {
  return { speed: 1, accel: 1, turn: 1, grip: 1, driftBoost: 1, driftCharge: 1 };
}

export function modsFromLevels(levels, out = baseMods()) {
  const l = (id) => levels[id] || 0;
  out.speed = 1 + 0.035 * l('speed');
  out.accel = 1 + 0.09 * l('accel');
  out.turn = 1 + 0.06 * l('handling');
  out.grip = 1 + 0.06 * l('handling');
  out.driftBoost = 1 + 0.15 * l('drift');
  out.driftCharge = 1 + 0.07 * l('drift');
  return out;
}

/**
 * Everything in the garage — wallet, upgrade levels, bought parts and the equipped look — lives
 * for one room / solo session only. Nothing is saved: leaving to the main menu resets it all.
 */
export class Garage {
  constructor() {
    this.reset();
  }

  reset() {
    this.wallet = 0;
    this.levels = { speed: 0, accel: 0, handling: 0, drift: 0 };
    this.owned = defaultOwned();
    this.look = { ...DEFAULT_LOOK };
  }

  // ------------------------------------------------ performance
  cost(id) {
    const lvl = this.levels[id];
    return lvl >= MAX_LEVEL ? Infinity : COSTS[lvl];
  }

  canBuy(id) {
    return this.cost(id) <= this.wallet;
  }

  buy(id) {
    if (!this.canBuy(id)) return false;
    this.wallet -= this.cost(id);
    this.levels[id]++;
    return true;
  }

  deposit(n) {
    this.wallet += Math.max(0, n | 0);
  }

  get mods() {
    return modsFromLevels(this.levels);
  }

  // ------------------------------------------------ cosmetics
  isOwned(slot, id) {
    return this.owned.has(`${slot}:${id}`);
  }

  /** Equip a part, buying it first if needed. Returns false if unaffordable. */
  equip(slot, part) {
    if (!this.isOwned(slot, part.id)) {
      if (this.wallet < part.price) return false;
      this.wallet -= part.price;
      this.owned.add(`${slot}:${part.id}`);
    }
    this.look[slot] = part.id;
    return true;
  }

  setPaint(which, hex) {
    this.look[which] = hex;
  }
}

/** CPU karts get free upgrades as rounds go on so solo stays competitive. */
export function botLevels(round, rand = Math.random) {
  const levels = { speed: 0, accel: 0, handling: 0, drift: 0 };
  const ids = Object.keys(levels);
  const points = Math.min(MAX_LEVEL * ids.length, Math.floor((round - 1) * 1.6));
  for (let i = 0; i < points; i++) {
    const id = ids[Math.floor(rand() * ids.length)];
    if (levels[id] < MAX_LEVEL) levels[id]++;
  }
  return levels;
}

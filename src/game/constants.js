// Shared tuning constants. Every peer must run identical values, so keep gameplay numbers here.

export const FIXED_DT = 1 / 60;
export const MAX_SUBSTEPS = 5;

export const MAX_KARTS = 8;
export const BATTLE_MS = 180000; // Balloon Battle time limit
export const BALLOONS = 3;
export const TOTAL_LAPS = 3;
export const SOLO_BOTS = 5;

export const NET_TICK_HZ = 30;
export const INTERP_DELAY_MS = 100;
export const MAX_EXTRAPOLATE_MS = 250;
export const ROOM_PREFIX = 'mkbros-v1-';

export const ITEM = Object.freeze({
  NONE: 0, SHELL: 1, BANANA: 2, MUSHROOM: 3, MEGA: 4, RED_SHELL: 5, LIGHTNING: 6, SHIELD: 7, MAGNET: 8,
  TRIPLE: 9, OIL: 10, GHOST: 11, ROCKET: 12, PAD: 13, CLOUD: 14, // item ids must stay ≤ 15 (packed in 4 bits)
});
export const ITEM_NAMES = ['', 'Green Shell', 'Banana', 'Mushroom', 'Mega Mushroom', 'Red Shell', 'Lightning Bolt', 'Bubble Shield', 'Coin Magnet',
  'Triple Mushroom', 'Oil Slick', 'Ghost', 'Rocket', 'Boost Pad', 'Storm Cloud'];

export const COLLISION = Object.freeze({ WALL: 0x0001, GROUND: 0x0002, KART: 0x0004 });

export const KART_COLORS = [
  0xe63946, // red
  0x2a9df4, // blue
  0x2ec27e, // green
  0xf4c20d, // yellow
  0x9b5de5, // purple
  0xff7f11, // orange
  0xf15bb5, // pink
  0x00c2c7, // teal
];

export const CPU_NAMES = ['Turbo Tina', 'Drift Dan', 'Nitro Nia', 'Axel', 'Pixel Pete', 'Skid Row', 'Vroomba'];

export const KART = Object.freeze({
  radius: 0.6,
  mass: 1,
  maxSpeed: 34, // m/s on tarmac
  reverseMax: 11,
  accel: 30,
  brake: 55,
  coastDrag: 0.55, // exponential linear damping when coasting
  overspeedDecay: 22, // how fast excess speed bleeds off after boosts
  turnRate: 1.75, // rad/s at full lock
  steerRise: 4.5, // how fast steering input ramps in (per second)
  steerFall: 9, // ...and recentres
  highSpeedSteerLoss: 0.35, // fraction of steering lost at top speed
  driftTurnBoost: 1.05, // drifts turn slightly tighter than grip steering
  airTurnFactor: 0.35,
  grip: 16, // lateral velocity damping on tarmac
  offroadGrip: 9,
  driftGrip: 4.2,
  driftSlide: 0.3, // outward slide injected per second while drifting
  driftMinSpeed: 12,
  driftTurnBase: 0.5,
  driftTurnRange: 0.35,
  driftWindow: 0.6, // seconds after hop in which a drift can be engaged
  hopVelocity: 5.2,
  offroadFactor: 0.52,
  offroadDrag: 1.4,
  boostMultiplier: 1.38,
  boostAccel: 70,
  coinSpeedBonus: 0.012, // +1.2% top speed per coin held...
  coinBonusCap: 10, // ...up to 10 coins
  maxCoins: 30, // coins held at the end of a round are banked for the garage
  spinDuration: 1.25,
  bumpDecay: 4.5, // how fast a collision knock-back fades (per second)
  bumpMin: 5, // minimum knock-back speed on contact (m/s)
  bumpMax: 16,
  mushroomDuration: 1.4,
  mushroomImpulse: 9,
});

// Mini-turbo tiers: charge seconds needed, boost duration, forward impulse and spark colour.
export const DRIFT_TIERS = [
  { charge: 0, duration: 0, impulse: 0, color: 0xffffff },
  { charge: 0.85, duration: 0.55, impulse: 4, color: 0x49b6ff },
  { charge: 1.8, duration: 1.0, impulse: 6.5, color: 0xff9f1c },
  { charge: 2.9, duration: 1.6, impulse: 9, color: 0xc77dff },
];

export const ITEMS = Object.freeze({
  boxRespawn: 3.5,
  rollTime: 1.1,
  shellSpeed: 50,
  shellRadius: 0.55,
  shellLife: 9,
  shellMaxBounces: 6,
  shellOwnerGrace: 0.35,
  bananaRadius: 0.6,
  coinRespawn: 8,
  redShellSpeed: 52,
  redShellLife: 12,
  redShellTurnRate: 4.5, // rad/s the homing shell can turn
  redShellLockRange: 45, // metres: closer than this it chases the target directly
  shrinkDuration: 6,
  shrinkScale: 0.55,
  shrinkSpeed: 0.72, // top-speed factor while shrunk
  shieldDuration: 15,
  magnetDuration: 8,
  magnetCoinRange: 12,
  magnetBoxRange: 5,
  oilRadius: 1.9,
  oilLife: 14,
  slipDuration: 1.3,
  ghostDuration: 6,
  rocketDuration: 3.5,
  rocketSpeed: 1.6, // top-speed multiplier while riding the rocket
  cloudDuration: 4.5,
  padLife: 25,
});

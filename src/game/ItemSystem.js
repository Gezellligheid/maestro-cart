import * as THREE from 'three';
import { box, cylinder, sphere, merge } from '../engine/geometry.js';
import { ITEM, ITEMS, KART } from './constants.js';

const SHELL_CAP = 24;
const RED_CAP = 16;
const BOX_CAP = 64; // max item boxes per track (rows × formation)
const OIL_CAP = 12;
const PAD_CAP = 8;
const CLOUD_CAP = 8;
const BANANA_CAP = 32;
const BLUE_CAP = 4;
const BOMB_CAP = 8;
const FIRE_CAP = 24;
const FAKE_CAP = 12;
// Projectiles fired forward from the kart's nose (the rest are dropped behind).
const THROWN = new Set([ITEM.SHELL, ITEM.RED_SHELL, ITEM.BLUE, ITEM.BOMB, ITEM.FIRE]);
const DROPPED = [ITEM.SHELL, ITEM.BANANA, ITEM.RED_SHELL, ITEM.OIL, ITEM.PAD, ITEM.BLUE, ITEM.BOMB, ITEM.FIRE, ITEM.FAKE];
const HIT_COLOR = {
  [ITEM.SHELL]: 0x2ec27e, [ITEM.RED_SHELL]: 0xe63946, [ITEM.BANANA]: 0xffe135,
  [ITEM.FIRE]: 0xff7b00, [ITEM.FAKE]: 0xff8fa3, [ITEM.BOMB]: 0x333333, [ITEM.BLUE]: 0x2563eb,
};
const BOX_SIZE = 1.5;
const RAINBOW = [0xff595e, 0xffca3a, 0x8ac926, 0x1982c4, 0x6a4c93, 0xff924c];

/** Preallocated projectile record; pools hand these out and take them back without allocation. */
class Projectile {
  constructor(type) {
    this.type = type;
    this.active = false;
    this.id = 0;
    this.owner = -1;
    this.idx = -1; // nearest track sample, for ground height
    this.target = -1; // red shells: slot being chased
    this.x = 0; this.y = 0; this.z = 0;
    this.vx = 0; this.vz = 0;
    this.age = 0;
    this.bounces = 0;
    this.spin = 0;
  }
}

/** Fixed-size object pool. When exhausted, the oldest live object is recycled. */
class ProjectilePool {
  constructor(type, capacity) {
    this.items = new Array(capacity);
    for (let i = 0; i < capacity; i++) this.items[i] = new Projectile(type);
    this._cursor = 0;
  }

  acquire() {
    const n = this.items.length;
    for (let k = 0; k < n; k++) {
      const p = this.items[(this._cursor + k) % n];
      if (!p.active) { this._cursor = (this._cursor + k + 1) % n; return p; }
    }
    let oldest = this.items[0];
    for (let i = 1; i < n; i++) if (this.items[i].age > oldest.age) oldest = this.items[i];
    return oldest;
  }

  findById(id) {
    for (let i = 0; i < this.items.length; i++) {
      const p = this.items[i];
      if (p.active && p.id === id) return p;
    }
    return null;
  }

  releaseAll() {
    for (let i = 0; i < this.items.length; i++) this.items[i].active = false;
  }
}

/**
 * Item boxes, coins and projectile items (green shells, bananas). Mushrooms are applied instantly.
 *
 * Authority model: the host (or solo game) owns every gameplay decision — pickups, item rolls,
 * projectile spawns and hits — and turns them into events. Events are applied locally through
 * `applyEvent()` and forwarded to peers via `onEvent`. Clients only *request* item use.
 */
export class ItemSystem {
  constructor({ renderer, physics, track, particles }) {
    this.renderer = renderer;
    this.physics = physics;
    this.track = track;
    this.particles = particles;
    this.isAuthority = true;
    this.onEvent = null; // (msg) => void   (authority: broadcast to peers)
    this.onRequest = null; // (msg) => void (client: send to host)
    this.onLocalHit = null; // (kart) => void (feedback for the local player)
    this.getKart = () => null;
    this.nextId = 1;
    this.time = 0;

    // Fixed pool; each track uses as many as it has spots for (`used`).
    this.boxes = Array.from({ length: BOX_CAP }, () => ({ x: 0, y: 0, z: 0, active: false, used: false, timer: 0, scale: 1 }));
    this._placeBoxes(track.itemBoxSpots);
    this.coins = track.coinSpots.map((s) => ({ x: s.x, y: s.y, z: s.z, active: true, timer: 0 }));
    this.shells = new ProjectilePool(ITEM.SHELL, SHELL_CAP);
    this.reds = new ProjectilePool(ITEM.RED_SHELL, RED_CAP);
    this.getKarts = () => []; // all karts, for lightning and red-shell targeting
    this.onZap = null; // (userSlot) => void, presentation hook
    this.bananas = new ProjectilePool(ITEM.BANANA, BANANA_CAP);
    this.oils = new ProjectilePool(ITEM.OIL, OIL_CAP);
    this.blues = new ProjectilePool(ITEM.BLUE, BLUE_CAP);
    this.bombs = new ProjectilePool(ITEM.BOMB, BOMB_CAP);
    this.fires = new ProjectilePool(ITEM.FIRE, FIRE_CAP);
    this.fakes = new ProjectilePool(ITEM.FAKE, FAKE_CAP);
    this._pools = [this.shells, this.reds, this.bananas, this.oils, this.blues, this.bombs, this.fires, this.fakes];
    this.onBlast = null; // (x, z) => void, presentation hook
    this.onHorn = null; // (slot) => void
    // Dropped boost pads (plain records, fixed pool).
    this.dropPads = Array.from({ length: PAD_CAP }, () => ({ active: false, id: 0, x: 0, y: 0, z: 0, yaw: 0, age: 0 }));
    this.onLocalEffect = null; // (kart, kind) => void, feedback for the local player
    this._slipCooldown = new Map(); // authority: slot -> seconds until oil can hit again

    this._buildMeshes();
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
  }

  _buildMeshes() {
    const r = this.renderer;
    const toon = r.toon({ vertexColors: true });

    // Item box: rainbow core inside a white frame.
    const h = BOX_SIZE / 2, t = 0.14;
    const frame = [];
    for (const a of [-h, h]) {
      for (const b of [-h, h]) {
        frame.push(box(BOX_SIZE + t, t, t, 0, a, b, 0xffffff));
        frame.push(box(t, BOX_SIZE + t, t, a, 0, b, 0xffffff));
        frame.push(box(t, t, BOX_SIZE + t, a, b, 0, 0xffffff));
      }
    }
    const core = new THREE.BoxGeometry(BOX_SIZE * 0.86, BOX_SIZE * 0.86, BOX_SIZE * 0.86).toNonIndexed();
    const c = new THREE.Color();
    const colors = new Float32Array(core.attributes.position.count * 3);
    for (let v = 0; v < core.attributes.position.count; v++) {
      c.setHex(RAINBOW[Math.floor(v / 6) % RAINBOW.length]);
      colors.set([c.r, c.g, c.b], v * 3);
    }
    core.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    core.deleteAttribute('uv');
    const boxGeo = merge([...frame, core]);
    this.boxMesh = this._instanced(boxGeo, toon, this.boxes.length);

    const coinGeo = merge([
      cylinder(0.55, 0.55, 0.14, 14, 0, 0, 0, 0xffc300, Math.PI / 2, 0, 0),
      cylinder(0.36, 0.36, 0.17, 12, 0, 0, 0, 0xffe066, Math.PI / 2, 0, 0),
    ]);
    this.coinMesh = this._instanced(coinGeo, toon, this.coins.length);

    const shellGeo = merge([
      sphere(0.55, 10, 6, 0, 0.12, 0, 0x2ec27e, 1, 0.75, 1),
      cylinder(0.6, 0.6, 0.18, 12, 0, 0, 0, 0xffffff),
      box(0.25, 0.1, 0.25, 0, 0.55, 0, 0xf5f5dc),
      box(0.22, 0.1, 0.22, 0.3, 0.42, 0.2, 0xf5f5dc),
      box(0.22, 0.1, 0.22, -0.3, 0.42, -0.2, 0xf5f5dc),
    ]);
    this.shellMesh = this._instanced(shellGeo, toon, SHELL_CAP);
    const redGeo = merge([
      sphere(0.55, 10, 6, 0, 0.12, 0, 0xe63946, 1, 0.75, 1),
      cylinder(0.6, 0.6, 0.18, 12, 0, 0, 0, 0xffffff),
      box(0.25, 0.1, 0.25, 0, 0.55, 0, 0xffe0e0),
      box(0.22, 0.1, 0.22, 0.3, 0.42, 0.2, 0xffe0e0),
      box(0.22, 0.1, 0.22, -0.3, 0.42, -0.2, 0xffe0e0),
    ]);
    this.redMesh = this._instanced(redGeo, toon, RED_CAP);

    const bananaGeo = merge([
      cylinder(0.16, 0.2, 0.55, 7, 0, 0.3, -0.2, 0xffe135, 0.7, 0, 0),
      cylinder(0.2, 0.2, 0.4, 7, 0, 0.45, 0.13, 0xffe135, -0.1, 0, 0),
      cylinder(0.2, 0.12, 0.45, 7, 0, 0.42, 0.45, 0xffe135, -0.9, 0, 0),
      cylinder(0.05, 0.05, 0.15, 5, 0, 0.62, 0.66, 0x5c3d1e, -0.9, 0, 0),
      cylinder(0.08, 0.05, 0.1, 5, 0, 0.12, -0.42, 0x5c3d1e, 0.7, 0, 0),
    ]);
    this.bananaMesh = this._instanced(bananaGeo, toon, BANANA_CAP);

    // Oil slick: dark puddle with a purple sheen.
    const oilGeo = merge([
      cylinder(ITEMS.oilRadius, ITEMS.oilRadius, 0.04, 16, 0, 0, 0, 0x14141c),
      cylinder(ITEMS.oilRadius * 0.55, ITEMS.oilRadius * 0.55, 0.05, 12, 0.3, 0.01, -0.2, 0x3b2f5c),
      cylinder(0.5, 0.5, 0.06, 10, -0.6, 0.02, 0.5, 0x4a4470),
    ]);
    this.oilMesh = this._instanced(oilGeo, toon, OIL_CAP);

    // Dropped boost pad: orange plate with yellow chevrons (points along +z).
    const padParts = [box(3.6, 0.06, 4.6, 0, 0, 0, 0xff7f11)];
    for (let k = 0; k < 3; k++) {
      const z = -1.4 + k * 1.3;
      padParts.push(box(1.8, 0.08, 0.35, 0.7, 0.01, z, 0xffe156, 0, -0.6, 0));
      padParts.push(box(1.8, 0.08, 0.35, -0.7, 0.01, z, 0xffe156, 0, 0.6, 0));
    }
    this.padMesh = this._instanced(merge(padParts), toon, PAD_CAP);

    // Storm cloud that hovers over a confused kart.
    const cloudGeo = merge([
      sphere(1.1, 8, 6, 0, 0, 0, 0x5b6275),
      sphere(0.9, 8, 6, 0.9, -0.1, 0.2, 0x4b5163),
      sphere(0.85, 8, 6, -0.9, -0.05, -0.1, 0x535a6d),
      sphere(0.7, 8, 6, 0.2, 0.45, -0.4, 0x656c80),
    ]);
    this.cloudMesh = this._instanced(cloudGeo, toon, CLOUD_CAP);

    // Spiny shell: blue shell with white spikes and little wings.
    const blueGeo = merge([
      sphere(0.8, 12, 8, 0, 0.15, 0, 0x2563eb, 1, 0.75, 1),
      cylinder(0.85, 0.85, 0.22, 14, 0, 0, 0, 0xffffff),
      cylinder(0.0, 0.2, 0.45, 6, 0, 0.85, 0, 0xffffff),
      cylinder(0.0, 0.18, 0.4, 6, 0.45, 0.6, 0.3, 0xffffff, 0, 0, -0.6),
      cylinder(0.0, 0.18, 0.4, 6, -0.45, 0.6, 0.3, 0xffffff, 0, 0, 0.6),
      cylinder(0.0, 0.18, 0.4, 6, 0, 0.6, -0.5, 0xffffff, -0.6, 0, 0),
      box(1.2, 0.08, 0.5, 1.1, 0.35, -0.1, 0xffffff, 0, 0, 0.35),
      box(1.2, 0.08, 0.5, -1.1, 0.35, -0.1, 0xffffff, 0, 0, -0.35),
    ]);
    this.blueMesh = this._instanced(blueGeo, toon, BLUE_CAP);

    const bombGeo = merge([
      sphere(0.75, 12, 10, 0, 0.75, 0, 0x1f2230),
      cylinder(0.25, 0.25, 0.25, 8, 0, 1.55, 0, 0x9aa1b2),
      cylinder(0.05, 0.05, 0.35, 5, 0, 1.8, 0, 0x8a6d3b),
      box(0.12, 0.35, 0.12, 0.55, 0.45, -0.35, 0xf4c20d),
      box(0.12, 0.35, 0.12, -0.55, 0.45, -0.35, 0xf4c20d),
      sphere(0.14, 6, 4, 0.25, 0.95, 0.62, 0xffffff),
      sphere(0.14, 6, 4, -0.25, 0.95, 0.62, 0xffffff),
    ]);
    this.bombMesh = this._instanced(bombGeo, toon, BOMB_CAP);

    const fireGeo = merge([
      sphere(0.55, 10, 8, 0, 0, 0, 0xff6b1a),
      sphere(0.38, 8, 6, 0, 0.05, 0.12, 0xffd23f),
    ]);
    this.fireMesh = this._instanced(fireGeo, this.renderer.basic({ vertexColors: true }), FIRE_CAP);

    // Fake item box: like the real thing, but pinkish with an upside-down look.
    const fh = BOX_SIZE / 2;
    const fakeFrame = [];
    for (const a of [-fh, fh]) {
      for (const b of [-fh, fh]) {
        fakeFrame.push(box(BOX_SIZE + t, t, t, 0, a, b, 0xffc2cf));
        fakeFrame.push(box(t, BOX_SIZE + t, t, a, 0, b, 0xffc2cf));
        fakeFrame.push(box(t, t, BOX_SIZE + t, a, b, 0, 0xffc2cf));
      }
    }
    const fakeCore = box(BOX_SIZE * 0.86, BOX_SIZE * 0.86, BOX_SIZE * 0.86, 0, 0, 0, 0xff5c7a);
    this.fakeMesh = this._instanced(merge([...fakeFrame, fakeCore]), toon, FAKE_CAP);
  }

  _instanced(geo, mat, count) {
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    this.renderer.scene.add(mesh);
    return mesh;
  }

  /** Re-read box/coin positions after the track was regenerated (counts never change). */
  syncWithTrack() {
    this._placeBoxes(this.track.itemBoxSpots);
    this.track.coinSpots.forEach((s, i) => Object.assign(this.coins[i], { x: s.x, y: s.y, z: s.z }));
  }

  /** Balloon Battle: no coins on track. */
  disableCoins() {
    for (const c of this.coins) { c.active = false; c.timer = Infinity; }
  }

  /** Time trial: no item boxes on track. */
  clearBoxes() {
    this._placeBoxes([]);
  }

  _placeBoxes(spots) {
    this.boxes.forEach((b, i) => {
      const s = spots[i];
      b.used = !!s;
      b.active = b.used;
      b.timer = 0;
      b.scale = 1;
      if (s) { b.x = s.x; b.y = s.y; b.z = s.z; }
    });
  }

  reset() {
    for (const b of this.boxes) { b.active = b.used; b.timer = 0; b.scale = 1; }
    for (const c of this.coins) { c.active = true; c.timer = 0; }
    this.shells.releaseAll();
    this.reds.releaseAll();
    this.bananas.releaseAll();
    this.oils.releaseAll();
    this.blues.releaseAll();
    this.bombs.releaseAll();
    this.fires.releaseAll();
    this.fakes.releaseAll();
    for (const p of this.dropPads) p.active = false;
    this._slipCooldown.clear();
    this.nextId = 1;
  }

  // ---------------------------------------------------------------- item use

  /** Fire the kart's held item. Works for the local player and for bots. */
  useItem(kart) {
    if (kart.item === ITEM.NONE || kart.rollTimer > 0 || kart.spinTimer > 0) return false;
    const it = kart.item;
    kart.item = ITEM.NONE;
    if (it === ITEM.TRIPLE) {
      kart.applyMushroom();
      kart.itemUses--;
      if (kart.itemUses > 0) kart.item = ITEM.TRIPLE; // keep the rest in the slot
      return true;
    }
    if (it === ITEM.ROCKET) {
      kart.activateRocket();
      return true;
    }
    if (it === ITEM.GOLDEN) {
      kart.activateGolden();
      kart.item = ITEM.GOLDEN; // stays in the slot until the timer runs out
      return true;
    }
    if (it === ITEM.STAR) {
      kart.activateStar();
      return true;
    }
    if (it === ITEM.FIRE) {
      kart.itemUses--;
      if (kart.itemUses > 0) kart.item = ITEM.FIRE; // five fireballs per flower
    }
    if (it === ITEM.HORN && this.isAuthority) {
      this._emit({ t: 'horn', s: kart.slot });
      return true;
    }
    if (it === ITEM.GHOST) {
      kart.activateGhost();
      if (this.isAuthority) this._steal(kart.slot);
      else if (this.onRequest) this.onRequest({ t: 'use', k: it, s: kart.slot });
      return true;
    }
    if (it === ITEM.CLOUD && this.isAuthority) {
      this._cloud(kart.slot);
      return true;
    }
    if (it === ITEM.MUSHROOM) {
      kart.applyMushroom();
      return true;
    }
    if (it === ITEM.MEGA) {
      kart.activateMega();
      return true;
    }
    if (it === ITEM.SHIELD) {
      kart.activateShield();
      return true;
    }
    if (it === ITEM.MAGNET) {
      kart.activateMagnet();
      return true;
    }
    if (it === ITEM.LIGHTNING && this.isAuthority) {
      this._emit({ t: 'zap', s: kart.slot });
      return true;
    }
    if (this.isAuthority) {
      this.spawnFromKart(it, kart.slot, kart.x, kart.z, kart.yaw, kart.speed);
    } else if (this.onRequest) {
      this.onRequest({ t: 'use', k: it, s: kart.slot, x: kart.x, z: kart.z, yaw: kart.yaw, spd: kart.speed });
    }
    return true;
  }

  /** Authority: handle an item-use request from a client. */
  handleRequest(msg, fromSlot) {
    if (!this.isAuthority || msg.t !== 'use' || msg.s !== fromSlot) return;
    if (msg.k === ITEM.LIGHTNING) {
      this._emit({ t: 'zap', s: fromSlot });
      return;
    }
    if (msg.k === ITEM.GHOST) { this._steal(fromSlot); return; }
    if (msg.k === ITEM.CLOUD) { this._cloud(fromSlot); return; }
    if (msg.k === ITEM.HORN) { this._emit({ t: 'horn', s: fromSlot }); return; }
    if (!DROPPED.includes(msg.k)) return;
    this.spawnFromKart(msg.k, fromSlot, +msg.x || 0, +msg.z || 0, +msg.yaw || 0, +msg.spd || 0);
  }

  spawnFromKart(type, owner, x, z, yaw, speed) {
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    let px, pz, vx = 0, vz = 0;
    let target = -1;
    if (type === ITEM.RED_SHELL) {
      // Chase whoever is one place ahead of the thrower.
      const me = this.getKart(owner);
      const ahead = me && this.getKarts().find((k) => k.rank === me.rank - 1 && !k.finished);
      target = ahead ? ahead.slot : -1;
    }
    if (type === ITEM.BLUE) {
      // Spiny shell: goes for the leader (or 2nd place when the leader threw it).
      const karts = this.getKarts();
      const lead = karts.find((k) => k.rank === 1 && k.slot !== owner && !k.finished)
        || karts.find((k) => k.rank === 2 && k.slot !== owner && !k.finished);
      target = lead ? lead.slot : -1;
    }
    if (THROWN.has(type)) {
      px = x + sin * 2.4;
      pz = z + cos * 2.4;
      const v = type === ITEM.RED_SHELL ? Math.max(ITEMS.redShellSpeed, speed + 14)
        : type === ITEM.BLUE ? ITEMS.blueSpeed
          : type === ITEM.BOMB ? Math.max(ITEMS.bombSpeed, speed + 8)
            : type === ITEM.FIRE ? Math.max(ITEMS.fireSpeed, speed + 16)
              : Math.max(ITEMS.shellSpeed, speed + 20);
      vx = sin * v;
      vz = cos * v;
      // Don't spawn inside a barrier when hugging a wall.
      const idx0 = this.track.nearestIndex(x, z, -1);
      const hit = this.physics.castWall(x, this.track.roadY(idx0, this.track.lastLateral) + 0.5, z, sin, cos, 2.4 + ITEMS.shellRadius);
      if (hit) { px = x; pz = z; }
    } else {
      // Dropped behind the kart; oil and pads sit a little further back.
      const back = type === ITEM.PAD ? 5.5 : type === ITEM.OIL ? 3.2 : 2.2;
      px = x - sin * back;
      pz = z - cos * back;
    }
    const id = this.nextId;
    this.nextId = this.nextId >= 60000 ? 1 : this.nextId + 1;
    if (type === ITEM.PAD) {
      this._emit({ t: 'pad', id, x: px, z: pz, yaw });
      return;
    }
    this._emit({ t: 'spawn', k: type, id, o: owner, x: px, z: pz, vx, vz, tg: target });
  }

  /** Ghost: steal a random rival's item, preferring karts ahead of the thief. */
  _steal(thiefSlot) {
    const thief = this.getKart(thiefSlot);
    const victims = this.getKarts().filter((k) => k !== thief && k.item !== ITEM.NONE && !(k.rollTimer > 0));
    if (!thief || victims.length === 0) {
      this._emit({ t: 'steal', from: -1, to: thiefSlot, it: ITEM.NONE });
      return;
    }
    const ahead = victims.filter((k) => k.rank < thief.rank);
    const pool = ahead.length ? ahead : victims;
    const v = pool[Math.floor(Math.random() * pool.length)];
    this._emit({ t: 'steal', from: v.slot, to: thiefSlot, it: v.item });
  }

  /** Storm cloud: hovers over the leader (never the user). */
  _cloud(userSlot) {
    const leader = this.getKarts().find((k) => k.rank === 1 && k.slot !== userSlot && !k.finished)
      || this.getKarts().find((k) => k.rank === 2 && k.slot !== userSlot && !k.finished);
    if (leader) this._emit({ t: 'cloud', s: leader.slot, by: userSlot });
  }

  // ---------------------------------------------------------------- events

  _emit(msg) {
    this.applyEvent(msg);
    if (this.onEvent) this.onEvent(msg);
  }

  /** Apply an authoritative event (from ourselves or from the host). */
  applyEvent(msg) {
    switch (msg.t) {
      case 'box': {
        const b = this.boxes[msg.i];
        if (!b) return;
        b.active = false;
        b.timer = ITEMS.boxRespawn;
        b.scale = 0;
        this.particles.burst(b.x, b.y + 1.2, b.z, 18, 9, 0.7, 0.35, RAINBOW[(Math.random() * RAINBOW.length) | 0], -10);
        const k = this.getKart(msg.s);
        if (k && k.simulated && msg.it) k.giveItem(msg.it, ITEMS.rollTime);
        break;
      }
      case 'coin': {
        const c = this.coins[msg.i];
        if (!c) return;
        c.active = false;
        c.timer = ITEMS.coinRespawn;
        this.particles.burst(c.x, c.y + 1, c.z, 6, 4, 0.4, 0.25, 0xffd60a, -8);
        const k = this.getKart(msg.s);
        if (k && k.simulated) k.addCoin();
        break;
      }
      case 'spawn': {
        const pool = this._poolFor(msg.k);
        const p = pool.acquire();
        p.active = true;
        p.id = msg.id;
        p.owner = msg.o;
        p.x = msg.x; p.z = msg.z;
        p.idx = this.track.nearestIndex(p.x, p.z, -1);
        const lift = { [ITEM.BANANA]: 0.05, [ITEM.OIL]: 0.07, [ITEM.FAKE]: 0.05, [ITEM.BOMB]: 0.05, [ITEM.BLUE]: 3.5, [ITEM.FIRE]: 0.6 }[msg.k];
        p.y = this.track.roadY(p.idx, this.track.lastLateral) + (lift ?? 0.5);
        p.target = Number.isInteger(msg.tg) ? msg.tg : -1;
        p.vx = msg.vx; p.vz = msg.vz;
        p.age = 0;
        p.bounces = 0;
        break;
      }
      case 'hit': {
        const p = this._find(msg.id);
        if (p) {
          p.active = false;
          const col = HIT_COLOR[p.type] ?? 0xffe135;
          this.particles.burst(p.x, p.y + 0.3, p.z, 14, 7, 0.6, 0.3, col, -12);
        }
        const k = this.getKart(msg.s);
        if (k && k.simulated && k.spinOut() && this.onLocalHit) this.onLocalHit(k);
        break;
      }
      case 'despawn': {
        const p = this._find(msg.id);
        if (p) {
          p.active = false;
          this.particles.burst(p.x, p.y + 0.1, p.z, 8, 5, 0.4, 0.25, 0xffffff, -10);
        }
        break;
      }
      case 'pad': {
        // Dropped boost pad: reuse the oldest slot if all are taken.
        let slot = this.dropPads.find((p) => !p.active);
        if (!slot) slot = this.dropPads.reduce((a, b) => (a.age > b.age ? a : b));
        const idx = this.track.nearestIndex(msg.x, msg.z, -1);
        Object.assign(slot, { active: true, id: msg.id, x: msg.x, z: msg.z, yaw: msg.yaw, age: 0, y: this.track.roadY(idx, this.track.lastLateral) + 0.06 });
        break;
      }
      case 'slip': {
        const k = this.getKart(msg.s);
        if (k) this.particles.burst(k.x, k.y, k.z, 10, 4, 0.5, 0.3, 0x2a2438, -8);
        if (k && k.simulated && k.slip() && this.onLocalEffect) this.onLocalEffect(k, 'slip');
        break;
      }
      case 'cloud': {
        const k = this.getKart(msg.s);
        if (k && k.simulated && k.confuse() && this.onLocalEffect) this.onLocalEffect(k, 'confused');
        break;
      }
      case 'steal': {
        const from = this.getKart(msg.from), to = this.getKart(msg.to);
        if (from && from.simulated && msg.it) {
          from.item = ITEM.NONE;
          from.itemUses = 0;
          if (this.onLocalEffect) this.onLocalEffect(from, 'robbed');
        }
        if (to && to.simulated && msg.it && to.item === ITEM.NONE) {
          to.setItem(msg.it);
          if (this.onLocalEffect) this.onLocalEffect(to, 'stole');
        }
        if (from) this.particles.burst(from.x, from.y + 1.5, from.z, 10, 4, 0.5, 0.3, 0xc9b8ff, -2);
        break;
      }
      case 'blast': {
        // Bomb / spiny-shell explosion: everyone the peer simulates inside the radius spins out.
        const p = msg.id ? this._find(msg.id) : null;
        if (p) p.active = false;
        const y = this.track.roadY(this.track.nearestIndex(msg.x, msg.z, -1), this.track.lastLateral);
        this.particles.burst(msg.x, y + 1.2, msg.z, 40, 14, 0.8, 0.7, 0xff7b00, -6);
        this.particles.burst(msg.x, y + 1.5, msg.z, 30, 10, 0.9, 0.6, 0xffd23f, -4);
        this.particles.burst(msg.x, y + 2, msg.z, 20, 5, 1.4, 0.9, 0x3a3a3a, 1);
        const r2 = msg.r * msg.r;
        for (const k of this.getKarts()) {
          if (!k.simulated) continue;
          const dx = k.x - msg.x, dz = k.z - msg.z;
          if (dx * dx + dz * dz < r2 && Math.abs(k.y - y) < 6 && k.spinOut() && this.onLocalHit) this.onLocalHit(k);
        }
        if (this.onBlast) this.onBlast(msg.x, msg.z);
        break;
      }
      case 'horn': {
        // Super Horn: shockwave that spins nearby karts and wipes out nearby items (spiny shells too).
        const u = this.getKart(msg.s);
        if (!u) break;
        const R = ITEMS.hornRadius, r2 = R * R;
        for (let n = 0; n < 36; n++) {
          const a = (n / 36) * Math.PI * 2;
          this.particles.spawn(u.x, u.y + 0.6, u.z, Math.cos(a) * R * 2.2, 0.5, Math.sin(a) * R * 2.2, 0.45, 0.45, n % 2 ? 0xffe156 : 0xffffff, 0);
        }
        for (const k of this.getKarts()) {
          if (k === u || !k.simulated) continue;
          const dx = k.x - u.x, dz = k.z - u.z;
          if (dx * dx + dz * dz < r2 && Math.abs(k.y - u.y) < 5 && k.spinOut() && this.onLocalHit) this.onLocalHit(k);
        }
        for (const pool of this._pools) {
          for (const p of pool.items) {
            if (!p.active || (p.owner === msg.s && p.age < 0.5)) continue;
            const dx = p.x - u.x, dz = p.z - u.z;
            if (dx * dx + dz * dz < r2) {
              p.active = false;
              this.particles.burst(p.x, p.y + 0.3, p.z, 8, 5, 0.4, 0.25, 0xffffff, -8);
            }
          }
        }
        if (this.onHorn) this.onHorn(msg.s);
        break;
      }
      case 'zap': {
        // Lightning: every other kart shrinks. Each peer applies it to the karts it simulates.
        const karts = this.getKarts();
        for (let i = 0; i < karts.length; i++) {
          const k = karts[i];
          if (k.slot === msg.s) continue;
          this.particles.burst(k.x, k.y + 2.5, k.z, 10, 6, 0.5, 0.35, 0xfff176, -18);
          if (k.simulated) k.zap();
        }
        if (this.onZap) this.onZap(msg.s);
        break;
      }
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- simulation

  _find(id) {
    for (const pool of this._pools) {
      const p = pool.findById(id);
      if (p) return p;
    }
    return null;
  }

  _poolFor(type) {
    return {
      [ITEM.SHELL]: this.shells, [ITEM.RED_SHELL]: this.reds, [ITEM.OIL]: this.oils, [ITEM.BLUE]: this.blues,
      [ITEM.BOMB]: this.bombs, [ITEM.FIRE]: this.fires, [ITEM.FAKE]: this.fakes,
    }[type] || this.bananas;
  }

  /** Weighted item roll: leaders get defensive items, karts at the back get catch-up items. */
  _rollItem(kart, total) {
    const t = total > 1 ? (kart.rank - 1) / (total - 1) : 0.5; // 0 = leader, 1 = last
    const table = [
      [ITEM.BANANA, 0.5 - 0.4 * t],
      [ITEM.SHELL, 0.35],
      [ITEM.MUSHROOM, 0.1 + 0.35 * t],
      [ITEM.SHIELD, 0.25 - 0.2 * t],
      [ITEM.MAGNET, 0.1],
      [ITEM.RED_SHELL, kart.rank > 1 ? 0.08 + 0.25 * t : 0], // nobody to chase from 1st
      [ITEM.MEGA, 0.02 + 0.11 * t],
      [ITEM.LIGHTNING, t > 0.5 ? 0.14 * (t - 0.5) * 2 : 0], // back half only
      [ITEM.TRIPLE, 0.04 + 0.18 * t],
      [ITEM.OIL, 0.18 - 0.1 * t],
      [ITEM.GHOST, t > 0.15 && t < 0.9 ? 0.07 : 0],
      [ITEM.ROCKET, t > 0.65 ? 0.22 * (t - 0.65) / 0.35 : 0], // last places only
      [ITEM.PAD, 0.08],
      [ITEM.CLOUD, kart.rank > 1 && t > 0.25 ? 0.07 : 0], // never from 1st
      [ITEM.FAKE, 0.14 - 0.1 * t],
      [ITEM.BOMB, 0.06 + 0.06 * t],
      [ITEM.FIRE, 0.07],
      [ITEM.HORN, 0.1 - 0.07 * t], // leaders' answer to the spiny shell
      [ITEM.GOLDEN, t > 0.35 ? 0.12 * t : 0],
      [ITEM.STAR, t > 0.5 ? 0.14 * (t - 0.5) * 2 : 0],
      [ITEM.BLUE, kart.rank > 2 && t > 0.4 ? 0.05 : 0], // rare, never from the front
    ];
    let sum = 0;
    for (const [, w] of table) sum += Math.max(0, w);
    let r = Math.random() * sum;
    for (const [it, w] of table) {
      r -= Math.max(0, w);
      if (r <= 0) return it;
    }
    return ITEM.BANANA;
  }

  fixedUpdate(dt, karts) {
    this.time += dt;

    for (const b of this.boxes) {
      if (!b.used) continue;
      if (!b.active) {
        b.timer -= dt;
        if (b.timer <= 0) b.active = true;
      } else if (b.scale < 1) {
        b.scale = Math.min(1, b.scale + dt * 3);
      }
    }
    for (const c of this.coins) {
      if (!c.active) {
        c.timer -= dt;
        if (c.timer <= 0) c.active = true;
      }
    }

    this._updateShells(dt);
    this._updateReds(dt);
    this._updateBlues(dt);
    this._bounceAlong(this.bombs, dt, 30, 4, 0x333333, 0.05, 2.2);
    this._bounceAlong(this.fires, dt, ITEMS.fireLife, 8, 0xff7b00, 0.6, 0);
    for (const f of this.fakes.items) if (f.active) f.age += dt;
    for (const f of this.fires.items) if (f.active && Math.random() < 0.5) this.particles.spawn(f.x, f.y, f.z, 0, 1, 0, 0.25, 0.3, Math.random() < 0.5 ? 0xffd23f : 0xff5a1f, 0);
    const bananas = this.bananas.items;
    for (let i = 0; i < bananas.length; i++) if (bananas[i].active) bananas[i].age += dt;
    const oils = this.oils.items;
    for (let i = 0; i < oils.length; i++) {
      const o = oils[i];
      if (!o.active) continue;
      o.age += dt;
      if (o.age > ITEMS.oilLife) o.active = false;
    }
    // Dropped boost pads: every peer applies them to the karts it simulates.
    for (const p of this.dropPads) {
      if (!p.active) continue;
      p.age += dt;
      if (p.age > ITEMS.padLife) { p.active = false; continue; }
      for (let i = 0; i < karts.length; i++) {
        const k = karts[i];
        if (!k.simulated) continue;
        const dx = k.x - p.x, dz = k.z - p.z;
        if (dx * dx + dz * dz < 2.6 * 2.6 && Math.abs(k.y - k.radius - p.y) < 2 && k.hitPad()) {
          this.particles.burst(p.x, p.y + 0.3, p.z, 8, 5, 0.3, 0.25, 0xffb703, -6);
        }
      }
    }
    for (const [slot, t] of this._slipCooldown) this._slipCooldown.set(slot, t - dt);

    if (this.isAuthority) this._authorityChecks(karts);
  }

  _updateShells(dt) {
    const shells = this.shells.items;
    const R = ITEMS.shellRadius;
    for (let i = 0; i < shells.length; i++) {
      const s = shells[i];
      if (!s.active) continue;
      s.age += dt;
      s.spin += dt * 14;
      if (s.age > ITEMS.shellLife) { s.active = false; continue; }
      const speed = Math.hypot(s.vx, s.vz);
      if (speed < 0.001) continue;
      const dx = s.vx / speed, dz = s.vz / speed;
      const dist = speed * dt;
      s.idx = this.track.nearestIndex(s.x, s.z, s.idx);
      s.y = this.track.roadY(s.idx, this.track.lastLateral) + 0.5;
      const hit = this.physics.castWall(s.x, s.y, s.z, dx, dz, dist + R);
      if (hit) {
        const travel = Math.max(0, hit.timeOfImpact - R);
        s.x += dx * travel;
        s.z += dz * travel;
        const nx = hit.normal.x, nz = hit.normal.z;
        const nl = Math.hypot(nx, nz) || 1;
        const dot = (s.vx * nx + s.vz * nz) / nl;
        s.vx -= (2 * dot * nx) / nl;
        s.vz -= (2 * dot * nz) / nl;
        s.bounces++;
        this.particles.burst(s.x, 0.5, s.z, 4, 4, 0.25, 0.2, 0xffffff, -6);
        if (s.bounces > ITEMS.shellMaxBounces) {
          s.active = false;
          this.particles.burst(s.x, 0.6, s.z, 8, 5, 0.4, 0.25, 0x2ec27e, -10);
        }
      } else {
        s.x += s.vx * dt;
        s.z += s.vz * dt;
      }
    }
  }

  /**
   * Generic bouncing projectile (bombs, fireballs): slides along the road, bounces off walls,
   * slows down with `drag` and expires after `life` seconds.
   */
  _bounceAlong(pool, dt, life, maxBounces, color, lift, drag) {
    const R = 0.5;
    for (const s of pool.items) {
      if (!s.active) continue;
      s.age += dt;
      s.spin += dt * 10;
      if (s.age > life) {
        s.active = false;
        continue;
      }
      if (drag) {
        const f = Math.exp(-drag * dt);
        s.vx *= f; s.vz *= f;
      }
      const speed = Math.hypot(s.vx, s.vz);
      s.idx = this.track.nearestIndex(s.x, s.z, s.idx);
      s.y = this.track.roadY(s.idx, this.track.lastLateral) + lift;
      if (speed < 0.05) continue;
      const dx = s.vx / speed, dz = s.vz / speed;
      const hit = this.physics.castWall(s.x, s.y + 0.4, s.z, dx, dz, speed * dt + R);
      if (hit) {
        const nx = hit.normal.x, nz = hit.normal.z;
        const nl = Math.hypot(nx, nz) || 1;
        const dot = (s.vx * nx + s.vz * nz) / nl;
        s.vx -= (2 * dot * nx) / nl;
        s.vz -= (2 * dot * nz) / nl;
        if (++s.bounces > maxBounces) {
          s.active = false;
          this.particles.burst(s.x, s.y + 0.3, s.z, 8, 5, 0.4, 0.25, color, -10);
        }
      } else {
        s.x += s.vx * dt;
        s.z += s.vz * dt;
      }
    }
  }

  /** Spiny shells fly above the racing line, then dive onto their target. Walls don't stop them. */
  _updateBlues(dt) {
    const pt = this._pt || (this._pt = { x: 0, z: 0 });
    for (const s of this.blues.items) {
      if (!s.active) continue;
      s.age += dt;
      s.spin += dt * 9;
      if (s.age > ITEMS.blueLife) { s.active = false; continue; }
      s.idx = this.track.nearestIndex(s.x, s.z, s.idx);
      const tk = s.target >= 0 ? this.getKart(s.target) : null;
      const tdx = tk ? tk.netX - s.x : 0, tdz = tk ? tk.netZ - s.z : 0;
      const close = tk && !tk.finished && tdx * tdx + tdz * tdz < 30 * 30;
      let ax, az, ay;
      if (close) {
        ax = tk.netX; az = tk.netZ; ay = tk.y + 0.4;
      } else {
        this.track.pointAt(s.idx + 12, 0, 0, pt);
        ax = pt.x; az = pt.z;
        ay = this.track.roadY(s.idx, 0) + 3.5;
      }
      const cur = Math.atan2(s.vx, s.vz);
      const want = Math.atan2(ax - s.x, az - s.z);
      let diff = Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
      const maxTurn = 7 * dt;
      diff = Math.max(-maxTurn, Math.min(maxTurn, diff));
      const heading = cur + diff;
      const speed = close ? ITEMS.blueSpeed * 1.15 : ITEMS.blueSpeed;
      s.vx = Math.sin(heading) * speed;
      s.vz = Math.cos(heading) * speed;
      s.x += s.vx * dt;
      s.z += s.vz * dt;
      s.y += (ay - s.y) * Math.min(1, dt * (close ? 6 : 3));
      if (Math.random() < 0.5) this.particles.spawn(s.x, s.y, s.z, 0, 0.5, 0, 0.35, 0.25, 0x93c5fd, 0);
    }
  }

  /**
   * Red shells follow the racing line and home in on their target once close. They shatter on
   * walls instead of bouncing. Every peer runs the same steering so they look consistent.
   */
  _updateReds(dt) {
    const reds = this.reds.items;
    const R = ITEMS.shellRadius;
    const pt = this._pt || (this._pt = { x: 0, z: 0 });
    for (let i = 0; i < reds.length; i++) {
      const s = reds[i];
      if (!s.active) continue;
      s.age += dt;
      s.spin += dt * 16;
      if (s.age > ITEMS.redShellLife) { s.active = false; continue; }
      s.idx = this.track.nearestIndex(s.x, s.z, s.idx);
      s.y = this.track.roadY(s.idx, this.track.lastLateral) + 0.5;

      // Pick an aim point: the target when close, otherwise a point further along the track.
      const tk = s.target >= 0 ? this.getKart(s.target) : null;
      let ax, az;
      const tdx = tk ? tk.netX - s.x : 0, tdz = tk ? tk.netZ - s.z : 0;
      if (tk && !tk.finished && tdx * tdx + tdz * tdz < ITEMS.redShellLockRange ** 2) {
        ax = tk.netX; az = tk.netZ;
      } else {
        this.track.pointAt(s.idx + 10, 0, 0, pt);
        ax = pt.x; az = pt.z;
      }
      const speed = Math.hypot(s.vx, s.vz) || ITEMS.redShellSpeed;
      const cur = Math.atan2(s.vx, s.vz);
      const want = Math.atan2(ax - s.x, az - s.z);
      let diff = Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
      const maxTurn = ITEMS.redShellTurnRate * dt;
      diff = Math.max(-maxTurn, Math.min(maxTurn, diff));
      const heading = cur + diff;
      s.vx = Math.sin(heading) * speed;
      s.vz = Math.cos(heading) * speed;

      const dx = Math.sin(heading), dz = Math.cos(heading);
      const hit = this.physics.castWall(s.x, s.y, s.z, dx, dz, speed * dt + R);
      if (hit) {
        s.active = false;
        this.particles.burst(s.x, s.y, s.z, 10, 6, 0.4, 0.3, 0xe63946, -10);
        continue;
      }
      s.x += s.vx * dt;
      s.z += s.vz * dt;
      if (Math.random() < 0.3) this.particles.spawn(s.x, s.y, s.z, 0, 0.6, 0, 0.3, 0.2, 0xff8a8a, 0);
    }
  }

  _authorityChecks(karts) {
    const total = karts.length;
    const boxR2 = (BOX_SIZE * 0.5 + KART.radius + 0.4) ** 2;
    const coinR2 = (0.6 + KART.radius + 0.3) ** 2;
    const magnetCoinR2 = ITEMS.magnetCoinRange ** 2;
    const magnetBoxR2 = (BOX_SIZE * 0.5 + KART.radius + ITEMS.magnetBoxRange) ** 2;

    for (let ki = 0; ki < karts.length; ki++) {
      const k = karts[ki];
      const kx = k.netX, kz = k.netZ;
      const ky = k.y - k.radius; // kart base height
      const magnet = k.magnetTimer > 0;
      const boxReach = magnet ? magnetBoxR2 : boxR2;
      const coinReach = magnet ? magnetCoinR2 : coinR2;

      for (let i = 0; i < this.boxes.length; i++) {
        const b = this.boxes[i];
        if (!b.active) continue;
        const dx = kx - b.x, dz = kz - b.z;
        if (Math.abs(ky - b.y) > 4) continue;
        if (dx * dx + dz * dz < boxReach) {
          const it = k.hasItemSlotFree ? this._rollItem(k, total) : ITEM.NONE;
          this._emit({ t: 'box', i, s: k.slot, it });
        }
      }

      for (let i = 0; i < this.coins.length; i++) {
        const c = this.coins[i];
        if (!c.active) continue;
        const dx = kx - c.x, dz = kz - c.z;
        if (Math.abs(ky - c.y) > 4) continue;
        if (dx * dx + dz * dz < coinReach) this._emit({ t: 'coin', i, s: k.slot });
      }

      if (k.spinTimer > 0 || k.finished) continue;
      if (k.ghostTimer > 0) continue; // ghosts can't be touched by anything
      if (k.megaTimer > 0 || k.rocketTimer > 0 || k.starTimer > 0) {
        // Mega / rocket / star karts smash projectiles and flatten anyone they touch.
        this._megaSmash(k, this.shells.items, ITEMS.shellRadius);
        this._megaSmash(k, this.reds.items, ITEMS.shellRadius);
        this._megaSmash(k, this.bananas.items, ITEMS.bananaRadius);
        this._megaSmash(k, this.fires.items, ITEMS.fireRadius);
        this._megaSmash(k, this.fakes.items, ITEMS.fakeRadius);
        this._megaSquash(k, karts); // the rocket bowls karts over too
        continue;
      }
      if (k.shrinkTimer > 0 && this._isSquashed(k, karts)) {
        this._emit({ t: 'hit', s: k.slot, id: 0 });
        continue;
      }
      this._checkProjectileHits(k, this.shells.items, ITEMS.shellRadius, ITEMS.shellOwnerGrace);
      this._checkProjectileHits(k, this.reds.items, ITEMS.shellRadius, ITEMS.shellOwnerGrace);
      this._checkProjectileHits(k, this.bananas.items, ITEMS.bananaRadius, 0.6);
      this._checkProjectileHits(k, this.fires.items, ITEMS.fireRadius, 0.3);
      this._checkProjectileHits(k, this.fakes.items, ITEMS.fakeRadius, 0.6);
      // Oil slicks aren't consumed: they catch every kart that drives through.
      if ((this._slipCooldown.get(k.slot) || 0) <= 0) {
        const r2 = (ITEMS.oilRadius + KART.radius * 0.6) ** 2;
        for (let i = 0; i < this.oils.items.length; i++) {
          const o = this.oils.items[i];
          if (!o.active || (o.owner === k.slot && o.age < 0.8)) continue;
          const dx = k.netX - o.x, dz = k.netZ - o.z;
          if (dx * dx + dz * dz < r2 && Math.abs(ky - o.y) < 2.5) {
            this._slipCooldown.set(k.slot, 2);
            this._emit({ t: 'slip', s: k.slot });
            break;
          }
        }
      }
    }

    // Bombs go off on contact or when the fuse runs out; spiny shells when they reach their target.
    for (const b of this.bombs.items) {
      if (!b.active) continue;
      let boom = b.age > ITEMS.bombFuse;
      if (!boom) {
        const r2 = (ITEMS.bombRadius + KART.radius) ** 2;
        for (const k of karts) {
          if ((k.slot === b.owner && b.age < 0.8) || k.finished) continue;
          const dx = k.netX - b.x, dz = k.netZ - b.z;
          if (dx * dx + dz * dz < r2 && Math.abs(k.y - k.radius - b.y) < 3) { boom = true; break; }
        }
      }
      if (boom) this._emit({ t: 'blast', id: b.id, x: b.x, z: b.z, r: ITEMS.bombBlast });
    }
    for (const s of this.blues.items) {
      if (!s.active) continue;
      let tk = s.target >= 0 ? this.getKart(s.target) : null;
      if (!tk || tk.finished) {
        // Target gone: hunt the current leader instead.
        tk = karts.find((k) => k.rank === 1 && !k.finished && k.slot !== s.owner) || null;
        s.target = tk ? tk.slot : -1;
        if (!tk) continue;
      }
      const dx = tk.netX - s.x, dz = tk.netZ - s.z;
      if (dx * dx + dz * dz < 2.5 * 2.5 && Math.abs(tk.y - s.y) < 3) {
        this._emit({ t: 'blast', id: s.id, x: tk.netX, z: tk.netZ, r: ITEMS.blueBlast });
      }
    }

    // Shells destroy bananas they touch.
    const shells = this.shells.items, bananas = this.bananas.items;
    const sbR2 = (ITEMS.shellRadius + ITEMS.bananaRadius) ** 2;
    for (let i = 0; i < shells.length; i++) {
      const s = shells[i];
      if (!s.active) continue;
      for (let j = 0; j < bananas.length; j++) {
        const b = bananas[j];
        if (!b.active) continue;
        const dx = s.x - b.x, dz = s.z - b.z;
        if (dx * dx + dz * dz < sbR2) {
          this._emit({ t: 'despawn', id: s.id });
          this._emit({ t: 'despawn', id: b.id });
          break;
        }
      }
    }
  }

  /** A shrunk kart gets flattened by any full-size kart it touches. */
  _isSquashed(k, karts) {
    for (let j = 0; j < karts.length; j++) {
      const o = karts[j];
      if (o === k || o.shrinkTimer > 0 || o.ghostTimer > 0 || Math.abs(o.y - k.y) > 4) continue;
      const reach = KART.radius * (k.megaScale + o.megaScale) + 0.3;
      const dx = k.netX - o.netX, dz = k.netZ - o.netZ;
      if (dx * dx + dz * dz < reach * reach) return true;
    }
    return false;
  }

  _megaSmash(k, list, radius) {
    const r2 = (radius + KART.radius * k.megaScale) ** 2;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p.active) continue;
      const dx = k.netX - p.x, dz = k.netZ - p.z;
      if (dx * dx + dz * dz < r2) this._emit({ t: 'despawn', id: p.id });
    }
  }

  _megaSquash(k, karts) {
    for (let j = 0; j < karts.length; j++) {
      const o = karts[j];
      if (o === k || o.megaTimer > 0 || o.ghostTimer > 0 || o.rocketTimer > 0 || o.starTimer > 0 || o.spinTimer > 0 || o.finished || Math.abs(o.y - k.y) > 4) continue;
      const reach = KART.radius * (k.megaScale + o.megaScale) + 0.4;
      const dx = k.netX - o.netX, dz = k.netZ - o.netZ;
      if (dx * dx + dz * dz < reach * reach) this._emit({ t: 'hit', s: o.slot, id: 0 });
    }
  }

  _checkProjectileHits(k, list, radius, ownerGrace) {
    const r2 = (radius + KART.radius) ** 2;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p.active) continue;
      if (p.owner === k.slot && p.age < ownerGrace) continue;
      if (Math.abs(k.y - k.radius - p.y) > 3) continue;
      const dx = k.netX - p.x, dz = k.netZ - p.z;
      if (dx * dx + dz * dz < r2) {
        this._emit({ t: 'hit', s: k.slot, id: p.id });
        return;
      }
    }
  }

  // ---------------------------------------------------------------- rendering

  render(time, karts = []) {
    const shadows = this.renderer.shadows;
    const m = this._m, q = this._q, e = this._e, p = this._p, s = this._s;

    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      const sc = b.used && b.active ? b.scale : 0;
      e.set(time * 0.9 + i, time * 1.3 + i * 0.7, 0.4);
      q.setFromEuler(e);
      m.compose(p.set(b.x, b.y + 1.3 + Math.sin(time * 2 + i) * 0.18, b.z), q, s.set(sc, sc, sc));
      this.boxMesh.setMatrixAt(i, m);
      if (sc > 0.01) shadows.add(b.x, b.y, b.z, 1.8 * sc);
    }
    this.boxMesh.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < this.coins.length; i++) {
      const c = this.coins[i];
      const sc = c.active ? 1 : 0;
      e.set(0, time * 3 + i * 0.4, 0);
      q.setFromEuler(e);
      // Coins near a magnet kart are drawn sliding toward it.
      let cx = c.x, cz = c.z;
      if (c.active) {
        for (let k = 0; k < karts.length; k++) {
          const kt = karts[k];
          if (!(kt.magnetTimer > 0)) continue;
          const dx = kt.renderX - c.x, dz = kt.renderZ - c.z;
          const d = Math.hypot(dx, dz);
          const range = ITEMS.magnetCoinRange * 1.6;
          if (d < range) {
            const f = Math.min(0.85, 1 - d / range);
            cx += dx * f; cz += dz * f;
          }
        }
      }
      m.compose(p.set(cx, c.y + 0.9, cz), q, s.set(sc, sc, sc));
      this.coinMesh.setMatrixAt(i, m);
    }
    this.coinMesh.instanceMatrix.needsUpdate = true;

    let n = 0;
    const shells = this.shells.items;
    for (let i = 0; i < shells.length; i++) {
      const sh = shells[i];
      if (!sh.active) continue;
      e.set(0, sh.spin, 0);
      q.setFromEuler(e);
      m.compose(p.set(sh.x, sh.y - 0.2, sh.z), q, s.set(1, 1, 1));
      this.shellMesh.setMatrixAt(n++, m);
      shadows.add(sh.x, sh.y - 0.5, sh.z, 1.4);
    }
    this.shellMesh.count = n;
    this.shellMesh.instanceMatrix.needsUpdate = true;

    n = 0;
    const reds = this.reds.items;
    for (let i = 0; i < reds.length; i++) {
      const sh = reds[i];
      if (!sh.active) continue;
      e.set(0, sh.spin, 0);
      q.setFromEuler(e);
      m.compose(p.set(sh.x, sh.y - 0.2, sh.z), q, s.set(1, 1, 1));
      this.redMesh.setMatrixAt(n++, m);
      shadows.add(sh.x, sh.y - 0.5, sh.z, 1.4);
    }
    this.redMesh.count = n;
    this.redMesh.instanceMatrix.needsUpdate = true;

    n = 0;
    const bananas = this.bananas.items;
    for (let i = 0; i < bananas.length; i++) {
      const b = bananas[i];
      if (!b.active) continue;
      e.set(0, b.id * 1.7, 0);
      q.setFromEuler(e);
      m.compose(p.set(b.x, b.y, b.z), q, s.set(1.2, 1.2, 1.2));
      this.bananaMesh.setMatrixAt(n++, m);
      shadows.add(b.x, b.y - 0.05, b.z, 1.2);
    }
    this.bananaMesh.count = n;
    this.bananaMesh.instanceMatrix.needsUpdate = true;

    n = 0;
    const oils = this.oils.items;
    for (let i = 0; i < oils.length; i++) {
      const o = oils[i];
      if (!o.active) continue;
      const fade = Math.min(1, (ITEMS.oilLife - o.age) / 1.5); // shrink away at the end
      e.set(0, o.id * 2.3, 0);
      q.setFromEuler(e);
      m.compose(p.set(o.x, o.y, o.z), q, s.set(fade, 1, fade));
      this.oilMesh.setMatrixAt(n++, m);
    }
    this.oilMesh.count = n;
    this.oilMesh.instanceMatrix.needsUpdate = true;

    n = 0;
    for (const pad of this.dropPads) {
      if (!pad.active) continue;
      e.set(0, pad.yaw, 0);
      q.setFromEuler(e);
      const pulse = 1 + Math.sin(time * 8) * 0.03;
      m.compose(p.set(pad.x, pad.y, pad.z), q, s.set(pulse, 1, pulse));
      this.padMesh.setMatrixAt(n++, m);
    }
    this.padMesh.count = n;
    this.padMesh.instanceMatrix.needsUpdate = true;

    n = 0;
    for (const b of this.blues.items) {
      if (!b.active) continue;
      e.set(0, b.spin, Math.sin(b.spin * 2) * 0.15);
      q.setFromEuler(e);
      m.compose(p.set(b.x, b.y, b.z), q, s.set(1.1, 1.1, 1.1));
      this.blueMesh.setMatrixAt(n++, m);
      shadows.add(b.x, this.track.roadY(b.idx, 0), b.z, 1.6);
    }
    this.blueMesh.count = n;
    this.blueMesh.instanceMatrix.needsUpdate = true;

    n = 0;
    for (const b of this.bombs.items) {
      if (!b.active) continue;
      // Swells and flashes as the fuse runs down.
      const left = ITEMS.bombFuse - b.age;
      const pulse = left < 1 ? 1 + Math.abs(Math.sin(b.age * 18)) * 0.25 : 1;
      e.set(0, Math.atan2(b.vx, b.vz), 0);
      q.setFromEuler(e);
      m.compose(p.set(b.x, b.y, b.z), q, s.set(pulse, pulse, pulse));
      this.bombMesh.setMatrixAt(n++, m);
      shadows.add(b.x, b.y, b.z, 1.5);
      if (Math.random() < 0.4) this.particles.spawn(b.x, b.y + 2, b.z, 0, 1.2, 0, 0.25, 0.18, left < 1 ? 0xff3b3b : 0xffd23f, 0);
    }
    this.bombMesh.count = n;
    this.bombMesh.instanceMatrix.needsUpdate = true;

    n = 0;
    for (const f of this.fires.items) {
      if (!f.active) continue;
      const hop = Math.abs(Math.sin(f.age * 9)) * 0.9;
      e.set(f.spin, 0, 0);
      q.setFromEuler(e);
      m.compose(p.set(f.x, f.y + hop, f.z), q, s.set(1, 1, 1));
      this.fireMesh.setMatrixAt(n++, m);
    }
    this.fireMesh.count = n;
    this.fireMesh.instanceMatrix.needsUpdate = true;

    n = 0;
    for (const f of this.fakes.items) {
      if (!f.active) continue;
      e.set(Math.PI + time * 0.9 + f.id, time * 1.3 + f.id * 0.7, 0.4);
      q.setFromEuler(e);
      m.compose(p.set(f.x, f.y + 1.3 + Math.sin(time * 2 + f.id) * 0.18, f.z), q, s.set(1, 1, 1));
      this.fakeMesh.setMatrixAt(n++, m);
      shadows.add(f.x, f.y, f.z, 1.8);
    }
    this.fakeMesh.count = n;
    this.fakeMesh.instanceMatrix.needsUpdate = true;

    // Storm clouds over confused karts, with a little rain.
    n = 0;
    for (let i = 0; i < karts.length && n < CLOUD_CAP; i++) {
      const kt = karts[i];
      if (!(kt.confusedTimer > 0)) continue;
      const cy = (kt.renderY ?? kt.y) + 4.2 * (kt.megaScale || 1);
      e.set(0, time * 0.8, 0);
      q.setFromEuler(e);
      m.compose(p.set(kt.renderX ?? kt.x, cy, kt.renderZ ?? kt.z), q, s.set(1, 0.8, 1));
      this.cloudMesh.setMatrixAt(n++, m);
      if (Math.random() < 0.6) {
        this.particles.spawn((kt.renderX ?? kt.x) + (Math.random() - 0.5) * 2.2, cy - 0.6, (kt.renderZ ?? kt.z) + (Math.random() - 0.5) * 2.2, 0, -9, 0, 0.35, 0.12, 0x9ecbff, 0);
      }
      if (Math.random() < 0.02) this.particles.burst(kt.renderX ?? kt.x, cy - 0.8, kt.renderZ ?? kt.z, 6, 3, 0.2, 0.25, 0xfff176, -2);
    }
    this.cloudMesh.count = n;
    this.cloudMesh.instanceMatrix.needsUpdate = true;
  }
}

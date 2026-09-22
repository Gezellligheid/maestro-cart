import * as THREE from 'three';
import { box, cylinder, sphere, merge } from '../engine/geometry.js';
import { ITEM, ITEMS, KART } from './constants.js';

const SHELL_CAP = 24;
const BANANA_CAP = 32;
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

    this.boxes = track.itemBoxSpots.map((s) => ({ x: s.x, y: s.y, z: s.z, active: true, timer: 0, scale: 1 }));
    this.coins = track.coinSpots.map((s) => ({ x: s.x, y: s.y, z: s.z, active: true, timer: 0 }));
    this.shells = new ProjectilePool(ITEM.SHELL, SHELL_CAP);
    this.bananas = new ProjectilePool(ITEM.BANANA, BANANA_CAP);

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

    const bananaGeo = merge([
      cylinder(0.16, 0.2, 0.55, 7, 0, 0.3, -0.2, 0xffe135, 0.7, 0, 0),
      cylinder(0.2, 0.2, 0.4, 7, 0, 0.45, 0.13, 0xffe135, -0.1, 0, 0),
      cylinder(0.2, 0.12, 0.45, 7, 0, 0.42, 0.45, 0xffe135, -0.9, 0, 0),
      cylinder(0.05, 0.05, 0.15, 5, 0, 0.62, 0.66, 0x5c3d1e, -0.9, 0, 0),
      cylinder(0.08, 0.05, 0.1, 5, 0, 0.12, -0.42, 0x5c3d1e, 0.7, 0, 0),
    ]);
    this.bananaMesh = this._instanced(bananaGeo, toon, BANANA_CAP);
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
    this.track.itemBoxSpots.forEach((s, i) => Object.assign(this.boxes[i], { x: s.x, y: s.y, z: s.z }));
    this.track.coinSpots.forEach((s, i) => Object.assign(this.coins[i], { x: s.x, y: s.y, z: s.z }));
  }

  reset() {
    for (const b of this.boxes) { b.active = true; b.timer = 0; b.scale = 1; }
    for (const c of this.coins) { c.active = true; c.timer = 0; }
    this.shells.releaseAll();
    this.bananas.releaseAll();
    this.nextId = 1;
  }

  // ---------------------------------------------------------------- item use

  /** Fire the kart's held item. Works for the local player and for bots. */
  useItem(kart) {
    if (kart.item === ITEM.NONE || kart.rollTimer > 0 || kart.spinTimer > 0) return false;
    const it = kart.item;
    kart.item = ITEM.NONE;
    if (it === ITEM.MUSHROOM) {
      kart.applyMushroom();
      return true;
    }
    if (it === ITEM.MEGA) {
      kart.activateMega();
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
    if (msg.k !== ITEM.SHELL && msg.k !== ITEM.BANANA) return;
    this.spawnFromKart(msg.k, fromSlot, +msg.x || 0, +msg.z || 0, +msg.yaw || 0, +msg.spd || 0);
  }

  spawnFromKart(type, owner, x, z, yaw, speed) {
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    let px, pz, vx = 0, vz = 0;
    if (type === ITEM.SHELL) {
      px = x + sin * 2.4;
      pz = z + cos * 2.4;
      const v = Math.max(ITEMS.shellSpeed, speed + 20);
      vx = sin * v;
      vz = cos * v;
      // Don't spawn inside a barrier when hugging a wall.
      const hit = this.physics.castWall(x, this.track.heightAt(this.track.nearestIndex(x, z, -1)) + 0.5, z, sin, cos, 2.4 + ITEMS.shellRadius);
      if (hit) { px = x; pz = z; }
    } else {
      px = x - sin * 2.2;
      pz = z - cos * 2.2;
    }
    const id = this.nextId;
    this.nextId = this.nextId >= 60000 ? 1 : this.nextId + 1;
    this._emit({ t: 'spawn', k: type, id, o: owner, x: px, z: pz, vx, vz });
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
        const pool = msg.k === ITEM.SHELL ? this.shells : this.bananas;
        const p = pool.acquire();
        p.active = true;
        p.id = msg.id;
        p.owner = msg.o;
        p.x = msg.x; p.z = msg.z;
        p.idx = this.track.nearestIndex(p.x, p.z, -1);
        p.y = this.track.heightAt(p.idx) + (msg.k === ITEM.SHELL ? 0.5 : 0.05);
        p.vx = msg.vx; p.vz = msg.vz;
        p.age = 0;
        p.bounces = 0;
        break;
      }
      case 'hit': {
        const p = this.shells.findById(msg.id) || this.bananas.findById(msg.id);
        if (p) {
          p.active = false;
          this.particles.burst(p.x, 0.8, p.z, 14, 7, 0.6, 0.3, p.type === ITEM.SHELL ? 0x2ec27e : 0xffe135, -12);
        }
        const k = this.getKart(msg.s);
        if (k && k.simulated && k.spinOut() && this.onLocalHit) this.onLocalHit(k);
        break;
      }
      case 'despawn': {
        const p = this.shells.findById(msg.id) || this.bananas.findById(msg.id);
        if (p) {
          p.active = false;
          this.particles.burst(p.x, 0.6, p.z, 8, 5, 0.4, 0.25, 0xffffff, -10);
        }
        break;
      }
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- simulation

  _rollItem(kart, total) {
    const t = total > 1 ? (kart.rank - 1) / (total - 1) : 0.5;
    const wBanana = 0.5 - 0.4 * t;
    const wShell = 0.4;
    const wMush = 0.1 + 0.4 * t;
    const wMega = 0.02 + 0.13 * t; // rare, mostly for karts at the back
    const r = Math.random() * (wBanana + wShell + wMush + wMega);
    if (r < wBanana) return ITEM.BANANA;
    if (r < wBanana + wShell) return ITEM.SHELL;
    if (r < wBanana + wShell + wMush) return ITEM.MUSHROOM;
    return ITEM.MEGA;
  }

  fixedUpdate(dt, karts) {
    this.time += dt;

    for (const b of this.boxes) {
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
    const bananas = this.bananas.items;
    for (let i = 0; i < bananas.length; i++) if (bananas[i].active) bananas[i].age += dt;

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
      s.y = this.track.heightAt(s.idx) + 0.5;
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

  _authorityChecks(karts) {
    const total = karts.length;
    const boxR2 = (BOX_SIZE * 0.5 + KART.radius + 0.4) ** 2;
    const coinR2 = (0.6 + KART.radius + 0.3) ** 2;

    for (let ki = 0; ki < karts.length; ki++) {
      const k = karts[ki];
      const kx = k.netX, kz = k.netZ;

      for (let i = 0; i < this.boxes.length; i++) {
        const b = this.boxes[i];
        if (!b.active) continue;
        const dx = kx - b.x, dz = kz - b.z;
        if (dx * dx + dz * dz < boxR2) {
          const it = k.hasItemSlotFree ? this._rollItem(k, total) : ITEM.NONE;
          this._emit({ t: 'box', i, s: k.slot, it });
        }
      }

      for (let i = 0; i < this.coins.length; i++) {
        const c = this.coins[i];
        if (!c.active) continue;
        const dx = kx - c.x, dz = kz - c.z;
        if (dx * dx + dz * dz < coinR2) this._emit({ t: 'coin', i, s: k.slot });
      }

      if (k.spinTimer > 0 || k.finished) continue;
      if (k.megaTimer > 0) {
        // Mega karts smash projectiles and flatten anyone they touch.
        this._megaSmash(k, this.shells.items, ITEMS.shellRadius);
        this._megaSmash(k, this.bananas.items, ITEMS.bananaRadius);
        this._megaSquash(k, karts);
        continue;
      }
      this._checkProjectileHits(k, this.shells.items, ITEMS.shellRadius, ITEMS.shellOwnerGrace);
      this._checkProjectileHits(k, this.bananas.items, ITEMS.bananaRadius, 0.6);
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
      if (o === k || o.megaTimer > 0 || o.spinTimer > 0 || o.finished) continue;
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
      const dx = k.netX - p.x, dz = k.netZ - p.z;
      if (dx * dx + dz * dz < r2) {
        this._emit({ t: 'hit', s: k.slot, id: p.id });
        return;
      }
    }
  }

  // ---------------------------------------------------------------- rendering

  render(time) {
    const shadows = this.renderer.shadows;
    const m = this._m, q = this._q, e = this._e, p = this._p, s = this._s;

    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      const sc = b.active ? b.scale : 0;
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
      m.compose(p.set(c.x, c.y + 0.9, c.z), q, s.set(sc, sc, sc));
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
  }
}

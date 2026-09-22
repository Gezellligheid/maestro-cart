import * as THREE from 'three';
import { MAX_KARTS, DRIFT_TIERS, KART } from './constants.js';
import { wrapAngle } from './Kart.js';
import { BODIES, SPOILERS, WHEELS, HATS, getBody, getSpoiler, getWheels, getHat, DEFAULT_LOOK } from './Cosmetics.js';

const PARTS_PER_KART = 7; // body, spoiler, hat, 4 wheels
const MAX_RENDERED = MAX_KARTS + 1; // + garage showroom kart
// Wheel layout in kart-local space: [zOffset, isFront, side]
const WHEEL_LAYOUT = [
  [0.72, 1, 1], [0.72, 1, -1],
  [-0.68, 0, 1], [-0.68, 0, -1],
];
const WHITE = new THREE.Color(0xffffff);

/**
 * Renders every kart — any mix of bodies, spoilers, wheels and headgear — with ONE draw call
 * via THREE.BatchedMesh. Each kart owns 7 batch instances whose geometry id is swapped to the
 * variant in its look. Paint/accent colours come from per-instance batch colours multiplied
 * with the white vertex colours of each part.
 */
export class KartRenderer {
  constructor(renderer, particles) {
    this.renderer = renderer;
    this.particles = particles;

    // Build every variant geometry once and measure the batch size.
    const geos = [];
    const add = (list) => list.map((p) => {
      if (!p.build) return -1;
      const g = p.build();
      geos.push(g);
      return geos.length - 1;
    });
    const bodyIdx = add(BODIES), spoilerIdx = add(SPOILERS), wheelIdx = add(WHEELS), hatIdx = add(HATS);
    const vertexCount = geos.reduce((n, g) => n + g.attributes.position.count, 0);

    const material = renderer.toon({ vertexColors: true });
    this.batch = new THREE.BatchedMesh(MAX_RENDERED * PARTS_PER_KART, vertexCount, 0, material);
    this.batch.frustumCulled = false;
    this.batch.perObjectFrustumCulled = true;
    this.batch.sortObjects = false;
    const ids = geos.map((g) => this.batch.addGeometry(g));
    const toId = (idxList) => idxList.map((i) => (i < 0 ? -1 : ids[i]));
    this.geo = {
      body: new Map(BODIES.map((p, i) => [p.id, toId(bodyIdx)[i]])),
      spoiler: new Map(SPOILERS.map((p, i) => [p.id, toId(spoilerIdx)[i]])),
      wheels: new Map(WHEELS.map((p, i) => [p.id, toId(wheelIdx)[i]])),
      hat: new Map(HATS.map((p, i) => [p.id, toId(hatIdx)[i]])),
    };

    // Pre-create all instances (hidden) so nothing is allocated during play.
    this.instances = [];
    this.instanceGeo = [];
    const fallback = ids[0];
    for (let i = 0; i < MAX_RENDERED * PARTS_PER_KART; i++) {
      const id = this.batch.addInstance(fallback);
      this.batch.setVisibleAt(id, false);
      this.batch.setColorAt(id, WHITE);
      this.instances.push(id);
      this.instanceGeo.push(fallback);
    }
    renderer.scene.add(this.batch);

    // Bubble shields: one transparent instanced sphere per shielded kart (1 draw call).
    const bubbleMat = renderer.basic({ color: 0x7fdcff, transparent: true, opacity: 0.28, depthWrite: false });
    this.bubbles = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 2), bubbleMat, MAX_RENDERED);
    this.bubbles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.bubbles.frustumCulled = false;
    this.bubbles.renderOrder = 2;
    this.bubbles.count = 0;
    renderer.scene.add(this.bubbles);

    this._kartMat = new THREE.Matrix4();
    this._local = new THREE.Matrix4();
    this._out = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._one = new THREE.Vector3(1, 1, 1);
    this._c = new THREE.Color();
    this._sparkTimer = 0;
    this._lastCount = 0;
  }

  _setPart(slot, geoId, matrix, color) {
    const inst = this.instances[slot];
    if (geoId < 0) {
      this.batch.setVisibleAt(inst, false);
      return;
    }
    if (this.instanceGeo[slot] !== geoId) {
      this.batch.setGeometryIdAt(inst, geoId);
      this.instanceGeo[slot] = geoId;
    }
    this.batch.setVisibleAt(inst, true);
    this.batch.setMatrixAt(inst, matrix);
    this.batch.setColorAt(inst, color);
  }

  /** Kept for API compatibility: colours are now applied every frame from each kart's look. */
  setColors() {}

  /** alpha interpolates simulated karts between physics steps. */
  update(karts, alpha, dt) {
    const shadows = this.renderer.shadows;
    this._sparkTimer += dt;
    const emitSparks = this._sparkTimer > 1 / 45;
    if (emitSparks) this._sparkTimer = 0;
    const count = Math.min(karts.length, MAX_RENDERED);
    let bubbleCount = 0;

    for (let i = 0; i < count; i++) {
      const k = karts[i];
      const look = k.look || DEFAULT_LOOK;
      const body = getBody(look.body);
      const wheel = getWheels(look.wheels);
      const hat = getHat(look.hat);
      const scale = k.megaScale || 1;
      const radius = KART.radius * scale;

      const a = k.simulated ? alpha : 1;
      const x = k.prevX + (k.x - k.prevX) * a;
      const y = k.prevY + (k.y - k.prevY) * a - radius;
      const z = k.prevZ + (k.z - k.prevZ) * a;
      const yaw = k.prevYaw + wrapAngle(k.yaw - k.prevYaw) * a;
      k.renderX = x; k.renderY = y; k.renderZ = z; k.renderYaw = yaw;

      // Pitch and roll with the road surface (hills and banked corners). Airborne karts
      // ease back towards level.
      let tPitch = 0, tRoll = 0;
      if (k.track && !k.preview && k.grounded) {
        const tr = k.track, idx = k.trackIdx;
        const grade = tr.gradeAt(idx), slope = tr.slopeAt(idx);
        const d = yaw - tr.yaw[idx];
        const cd = Math.cos(d), sd = Math.sin(d);
        tPitch = -Math.atan(grade * cd - slope * sd); // gradient along the kart's nose
        tRoll = -Math.atan(grade * sd + slope * cd); // gradient to the kart's right (local +x = left)
      }
      const blend = Math.min(1, dt * (k.grounded ? 10 : 2));
      k.visPitch = (k.visPitch || 0) + (tPitch - (k.visPitch || 0)) * blend;
      k.visRoll = (k.visRoll || 0) + (tRoll - (k.visRoll || 0)) * blend;

      const visualYaw = yaw + k.driftVisual + k.spinAngle;
      const lean = -k.steerVisual * Math.min(1, Math.abs(k.speed) / 25) * 0.08 + k.driftVisual * 0.15;
      const bob = k.boostTimer > 0 ? Math.sin(performance.now() * 0.05) * 0.03 : 0;
      this._e.set(k.visPitch, visualYaw, lean + k.visRoll);
      this._q.setFromEuler(this._e);
      this._s.set(scale, scale, scale);
      this._kartMat.compose(this._p.set(x, y + bob, z), this._q, this._s);

      const base = i * PARTS_PER_KART;
      const paint = this._c.setHex(look.color);
      const lift = wheel.radius - 0.3;

      // Body (lifted when wheels are taller than stock)
      this._local.makeTranslation(0, lift, 0);
      this._out.multiplyMatrices(this._kartMat, this._local);
      this._setPart(base, this.geo.body.get(body.id), this._out, paint);

      // Spoiler + headgear use the accent colour
      const accent = this._c.setHex(look.accent);
      this._local.makeTranslation(0, lift + body.mount.spoilerY, body.mount.spoilerZ);
      this._out.multiplyMatrices(this._kartMat, this._local);
      this._setPart(base + 1, this.geo.spoiler.get(getSpoiler(look.spoiler).id), this._out, accent);

      this._local.makeTranslation(0, lift + body.mount.headY, body.mount.headZ);
      this._out.multiplyMatrices(this._kartMat, this._local);
      this._setPart(base + 2, this.geo.hat.get(hat.id), this._out, hat.tint ? accent : WHITE);

      const wheelGeo = this.geo.wheels.get(wheel.id);
      for (let w = 0; w < 4; w++) {
        const [wz, front, side] = WHEEL_LAYOUT[w];
        this._e.set(k.wheelSpin * (0.3 / wheel.radius), front ? -k.steerVisual * 0.45 : 0, 0);
        this._q.setFromEuler(this._e);
        this._local.compose(this._p.set(side * body.wheelX, wheel.radius, wz), this._q, this._one);
        this._out.multiplyMatrices(this._kartMat, this._local);
        this._setPart(base + 3 + w, wheelGeo, this._out, WHITE);
      }

      if (k.shieldTimer > 0) {
        const r = 1.9 * scale * (1 + Math.sin(performance.now() * 0.006 + i) * 0.03);
        this._local.compose(this._p.set(x, y + 0.85 * scale, z), this._q.identity(), this._s.set(r, r, r));
        this.bubbles.setMatrixAt(bubbleCount++, this._local);
      }
      if (k.shieldPopped) {
        k.shieldPopped = false;
        this.particles.burst(x, y + 1, z, 18, 8, 0.45, 0.3, 0x7fdcff, -6);
      }

      if (!k.preview) {
        shadows.add(x, k.track.roadY(k.trackIdx, k.trackLateral || 0), z, 2.6 * scale);
        if (emitSparks) this._emitEffects(k, x, y, z, visualYaw, scale);
      }
    }

    this.bubbles.count = bubbleCount;
    if (bubbleCount > 0) this.bubbles.instanceMatrix.needsUpdate = true;

    // Hide instances of karts that are no longer rendered.
    for (let i = count; i < this._lastCount; i++) {
      for (let p = 0; p < PARTS_PER_KART; p++) this.batch.setVisibleAt(this.instances[i * PARTS_PER_KART + p], false);
    }
    this._lastCount = count;
  }

  _emitEffects(k, x, y, z, yaw, scale) {
    const p = this.particles;
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    const rx = -cos, rz = sin; // kart right vector
    const backX = x - sin * 0.9 * scale, backZ = z - cos * 0.9 * scale;

    if (k.drifting && k.grounded && k.driftTier > 0) {
      const color = DRIFT_TIERS[k.driftTier].color;
      for (let side = -1; side <= 1; side += 2) {
        p.spawn(
          backX + rx * side * 0.8 * scale, y + 0.15, backZ + rz * side * 0.8 * scale,
          (Math.random() - 0.5) * 3 - sin * 2, 2 + Math.random() * 2.5, (Math.random() - 0.5) * 3 - cos * 2,
          0.3, 0.28 * scale, color, -14,
        );
      }
    } else if (k.drifting && k.grounded) {
      p.spawn(backX, y + 0.1, backZ, (Math.random() - 0.5) * 2, 1 + Math.random(), (Math.random() - 0.5) * 2, 0.4, 0.4, 0xdddddd, -2);
    }
    if (k.boostTimer > 0) {
      for (let side = -1; side <= 1; side += 2) {
        p.spawn(
          x - sin * 1.35 * scale + rx * side * 0.28 * scale, y + 0.72 * scale, z - cos * 1.35 * scale + rz * side * 0.28 * scale,
          -sin * 6 + (Math.random() - 0.5), 0.5 + Math.random(), -cos * 6 + (Math.random() - 0.5),
          0.22, 0.42 * scale, Math.random() < 0.5 ? 0xff9f1c : 0xffe066, 0,
        );
      }
    }
    if (k.megaTimer > 0) {
      const a = Math.random() * Math.PI * 2;
      p.spawn(x + Math.cos(a) * 1.6 * scale, y + Math.random() * 2 * scale, z + Math.sin(a) * 1.6 * scale, 0, 2.5, 0, 0.5, 0.35, Math.random() < 0.5 ? 0xffd23f : 0xff595e, 0);
    }
    if (k.magnetTimer > 0) {
      // Blue sparks drawn in toward the kart.
      const a = Math.random() * Math.PI * 2, d = 4 + Math.random() * 4;
      p.spawn(x + Math.cos(a) * d, y + 0.8, z + Math.sin(a) * d, -Math.cos(a) * d * 2.2, 0, -Math.sin(a) * d * 2.2, 0.45, 0.22, 0x5ab4ff, 0);
    }
    if (k.shrinkTimer > 0 && Math.random() < 0.3) {
      p.spawn(x, y + 1.2 * scale, z, (Math.random() - 0.5) * 2, 1.5, (Math.random() - 0.5) * 2, 0.4, 0.2, 0xfff176, -2);
    }
    if (k.offroad && Math.abs(k.speed) > 6 && k.grounded) {
      p.spawn(backX, y + 0.2, backZ, (Math.random() - 0.5) * 3, 1.5 + Math.random() * 2, (Math.random() - 0.5) * 3, 0.45, 0.35, 0x8d6e4a, -9);
    }
    if (k.onIce && k.grounded && Math.abs(k.speed) > 8) {
      p.spawn(backX, y + 0.15, backZ, (Math.random() - 0.5) * 2, 0.8 + Math.random(), (Math.random() - 0.5) * 2, 0.35, 0.22, 0xe0f6ff, -4);
    }
    if (k.spinTimer > 0) {
      const a = Math.random() * Math.PI * 2;
      p.spawn(x + Math.cos(a) * 0.9, y + 1.9, z + Math.sin(a) * 0.9, Math.cos(a) * 1.5, 1.2, Math.sin(a) * 1.5, 0.45, 0.3, 0xffe600, -2);
    }
  }
}

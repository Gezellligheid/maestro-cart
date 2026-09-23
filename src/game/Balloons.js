import * as THREE from 'three';
import { MAX_KARTS } from './constants.js';

const PER_KART = 3;
// Balloon offsets behind the driver (kart space: x right, z forward).
const OFFSETS = [[-0.75, 1.65, -1.3], [0, 1.95, -1.5], [0.75, 1.65, -1.3]];

/**
 * Balloon Battle balloons: three per kart in the kart's colour, bobbing behind the driver
 * (one instanced draw call). Pops a burst of confetti whenever a kart's count drops.
 */
export class Balloons {
  constructor(renderer, particles) {
    this.particles = particles;
    const geo = new THREE.SphereGeometry(0.3, 12, 8);
    geo.scale(1, 1.2, 1);
    this.mesh = new THREE.InstancedMesh(geo, renderer.toon({ color: 0xffffff }), MAX_KARTS * PER_KART);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    renderer.scene.add(this.mesh);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
    this._up = new THREE.Vector3(0, 1, 0);
    this.enabled = false;
  }

  set(on) {
    this.enabled = on;
    this.mesh.visible = on;
    this.mesh.count = 0;
  }

  /** onPop(kart) fires once per lost balloon (for any kart, local or remote). */
  update(karts, time, onPop) {
    if (!this.enabled) return;
    let n = 0;
    for (const k of karts) {
      const count = Math.max(0, k.balloons ?? 0);
      if (k._shownBalloons != null && count < k._shownBalloons) {
        this._pop(k);
        if (onPop) onPop(k);
      }
      k._shownBalloons = count;
      if (!count) continue;
      const yaw = k.renderYaw ?? k.yaw;
      const sin = Math.sin(yaw), cos = Math.cos(yaw);
      const sc = k.megaScale || 1;
      this._q.setFromAxisAngle(this._up, yaw);
      for (let b = 0; b < count && b < PER_KART; b++) {
        const [ox, oy, oz] = OFFSETS[b];
        const bob = Math.sin(time * 2.4 + k.slot + b * 1.7) * 0.12;
        const x = (ox * cos + oz * sin) * sc, z = (-ox * sin + oz * cos) * sc;
        this._m.compose(this._p.set((k.renderX ?? k.x) + x, (k.renderY ?? k.y) + (oy + bob) * sc, (k.renderZ ?? k.z) + z), this._q, this._s.set(sc, sc, sc));
        this.mesh.setMatrixAt(n, this._m);
        this.mesh.setColorAt(n, this._c.setHex(k.color ?? 0xff4d6d));
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  _pop(k) {
    const x = k.renderX ?? k.x, y = (k.renderY ?? k.y) + 2.3, z = k.renderZ ?? k.z;
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 4;
      this.particles.spawn(x, y, z, Math.cos(a) * sp, 2 + Math.random() * 4, Math.sin(a) * sp, 0.7, 0.25, k.color ?? 0xff4d6d, -8);
    }
  }
}

import * as THREE from 'three';
import { box, cylinder, sphere, merge } from '../engine/geometry.js';

// Moving track hazards, one kind per theme. Motion is a pure function of the race clock, so
// every peer draws them in the same place without any network traffic. Touching one spins
// you out (shields, ghosts, rockets and Mega karts are protected as usual).

const BALLS_PER_BAR = 5;

const KINDS = {
  cow: {
    radius: 1.5, bob: 0, roll: false,
    build: () => merge([
      box(1.1, 0.8, 1.9, 0, 1.1, 0, 0xffffff), box(0.5, 0.4, 0.7, 0.3, 1.35, 0.3, 0x222222),
      box(0.6, 0.55, 0.6, 0, 1.4, 1.15, 0xffffff), box(0.62, 0.3, 0.2, 0, 1.25, 1.5, 0xf4a3b4),
      box(0.22, 0.75, 0.22, 0.35, 0.37, 0.65, 0xffffff), box(0.22, 0.75, 0.22, -0.35, 0.37, 0.65, 0xffffff),
      box(0.22, 0.75, 0.22, 0.35, 0.37, -0.65, 0xffffff), box(0.22, 0.75, 0.22, -0.35, 0.37, -0.65, 0xffffff),
    ]),
    scale: 1.4,
  },
  tumbleweed: {
    radius: 1.1, bob: 0.6, roll: true,
    build: () => merge([sphere(1, 6, 4, 0, 0, 0, 0xa07845), sphere(0.8, 5, 3, 0.2, 0.1, 0.1, 0x8a6538)]),
    scale: 1,
  },
  snowball: {
    radius: 1.7, bob: 0, roll: true,
    build: () => merge([sphere(1.7, 12, 8, 0, 0, 0, 0xffffff), sphere(0.5, 6, 4, 1.2, 0.8, 0.6, 0xdbe6ee)]),
    scale: 1,
  },
  hopper: {
    radius: 1.3, bob: 2.2, roll: false,
    build: () => merge([
      cylinder(0.5, 0.65, 1.1, 10, 0, 0.55, 0, 0xfdf0d5),
      sphere(1.25, 12, 6, 0, 1.2, 0, 0xe63946, 1, 0.6, 1),
      sphere(0.28, 6, 4, 0.7, 1.55, 0.5, 0xffffff), sphere(0.28, 6, 4, -0.6, 1.5, -0.6, 0xffffff),
      sphere(0.1, 5, 4, 0.2, 0.75, 0.48, 0x222222), sphere(0.1, 5, 4, -0.2, 0.75, 0.48, 0x222222),
    ]),
    scale: 1,
  },
  crab: {
    radius: 1.2, bob: 0, roll: false,
    build: () => merge([
      sphere(0.8, 10, 6, 0, 0.55, 0, 0xe4572e, 1.3, 0.6, 1),
      sphere(0.35, 8, 6, 1.2, 0.6, 0.5, 0xe4572e), sphere(0.35, 8, 6, -1.2, 0.6, 0.5, 0xe4572e),
      cylinder(0.05, 0.05, 0.45, 5, 0.25, 1.05, 0.4, 0x222222), cylinder(0.05, 0.05, 0.45, 5, -0.25, 1.05, 0.4, 0x222222),
      sphere(0.12, 6, 4, 0.25, 1.3, 0.4, 0xffffff), sphere(0.12, 6, 4, -0.25, 1.3, 0.4, 0xffffff),
    ]),
    scale: 1.3,
  },
  ghost: {
    radius: 1.2, bob: 0.8, roll: false,
    build: () => merge([
      sphere(1, 10, 8, 0, 2.2, 0, 0xf5f3ff), cylinder(1, 0.6, 1.6, 10, 0, 1.3, 0, 0xf5f3ff),
      sphere(0.14, 6, 4, 0.35, 2.35, 0.88, 0x1b1530), sphere(0.14, 6, 4, -0.35, 2.35, 0.88, 0x1b1530),
    ]),
    scale: 1.2,
  },
  star: {
    radius: 1.3, bob: 2.5, roll: false,
    build: () => {
      const g = new THREE.OctahedronGeometry(1.3, 0);
      g.scale(1, 1, 0.45);
      return merge([sphere(0.01, 3, 2, 0, 0, 0, 0xffe156), paintGeo(g, 0xffe156)]);
    },
    scale: 1,
  },
  firebar: { radius: 0.6, build: () => sphere(0.6, 8, 6, 0, 0, 0, 0xff7b00), scale: 1 },
};

function paintGeo(g, hex) {
  const n = g.index ? g.toNonIndexed() : g;
  const c = new THREE.Color(hex);
  const arr = new Float32Array(n.attributes.position.count * 3);
  for (let i = 0; i < arr.length; i += 3) { arr[i] = c.r; arr[i + 1] = c.g; arr[i + 2] = c.b; }
  n.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (n.attributes.uv) n.deleteAttribute('uv');
  return n;
}

export class Movers {
  constructor(renderer, particles) {
    this.renderer = renderer;
    this.particles = particles;
    this.mesh = null;
    this.list = [];
    this.balls = []; // collision spheres this frame: {x, y, z, r}
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._pt = { x: 0, z: 0 };
  }

  /** Rebuild for a freshly generated track. */
  setTrack(track) {
    this.track = track;
    this.list = track.movers || [];
    if (this.mesh) {
      this.renderer.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.dispose();
      this.mesh = null;
    }
    if (!this.list.length) return;
    const kind = KINDS[this.list[0].kind];
    this.kind = kind;
    const count = this.list[0].kind === 'firebar' ? this.list.length * BALLS_PER_BAR : this.list.length;
    const mat = this.list[0].kind === 'firebar' || this.list[0].kind === 'star'
      ? this.renderer.basic({ vertexColors: true })
      : this.renderer.toon({ vertexColors: true });
    this.mesh = new THREE.InstancedMesh(kind.build(), mat, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.renderer.scene.add(this.mesh);
  }

  /** Position everything for race time `t` (seconds). */
  update(t) {
    const tr = this.track;
    this.balls.length = 0;
    if (!this.mesh) return;
    const m = this._m, q = this._q, e = this._e, p = this._p, s = this._s, pt = this._pt;
    let n = 0;
    for (const mv of this.list) {
      const w = tr.widthAt(mv.i);
      if (mv.kind === 'firebar') {
        // A bar of fireballs spinning around a post at the road edge.
        const pivotLat = mv.side * (w + 0.6);
        const ang = t * (Math.PI * 2 / mv.period) * 1.4 + mv.phase;
        for (let b = 1; b <= BALLS_PER_BAR; b++) {
          const r = b * 1.5;
          const fwd = Math.cos(ang) * r, lat = pivotLat - mv.side * Math.sin(ang) * r;
          tr.pointAt(mv.i, lat, fwd, pt);
          const y = tr.roadY(mv.i, Math.max(-w, Math.min(w, lat))) + 1.1;
          m.compose(p.set(pt.x, y, pt.z), q.identity(), s.set(1, 1, 1));
          this.mesh.setMatrixAt(n++, m);
          this.balls.push({ x: pt.x, y, z: pt.z, r: 0.7 });
          if (Math.random() < 0.08) this.particles.spawn(pt.x, y, pt.z, 0, 1.5, 0, 0.35, 0.3, 0xffb703, 0);
        }
        continue;
      }
      // Crossers wander from one side of the road to the other and back.
      const k = this.kind;
      const u = t * (Math.PI * 2 / mv.period) + mv.phase;
      const lat = Math.sin(u) * (w - 1.6);
      const vel = Math.cos(u);
      tr.pointAt(mv.i, lat, 0, pt);
      const bob = k.bob ? Math.abs(Math.sin(t * 3 + mv.phase)) * k.bob : 0;
      const y = tr.roadY(mv.i, lat) + (k.roll ? k.radius : 0) + bob;
      const facing = tr.yaw[mv.i % tr.samples] + (vel > 0 ? -Math.PI / 2 : Math.PI / 2);
      const spin = k.roll ? lat / k.radius : 0;
      e.set(spin, facing, 0);
      q.setFromEuler(e);
      m.compose(p.set(pt.x, y, pt.z), q, s.set(k.scale, k.scale, k.scale));
      this.mesh.setMatrixAt(n++, m);
      this.balls.push({ x: pt.x, y: y + (k.roll ? 0 : 1), z: pt.z, r: k.radius });
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Spin out any locally simulated kart touching a hazard. Returns karts that got hit. */
  collide(karts, onHit) {
    for (let i = 0; i < karts.length; i++) {
      const k = karts[i];
      if (!k.simulated || k.spinTimer > 0) continue;
      for (const b of this.balls) {
        const dx = k.x - b.x, dz = k.z - b.z;
        const r = b.r + k.radius * 0.8;
        if (dx * dx + dz * dz < r * r && Math.abs(k.y - b.y) < b.r + 1.5) {
          if (k.spinOut()) onHit(k);
          break;
        }
      }
    }
  }
}

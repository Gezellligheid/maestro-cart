import * as THREE from 'three';

/**
 * Fixed-capacity particle pool backed by typed arrays and one InstancedMesh.
 * Spawning never allocates; dead particles are swap-removed so live ones stay packed.
 */
export class Particles {
  constructor(renderer, capacity = 600) {
    this.capacity = capacity;
    this.count = 0;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);

    const geo = new THREE.OctahedronGeometry(0.5, 0);
    const mat = renderer.basic({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    renderer.scene.add(this.mesh);

    this._m = new THREE.Matrix4();
    this._c = new THREE.Color();
  }

  spawn(x, y, z, vx, vy, vz, life, size, color, gravity = 0) {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this._c.setHex(color);
    this.col[i3] = this._c.r; this.col[i3 + 1] = this._c.g; this.col[i3 + 2] = this._c.b;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.gravity[i] = gravity;
  }

  burst(x, y, z, n, speed, life, size, color, gravity = -12) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const up = Math.random();
      this.spawn(
        x, y, z,
        Math.cos(a) * speed * (0.4 + Math.random() * 0.6),
        speed * (0.3 + up * 0.7),
        Math.sin(a) * speed * (0.4 + Math.random() * 0.6),
        life * (0.6 + Math.random() * 0.4), size, color, gravity,
      );
    }
  }

  _kill(i) {
    const last = --this.count;
    if (i === last) return;
    const i3 = i * 3, l3 = last * 3;
    for (let k = 0; k < 3; k++) {
      this.pos[i3 + k] = this.pos[l3 + k];
      this.vel[i3 + k] = this.vel[l3 + k];
      this.col[i3 + k] = this.col[l3 + k];
    }
    this.life[i] = this.life[last];
    this.maxLife[i] = this.maxLife[last];
    this.size[i] = this.size[last];
    this.gravity[i] = this.gravity[last];
  }

  update(dt) {
    let i = 0;
    while (i < this.count) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this._kill(i); continue; }
      const i3 = i * 3;
      this.vel[i3 + 1] += this.gravity[i] * dt;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] = Math.max(0.05, this.pos[i3 + 1] + this.vel[i3 + 1] * dt);
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      i++;
    }

    const e = this._m.elements;
    const colors = this.mesh.instanceColor.array;
    for (let j = 0; j < this.count; j++) {
      const j3 = j * 3;
      const s = this.size[j] * (this.life[j] / this.maxLife[j]);
      e[0] = s; e[1] = 0; e[2] = 0; e[3] = 0;
      e[4] = 0; e[5] = s; e[6] = 0; e[7] = 0;
      e[8] = 0; e[9] = 0; e[10] = s; e[11] = 0;
      e[12] = this.pos[j3]; e[13] = this.pos[j3 + 1]; e[14] = this.pos[j3 + 2]; e[15] = 1;
      this.mesh.setMatrixAt(j, this._m);
      colors[j3] = this.col[j3]; colors[j3 + 1] = this.col[j3 + 1]; colors[j3 + 2] = this.col[j3 + 2];
    }
    this.mesh.count = this.count;
    if (this.count > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
    }
  }

  clear() {
    this.count = 0;
    this.mesh.count = 0;
  }
}

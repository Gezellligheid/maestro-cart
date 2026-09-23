import * as THREE from 'three';

const COUNT = 600;
const BOX = { x: 70, y: 36, z: 70 }; // volume around the camera that the drops live in

/**
 * Rain or snowfall around the camera: one instanced mesh of drops/flakes kept in a box
 * centred on the camera and wrapped as it moves (1 draw call).
 */
export class Weather {
  constructor(renderer) {
    this.renderer = renderer;
    this.type = 'none';
    this.off = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      this.off[i * 3] = (Math.random() - 0.5) * BOX.x;
      this.off[i * 3 + 1] = (Math.random() - 0.5) * BOX.y;
      this.off[i * 3 + 2] = (Math.random() - 0.5) * BOX.z;
    }
    const rainGeo = new THREE.BoxGeometry(0.04, 1.1, 0.04);
    const snowGeo = new THREE.OctahedronGeometry(0.13, 0);
    this.rain = new THREE.InstancedMesh(rainGeo, renderer.basic({ color: 0xaecbff, transparent: true, opacity: 0.55, depthWrite: false }), COUNT);
    this.snow = new THREE.InstancedMesh(snowGeo, renderer.basic({ color: 0xffffff }), COUNT);
    for (const m of [this.rain, this.snow]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.visible = false;
      renderer.scene.add(m);
    }
    this._m = new THREE.Matrix4();
    this._t = 0;
  }

  set(type) {
    this.type = type || 'none';
    this.rain.visible = this.type === 'rain';
    this.snow.visible = this.type === 'snow';
  }

  /** `show` = false hides it (e.g. while the camera is at the podium or garage). */
  update(dt, cam, show = true) {
    this.rain.visible = show && this.type === 'rain';
    this.snow.visible = show && this.type === 'snow';
    if (this.type === 'none' || !show) return;
    this._t += dt;
    const rain = this.type === 'rain';
    const mesh = rain ? this.rain : this.snow;
    const fall = rain ? 32 : 3.2;
    const e = this._m.elements;
    const hx = BOX.x / 2, hy = BOX.y / 2, hz = BOX.z / 2;
    for (let i = 0; i < COUNT; i++) {
      const i3 = i * 3;
      this.off[i3 + 1] -= fall * dt;
      if (!rain) {
        this.off[i3] += Math.sin(this._t * 0.8 + i) * 0.6 * dt;
        this.off[i3 + 2] += Math.cos(this._t * 0.7 + i * 1.3) * 0.6 * dt;
      }
      // Wrap inside the box around the camera.
      if (this.off[i3 + 1] < -hy) this.off[i3 + 1] += BOX.y;
      if (this.off[i3] > hx) this.off[i3] -= BOX.x; else if (this.off[i3] < -hx) this.off[i3] += BOX.x;
      if (this.off[i3 + 2] > hz) this.off[i3 + 2] -= BOX.z; else if (this.off[i3 + 2] < -hz) this.off[i3 + 2] += BOX.z;
      const x = cam.x + this.off[i3], z = cam.z + this.off[i3 + 2];
      e[0] = 1; e[1] = 0; e[2] = 0; e[3] = 0;
      e[4] = 0; e[5] = 1; e[6] = 0; e[7] = 0;
      e[8] = 0; e[9] = 0; e[10] = 1; e[11] = 0;
      e[12] = x; e[13] = cam.y + this.off[i3 + 1]; e[14] = z; e[15] = 1;
      mesh.setMatrixAt(i, this._m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
}

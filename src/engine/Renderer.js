import * as THREE from 'three';

const SKY_TOP = new THREE.Color(0x3d8bff);
const SKY_HORIZON = new THREE.Color(0xbfe6ff);

/**
 * Owns the WebGL context, scene, camera and the shared material library.
 * All materials come from `toon()` / `basic()` so geometry batches share programs.
 */
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.info.autoReset = true;

    this.scene = new THREE.Scene();
    this.scene.background = SKY_HORIZON.clone();
    this.scene.fog = new THREE.Fog(SKY_HORIZON.getHex(), 140, 420);

    this.camera = new THREE.PerspectiveCamera(68, 1, 0.1, 900);
    this.camera.position.set(0, 20, -30);
    this.baseFov = 68;

    this._materials = new Map();
    this.gradientMap = this._makeGradientMap();

    this._setupLights();
    this._buildSky();
    this.shadows = new BlobShadows(this, 96);

    // Chase-camera scratch state (no per-frame allocation).
    this._camPos = new THREE.Vector3(0, 20, -30);
    this._camLook = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._shake = 0;

    this.resize = this.resize.bind(this);
    window.addEventListener('resize', this.resize);
    this.resize();
  }

  _makeGradientMap() {
    // Three-band ramp gives the crisp cel-shaded look.
    const data = new Uint8Array([90, 90, 90, 255, 175, 175, 175, 255, 255, 255, 255, 255]);
    const tex = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  _setupLights() {
    const hemi = new THREE.HemisphereLight(0xe8f4ff, 0x6a8f4e, 1.4);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(80, 140, 60);
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  }

  _buildSky() {
    const geo = new THREE.SphereGeometry(800, 24, 12);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = Math.max(0, pos.getY(i) / 800);
      c.copy(SKY_HORIZON).lerp(SKY_TOP, Math.pow(t, 0.6));
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false });
    const sky = new THREE.Mesh(geo, mat);
    sky.renderOrder = -1;
    sky.frustumCulled = false;
    this.sky = sky;
    this.scene.add(sky);
  }

  /** Shared cel-shaded material, cached by options. */
  toon({ color = 0xffffff, vertexColors = false, emissive = 0x000000, transparent = false, opacity = 1, side = THREE.FrontSide } = {}) {
    const key = `toon:${color}:${vertexColors}:${emissive}:${transparent}:${opacity}:${side}`;
    let m = this._materials.get(key);
    if (!m) {
      m = new THREE.MeshToonMaterial({ color, vertexColors, gradientMap: this.gradientMap, emissive, transparent, opacity, side });
      this._materials.set(key, m);
    }
    return m;
  }

  /** Shared unlit material, cached by options. */
  basic({ color = 0xffffff, vertexColors = false, transparent = false, opacity = 1, map = null, depthWrite = true, blending = THREE.NormalBlending } = {}) {
    const key = `basic:${color}:${vertexColors}:${transparent}:${opacity}:${map ? map.uuid : ''}:${depthWrite}:${blending}`;
    let m = this._materials.get(key);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color, vertexColors, transparent, opacity, map, depthWrite, blending });
      this._materials.set(key, m);
    }
    return m;
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.gl.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  addShake(amount) {
    this._shake = Math.min(1, this._shake + amount);
  }

  /** Smooth third-person chase camera. Speed widens FOV; boosts push it further. */
  updateChaseCamera(x, y, z, yaw, speed, boosting, dt, snap = false, zoom = 1) {
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const back = (7.2 + Math.min(Math.abs(speed), 45) * 0.03) * zoom;
    const height = 3.1 * zoom;

    const desired = this._tmp.set(x - fx * back, y + height, z - fz * back);
    const k = snap ? 1 : 1 - Math.exp(-dt * 7);
    this._camPos.lerp(desired, k);
    this._camLook.set(x + fx * 4 * zoom, y + 1.1 * zoom, z + fz * 4 * zoom);

    const cam = this.camera;
    cam.position.copy(this._camPos);
    if (this._shake > 0) {
      const s = this._shake * 0.35;
      cam.position.x += (Math.random() - 0.5) * s;
      cam.position.y += (Math.random() - 0.5) * s;
      this._shake = Math.max(0, this._shake - dt * 2.5);
    }
    cam.lookAt(this._camLook);

    const targetFov = this.baseFov + Math.min(Math.abs(speed), 50) * 0.22 + (boosting ? 8 : 0);
    const fov = cam.fov + (targetFov - cam.fov) * (1 - Math.exp(-dt * 5));
    if (Math.abs(fov - cam.fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    this.sky.position.copy(cam.position);
  }

  /** Slow orbit used on the menu screen. */
  updateOrbitCamera(time, cx, cz, radius) {
    const a = time * 0.08;
    this.camera.position.set(cx + Math.cos(a) * radius, 70, cz + Math.sin(a) * radius);
    this.camera.lookAt(cx, 0, cz);
    if (this.camera.fov !== this.baseFov) {
      this.camera.fov = this.baseFov;
      this.camera.updateProjectionMatrix();
    }
    this.sky.position.copy(this.camera.position);
    this._camPos.copy(this.camera.position);
  }

  /** Garage showroom: slow orbit around a kart on a podium, framed to the left of the side panel. */
  updateShowroomCamera(time, cx, cy, cz) {
    const a = time * 0.35;
    const cam = this.camera;
    const wide = window.innerWidth >= 768;
    cam.position.set(cx + Math.sin(a) * 8.5, cy + 3.2, cz + Math.cos(a) * 8.5);
    // Aim right of the kart on wide screens so it sits in the free space left of the panel.
    const off = wide ? 3 : 0;
    cam.lookAt(cx + Math.cos(a) * off, cy + 0.9, cz - Math.sin(a) * off);
    if (cam.fov !== this.baseFov) {
      cam.fov = this.baseFov;
      cam.updateProjectionMatrix();
    }
    this.sky.position.copy(cam.position);
    this._camPos.copy(cam.position);
  }

  render() {
    this.shadows.flush();
    this.gl.render(this.scene, this.camera);
  }

  get drawCalls() {
    return this.gl.info.render.calls;
  }
}

/**
 * One instanced quad per blob shadow for every dynamic object in the scene (1 draw call total).
 * Call add() during the frame; render() flushes and resets.
 */
export class BlobShadows {
  constructor(renderer, capacity) {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(0.6, 'rgba(0,0,0,0.3)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;

    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = renderer.basic({ map: tex, transparent: true, depthWrite: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.count = 0;
    this.capacity = capacity;
    this._n = 0;
    this._m = new THREE.Matrix4();
    renderer.scene.add(this.mesh);
  }

  add(x, y, z, scale) {
    if (this._n >= this.capacity) return;
    const e = this._m.elements;
    e[0] = scale; e[1] = 0; e[2] = 0; e[3] = 0;
    e[4] = 0; e[5] = 1; e[6] = 0; e[7] = 0;
    e[8] = 0; e[9] = 0; e[10] = scale; e[11] = 0;
    e[12] = x; e[13] = y + 0.06; e[14] = z; e[15] = 1;
    this.mesh.setMatrixAt(this._n++, this._m);
  }

  flush() {
    this.mesh.count = this._n;
    if (this._n > 0) this.mesh.instanceMatrix.needsUpdate = true;
    this._n = 0;
  }
}

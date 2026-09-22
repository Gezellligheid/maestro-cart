import RAPIER from '@dimforge/rapier3d-compat';
import { FIXED_DT, MAX_SUBSTEPS, COLLISION, KART } from '../game/constants.js';

// Packs Rapier interaction groups: upper 16 bits = membership, lower 16 bits = filter.
const groups = (membership, filter) => membership * 0x10000 + filter;
const ALL = 0xffff;

/**
 * Thin wrapper around a Rapier world that runs on a fixed timestep, decoupled from
 * requestAnimationFrame. Render code reads `alpha` to interpolate between the last two steps.
 */
export class Physics {
  static async create() {
    await RAPIER.init();
    return new Physics();
  }

  constructor() {
    this.RAPIER = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: -28, z: 0 });
    this.world.timestep = FIXED_DT;
    this.accumulator = 0;
    this.alpha = 0;
    this.stepCount = 0;

    // Reused query objects so hot-path raycasts never allocate JS wrappers.
    this._ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.groundGroups = groups(ALL, COLLISION.GROUND);
    this.wallGroups = groups(ALL, COLLISION.WALL);
    this.solidFilter = RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC;
  }

  addGround(halfSize) {
    // Safety floor well below the terrain; the road trimesh is the real driving surface.
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -31, 0));
    const desc = RAPIER.ColliderDesc.cuboid(halfSize, 1, halfSize)
      .setFriction(0)
      .setCollisionGroups(groups(COLLISION.GROUND, ALL));
    return this.world.createCollider(desc, body);
  }

  /** Static oriented box used for barriers. `yaw` rotates around +Y. */
  addWall(x, y, z, hx, hy, hz, yaw) {
    const half = yaw * 0.5;
    const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(x, y, z)
      .setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) })
      .setFriction(0)
      .setRestitution(0.35)
      .setCollisionGroups(groups(COLLISION.WALL, ALL));
    return this.world.createCollider(desc);
  }

  /** Static triangle mesh in the GROUND group (bridge decks and ramps). */
  addTrimesh(vertices, indices) {
    const desc = RAPIER.ColliderDesc.trimesh(vertices, indices)
      .setFriction(0)
      .setCollisionGroups(groups(COLLISION.GROUND, ALL));
    return this.world.createCollider(desc);
  }

  /** Dynamic kart body: a frictionless ball with all rotations locked; heading is handled by Kart. */
  createKartBody(x, y, z) {
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .lockRotations()
      .setLinearDamping(0)
      .setCcdEnabled(true)
      .setCanSleep(false);
    const body = this.world.createRigidBody(bodyDesc);
    const colDesc = RAPIER.ColliderDesc.ball(KART.radius)
      .setFriction(0)
      .setRestitution(0.25)
      .setMass(KART.mass)
      .setCollisionGroups(groups(COLLISION.KART, ALL));
    this.world.createCollider(colDesc, body);
    return body;
  }

  /** Kinematic body for network-driven opponents so the local kart can bump into them. */
  createKinematicKartBody(x, y, z) {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y, z),
    );
    const colDesc = RAPIER.ColliderDesc.ball(KART.radius)
      .setFriction(0)
      .setRestitution(0.4)
      .setCollisionGroups(groups(COLLISION.KART, ALL));
    this.world.createCollider(colDesc, body);
    return body;
  }

  removeBody(body) {
    if (body) this.world.removeRigidBody(body);
  }

  /** Downward ray against the ground only. Returns distance or -1. */
  groundDistance(x, y, z, maxDist) {
    const ray = this._ray;
    ray.origin.x = x; ray.origin.y = y; ray.origin.z = z;
    ray.dir.x = 0; ray.dir.y = -1; ray.dir.z = 0;
    const hit = this.world.castRay(ray, maxDist, true, this.solidFilter, this.groundGroups);
    return hit ? hit.timeOfImpact : -1;
  }

  /**
   * Horizontal ray against barriers only. Returns the Rapier hit (with normal) or null.
   * (dx, dz) must be normalised.
   */
  castWall(x, y, z, dx, dz, maxDist) {
    const ray = this._ray;
    ray.origin.x = x; ray.origin.y = y; ray.origin.z = z;
    ray.dir.x = dx; ray.dir.y = 0; ray.dir.z = dz;
    return this.world.castRayAndGetNormal(ray, maxDist, true, this.solidFilter, this.wallGroups);
  }

  /**
   * Advance the simulation by a variable frame delta using a fixed-step accumulator.
   * `pre(dt)` runs before each world.step (apply forces/velocities), `post(dt)` after it.
   */
  step(frameDt, pre, post) {
    this.accumulator += Math.min(frameDt, FIXED_DT * MAX_SUBSTEPS);
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      pre(FIXED_DT);
      this.world.step();
      post(FIXED_DT);
      this.accumulator -= FIXED_DT;
      this.stepCount++;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this.accumulator = 0; // drop time instead of spiralling
    this.alpha = this.accumulator / FIXED_DT;
    return steps;
  }
}

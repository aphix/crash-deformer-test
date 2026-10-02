import * as THREE from "three";

/** Inside the lamp ring (16 m) and well inside the 48 m pad: the bowl for up to 12 cars. */
export const DERBY_RADIUS = 16.4;
/** Spawn ring sits this far inside the wall (`layoutDerby`). */
export const SPAWN_INSET = 5.2;
/** Bumper-to-bumper room between tangent neighbours on the spawn ring: a 4.44 m car plus 1.2 m. */
const SPAWN_PITCH = 5.64;

/** Bowl radius for a field of `count`: today's bowl up to 12 cars, then wide enough that the spawn ring keeps `SPAWN_PITCH` (32 cars: ~34 m). */
export function derbyRadius(count: number): number {
  const n = Math.max(2, Math.round(count) || 2);
  return Math.max(DERBY_RADIUS, SPAWN_PITCH / (2 * Math.sin(Math.PI / n)) + SPAWN_INSET);
}
const SEGMENTS = 28;
const WALL_H = 1.15;
const WALL_T = 0.42;

export function makeDerbyArena(): THREE.Group {
  const g = new THREE.Group();
  g.name = "derby-arena";
  const mat = new THREE.MeshStandardMaterial({
    color: 0xb7b1a4,
    roughness: 0.92,
    metalness: 0.06,
  });
  const stripe = new THREE.MeshStandardMaterial({
    color: 0xd8d4cc,
    roughness: 0.55,
    metalness: 0.08,
  });
  const arc = (Math.PI * 2) / SEGMENTS;
  const chord = 2 * DERBY_RADIUS * Math.sin(arc * 0.5);
  const box = new THREE.BoxGeometry(WALL_T, WALL_H, chord * 0.96);
  // Alternating slabs: one instanced draw per material instead of one per slab.
  const walls = [mat, stripe].map((m) => {
    const mesh = new THREE.InstancedMesh(box, m, SEGMENTS / 2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  });
  const slab = new THREE.Object3D();
  for (let i = 0; i < SEGMENTS; i++) {
    const a = i * arc;
    slab.position.set(Math.sin(a) * DERBY_RADIUS, WALL_H * 0.5, Math.cos(a) * DERBY_RADIUS);
    // Box long axis is local Z. rotation.y = a points that axis down the radius.
    slab.rotation.y = a + Math.PI / 2;
    slab.updateMatrix();
    walls[i % 2]!.setMatrixAt(i >> 1, slab.matrix);
  }
  for (const w of walls) {
    w.computeBoundingSphere();
    g.add(w);
  }
  const lip = new THREE.Mesh(
    new THREE.RingGeometry(DERBY_RADIUS - 0.35, DERBY_RADIUS + 0.2, 64),
    new THREE.MeshBasicMaterial({ color: 0xd8d4cc, transparent: true, opacity: 0.18, side: THREE.DoubleSide, forceSinglePass: true }),
  );
  lip.rotation.x = -Math.PI / 2;
  lip.position.y = 0.03;
  g.add(lip);
  g.visible = false;
  return g;
}

/** Spot height above the winner (m) and its candela when on. */
const SPOT_HEIGHT = 7;
const SPOT_CANDELA = 320;

/**
 * The derby winner's spotlight: a warm narrow cone from above that follows the champion and throws a soft
 * pool on the ground, plus an additive glow decal under the car. Built once; "off" is intensity and opacity
 * 0, so no light or mesh is ever added, removed or hidden at runtime (each would recompile lit materials).
 * ponytail: no shadow map — the pool reads without one; add `castShadow` only if a cheap one is wanted.
 */
export class WinnerSpot {
  readonly light = new THREE.SpotLight(0xfff0d8, 0, SPOT_HEIGHT * 2, 0.36, 0.65, 2);
  private readonly glow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

  constructor(scene: THREE.Scene, pool: THREE.Texture) {
    this.glow = new THREE.Mesh(
      new THREE.PlaneGeometry(6.5, 6.5),
      new THREE.MeshBasicMaterial({ color: 0xffd9a0, map: pool, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.glow.rotation.x = -Math.PI / 2;
    this.glow.position.y = 0.03;
    scene.add(this.light, this.light.target, this.glow);
  }

  follow(x: number, z: number): void {
    this.light.position.set(x, SPOT_HEIGHT, z);
    this.light.target.position.set(x, 0, z);
    this.light.target.updateMatrixWorld();
    this.light.intensity = SPOT_CANDELA;
    this.glow.position.set(x, 0.03, z);
    this.glow.material.opacity = 0.5;
  }

  off(): void {
    this.light.intensity = 0;
    this.glow.material.opacity = 0;
  }
}

/** Push a body back inside the bowl of `radius`. Returns true if it hit the wall. */
export function clipToDerbyBowl(
  x: number,
  z: number,
  vx: number,
  vz: number,
  pad = 1.35,
  radius = DERBY_RADIUS,
): { x: number; z: number; vx: number; vz: number; hit: boolean } {
  const limit = radius - pad;
  const r = Math.hypot(x, z);
  if (r <= limit || r < 1e-6) return { x, z, vx, vz, hit: false };
  const nx = x / r;
  const nz = z / r;
  const px = nx * limit;
  const pz = nz * limit;
  const outward = vx * nx + vz * nz;
  let nvx = vx;
  let nvz = vz;
  if (outward > 0) {
    nvx -= nx * outward * 1.15;
    nvz -= nz * outward * 1.15;
  }
  return { x: px, z: pz, vx: nvx, vz: nvz, hit: true };
}

import * as THREE from "three";

/** Inside the lamp ring (16 m) and well inside the 48 m pad. */
export const DERBY_RADIUS = 16.4;
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

/** Push a body back inside the bowl. Returns true if it hit the wall. */
export function clipToDerbyBowl(
  x: number,
  z: number,
  vx: number,
  vz: number,
  pad = 1.35,
): { x: number; z: number; vx: number; vz: number; hit: boolean } {
  const limit = DERBY_RADIUS - pad;
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

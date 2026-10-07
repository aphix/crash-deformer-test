import * as THREE from "three";
import type { Collider, RigidBody, World } from "@dimforge/rapier3d";
import { PREFABS, type PrefabId } from "../world/catalog.ts";

const _q = new THREE.Quaternion();
const _a = new THREE.Vector3();

/**
 * World height of the lowest point of knockable prop `prefab`'s own shape (placed at scale 1) on `body`, worked out from
 * its prefab's size and the shape's makeup, not read from its colliders: a cone's 0.4 m square base plate 4 cm thick and
 * its tip at the top, a tyre stack's upright cylinder, a crate's or a hay bale's box.
 */
export function lowestPoint(prefab: PrefabId, body: RigidBody): number {
  const t = body.translation();
  const r = body.rotation();
  _q.set(r.x, r.y, r.z, r.w);
  const [w, h, d] = PREFABS[prefab].size;
  // How far up the world each of its own axes points.
  const ux = _a.set(1, 0, 0).applyQuaternion(_q).y;
  const uy = _a.set(0, 1, 0).applyQuaternion(_q).y;
  const uz = _a.set(0, 0, 1).applyQuaternion(_q).y;
  if (prefab === "tyre-stack") return t.y - (Math.abs(uy) * h) / 2 - (w / 2) * Math.sqrt(Math.max(0, 1 - uy * uy));
  if (prefab === "cone") {
    // The plate's middle is 0.02 m over the base (half 0.02 thick); the tip is half the cone's height over its middle.
    const plate = t.y + (0.02 - h / 2) * uy - (w / 2) * Math.abs(ux) - 0.02 * Math.abs(uy) - (d / 2) * Math.abs(uz);
    return Math.min(plate, t.y + (h / 2) * uy);
  }
  return t.y - (w / 2) * Math.abs(ux) - (h / 2) * Math.abs(uy) - (d / 2) * Math.abs(uz);
}

/**
 * How deep (m) a knocked prop's own shape (its colliders `own`) is inside the deepest of `world`'s statics other than the
 * ground (a course's walls and solids; its ground is a heightfield), as Rapier's shape query measures the two shapes (the
 * depth it would take to part them), whatever their collision groups. Clear of them all: minus its gap to the nearest
 * within 0.1 m, or -Infinity.
 */
export function deepestInStatics(world: World, own: readonly Collider[]): number {
  let deepest = -Infinity;
  world.forEachCollider((other) => {
    // Rapier's `ShapeType.HeightField` is 7.
    if (other.parent() !== null || other.shapeType() === 7) return;
    for (const c of own) {
      const hit = c.contactCollider(other, 0.1);
      if (hit) deepest = Math.max(deepest, -hit.distance);
    }
  });
  return deepest;
}

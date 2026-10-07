import * as THREE from "three";
import type { DeformableCar } from "./car.ts";
import type { GlassName } from "./car-core.ts";
import { GLASS_NAMES } from "./car-glass.ts";

/** World centre of pane `name` of `car` and its outward unit normal (out of the cabin), from the drawn pane itself. */
export function paneFrame(car: DeformableCar, name: GlassName): { centre: THREE.Vector3; out: THREE.Vector3 } {
  const centre = car.glassWorld(name, new THREE.Vector3());
  const pane = car["glassPanes"].find((g) => g.name === name)!;
  const normals = pane.mesh.geometry.getAttribute("normal");
  const out = new THREE.Vector3();
  for (let i = 0; i < normals.count; i++) out.add(new THREE.Vector3(normals.getX(i), normals.getY(i), normals.getZ(i)));
  out.transformDirection(pane.mesh.matrixWorld);
  // Out of the cabin: away from the middle of the greenhouse.
  const cabin = new THREE.Vector3(0, 1, -0.1).applyMatrix4(car.group.matrixWorld);
  if (out.dot(centre.clone().sub(cabin)) < 0) out.negate();
  return { centre, out };
}

/** Each pane's state, by name. */
export function glassOf(car: DeformableCar): Record<string, string> {
  const bits = car.glassBits();
  const states = ["intact", "cracked", "shattered"];
  return Object.fromEntries(GLASS_NAMES.map((n, i) => [n, states[(bits >> (2 * i)) & 3]!]));
}

import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { CLASSES, killClass } from "../vehicle/vehicle-classes.ts";

/** Barrier speed (m/s) of the hit that packs a durability-1 block to `killTravel` at realism 1: 56 km/h. */
const KILL_EBS = 15.6;

/**
 * Will the hit about to land throw a driver: does either car take it past the realistic kill, at its energy-equivalent
 * barrier speed (its share of `closing` by the other's mass; all of it into a wall, `b` null) against `KILL_EBS` ×
 * √durability? The sandbox clock asks just before the hit, so a throw's slow-mo waits (`THROW_ONSET`). The throw
 * itself is the sim's call (`EjectionWatch`, vehicle/ejection.ts); this only predicts it.
 * Lane ragdoll-5's probe: 40 default fleet runs (0–32 m/s) and 7 barrier speeds, 87 of 87 cars as `EjectionWatch` judged them.
 */
function throwLikely(a: DeformableCar, b: DeformableCar | null, closing: number): boolean {
  const ca = CLASSES[killClass(a)];
  if (!b) return closing >= KILL_EBS * Math.sqrt(ca.durability);
  const cb = CLASSES[killClass(b)];
  const share = closing / (ca.mass + cb.mass);
  return share * cb.mass >= KILL_EBS * Math.sqrt(ca.durability) || share * ca.mass >= KILL_EBS * Math.sqrt(cb.durability);
}

const _rel = new THREE.Vector3();

/**
 * Will the hit about to land in `cars` throw a driver (`throwLikely`): a pair closing within 10 m centre to centre, or
 * a car under 0.3 s off `barrier` (the standing jersey barrier, else null)? The engine asks once its pre-hit check sees
 * contact coming.
 */
export function throwComing(cars: readonly DeformableCar[], barrier: { contactEta(cars: readonly DeformableCar[], eta: number): number } | null): boolean {
  for (let i = 0; i < cars.length; i++) {
    const a = cars[i]!;
    if (barrier && barrier.contactEta([a], Infinity) < 0.3 && throwLikely(a, null, a.speed)) return true;
    for (let j = i + 1; j < cars.length; j++) {
      const b = cars[j]!;
      if (a.group.position.distanceTo(b.group.position) < 10 && throwLikely(a, b, _rel.copy(a.velocity).sub(b.velocity).length())) return true;
    }
  }
  return false;
}

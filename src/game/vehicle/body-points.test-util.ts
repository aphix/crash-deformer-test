import { CAR_HALF } from "./car-mesh.ts";
import type { DeformableCar } from "./car.ts";

/**
 * The car's body as world points (x, z): a live car's box corners and crush hulls; a wreck's crush hulls and body masses
 * (not the wheel hubs). A crushed nose is shorter than the box it was built in, so a wreck's box corners are no longer its body.
 */
export function bodyPoints(car: DeformableCar): [number, number][] {
  const out: [number, number][] = [];
  const p = car.group.position;
  const c = Math.cos(car.yaw);
  const s = Math.sin(car.yaw);
  const add = (lx: number, lz: number): void => void out.push([p.x + lx * c + lz * s, p.z - lx * s + lz * c]);
  if (!car.deform.massActive) for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(sx * CAR_HALF.x, sz * CAR_HALF.z);
  for (const h of car.crushHulls()) for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(h.cx + sx * h.hx, h.cz + sz * h.hz);
  if (car.deform.massActive) for (const m of car.deform.masses) if (!m.hub) out.push([m.world.x, m.world.z]);
  return out;
}

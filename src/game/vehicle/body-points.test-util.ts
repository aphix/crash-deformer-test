import type { DeformableCar } from "./car.ts";

/** The car's body as world points (x, z): the cage's vertices, the drawn body as it stands crushed or whole (not the wheel hubs). */
export function bodyPoints(car: DeformableCar): [number, number][] {
  car.refitCage();
  const out: [number, number][] = [];
  const p = car.group.position;
  const c = Math.cos(car.yaw);
  const s = Math.sin(car.yaw);
  const pos = car.cage.fields.pos;
  for (let k = 0; k < car.cage.style.vertexCount; k++) {
    const lx = pos[k * 3]!;
    const lz = pos[k * 3 + 2]!;
    out.push([p.x + lx * c + lz * s, p.z - lx * s + lz * c]);
  }
  return out;
}

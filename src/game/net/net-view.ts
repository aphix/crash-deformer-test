import type { DeformableCar } from "../car.ts";
import type { Snapshot } from "./codec.ts";
import type { NetGame } from "./net-ports.ts";

/**
 * Client: every car as of render time `rt` (host clock, s) from the snapshot ring. Poses interpolate
 * between the newest snapshot at or before `rt` and the oldest after it (held at either end); each
 * car's newest wreck section at or before `rt` is applied once. `ringOrder[k]` is slot k's receive
 * order (0 = empty); `applied[i]` the receive order of the wreck section car i last took.
 */
export function drawSnapshots(
  ring: readonly Snapshot[],
  ringOrder: readonly number[],
  applied: number[],
  cars: readonly DeformableCar[],
  rt: number,
  wallDt: number,
  game: Pick<NetGame, "setVaporized">,
): void {
  let a = -1;
  let b = -1;
  for (let k = 0; k < ringOrder.length; k++) {
    if (ringOrder[k] === 0) continue;
    const tk = ring[k]!.time;
    if (tk <= rt) {
      if (a < 0 || tk > ring[a]!.time) a = k;
    } else if (b < 0 || tk < ring[b]!.time) b = k;
  }
  const sa = ring[a >= 0 ? a : b]!;
  const orderA = ringOrder[a >= 0 ? a : b]!;
  const sb = ring[b >= 0 ? b : a]!;
  const u = sa === sb ? 0 : Math.min(1, Math.max(0, (rt - sa.time) / (sb.time - sa.time)));

  for (let i = 0; i < cars.length && i < sa.count; i++) {
    const car = cars[i]!;
    const fa = sa.cars[i]!;
    const fb = i < sb.count ? sb.cars[i]! : fa;
    if (car.crashed && !fa.crashed) {
      car.resetVisual();
      applied[i] = orderA;
    }
    let dyaw = fb.yaw - fa.yaw;
    if (dyaw > Math.PI) dyaw -= Math.PI * 2;
    else if (dyaw < -Math.PI) dyaw += Math.PI * 2;
    car.yaw = fa.yaw + dyaw * u;
    car.pitch = fa.pitch + (fb.pitch - fa.pitch) * u;
    let droll = fb.roll - fa.roll;
    if (droll > Math.PI) droll -= Math.PI * 2;
    else if (droll < -Math.PI) droll += Math.PI * 2;
    car.roll = fa.roll + droll * u;
    car.group.position.set(
      fa.x + (fb.x - fa.x) * u,
      fa.y + (fb.y - fa.y) * u,
      fa.z + (fb.z - fa.z) * u,
    );
    car.group.rotation.set(car.pitch, car.yaw, car.roll, "YXZ");
    car.velocity.set(
      fa.vx + (fb.vx - fa.vx) * u,
      fa.vy + (fb.vy - fa.vy) * u,
      fa.vz + (fb.vz - fa.vz) * u,
    );
    car.angular.set(0, fa.wy + (fb.wy - fa.wy) * u, 0);
    car.speed = car.velocity.length();
    car.crashed = fa.crashed;
    car.refreshBasis();
    // Fleet disc edge: the falling fake follows the host's pose (stepEdge shrinks it here too); the
    // vaporize burst plays locally. Neither takes mesh updates.
    if (fa.vaporized !== car.vaporized) game.setVaporized(i, fa.vaporized);
    if (car.falling && !fa.falling) car.group.scale.setScalar(1);
    car.falling = fa.falling;

    // The newest wreck section at or before the render time, once.
    let w = -1;
    for (let k = 0; k < ringOrder.length; k++) {
      const s = ring[k];
      if (
        !s ||
        ringOrder[k]! <= (applied[i] ?? 0) ||
        s.time > rt ||
        i >= s.count ||
        !s.cars[i]!.wreck
      )
        continue;
      if (w < 0 || ringOrder[k]! > ringOrder[w]!) w = k;
    }
    if (w >= 0 && !car.falling && !car.vaporized) {
      const f = ring[w]!.cars[i]!;
      car.writeNetState(f.deform, f.parts);
      applied[i] = ringOrder[w]!;
    }
    if (!car.falling && !car.vaporized) car.netFrame(wallDt);
  }
}

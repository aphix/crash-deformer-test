import { NO_FLOOR } from "../world/ground.ts";
import { GROUND_SKIN, HUB_FLOOR } from "./deform-state.ts";
import type { MassNode } from "./deform-rig.ts";
import { CRASH, FRICTION_G, hypot2 } from "./physics-util.ts";
import { MIN_INERTIA } from "./constants.ts";

/**
 * The tyres' resistance to a wreck's turn: each hub on the ground (`HUB_FLOOR` + `GROUND_SKIN` over its floor) carries
 * an equal share of the weight and rubs against its own sliding velocity at Coulomb μ (a tyre `muSlide`, a popped
 * hub's rim `muScuff`, × the ground's grip). The torque of those forces about the centroid takes the spin down, never
 * past zero and never the other way: a wreck sliding straight has the translation drag's, and only the spin it already
 * has is resisted. Pure spin on n tyres: τ = Σ μ (M g / n) r. `floor`/`grip`: the ground under each mass after its move.
 */
export function resistYaw(masses: readonly MassNode[], floor: Float64Array, grip: Float64Array, dt: number): void {
  let m = 0,
    cx = 0,
    cz = 0;
  for (let i = 0; i < masses.length; i++) {
    const q = masses[i]!;
    if (!q.dynamic) continue;
    m += q.mass;
    cx += q.world.x * q.mass;
    cz += q.world.z * q.mass;
  }
  if (m < 1e-8 || dt <= 0) return;
  cx /= m;
  cz /= m;
  let n = 0,
    l = 0,
    inertia = 0;
  for (let i = 0; i < masses.length; i++) {
    const q = masses[i]!;
    if (!q.dynamic) continue;
    const rx = q.world.x - cx;
    const rz = q.world.z - cz;
    l += q.mass * (rz * q.vel.x - rx * q.vel.z);
    inertia += q.mass * (rx * rx + rz * rz);
    if (q.hub && floor[i] !== NO_FLOOR && q.world.y <= floor[i]! + HUB_FLOOR + GROUND_SKIN) n++;
  }
  if (n === 0 || inertia < MIN_INERTIA || Math.abs(l) < 1e-9) return;
  const share = (m * FRICTION_G) / n;
  let torque = 0;
  for (let i = 0; i < masses.length; i++) {
    const q = masses[i]!;
    if (!q.dynamic || !q.hub || floor[i] === NO_FLOOR || q.world.y > floor[i]! + HUB_FLOOR + GROUND_SKIN) continue;
    const s = hypot2(q.vel.x, q.vel.z);
    if (s < 1e-5) continue;
    const f = -((q.popped ? CRASH.muScuff : CRASH.muSlide) * grip[i]! * share) / s;
    torque += (q.world.z - cz) * q.vel.x * f - (q.world.x - cx) * q.vel.z * f;
  }
  // Only a torque against the spin counts, and it stops the spin at zero.
  const w = l / inertia;
  if (torque * w >= 0) return;
  const dw = Math.sign(w) * Math.min(Math.abs(w), (Math.abs(torque) * dt) / inertia);
  for (let i = 0; i < masses.length; i++) {
    const q = masses[i]!;
    if (!q.dynamic) continue;
    q.vel.x -= dw * (q.world.z - cz);
    q.vel.z += dw * (q.world.x - cx);
  }
}

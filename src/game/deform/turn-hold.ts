/** What a position-only pass (a clamp, an overlap push, shape matching) does to a wreck's turn and its angular momentum. */
type Body = { readonly mass: number; readonly world: { x: number; z: number }; readonly vel: { x: number; z: number } };

/** Every mass's world x/z into `heldX`/`heldZ`: the pose `undoNetTurn` measures a pass's turn against. */
export function holdPositions(masses: readonly Body[], heldX: Float64Array, heldZ: Float64Array): void {
  for (let i = 0; i < masses.length; i++) {
    heldX[i] = masses[i]!.world.x;
    heldZ[i] = masses[i]!.world.z;
  }
}

/** Undo the net turn (about the held centroid, as stepShapeMatch does for its goals) that a
 *  position-only pass made since `holdPositions`; its translation and reshaping stay. */
export function undoNetTurn(masses: readonly Body[], heldX: Float64Array, heldZ: Float64Array): void {
  let mx = 0,
    mz = 0,
    mm = 0;
  for (let i = 0; i < masses.length; i++) {
    const m = masses[i]!;
    mx += heldX[i]! * m.mass;
    mz += heldZ[i]! * m.mass;
    mm += m.mass;
  }
  mx /= mm;
  mz /= mm;
  let turn = 0,
    turnI = 0;
  for (let i = 0; i < masses.length; i++) {
    const m = masses[i]!;
    const rx = heldX[i]! - mx;
    const rz = heldZ[i]! - mz;
    turn += m.mass * (rz * (m.world.x - heldX[i]!) - rx * (m.world.z - heldZ[i]!));
    turnI += m.mass * (rx * rx + rz * rz);
  }
  const w = turn / turnI;
  for (let i = 0; i < masses.length; i++) {
    const m = masses[i]!;
    m.world.x -= w * (heldZ[i]! - mz);
    m.world.z += w * (heldX[i]! - mx);
  }
}

/**
 * The masses' angular momentum about their centroid (y) into `held[slot]`, or with `restore`, a rigid turn added to
 * every mass's velocity that sets it back to `held[slot]`. Through typed arrays, not an argument and return value: the
 * solver calls it out of line, and both were boxed per call.
 */
export function holdMomentum(masses: readonly Body[], held: Float64Array, slot: number, restore: boolean): void {
  let mass = 0,
    cx = 0,
    cz = 0;
  for (let mi = 0; mi < masses.length; mi++) {
    const m = masses[mi]!;
    cx += m.world.x * m.mass;
    cz += m.world.z * m.mass;
    mass += m.mass;
  }
  cx /= mass;
  cz /= mass;
  let l = 0,
    inertia = 0;
  for (let mi = 0; mi < masses.length; mi++) {
    const m = masses[mi]!;
    const rx = m.world.x - cx;
    const rz = m.world.z - cz;
    l += m.mass * (rz * m.vel.x - rx * m.vel.z);
    inertia += m.mass * (rx * rx + rz * rz);
  }
  if (!restore) {
    held[slot] = l;
    return;
  }
  const target = held[slot]!;
  if (Number.isNaN(target) || inertia < 1e-9) return;
  const w = (target - l) / inertia;
  for (let mi = 0; mi < masses.length; mi++) {
    const m = masses[mi]!;
    m.vel.x += w * (m.world.z - cz);
    m.vel.z -= w * (m.world.x - cx);
  }
}

/**
 * Turn every mass's velocity relative to the mean by the net turn a position-only pass kept since `holdPositions` (the
 * angle `undoNetTurn` takes back): the body's internal motion, its spin included, turns with its pose.
 */
export function turnVelocities(masses: readonly Body[], heldX: Float64Array, heldZ: Float64Array): void {
  let mx = 0,
    mz = 0,
    mm = 0,
    vx = 0,
    vz = 0;
  for (let i = 0; i < masses.length; i++) {
    const m = masses[i]!;
    mx += heldX[i]! * m.mass;
    mz += heldZ[i]! * m.mass;
    vx += m.vel.x * m.mass;
    vz += m.vel.z * m.mass;
    mm += m.mass;
  }
  mx /= mm;
  mz /= mm;
  vx /= mm;
  vz /= mm;
  let turn = 0,
    turnI = 0;
  for (let i = 0; i < masses.length; i++) {
    const m = masses[i]!;
    const rx = heldX[i]! - mx;
    const rz = heldZ[i]! - mz;
    turn += m.mass * (rz * (m.world.x - heldX[i]!) - rx * (m.world.z - heldZ[i]!));
    turnI += m.mass * (rx * rx + rz * rz);
  }
  const w = turn / turnI;
  const c = Math.cos(w);
  const s = Math.sin(w);
  for (let i = 0; i < masses.length; i++) {
    const m = masses[i]!;
    const ux = m.vel.x - vx;
    const uz = m.vel.z - vz;
    m.vel.x = vx + ux * c + uz * s;
    m.vel.z = vz - ux * s + uz * c;
  }
}

import { detSin, detCos, sinCosAt } from "../kernel/physics-core.js";
/** `fit`'s heading in [yaw, _], its [sin, cos] out (`sinCosAt`: no boxed argument or result). */
const _sc = new Float64Array(2);
/** Steepest ground plane (rad, 34°) a planted wreck settles to; the stunt course's kicker is 21.5°. */
const TILT = 0.6;
/** Least spread (m⁴) of the hubs' x/z a ground plane is fitted on: four hubs read 16, three 5; a squeezed or lost set is no plane. */
const SPREAD = 0.5;

/**
 * The ground plane under a wreck's attached hubs: the least-squares slope (m per m) of their floors over their own
 * x/z, taken about the first hub's floor in height (`add` is given x/z about the cell), so the sums stay small and a
 * level ground fits level to the last bit. Two hubs on a ramp's side and two on the flat share one plane.
 */
export class HubPlane {
  /** Pitch and roll (rad) of the fitted plane in the car's heading (`fit`). */
  pitch = 0;
  roll = 0;
  /** The plane's height (m) at the cell (`add`'s origin) and its rise (m per m) along world x and z; height NaN where the hubs fix no plane. */
  height = NaN;
  gx = 0;
  gz = 0;
  private n = 0;
  private base = 0;
  private sx = 0;
  private sz = 0;
  private sf = 0;
  private sxx = 0;
  private sxz = 0;
  private szz = 0;
  private sxf = 0;
  private szf = 0;

  reset(): void {
    this.n = 0;
    this.sx = this.sz = this.sf = this.sxx = this.sxz = this.szz = this.sxf = this.szf = 0;
  }

  /** A hub at (x, z) over a floor `floor` high. */
  add(x: number, z: number, floor: number): void {
    if (this.n++ === 0) this.base = floor;
    const h = floor - this.base;
    this.sx += x;
    this.sz += z;
    this.sf += h;
    this.sxx += x * x;
    this.sxz += x * z;
    this.szz += z * z;
    this.sxf += x * h;
    this.szf += z * h;
  }

  /**
   * The plane as the frame's pitch and roll in heading `yaw` (YXZ: the body's up is yaw · pitch · roll · y, so a plane
   * rising `along` per m along the car reads pitch −atan(along), nose up negative), faded by `grounded` (0..1). Level
   * where the hubs fix no plane (fewer than three on a ground, or squeezed in a line): the world's level, as before.
   */
  fit(yaw: number, grounded: number): void {
    this.pitch = 0;
    this.roll = 0;
    this.height = NaN;
    const n = this.n;
    if (n < 3) return;
    const mx = this.sx / n;
    const mz = this.sz / n;
    const mf = this.sf / n;
    const dxx = this.sxx - this.sx * mx;
    const dxz = this.sxz - this.sx * mz;
    const dzz = this.szz - this.sz * mz;
    const dxf = this.sxf - this.sx * mf;
    const dzf = this.szf - this.sz * mf;
    const spread = dxx * dzz - dxz * dxz;
    if (spread <= SPREAD) return;
    const gx = (dxf * dzz - dzf * dxz) / spread;
    const gz = (dzf * dxx - dxf * dxz) / spread;
    this.height = this.base + mf - gx * mx - gz * mz;
    this.gx = gx;
    this.gz = gz;
    _sc[0] = yaw;
    sinCosAt(_sc, 0);
    const sy = _sc[0]!;
    const cy = _sc[1]!;
    const along = gx * sy + gz * cy;
    const across = gx * cy - gz * sy;
    this.pitch = Math.max(-TILT, Math.min(TILT, -Math.atan(along))) * grounded;
    this.roll = Math.max(-TILT, Math.min(TILT, Math.asin(across / Math.sqrt(1 + across * across + along * along)))) * grounded;
  }
}

/** The rise (m) across the car-local offset (dx, dy, dz) under a frame pitched `pitch` and rolled `roll` (Rz roll, then Rx pitch; yaw leaves y alone). On the level it is `dy` exactly. */
export function tiltedRise(pitch: number, roll: number, dx: number, dy: number, dz: number): number {
  return (dx * detSin(roll) + dy * detCos(roll)) * detCos(pitch) - dz * detSin(pitch);
}

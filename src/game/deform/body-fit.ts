/**
 * The spin a wreck's masses carry in the ground plane (x/z, about +y): angular momentum over inertia about their
 * centroid. Sums are taken about a reference point (the cell), so a car a kilometre from the origin loses no digits.
 */
export class BodyFit {
  private spinMass = 0;
  private sx = 0;
  private sz = 0;
  private svx = 0;
  private svz = 0;
  private sl = 0;
  private si = 0;

  reset(): void {
    this.spinMass = this.sx = this.sz = this.svx = this.svz = this.sl = this.si = 0;
  }

  /** A mass at world offset (x, z) from the reference moving at (vx, vz). */
  addSpin(mass: number, x: number, z: number, vx: number, vz: number): void {
    this.spinMass += mass;
    this.sx += mass * x;
    this.sz += mass * z;
    this.svx += mass * vx;
    this.svz += mass * vz;
    this.sl += mass * (z * vx - x * vz);
    this.si += mass * (x * x + z * z);
  }

  /** The spin (rad/s about +y: v = ω (z, −x) about the centroid) the masses' angular momentum is over their inertia; 0 for a lone point. */
  spin(): number {
    const m = this.spinMass;
    if (m < 1e-9) return 0;
    const inertia = this.si - (this.sx * this.sx + this.sz * this.sz) / m;
    if (inertia < 1e-9) return 0;
    return (this.sl - (this.sz * this.svx - this.sx * this.svz) / m) / inertia;
  }
}

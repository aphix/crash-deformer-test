/** Bilinear sample of a row-major grid `f` (`nx` wide) in the cell whose low corner is index `c`, at (fu, fv). */
export function bilinear(f: Float32Array, c: number, nx: number, fu: number, fv: number): number {
  const a = f[c]! + (f[c + 1]! - f[c]!) * fu;
  const b = f[c + nx]! + (f[c + nx + 1]! - f[c + nx]!) * fu;
  return a + (b - a) * fv;
}

/**
 * The main loop's road + runoff on `TrackGround`'s grid: per cell its centre height, lateral / half width and half
 * width × tan(bank). The road's edge is a crease (the bank's plane meets the flat runoff) that a bilinear height
 * field rounds off over a cell: 8 cm above the plane on the low side of stunt's 18° bank, sinking tyres there.
 * Interpolating these instead and clamping the lateral at the point keeps the crease sharp; on a level road it is
 * the bilinear height to the bit.
 */
export class RoadCrease {
  private readonly centre: Float32Array;
  /** NaN off the main road + runoff. */
  private readonly lat: Float32Array;
  private readonly drop: Float32Array;

  constructor(cells: number) {
    this.centre = new Float32Array(cells);
    this.lat = new Float32Array(cells).fill(NaN);
    this.drop = new Float32Array(cells);
  }

  /** Cell `c` at lateral `lat` of a road `half` wide (centre `yc`, `bank` rad), `out` m beyond its runoff (> 0: off it). */
  set(c: number, out: number, lat: number, half: number, yc: number, bank: number): void {
    this.lat[c] = out > 0 ? NaN : lat / half;
    this.centre[c] = yc;
    this.drop[c] = half * Math.tan(bank);
  }

  /** Road height in the cell at low corner `c` (grid `nx` wide) at (fu, fv); NaN when a corner is off the road. */
  at(c: number, nx: number, fu: number, fv: number): number {
    const L = this.lat;
    // NaN fails every comparison.
    if (!(L[c]! === L[c]! && L[c + 1]! === L[c + 1]! && L[c + nx]! === L[c + nx]! && L[c + nx + 1]! === L[c + nx + 1]!)) return NaN;
    const l = bilinear(L, c, nx, fu, fv);
    return bilinear(this.centre, c, nx, fu, fv) - Math.max(-1, Math.min(1, l)) * bilinear(this.drop, c, nx, fu, fv);
  }
}

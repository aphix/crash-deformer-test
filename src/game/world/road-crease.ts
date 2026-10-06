/**
 * The main loop's road + runoff on `TrackGround`'s grid: per cell its centre height, lateral / half width and half
 * width × tan(bank). The road's edge is a crease (the bank's plane meets the flat runoff) that a bilinear height
 * field rounds off over a cell: 8 cm above the plane on the low side of stunt's 18° bank, sinking tyres there.
 * The ground's surface store (`world/surfaces.ts`) interpolates these instead and clamps the lateral at the point, which
 * keeps the crease sharp; on a level road it is the bilinear height to the bit.
 */
export class RoadCrease {
  readonly centre: Float32Array;
  /** NaN off the main road + runoff. */
  readonly lat: Float32Array;
  readonly drop: Float32Array;

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
}

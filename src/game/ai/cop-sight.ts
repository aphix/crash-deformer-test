import { hypot2 } from "../kernel/physics-core.js";
import { MAX_CARS } from "../scenes/fleet.ts";
import { blankProjection, projectPath, type Projection, type Track } from "../world/track.ts";
import type { AiCar } from "./derby-ai.ts";

/** Straight-line distance (m) inside which a racer sees everything: no cop is put on the road or taken off it this close to any racer. */
export const SIGHT_NEAR = 100;
/** Metres of road ahead of a racer that it sees down (a stakeout parks beyond this), and behind it that still show in its mirrors. */
export const SIGHT_AHEAD = 200;
export const SIGHT_BEHIND = 40;
/** Metres a racer drives, flat out, in the 0.25 s between the beat that reads its place and the frame a cop put on the road shows. */
export const SIGHT_MARGIN = 20;
/** Metres a racer may be past the road's run-off and still be on its corridor (`projectPath`'s own margin): beyond it the racer is not on this road. */
export const CORRIDOR = 8;

/** Whether a point on the course is out of every racer's sight, by where the racers are and the road between: no camera is read. */
export class RacerSight {
  /** The straight-line distance (m) from the last queried point to the nearest racer. */
  gap = Infinity;
  private readonly track: Track;
  private readonly racers: number;
  private cars: readonly AiCar[] = [];
  /** Per racer: its road arc (m) and whether it is on the road's corridor (else its arc says nothing about what it sees). */
  private readonly arc = new Float64Array(MAX_CARS);
  private readonly onRoad = new Uint8Array(MAX_CARS);
  /** Per car id: projection hint. */
  private readonly seg = new Int32Array(MAX_CARS).fill(-1);
  private readonly proj = blankProjection();

  constructor(track: Track, racers: number) {
    this.track = track;
    this.racers = racers;
  }

  /** The racers' places this beat (`cars[0 … racers − 1]`); every query after reads them. */
  watch(cars: readonly AiCar[]): void {
    this.cars = cars;
    for (let i = 0; i < this.racers; i++) {
      const car = cars[i]!;
      const on = this.project(car);
      this.arc[i] = on.s;
      this.onRoad[i] = this.onCorridor(on) ? 1 : 0;
    }
  }

  /** Car `c` stands where no racer sees it: see `hiddenAt`. */
  hiddenCar(c: AiCar): boolean {
    const on = this.project(c);
    return this.hiddenAt(c.x, c.z, on.s, this.onCorridor(on));
  }

  /**
   * (x, z), at road arc `s` and on the road's corridor or not, is out of sight of every racer: `SIGHT_NEAR` m or more from each, and for
   * a racer on the road, more than `SIGHT_BEHIND` m behind it or `SIGHT_AHEAD` m ahead along the road (a racer off the road, whose
   * heading says nothing of the road, sees `SIGHT_AHEAD` m round it), each with `SIGHT_MARGIN` m to spare for the metres a racer
   * drives between the beat that read its place and the frame the cop shows. Sets `gap`.
   */
  hiddenAt(x: number, z: number, s: number, onCorridor: boolean): boolean {
    const L = this.track.length;
    let hidden = true;
    this.gap = Infinity;
    for (let i = 0; i < this.racers; i++) {
      const racer = this.cars[i]!;
      const dist = hypot2(racer.x - x, racer.z - z);
      if (dist < this.gap) this.gap = dist;
      if (dist < SIGHT_NEAR + SIGHT_MARGIN) hidden = false;
      else if (!onCorridor || this.onRoad[i] === 0) hidden = hidden && dist >= SIGHT_AHEAD + SIGHT_MARGIN;
      else {
        const along = s - this.arc[i]!;
        const ahead = along - L * Math.round(along / L);
        hidden = hidden && (ahead <= -(SIGHT_BEHIND + SIGHT_MARGIN) || ahead >= SIGHT_AHEAD + SIGHT_MARGIN);
      }
    }
    return hidden;
  }

  private project(c: AiCar): Projection {
    const on = projectPath(this.track.path, c.x, c.z, this.seg[c.id]!, this.proj);
    this.seg[c.id] = on.k;
    return on;
  }

  private onCorridor(on: Projection): boolean {
    const path = this.track.path;
    const reach = path.half[on.k]! + Math.max(path.runL[on.k]!, path.runR[on.k]!) + CORRIDOR;
    return on.dist2 <= reach * reach;
  }
}

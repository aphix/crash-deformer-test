import assert from "node:assert/strict";
import { blankAiCar, type AiCar } from "./derby-ai.ts";
import { PoliceBrain } from "./police.ts";
import type { PoliceWorld } from "./cop-brain.ts";
import { RaceBrain } from "./race-ai.ts";
import { blankPoint, blankProjection, Track } from "../world/track.ts";
import oval from "../world/tracks/oval.json" with { type: "json" };

export const track = new Track(oval);
export const BEAT = 0.25;
export const pt = blankPoint();

/** One racer (car 0) and a stakeout of two units (cars 1 and 2) parked ahead of it, `units` cops in all, the stakeout a `leadShare` of the lap on. Unit 1 has just woken (the racer passed it); unit 2, 12 m on, is still parked. */
export function rig(units = 2, seed = 1, leadShare = 0.4) {
  const cars: AiCar[] = Array.from({ length: units + 1 }, (_, i) => blankAiCar(i));
  const hunt = new Uint8Array(cars.length);
  hunt[0] = 1;
  const stored: number[] = [];
  const spots: { x: number; z: number }[] = [];
  /** Every placement, with the racer's place at that moment. */
  const parks: { id: number; x: number; z: number; racer: { x: number; z: number } }[] = [];
  const knockedOut = new Set<number>();
  const world: PoliceWorld = {
    park: (id, x, _y, z, yaw) => {
      spots[id] = { x, z };
      parks.push({ id, x, z, racer: { x: cars[0]!.x, z: cars[0]!.z } });
      Object.assign(cars[id]!, { x, z, vx: 0, vz: 0, yaw });
    },
    store: (id) => {
      stored.push(id);
    },
    down: (id) => knockedOut.has(id),
    sirens: () => {},
  };
  const police = new PoliceBrain(track, new RaceBrain(track, 1), 1, units, seed);
  const lead = track.length * leadShare;
  let time = 0;
  const beat = () => {
    police.update(time, BEAT, cars, hunt, lead, world);
    time += BEAT;
  };
  const run = (seconds: number) => {
    for (let n = 0; n < seconds / BEAT; n++) beat();
  };
  /** Car 0 on the centreline `ds` m along from unit 1's spot. */
  const sit = (ds: number) => {
    const s = track.project(spots[1]!.x, spots[1]!.z, -1, blankProjection()).s;
    const p = track.pointAt(s + ds, pt);
    Object.assign(cars[0]!, { x: p.x, z: p.z });
  };
  const start = track.pointAt(lead, pt);
  Object.assign(cars[0]!, { x: start.x, z: start.z });
  beat();
  assert.ok(spots[1] && spots[2], "the stakeout parked");
  sit(5);
  beat();
  assert.deepEqual(police.chasers(cars, []).map((c) => c.id), [1], "unit 1 chases");
  assert.equal(stored.length, 0);
  return { police, cars, hunt, stored, parks, knockedOut, beat, run, sit, world, clock: () => time };
}

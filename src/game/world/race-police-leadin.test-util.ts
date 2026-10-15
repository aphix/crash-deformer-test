import assert from "node:assert/strict";
import { setGround } from "./ground.ts";
import { FRAME, frame, makeWorld } from "./race-world.test-util.ts";
import { blankPoint, blankProjection, Track } from "./track.ts";
import { parseTrack } from "./track-schema.ts";
import { TRACKS } from "./tracks/index.ts";

/**
 * One 2-lap police race on the oval (field seed 1), its frame accumulator starting at `phase` seconds: the same field
 * and the same cops, but the physics steps partition the frames differently, so the cars take a different chaotic
 * path through it. Every lead-in's heading is checked as it ends; the counts and the lead-ins whose heading did not
 * converge come back for the pooled floors and caps. `until(checked, wakes)`, asked after every frame with the lead-in headings
 * judged so far and the stakeout wakes seen, stops the race early when it answers true (the race then need not have closed).
 */
export function leadIns(phase: number, seed = 1, trackId = "oval", until?: (checked: number, wakes: number) => boolean): { wakes: number; converged: number; diverged: string[]; offRoadLeadIns: number; tbones: number; pursuitHits: number; leadInPairs: number } {
  const w = makeWorld();
  w.race.enter();
  try {
    w.race.command({ type: "options", options: { trackId, laps: 2, aiCount: 4, spectate: true, police: true } });
    w.race.reseed(seed);
    w.race.command({ type: "start" });
    const track = new Track(TRACKS.find((j) => parseTrack(j).id === trackId)!);
    const L = track.length;
    const proj = blankProjection();
    // A car's arc along the road. Where two stretches stack (Dam Spine's dam over the valley road, at one place in plan) the nearest
    // centreline in plan flips between them from one frame to the next, so a car's first read takes the stretch at its own height and
    // every later one stays near it, as the cops' own brain reads its racers and its parking spots.
    const hint = new Int32Array(64).fill(-1);
    const stretchAt = (x: number, y: number, z: number): number => {
      const p = track.path;
      let best = -1;
      let bestCost = Infinity;
      for (let k = 0; k < p.count; k++) {
        const d = Math.hypot(p.x[k]! - x, p.z[k]! - z);
        const cost = d + 5 * Math.abs(p.y[k]! - y);
        if (cost < bestCost) [best, bestCost] = [k, cost];
      }
      return best;
    };
    const arc = (i: number) => {
      const p = w.cars[i]!.group.position;
      if (hint[i]! < 0) hint[i] = stretchAt(p.x, p.y, p.z);
      const on = track.project(p.x, p.z, hint[i]!, proj);
      hint[i] = on.k;
      return on.s;
    };
    const ahead = (s: number, from: number) => s - from - L * Math.round((s - from) / L);
    const angle = (ax: number, az: number, bx: number, bz: number) => Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
    const racers = w.race.racers.length;
    const tangent = blankPoint();
    // Per racer, the cells of the road (per 2 m of it) it has driven on: a lead-in whose target never drove its cell has no road there to line up on.
    const drove = Array.from({ length: racers }, () => new Uint8Array(Math.ceil(L / 2)));
    // Per police car: its parked spot's arc (NaN: not parked), the lead-in window's target and end, and its last
    // contact with any car (a parked car knocked along, or a lead-in knocked off line by a pack-mate, says nothing of its steering).
    const parkS = new Float64Array(64).fill(NaN);
    const target = new Int32Array(64).fill(-1);
    const leadEnd = new Float64Array(64);
    const angle0 = new Float64Array(64).fill(NaN);
    const bumped = new Float64Array(64).fill(-1e9);
    // Per police car: a pack-mate came within `CROWD` m during its lead-in (the pack guard swerved it round the mate, which
    // says nothing of its steering toward the target, as a knock from one does not).
    const CROWD = 8;
    const crowded = new Uint8Array(64);
    // Per police car: a stretch of the target's heading the cop is matching was never driven on the road (the target merged off a
    // shortcut there), so the lead-in has no reference and is not checked; `offRoadLeadIns` counts those.
    const offRoad = new Uint8Array(64);
    let t = 0;
    let wakes = 0;
    let converged = 0;
    let offRoadLeadIns = 0;
    let tbones = 0;
    let pursuitHits = 0;
    const diverged: string[] = [];
    // Pairs of police cars that touched while both were inside their lead-in windows (a stakeout pair parks 12 m apart, one
    // facing each racer's travel and one against it, so both full-throttle lead-ins met head-on).
    const leadInPairs = new Set<number>();
    const hit = w.step.pairHit;
    w.step.pairHit = (a, b, h) => {
      hit?.(a, b, h);
      if (a >= racers && b >= racers && t < leadEnd[a]! && t < leadEnd[b]!) leadInPairs.add((a * 64 + b) * 1e4 + Math.round(leadEnd[a]!));
      if (a >= racers) bumped[a] = t;
      if (b >= racers) bumped[b] = t;
      if (a >= racers === b >= racers) return;
      const [p, r] = a >= racers ? [a, b] : [b, a];
      if (t >= leadEnd[p]!) {
        pursuitHits++;
        return;
      }
      if (r !== target[p]) return;
      // A T-bone: the normal across the target's flank with the police car crossways to it.
      const ty = w.cars[r]!.yaw;
      const py = w.cars[p]!.yaw;
      const nAlong = Math.abs(h.normal.x * Math.sin(ty) + h.normal.z * Math.cos(ty));
      const cross = Math.abs(Math.sin(py) * Math.sin(ty) + Math.cos(py) * Math.cos(ty));
      if (nAlong < 0.5 && cross < 0.5) tbones++;
    };
    const state = { acc: phase };
    const bound = 4.5 + 2 * 3 * (track.length / 9);
    let stopped = false;
    for (let n = 0; w.race.phase !== "finished" && n * FRAME < bound && !stopped; n++) {
      frame(w, state);
      t = n * FRAME;
      for (let r = 0; r < racers; r++) {
        // Every frame, as the cops' brain reads its racers: a hint left to the wake checks lags its car by up to the road's corridor
        // (a truck 9 m past a cop's spot read 8 m short of it, so the cop it woke looked like it pulled away unprompted).
        arc(r);
        const p = w.cars[r]!.group.position;
        const on = track.project(p.x, p.z, -1, proj);
        // Only where the racer drives the road: a racer merging off a shortcut has no road under it, so the cop that lines
        // up behind it has no stretch of road to line up on (seed 1, cop 6 at 38 s: the target merged off the road).
        // Cells never driven stay 0: no sample.
        if (Math.abs(on.lateral) > track.path.half[on.k]!) continue;
        drove[r]![Math.floor(on.s / 2)] = 1;
      }
      for (let i = racers; i < w.live().length; i++) {
        const car = w.cars[i]!;
        const v = car.velocity;
        const speed = Math.hypot(v.x, v.z);
        if (!car.group.visible) {
          // Stored: it comes back parked somewhere new, so its next read is a first read. Kept, the hint from its last spot
          // read Dam Spine seed 1's cop 6 (stored after a thrown driver, re-parked at 54.25 s) on the stretch stacked under
          // its new spot: 488 m along, not 2543, so the racer 8 m past it as it woke read 2064 m past.
          parkS[i] = NaN;
          hint[i] = -1;
          continue;
        }
        // A wrecked cop that lies still is not a stakeout: a racer wreck that shoves it along would read as the cop waking (a wall now slows a racer
        // that hits it at speed, and the cop that was pursuing it ends up a wreck beside it).
        if (speed < 0.3 && !car.sirens && !car.crashed && t >= leadEnd[i]!) {
          parkS[i] = arc(i);
          continue;
        }
        // It moved, or its sirens came on (a woken cop held by the pack guard can sit still for a second: a racer 55 m/s fast is 55 m on by then):
        // a racer must be past its spot (a patrol beat plus its pull-away), unless one just knocked it.
        if (!Number.isNaN(parkS[i]!) && (car.sirens || speed > 1)) {
          // The sirens come on within a beat (0.25 s) of the wake, when the racer that woke it is at most 30 m + a beat past.
          let best = -1;
          let bestD = Infinity;
          for (let r = 0; r < racers; r++) {
            const d = ahead(arc(r), parkS[i]!);
            if (d >= 0 && d < bestD) [best, bestD] = [r, d];
          }
          assert.ok(bestD < 80 || t - bumped[i]! < 0.5, `police car ${i} pulled away at ${t.toFixed(2)} s with no racer past its spot (nearest past ${bestD.toFixed(0)} m)`);
          parkS[i] = NaN;
          target[i] = best;
          leadEnd[i] = t + 1.8;
          angle0[i] = NaN;
          crowded[i] = 0;
          offRoad[i] = 0;
          wakes++;
        }
        const r = target[i]!;
        if (r < 0 || t >= leadEnd[i]! || speed < 3) continue;
        for (let j = racers; j < w.live().length; j++) {
          if (j !== i && w.cars[j]!.group.visible && w.cars[i]!.group.position.distanceTo(w.cars[j]!.group.position) < CROWD) crowded[i] = 1;
        }
        const s = arc(i);
        if (!drove[r]![Math.floor(s / 2)]) offRoad[i] = 1;
        // The cop's heading against the road's direction of travel under it: lining up behind its target on the road.
        const road = track.pointAt(s, tangent);
        const a = angle(v.x, v.z, road.tx, road.tz);
        if (Number.isNaN(angle0[i]!)) angle0[i] = a;
        if (t + FRAME >= leadEnd[i]! && bumped[i]! < leadEnd[i]! - 1.8 && !crowded[i]) {
          if (offRoad[i]) {
            offRoadLeadIns++;
            continue;
          }
          if (a < angle0[i]! || a < 0.2) converged++;
          else diverged.push(`seed ${seed} car ${i} at ${t.toFixed(1)} s: ${angle0[i]!.toFixed(2)} → ${a.toFixed(2)} rad`);
        }
      }
      stopped = until?.(converged + diverged.length, wakes) ?? false;
    }
    if (!stopped) assert.equal(w.race.phase, "finished", "the race closed");
    assert.equal(tbones, 0, "a police car T-boned its target during its lead-in");
    return { wakes, converged, diverged, offRoadLeadIns, tbones, pursuitHits, leadInPairs: leadInPairs.size };
  } finally {
    w.race.exit();
    setGround(null);
  }
}

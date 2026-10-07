import * as THREE from "three";
import { DerbyMatch, heatLimit, snapshotAiCar, type DerbyDecided } from "../match/derby.ts";
import { clipDerbyCar, derbyRadius } from "../scenes/derby-arena.ts";
import { applyDrive } from "../vehicle/car-drive.ts";
import { fleetStyle, layoutDerby } from "../scenes/fleet.ts";
import { DeformableCar } from "../vehicle/car.ts";
import { CAR_HALF } from "../vehicle/car-mesh.ts";
import { physicsSlice } from "../contact/sat.ts";
import { newWorld, stepWorld } from "../engine/world-step.ts";
import { armKill, assignClass, carClass, CLASSES, HANDLING, type VehicleClassId } from "../vehicle/vehicle-classes.ts";
import { INITIAL_HUD } from "../hud/hud-store.ts";
import { aggressive, ScootWatch, type ScootShare } from "./derby-scoot.test-util.ts";

export type Field = {
  seed: number;
  winner: number | null;
  decided: DerbyDecided | null;
  t: number;
  deaths: number[];
  outs: number[];
  contactSpins: string[];
  freeSpins: string[];
  /** Peak heading rate over any 0.1 s inside 0.5 s of a pair contact, in the first 2 min. */
  contactPeak: { rate: number; note: string };
  zips: string[];
  /** Largest zip, in metres (0 when none). */
  zipMax: number;
  impacts: { front: number; rear: number; side: number };
  swings: number;
  jturns: number;
  sideswipes: number;
  /** Late-heat car windows (3-5 cars alive) and the ones that scoot (`ScootWatch`). */
  scoot: ScootShare;
  /** Pair hits the match credited (closing ≥ 1.8 m/s), and the ones that were aggressive (≥ `DERBY_RULES.hitSpeed`). */
  hits: number;
  aggro: number;
  /** Live car-seconds, to put the hits per car-minute. */
  carSeconds: number;
};

function face(c: DeformableCar, p: THREE.Vector3): "front" | "rear" | "side" {
  const dx = p.x - c.group.position.x;
  const dz = p.z - c.group.position.z;
  const along = (dx * c.fwdFlat.x + dz * c.fwdFlat.z) / CAR_HALF.z;
  const across = (dx * c.fwdFlat.z - dz * c.fwdFlat.x) / CAR_HALF.x;
  if (Math.abs(along) * 1.15 < Math.abs(across)) return "side";
  return along > 0 ? "front" : "rear";
}

function centroid(c: DeformableCar): { x: number; z: number } {
  let x = 0;
  let z = 0;
  let m = 0;
  for (const p of c.deform.masses) {
    x += p.world.x * p.mass;
    z += p.world.z * p.mass;
    m += p.mass;
  }
  return { x: x / m, z: z / m };
}

/**
 * One manoeuvre per run of a move: the brain re-picks its tactic every slice, and a J-turn flips in and out
 * of `jturn` slice by slice (main, seeds 1/2/3/11: of 350 entries, 309 came < 0.05 s after the last, 33 more
 * than 5 s after, 8 in between). Counting tactic changes counted those flips, not J-turns.
 */
const MOVE_GAP = 1;

/**
 * A derby of `n` AI cars through the engine's stack (`stepWorld` with the derby's hit credit and bowl,
 * cars dressed as `dressCar` does at the game's defaults), at the default slider, to the end of the heat.
 * `playerClass` is car 0's class (the HUD's player class, the sedan by default).
 * Spins: |yaw rate| > 5 rad/s for > 0.2 s in the first 2 min, split by a car contact in the 0.3 s before the spin began.
 * Zips: a live mass centroid moving more than 3·v·h + 5 cm in a step. Impacts: AI hits closing ≥ 3 m/s,
 * by the attacker's face. Moves: swings, J-turns and sideswipes, each a manoeuvre (`MOVE_GAP`).
 */
export function runField(n: number, seed: number, playerClass?: VehicleClassId): Field {
  const scene = new THREE.Scene();
  const cars = Array.from(
    { length: n },
    (_, i) => new DeformableCar({ body: 0xc5c8ce, accent: 0x9aa0a8, name: `c${i}` }, scene, null, i === 0 && playerClass ? CLASSES[playerClass].style : fleetStyle(i)),
  );
  let s = seed;
  const rng = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  const radius = derbyRadius(n);
  const slots = layoutDerby(n, radius, rng);
  const match = new DerbyMatch();
  match.begin(
    cars.map((_, i) => ({ id: i, name: `c${i}` })),
    { seed },
  );
  const w = newWorld(cars);
  w.afterCar = (c) => clipDerbyCar(c, radius);
  for (const [i, c] of cars.entries()) {
    c.spawnFacing(slots[i]!.x, slots[i]!.z, slots[i]!.yaw, 0);
    c.deform.squash = INITIAL_HUD.squash;
    c.deform.buckle = INITIAL_HUD.buckle;
    c.deform.setMode(INITIAL_HUD.deformMode);
    const cls = i === 0 && playerClass ? playerClass : carClass(c);
    assignClass(c, cls);
    armKill(c.deform, cls, HANDLING.realism, "derby");
  }
  const out: Field = {
    seed,
    winner: null,
    decided: null,
    t: 0,
    deaths: [],
    outs: [],
    contactSpins: [],
    freeSpins: [],
    zips: [],
    zipMax: 0,
    contactPeak: { rate: 0, note: "none" },
    impacts: { front: 0, rear: 0, side: 0 },
    swings: 0,
    jturns: 0,
    sideswipes: 0,
    scoot: { windows: 0, flagged: 0 },
    hits: 0,
    aggro: 0,
    carSeconds: 0,
  };
  const watch = new ScootWatch(n);
  const yaw0 = cars.map((c) => c.yaw);
  const spinFor = new Array<number>(n).fill(0);
  /** Per car: [t, yaw] pairs spanning about 0.1 s, for the contact peak. */
  const ring = cars.map((): number[] => []);
  const touched = new Array<number>(n).fill(-9);
  /** Per car, when it was last in each move: back in it within MOVE_GAP s is the same manoeuvre. */
  const lastIn = { swing: new Array<number>(n).fill(-9), jturn: new Array<number>(n).fill(-9), sideswipe: new Array<number>(n).fill(-9) };
  const alive = new Array<boolean>(n).fill(true);
  // Match time: negative through the start lights, 0 at green.
  let t = match.time;
  let state = "running";
  const end = heatLimit(n) + 1;
  while (t < end && state === "running") {
    let vmax = 8;
    for (const c of cars) vmax = Math.max(vmax, c.speed);
    const h = physicsSlice(1 / 60, vmax);
    const before = cars.map((c) => (c.deform.massActive ? centroid(c) : null));
    const speed0 = cars.map((c) => Math.hypot(c.velocity.x, c.velocity.z));
    const shove = new Array<number>(n).fill(0);
    const snaps = match.snapshots(n);
    for (const [i, c] of cars.entries()) snapshotAiCar(snaps[i]!, i, c, c.deform.drivetrainAlive);
    for (const [i, c] of cars.entries()) {
      applyDrive(c, match.think(snaps[i]!, snaps, h), h);
      const now = match.brain.tacticOf(i);
      if (now === "swing" || now === "jturn" || now === "sideswipe") {
        if (t - lastIn[now][i]! > MOVE_GAP) out[now === "swing" ? "swings" : now === "jturn" ? "jturns" : "sideswipes"]++;
        lastIn[now][i] = t;
      }
    }
    w.pairHit = (a, b, pair) => {
      const ca = cars[a]!;
      const cb = cars[b]!;
      touched[a] = t;
      touched[b] = t;
      shove[a] = Math.max(shove[a]!, speed0[b]!);
      shove[b] = Math.max(shove[b]!, speed0[a]!);
      const aInto = -(ca.velocity.x * pair.normal.x + ca.velocity.z * pair.normal.z);
      const bInto = cb.velocity.x * pair.normal.x + cb.velocity.z * pair.normal.z;
      if (!match.noteHit(a, b, aInto, bInto, pair.impulse)) return;
      out.hits++;
      if (aggressive(Math.max(aInto, bInto))) out.aggro++;
      watch.hit(a, b, t);
      const attacker = aInto >= bInto ? ca : cb;
      if (attacker.deform.drivetrainAlive && aInto + bInto >= 3) out.impacts[face(attacker, pair.contact)]++;
    };
    stepWorld(w, h);
    for (const c of cars) if (c.deform.massActive && !c.deform.drivetrainAlive) c.deform.cutDrive(h);
    state = match.step(
      h,
      cars.map((c, i) => ({ id: i, name: `c${i}`, alive: c.deform.drivetrainAlive, x: c.group.position.x, z: c.group.position.z })),
    );
    const running = (i: number) => cars[i]!.deform.drivetrainAlive && !match.board[i]!.out;
    if (watch.due(t)) watch.sample(t, cars.map((c, i) => ({ alive: running(i), x: c.group.position.x, z: c.group.position.z, fwd: c.velocity.x * c.fwdFlat.x + c.velocity.z * c.fwdFlat.z })));
    for (const [i, c] of cars.entries()) {
      if (t >= 0 && running(i)) out.carSeconds += h;
      if (alive[i] && !c.deform.drivetrainAlive) out.deaths.push(+t.toFixed(1));
      alive[i] = c.deform.drivetrainAlive;
      if (match.board[i]!.out && !out.outs.includes(i)) out.outs.push(i);
      let dyaw = c.yaw - yaw0[i]!;
      dyaw -= Math.round(dyaw / (Math.PI * 2)) * Math.PI * 2;
      yaw0[i] = c.yaw;
      if (Math.abs(dyaw) / h > 5) spinFor[i]! += h;
      else spinFor[i] = 0;
      if (spinFor[i]! > 0.2 && spinFor[i]! - h <= 0.2 && t < 120) {
        const note = `t=${t.toFixed(1)} c${i} ${(Math.abs(dyaw) / h).toFixed(1)} rad/s`;
        (t - touched[i]! < 0.5 ? out.contactSpins : out.freeSpins).push(note);
      }
      const rb = ring[i]!;
      rb.push(t, c.yaw);
      while (rb.length > 4 && rb[2]! <= t - 0.1) rb.splice(0, 2);
      if (t - rb[0]! >= 0.099 && t - touched[i]! < 0.5 && t < 120) {
        let turn = c.yaw - rb[1]!;
        turn -= Math.round(turn / (Math.PI * 2)) * Math.PI * 2;
        const rate = Math.abs(turn) / (t - rb[0]!);
        if (rate > out.contactPeak.rate) out.contactPeak = { rate, note: `c${i} ${rate.toFixed(2)} rad/s at t=${t.toFixed(1)}` };
      }
      const a = before[i];
      if (!a || !c.deform.massActive || t >= 120) continue;
      const b = centroid(c);
      const moved = Math.hypot(b.x - a.x, b.z - a.z);
      const vMax = Math.max(speed0[i]!, Math.hypot(c.velocity.x, c.velocity.z), shove[i]!);
      if (moved > 3 * vMax * h + 0.05) {
        out.zips.push(`t=${t.toFixed(2)} c${i} ${moved.toFixed(2)} m`);
        out.zipMax = Math.max(out.zipMax, moved);
      }
    }
    t += h;
  }
  out.t = +t.toFixed(1);
  out.winner = match.winnerId;
  out.decided = match.decided;
  out.scoot = watch.share();
  return out;
}

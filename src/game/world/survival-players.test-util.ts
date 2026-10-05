import { Obstacles } from "../ai/hunter.ts";
import { clamp, hash01, wrapPi } from "../kernel/scalar.ts";
import { placeProps, propColliders } from "./placements.ts";
import type { CopBrain } from "../ai/police.ts";
import type { DriveInput } from "../vehicle/car-drive.ts";
import { holdLine, leaveSurvival, liveCops, play, steerAt, survivalWorld, type Play } from "./survival-run.test-util.ts";
import type { World } from "./race-world.test-util.ts";
import { Track } from "./track.ts";
import { HAVANA } from "./tracks/havana.ts";

/**
 * Scripted players who try to get away from the Survival pack, and the run that measures them (docs/SURVIVAL.md). Not a test file
 * itself. Each one is a plain driver with no knowledge of the cops: the run ends because the pack catches it or never.
 *   straight: the owner's "holds W straight": over the hill on the boulevard line, then the pedal down and the wheel dead ahead for good;
 *   flee: holds the throttle and its heading and steers only to keep clear of solids (no lifting, no turning back): the owner's "holds W";
 *   ring: down the boulevard, then laps the D ring (the lawn island's road) at 22 m/s, steering at a point ahead on it;
 *   held: the set piece's driver: holds the boulevard line (x = −6 ± 1.5, looking 25–40 m ahead) flat out over the hill, then flees;
 *   evade: for the closed arena (`survival-arena.test-util.ts`): runs straight away from the nearest cop, round solids and round cops, lifting for a wall it cannot stop before; it never stops.
 */
export type Fleer = "straight" | "flee" | "ring" | "held" | "evade";
/** The scripts of the open map; `evade` runs in the arena only. */
export const FLEERS: readonly Fleer[] = ["straight", "flee", "ring", "held"];

/** The player's pedals for one frame. */
type Driver = (w: World) => void;

/** A driver stops within the clear run less `MARGIN` m at `BRAKE` m/s²: the speed (m/s) it may carry with `run` m clear ahead. */
const BRAKE = 7;
const MARGIN = 14;
const safe = (run: number): number => Math.max(8, Math.sqrt(2 * BRAKE * Math.max(0, run - MARGIN)));
/** A fleeing driver looks `LOOK_TIME` s of road ahead for a clear way (at least `LOOK_MIN` m: a car at 38 m/s needs 160 m to turn round), and the speed (m/s) the ring's bends allow. */
const LOOK_TIME = 5;
const LOOK_MIN = 60;
const RING_SPEED = 22;

/** Metres from (x, z) along heading `h` to the first cop within `HALF_LANE` m of the line (`len` when none): a cop is a car, not a thing to drive through. */
const HALF_LANE = 3.5;
function copRun(cops: readonly { x: number; z: number }[], x: number, z: number, h: number, len: number): number {
  let run = len;
  for (const p of cops) {
    const dx = p.x - x;
    const dz = p.z - z;
    const along = dx * Math.sin(h) + dz * Math.cos(h);
    if (along > 0 && along < run && Math.abs(dx * Math.cos(h) - dz * Math.sin(h)) < HALF_LANE) run = along;
  }
  return run;
}

/**
 * Holds the heading it has at the first call, bends to the nearest one with `LOOK` m clear (else the longest run). `evade`: wants the heading
 * straight away from the nearest cop, cops block a heading like a wall does, and it lifts for what is ahead (`safe`).
 */
function fleeing(obstacles: Obstacles, evade = false): Driver {
  let want: number | null = null;
  return (w) => {
    const car = w.cars[0]!;
    const c = car.group.position;
    const cops = evade ? liveCops(w).map((i) => w.cars[i]!.group.position) : [];
    if (cops.length > 0) {
      let nearest = cops[0]!;
      for (const p of cops) if (Math.hypot(p.x - c.x, p.z - c.z) < Math.hypot(nearest.x - c.x, nearest.z - c.z)) nearest = p;
      want = Math.atan2(c.x - nearest.x, c.z - nearest.z);
    }
    want ??= Math.atan2(car.fwdFlat.x, car.fwdFlat.z);
    const look = Math.max(LOOK_MIN, car.velocity.length() * LOOK_TIME);
    const clear = (h: number, len: number): number => Math.min(obstacles.run(c.x, c.z, h, len), copRun(cops, c.x, c.z, h, len));
    let h = want;
    let best = -1;
    for (let d = 0; d <= Math.PI / 2 + 1e-9 && best < look; d += 0.15) {
      for (const s of d === 0 ? [1] : [1, -1]) {
        const run = clear(want + s * d, look);
        if (run > best) {
          best = run;
          h = want + s * d;
        }
      }
    }
    // The cap follows what the car itself faces, not the heading it is bending to: it cannot turn 40° in a few metres at 38 m/s.
    steerAt(w, c.x + Math.sin(h) * look, c.z + Math.cos(h) * look, evade ? safe(clear(Math.atan2(car.fwdFlat.x, car.fwdFlat.z), look)) : null);
  };
}

export function drivers(kind: Fleer, seed: number, course: unknown = HAVANA): Driver {
  const track = new Track(course);
  const colliders = new Obstacles(propColliders(placeProps(track)));
  const flee = fleeing(colliders);
  if (kind === "evade") return fleeing(colliders, true);
  if (kind === "flee") return flee;
  if (kind === "straight") {
    const line = -6 + (hash01(seed, 1) - 0.5) * 3;
    const look = 25 + 15 * hash01(seed, 2);
    // Over the hill on the boulevard line, then the pedal down and the wheel dead straight, whatever stands ahead.
    return (w) => {
      if (w.cars[0]!.group.position.z > -100) return holdLine(w, line, look, null);
      const intent = w.seat.intent;
      intent.wheel = 0;
      intent.gas = 1;
      intent.brake = 0;
      intent.handbrake = false;
    };
  }
  if (kind === "held") {
    const line = -6 + (hash01(seed, 1) - 0.5) * 3;
    const look = 25 + 15 * hash01(seed, 2);
    return (w) => (w.cars[0]!.group.position.z > -100 ? holdLine(w, line, look, null) : flee(w));
  }
  const p = track.path;
  const step = track.length / p.count;
  return (w) => {
    const c = w.cars[0]!.group.position;
    // Down the boulevard, braking for the ring's north leg; on the ring, a point ahead of the nearest sample, slow while the car is not pointed at it (the corner in, as a human brakes for it).
    if (c.z > 62) return holdLine(w, 0, 30, c.z > 150 ? null : 14);
    let k = 0;
    let best = Infinity;
    for (let i = 0; i < p.count; i++) {
      const d = (p.x[i]! - c.x) ** 2 + (p.z[i]! - c.z) ** 2;
      if (d < best) {
        best = d;
        k = i;
      }
    }
    const j = (k + Math.round(clamp(w.cars[0]!.velocity.length() * 0.8 + 6, 12, 30) / step)) % p.count;
    const car = w.cars[0]!;
    const off = Math.abs(wrapPi(Math.atan2(p.x[j]! - c.x, p.z[j]! - c.z) - Math.atan2(car.fwdFlat.x, car.fwdFlat.z)));
    steerAt(w, p.x[j]!, p.z[j]!, off > 0.5 ? 9 : RING_SPEED);
  };
}

export type Chase = {
  fleer: Fleer;
  seed: number;
  /** The run ended within the time given: how, and when (race seconds from the green). */
  ended: boolean;
  cause: string;
  time: number;
  /** Cop contacts with the player before the end (a new one after half a second apart), and the race second of the last. */
  touches: number;
  lastTouch: number;
  /** The player's speed at the end (m/s), the rectangle it drove over, and the most cops live at once. */
  speed: number;
  reach: { minX: number; maxX: number; minZ: number; maxZ: number };
  peak: number;
  played: Play;
};

/**
 * A control: runs on each police unit's pedals (`DriveInput`) as its brain returns them, before `applyDrive` turns them into motion
 * (frozen cops, a pack that never boosts). Not `car.drive`: that is only the record of the pedals the step already ran.
 */
export type CopTamper = (input: DriveInput) => void;

/** One Survival run on `course` (Havana) with `fleer` at the wheel, `seed` pinning the field's dice, for at most `seconds` of game time. */
export function chase(fleer: Fleer, seed: number, seconds: number, course?: unknown, tamper?: CopTamper): Chase {
  const w = survivalWorld(course, seed);
  try {
    if (tamper) {
      const orig = w.race.drive.bind(w.race);
      let tampered: unknown = null;
      // The race's brain is a protected field of the engine class; a control has to reach it to change what the cops decide.
      const race: { police: CopBrain | null } = w.race as unknown as { police: CopBrain | null };
      w.race.drive = (dt: number): void => {
        const brain = race.police;
        if (brain && brain !== tampered) {
          const think = brain.think.bind(brain);
          brain.think = (self, snaps, h) => {
            const input = think(self, snaps, h);
            tamper(input);
            return input;
          };
          tampered = brain;
        }
        orig(dt);
      };
    }
    const drive = drivers(fleer, seed, course);
    let touches = 0;
    let lastTouch = -1;
    const reach = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    w.onPairContact = (a, b) => {
      if (a !== 0 && b !== 0) return;
      if (w.race.time - lastTouch > 0.5) touches++;
      lastTouch = w.race.time;
    };
    let speed = 0;
    const played = play(w, {
      seconds,
      retry: false,
      player: (ww) => {
        const car = ww.cars[0]!;
        speed = car.velocity.length();
        const p = car.group.position;
        reach.minX = Math.min(reach.minX, p.x);
        reach.maxX = Math.max(reach.maxX, p.x);
        reach.minZ = Math.min(reach.minZ, p.z);
        reach.maxZ = Math.max(reach.maxZ, p.z);
        drive(ww);
      },
    });
    const end = played.ends[0];
    return { fleer, seed, ended: end !== undefined, cause: end?.cause ?? "none", time: end?.time ?? w.race.time, touches, lastTouch, speed, reach, peak: played.peak, played };
  } finally {
    leaveSurvival(w);
  }
}

import { Obstacles } from "../ai/hunter.ts";
import { clamp, hash01, wrapPi } from "../kernel/scalar.ts";
import { placeProps, propColliders } from "./placements.ts";
import { holdLine, leaveSurvival, play, steerAt, survivalWorld, type Play } from "./survival-run.test-util.ts";
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
 *   shuttle: the hardest to catch: lifts for a wall it cannot stop before (`safe`) and turns back for the way it came, so it keeps running;
 *   orbit: the Driver 2 trick: down the boulevard, then circles the lawn round the hill at 14 m/s (the most the grass grips at that radius).
 */
export type Fleer = "straight" | "flee" | "ring" | "held" | "shuttle" | "orbit";
export const FLEERS: readonly Fleer[] = ["straight", "flee", "ring", "held", "shuttle", "orbit"];

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
/** The orbiting driver's circle round the hill (m): clear of the plateau's foot, inside the ring road. */
const ORBIT_R = 42;
/** A shuttling driver turns back when the way ahead is clear for less than this (m). */
const TURN_BACK = 90;

/** Holds the heading it has at the first call, bends to the nearest one with `LOOK` m clear (else the longest run). `shuttle`: turns back when less than `TURN_BACK` m are clear, and lifts for what is ahead. */
function fleeing(obstacles: Obstacles, shuttle: boolean): Driver {
  let want: number | null = null;
  let flipped = -Infinity;
  return (w) => {
    const car = w.cars[0]!;
    const c = car.group.position;
    want ??= Math.atan2(car.fwdFlat.x, car.fwdFlat.z);
    if (shuttle && w.race.time - flipped > 6 && obstacles.run(c.x, c.z, want, TURN_BACK) < TURN_BACK) {
      want += Math.PI;
      flipped = w.race.time;
    }
    const look = Math.max(LOOK_MIN, car.velocity.length() * LOOK_TIME);
    let h = want;
    let best = -1;
    for (let d = 0; d <= Math.PI / 2 + 1e-9 && best < look; d += 0.15) {
      for (const s of d === 0 ? [1] : [1, -1]) {
        const run = obstacles.run(c.x, c.z, want + s * d, look);
        if (run > best) {
          best = run;
          h = want + s * d;
        }
      }
    }
    // The cap follows what the car itself faces, not the heading it is bending to: it cannot turn 40° in a few metres at 38 m/s.
    steerAt(w, c.x + Math.sin(h) * look, c.z + Math.cos(h) * look, shuttle ? safe(obstacles.run(c.x, c.z, Math.atan2(car.fwdFlat.x, car.fwdFlat.z), look)) : null);
  };
}

export function drivers(kind: Fleer, seed: number): Driver {
  const track = new Track(HAVANA);
  const colliders = new Obstacles(propColliders(placeProps(track)));
  const flee = fleeing(colliders, kind === "shuttle");
  if (kind === "flee" || kind === "shuttle") return flee;
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
  if (kind === "orbit") {
    return (w) => {
      const c = w.cars[0]!.group.position;
      if (c.z > 62) return holdLine(w, 0, 30, c.z > 150 ? null : 14);
      const a = Math.atan2(c.x, c.z) + 0.5;
      steerAt(w, Math.sin(a) * ORBIT_R, Math.cos(a) * ORBIT_R, 14);
    };
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

/** One Survival run on Havana with `fleer` at the wheel, `seed` pinning the field's dice, for at most `seconds` of game time. */
export function chase(fleer: Fleer, seed: number, seconds: number): Chase {
  const w = survivalWorld(undefined, seed);
  try {
    const drive = drivers(fleer, seed);
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

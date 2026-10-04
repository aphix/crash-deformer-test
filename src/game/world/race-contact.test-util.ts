import { DERBY_RULES } from "../ai/derby-ai.ts";
import { crestSpeed } from "../ai/race-ai.ts";
import type { Track } from "./track.ts";
import { blankProjection } from "./track.ts";
import { FRAME, raceOnce, type Outcome, type World } from "./race-world.test-util.ts";

/**
 * Who started a racer-racer contact. One car's state per frame (`Sample`), the last frame before the
 * contact first registered, and the `KNOCK` s before it.
 *
 * With n the unit vector from car A's centre to car B's, car X "closes" on the other when its velocity
 * toward it (X·n, sign flipped for B) is at least `CLOSE_MIN` m/s and it was not knocked there: no car-car
 * contact on X in the `KNOCK` s before (a shove or a wreck's slide is the other car's doing). A car's
 * velocity is its own steer, throttle and brake integrated, so X closing means X turned into the other
 * or drove up to it without getting off its speed; a car that is the one rear-ended, passed or
 * pushed is moving away along n (or not at all), so it does not close. The contact must close at
 * `GRAZE` m/s or more (relative; the derby's `hitSpeed`: a push or a nudge is not a hit); less is a scrape.
 *   one car closes → `initiated` (that car) / `suffered` (the other);
 *   both close → `converging` (two lines meeting: a shared apex, a head-on, a reverse into a car behind);
 *   neither → `none` (a graze, or both were pushed together).
 */
export const KNOCK = 0.5;
export const CLOSE_MIN = 0.5;
export const GRAZE = DERBY_RULES.hitSpeed;

export type Sample = { x: number; z: number; vx: number; vz: number; yaw: number; throttle: number; steer: number; brake: number; bumped: boolean };
export type Role = "initiated" | "suffered" | "converging" | "none";
export type Verdict = { a: Role; b: Role; /** Relative closing speed (m/s) at the last frame. */ closing: number; towardA: number; towardB: number };

/** `a` and `b`: the two cars' samples, oldest to newest, equal length ≥ 1, the last the frame before the contact. */
export function classifyContact(a: readonly Sample[], b: readonly Sample[]): Verdict {
  const T = a.length - 1;
  const dx = b[T]!.x - a[T]!.x;
  const dz = b[T]!.z - a[T]!.z;
  const d = Math.hypot(dx, dz) || 1;
  const towardA = (a[T]!.vx * dx + a[T]!.vz * dz) / d;
  const towardB = -(b[T]!.vx * dx + b[T]!.vz * dz) / d;
  const knocked = (s: readonly Sample[]) => s.slice(Math.max(0, T - Math.round(KNOCK / FRAME)), T + 1).some((x) => x.bumped);
  const closing = towardA + towardB;
  const ca = closing >= GRAZE && towardA >= CLOSE_MIN && !knocked(a);
  const cb = closing >= GRAZE && towardB >= CLOSE_MIN && !knocked(b);
  const role = (me: boolean, other: boolean): Role => (me && other ? "converging" : me ? "initiated" : other ? "suffered" : "none");
  return { a: role(ca, cb), b: role(cb, ca), closing, towardA, towardB };
}

/** One contact the tracker saw: who, when, where, and the verdict with the evidence behind it. */
export type ContactEvent = {
  frame: number;
  a: number;
  b: number;
  /** Car b is a traffic car (a is always a racer). */
  traffic: boolean;
  /** Rolled aggression of each car (0 for the AI-driven player slot). */
  aggA: number;
  aggB: number;
  verdict: Verdict;
  /** Lateral offset (m) of each car from the centreline, and half the road width there. */
  latA: number;
  latB: number;
  half: number;
  /** The road here is a crest the faster of the two cars would leave (`crestSpeed`): a hit that sends a car off it. */
  crest: boolean;
  /** Each car's speed (m/s) at the frame before. */
  speedA: number;
  speedB: number;
  /** The initiator's index when exactly one car closed, else −1. */
  initiator: number;
  samplesA: Sample[];
  samplesB: Sample[];
};

export type ContactRace = { outcome: Outcome; contacts: ContactEvent[] };

const KEEP = Math.round(KNOCK / FRAME) + 1;
/** A pair in contact again within this many frames is the same contact (a scrape), not a new one. */
const SAME = 20;

/** One `raceOnce` with every contact of a racer classified, racer-racer or racer-traffic (`traffic`; police off: `raceOnce` never switches them on). */
export function contactRace(w: World, track: Track, bound: number, seed: number, slider: number, aiCount = 4): ContactRace {
  const contacts: ContactEvent[] = [];
  const hist: Sample[][] = [];
  const lastBump = new Map<number, number>();
  const lastPair = new Map<number, number>();
  const pending: [number, number][] = [];
  const proj = blankProjection();
  w.onPairContact = (a, b) => pending.push([a, b]);
  try {
    const outcome = raceOnce(w, track, bound, seed, slider, (n) => {
      const cars = w.live();
      const racers = w.race.racers.length;
      // Contacts first, from the frames before this one.
      for (const [a, b] of pending) {
        const key = a * 64 + b;
        const prev = lastPair.get(key);
        lastPair.set(key, n);
        if (a >= racers || (prev !== undefined && n - prev <= SAME) || hist[a] === undefined || hist[b] === undefined) continue;
        const sa = hist[a]!.slice();
        const sb = hist[b]!.slice();
        const verdict = classifyContact(sa, sb);
        const pa = cars[a]!.group.position;
        const pb = cars[b]!.group.position;
        const ja = track.project(pa.x, pa.z, -1, proj);
        const latA = ja.lateral;
        const half = track.path.half[ja.k]!;
        const latB = track.project(pb.x, pb.z, -1, proj).lateral;
        const e = w.race.racers;
        contacts.push({
          frame: n,
          a,
          b,
          traffic: b >= racers,
          aggA: e[a]!.aggression,
          aggB: e[b]?.aggression ?? 0,
          verdict,
          latA,
          latB,
          half,
          crest: Math.max(Math.hypot(sa[sa.length - 1]!.vx, sa[sa.length - 1]!.vz), Math.hypot(sb[sb.length - 1]!.vx, sb[sb.length - 1]!.vz)) > crestSpeed(track.path, ja.s),
          speedA: Math.hypot(sa[sa.length - 1]!.vx, sa[sa.length - 1]!.vz),
          speedB: Math.hypot(sb[sb.length - 1]!.vx, sb[sb.length - 1]!.vz),
          initiator: verdict.a === "initiated" ? a : verdict.b === "initiated" ? b : -1,
          samplesA: sa,
          samplesB: sb,
        });
      }
      for (const [a, b] of pending) {
        lastBump.set(a, n);
        lastBump.set(b, n);
      }
      pending.length = 0;
      for (let i = 0; i < cars.length; i++) {
        const c = cars[i]!;
        const h = (hist[i] ??= []);
        h.push({
          x: c.group.position.x,
          z: c.group.position.z,
          vx: c.velocity.x,
          vz: c.velocity.z,
          yaw: c.yaw,
          throttle: c.drive.throttle,
          steer: c.drive.steer,
          brake: c.drive.brake,
          bumped: lastBump.get(i) === n,
        });
        if (h.length > KEEP) h.shift();
      }
    }, aiCount);
    return { outcome, contacts };
  } finally {
    w.onPairContact = null;
  }
}

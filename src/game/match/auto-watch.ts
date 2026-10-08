import { hypot2 } from "../kernel/physics-core.js";
import { MIN_SCORE, QUIET_GAP } from "./highlights.ts";
import { BUST } from "./session.ts";

/**
 * Auto spectating: the "Auto" entry of the driver list lets the director pick which car the camera rides. Pure and
 * deterministic (race clock in, car id out); `RaceDirector.autoStep` feeds it from the live cars, the rules records
 * and the highlight ledger. A car's interest is the MAX of a few cheap signals, never a sum, so a pile of mild things
 * never outranks one big thing.
 */
export const WATCH = {
  /** Seconds on a car before a camera cut may move the view (the ask: "over 4 seconds"). */
  floor: 4,
  /** Interest under this is "nothing is happening to this car". */
  idle: 0.25,
  /** A car at or over this has something worth leaving an idle car for... */
  might: 0.4,
  /** ...and by at least this much more than the car being watched. */
  margin: 0.15,
  /** A car at or over this is never rotated away from: it is mid-crash, mid-bust or in a close fight. */
  hot: 0.7,
  /**
   * Shots a car gets before the director moves on. A clip in the highlight reel is three shots (opener, run-in,
   * aftermath), so a car gets one such sequence and then the camera follows a new subject.
   */
  rotate: 3,
  /** Seconds a shot lasts on a camera that makes no cuts: the trackside cam's `CINE.maxShot`, the longest any cut-making cam holds. */
  shotS: 7,
  /** Imminent big crash: another pair's contact in under `crashTtc` s at `crashClosing` m/s (43 km/h, a hit, not a tap) or more... */
  crashTtc: 1,
  crashClosing: 12,
  /** ...is worth leaving the car for off a cut, after this many seconds on it (2 s stops ping-pong between two crashes). */
  crashFloor: 2,
  /**
   * The watched car finished, is out, respawning or put away: nothing left to see on it. Leaving it is a necessity, not
   * a taste, so the 4 s floor does not apply; 1 s only keeps a one-frame status blip from flipping the view.
   */
  invalidFloor: 1,
  /** Pairs further apart than this (m) are not tested for contact or a battle. */
  range: 60,
  /** Contact is predicted when the closest approach comes within `horizon` s... */
  horizon: 2.5,
  /** ...closer than `hitR` m (a hit, full score) or `missR` m (a near miss, half). */
  hitR: 3,
  missR: 5,
  /** Closing speed (m/s) that scores 1 at 0.5 s from contact. */
  closeRef: 15,
  /** Adjacent places this close (s) are a battle: `battleW` at 0 s, falling to 0 at `battle`. */
  battle: 1,
  battleW: 0.8,
  /** An airborne car (a jump or a crest). Modest: alone never enough to leave a car for (under `might`). */
  air: 0.35,
  /** A car that changed place in the last `passS` s: an overtake. */
  passS: 3,
  pass: 0.5,
  /** A speed `jolt` m/s off the car's own `smooth`-second average is a hit or a hard brake; `joltRef` m/s scores 1. */
  jolt: 5,
  joltRef: 15,
  smooth: 1,
  /** `BUST.time` s held slow beside a police car scores `bust`: a bust ends that racer's race. */
  bust: 1.1,
  /** A cluster of this score is a full 1.0: twice the reel's `MIN_SCORE`, so a lone tap stays under `might`. */
  wreckRef: 2 * MIN_SCORE,
  /** A car unseen this long (s) starts its history afresh (it respawned, or was not racing). */
  gap: 0.5,
};

/** One car as the scorer sees it: plain numbers, metres and seconds. */
export type Cand = {
  id: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** Live position, 1 = leading. */
  place: number;
  /** Seconds behind the first car through the last gate this car crossed (`CarRecord.split`), null before the line. */
  split: number | null;
  /** Unbroken seconds held slow beside a police car (`CarRecord.stopped`; `BUST.time` busts it). */
  stopped: number;
  air: boolean;
  /** On the course and in the race. False for finished, out, dnf, respawning, police, traffic and our own car: never a candidate. */
  racing: boolean;
};

/** An open highlight-ledger cluster: its cars (bit i = car i), seconds since its last impact, and its score (`CrashCluster.score`). */
export type Wreck = { cars: number; age: number; score: number };

/** What a switch was for: the dominant signal of the car it went to, or `rotate` / `crash` / `invalid`. */
type Why = "contact" | "wreck" | "bust" | "battle" | "air" | "pass" | "jolt" | "rotate" | "crash" | "invalid";

type Switch = { t: number; from: number; to: number; why: Why };

/** Closest approach of two cars at constant velocity. */
type Approach = { ttc: number; closing: number; miss: number };

/** Where `a` and `b` are headed: false unless they close in within `WATCH.horizon` s. */
function approach(a: Cand, b: Cand, out: Approach): boolean {
  const rx = b.x - a.x;
  const rz = b.z - a.z;
  const vx = b.vx - a.vx;
  const vz = b.vz - a.vz;
  const vv = vx * vx + vz * vz;
  if (vv < 1e-6) return false;
  const t = -(rx * vx + rz * vz) / vv;
  if (t <= 0 || t > WATCH.horizon) return false;
  out.ttc = t;
  out.closing = Math.sqrt(vv);
  out.miss = hypot2(rx + vx * t, rz + vz * t);
  return true;
}

/** Interest of a predicted contact: closing speed, sooner is hotter, a near miss counts half. */
function contactScore(p: Approach): number {
  const w = p.miss < WATCH.hitR ? 1 : p.miss < WATCH.missR ? 0.5 : 0;
  return Math.min(1.2, (w * (p.closing / WATCH.closeRef)) / (p.ttc + 0.5));
}

type Hist = { seen: number; speed: number; place: number; placeAt: number };

const LOG_DEPTH = 32;
/** Place differences wrap at this (cars past `cur` in place order). */
const PLACES = 64;

/**
 * Picks the car to watch. `step` is called every frame with the race clock; the car it returns changes at most once per
 * `WATCH.floor` s (two exceptions, below) and only ever to a `racing` candidate.
 */
export class AutoWatch {
  /** The car being watched (-1: none). */
  current = -1;
  /** The last 32 switches, oldest first. */
  readonly log: Switch[] = [];
  private since = -Infinity;
  private cutsAt = -1;
  private readonly hist: (Hist | undefined)[] = [];
  /** Per candidate (the index into `cands` of the last step): interest, its dominant signal, in an imminent big crash. */
  private readonly val: number[] = [];
  private readonly tag: Why[] = [];
  private readonly big: boolean[] = [];
  private readonly ap: Approach = { ttc: 0, closing: 0, miss: 0 };

  reset(): void {
    this.current = -1;
    this.since = -Infinity;
    this.cutsAt = -1;
    this.hist.length = 0;
    this.log.length = 0;
  }

  /** The camera is on `id` already (the viewer picked it, or Auto just came on): its time on screen counts from `t`; `cuts` is the cut counter now. */
  follow(id: number, t: number, cuts: number): void {
    this.current = id;
    this.since = t;
    this.cutsAt = cuts;
  }

  /**
   * The car to watch at race time `t` (s). `cuts` is the camera director's monotone cut counter, -1 when the camera
   * makes no cuts (chase, far, hood, trackside, wheel, orbit); `atCut` is whether it cuts right now, or never cuts so
   * that a switch is itself the cut. A switch happens when:
   *  1. the car is gone (not a `racing` candidate): to the best car, after `invalidFloor` s;
   *  2. a big crash is about to happen between two other cars, after `crashFloor` s on this one: even between cuts;
   *  3. at a cut, after `floor` s on this one: nothing is happening to it and another car has something worth it; or
   *     it has had `rotate` shots and is not hot: on to the best car, or the next by place when nothing stands out.
   */
  step(t: number, cands: readonly Cand[], wrecks: readonly Wreck[], cuts: number, atCut: boolean): number {
    this.score(t, cands, wrecks);
    let cur = -1;
    for (let k = 0; k < cands.length; k++) if (cands[k]!.racing && cands[k]!.id === this.current) cur = k;
    const held = t - this.since;
    if (cur < 0) {
      if (held < WATCH.invalidFloor) return this.current;
      const k = this.pick(cands, -1, false);
      return k < 0 ? this.current : this.go(t, cands[k]!.id, "invalid", cuts);
    }
    if (held >= WATCH.crashFloor) {
      const k = this.pick(cands, cur, true);
      if (k >= 0) return this.go(t, cands[k]!.id, "crash", cuts);
    }
    if (!atCut || held < WATCH.floor) return this.current;
    const k = this.pick(cands, cur, false);
    if (k < 0) return this.current;
    const here = this.val[cur]!;
    if (here < WATCH.idle && this.val[k]! >= WATCH.might && this.val[k]! >= here + WATCH.margin) return this.go(t, cands[k]!.id, this.tag[k]!, cuts);
    const byCuts = cuts >= 0 && this.cutsAt >= 0 ? cuts - this.cutsAt : 0;
    // A camera that cuts is counted by its cuts, one that does not by the clock; the larger rules where both are known.
    if (Math.max(byCuts, Math.floor(held / WATCH.shotS)) >= WATCH.rotate && here < WATCH.hot) return this.go(t, cands[k]!.id, "rotate", cuts);
    return this.current;
  }

  private go(t: number, to: number, why: Why, cuts: number): number {
    this.log.push({ t, from: this.current, to, why });
    if (this.log.length > LOG_DEPTH) this.log.shift();
    this.follow(to, t, cuts);
    return to;
  }

  /**
   * The candidate (index; -1: none) other than `cur` with the highest interest; a tie goes to the next car by place after
   * `cur`'s, wrapping (with no `cur`: the leader). `bigOnly`: only cars in an imminent big crash.
   */
  private pick(cands: readonly Cand[], cur: number, bigOnly: boolean): number {
    let best = -1;
    let bv = -1;
    let bf = 0;
    for (let k = 0; k < cands.length; k++) {
      const c = cands[k]!;
      if (!c.racing || k === cur || (bigOnly && !this.big[k])) continue;
      const f = cur < 0 ? c.place : (((c.place - cands[cur]!.place) % PLACES) + PLACES) % PLACES || PLACES;
      const v = this.val[k]!;
      if (v > bv || (v === bv && f < bf)) {
        best = k;
        bv = v;
        bf = f;
      }
    }
    return best;
  }

  /** Every racing candidate's interest and dominant signal, and which cars are in an imminent big crash. */
  private score(t: number, cands: readonly Cand[], wrecks: readonly Wreck[]): void {
    const n = cands.length;
    while (this.val.length < n) {
      this.val.push(0);
      this.tag.push("contact");
      this.big.push(false);
    }
    for (let k = 0; k < n; k++) {
      const c = cands[k]!;
      this.val[k] = 0;
      this.big[k] = false;
      if (!c.racing) continue;
      // The car's own history: a place change (an overtake), and a speed far off its smoothed speed (a hit, a hard brake).
      const speed = hypot2(c.vx, c.vz);
      let h = this.hist[c.id];
      if (!h) h = this.hist[c.id] = { seen: -Infinity, speed, place: c.place, placeAt: -Infinity };
      if (t - h.seen > WATCH.gap || t < h.seen) {
        h.speed = speed;
        h.place = c.place;
        h.placeAt = -Infinity;
      } else {
        const off = Math.abs(speed - h.speed);
        if (off >= WATCH.jolt) this.add(k, Math.min(1, off / WATCH.joltRef), "jolt");
        // A second step at the same instant (an `advance` probe) adds no time: the average stays.
        h.speed += (speed - h.speed) * Math.min(1, (t - h.seen) / WATCH.smooth);
        if (c.place !== h.place) h.placeAt = t;
        h.place = c.place;
      }
      h.seen = t;
      if (t - h.placeAt < WATCH.passS) this.add(k, WATCH.pass, "pass");
      if (c.air) this.add(k, WATCH.air, "air");
      if (c.stopped > 0) this.add(k, Math.min(1, c.stopped / BUST.time) * WATCH.bust, "bust");
    }
    for (const w of wrecks) {
      if (w.age >= QUIET_GAP) continue;
      const s = Math.min(1.2, w.score / WATCH.wreckRef);
      for (let k = 0; k < n; k++) if (cands[k]!.racing && ((w.cars >>> cands[k]!.id) & 1) === 1) this.add(k, s, "wreck");
    }
    const r2 = WATCH.range * WATCH.range;
    for (let i = 0; i < n; i++) {
      const a = cands[i]!;
      if (!a.racing) continue;
      for (let j = i + 1; j < n; j++) {
        const b = cands[j]!;
        if (!b.racing || (b.x - a.x) ** 2 + (b.z - a.z) ** 2 > r2) continue;
        if (approach(a, b, this.ap)) {
          const s = contactScore(this.ap);
          this.add(i, s, "contact");
          this.add(j, s, "contact");
          // A crash the watched car is in is not "another" crash.
          if (this.ap.ttc < WATCH.crashTtc && this.ap.closing >= WATCH.crashClosing && this.ap.miss < WATCH.hitR && a.id !== this.current && b.id !== this.current) {
            this.big[i] = true;
            this.big[j] = true;
          }
        }
        // Adjacent places inside a second of each other: a battle, both cars in it.
        if (Math.abs(a.place - b.place) === 1 && a.split !== null && b.split !== null) {
          const gap = Math.max(0, a.place < b.place ? b.split - a.split : a.split - b.split);
          if (gap < WATCH.battle) {
            const s = WATCH.battleW * (1 - gap / WATCH.battle);
            this.add(i, s, "battle");
            this.add(j, s, "battle");
          }
        }
      }
    }
  }

  private add(k: number, v: number, why: Why): void {
    if (v <= this.val[k]!) return;
    this.val[k] = v;
    this.tag[k] = why;
  }
}

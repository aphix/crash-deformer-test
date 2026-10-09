import { hypot2, detSin, detCos } from "../kernel/physics-core.js";
import { chargeBoost, clearDrive, DRIVE, idleDrive, topUpBoost, type DriveInput } from "../vehicle/car-drive.ts";
import { DERBY_RADIUS } from "../scenes/derby-arena.ts";
import { MAX_CARS } from "../scenes/fleet.ts";
import { mood } from "./ai-aggression.ts";
import { DerbyPocket } from "./derby-pocket.ts";
import { clamp, hash01 } from "../kernel/scalar.ts";
import { OpeningWatch } from "./derby-opening.ts";
import { personality, type Personality } from "./personality.ts";

export type AiCar = {
  id: number;
  x: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  alive: boolean;
  /** 0 mint … 1 dead. Driven by the spent nose (the engine lives there). */
  damage: number;
  /** Spent share of the nose crumple zone, 0 mint … 1 flat. */
  front: number;
  /** Spent share of the tail crumple zone. */
  rear: number;
  /** Seconds since this car's last aggressive hit on a live car (the hit clock, `DERBY_RULES.hitClock`). */
  idle: number;
};

export function blankAiCar(id: number): AiCar {
  return { id, x: 0, z: 0, yaw: 0, vx: 0, vz: 0, alive: true, damage: 0, front: 0, rear: 0, idle: 0 };
}

/**
 * Count-out rules from fair rule books (docs/DERBY_AI.md; .extraResearch/perplexity/41 and 50): an
 * aggressive hit on a live car at least every 60 s (the common clock; some books run 90 s or 2 min), and
 * a car that hasn't moved for 60 s is out. One place to tune them.
 */
export const DERBY_RULES = {
  /** Seconds without an aggressive hit on a live car before a car is counted out. */
  hitClock: 60,
  /** Closing speed (m/s) into the other car that makes a hit aggressive; a push or a nudge doesn't. */
  hitSpeed: 2,
  /** Seconds without getting `stillRadius` from where it stopped before a car is counted out. */
  stillClock: 60,
  /** Metres a stopped car has to move for the still clock to restart (rocking in a wedge doesn't count). */
  stillRadius: 2,
};

/** The derby field's aggression slider: a maximum, each driver rolls its own under it (ai-aggression.ts). */
export const DEFAULT_DERBY_AGGRESSION = 1;

/** The steering wheel sits at local x −0.22 (car-mesh `makeInterior`): the driver's door is the −x side. */
const DRIVER_SIDE = -1;

function wrapPi(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

function smooth(lo: number, hi: number, v: number): number {
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

/**
 * The arena pace (m/s) the brain's forward throttle is a share of: the 65 km/h top it was tuned at. A car's
 * throttle is a share of its class top (200 km/h), so `DerbyMatch.think` scales it down to this; at the
 * class top a cruise (0.82–1) meant 45–55 m/s in a 16 m bowl.
 */
export const DERBY_PACE = 18;
/** Below this with throttle held, the car is pinned or wedged. */
export const STUCK_SPEED = 1;
/** Shoving the target this slowly counts (at 60 %) toward backing off for a run-up. */
const GRIND_SPEED = 2.5;
const GRIND_RANGE = 4.6;
const RESCORE = 0.14;
/** Contact range: closer than this counts as engaged, not orbiting. */
const ENGAGED = 3.8;
/** Nose point (front wheel / radiator) ahead of a car's origin. */
const NOSE = 1.7;
const MODE_REV = 0;
const MODE_FWD = 1;
/**
 * Within SPIN_HOLD s of another car's centre coming inside SPIN_NEAR m (about a car length: touching or
 * about to) a driver stops adding lock the way the car already turns from SPIN_EASE rad/s and lets go
 * of it by SPIN_LET_GO (the yaw rate seen over SPIN_LAG s). Its own steer took a shoved car past 5 rad/s
 * in and just after contact (derby seed 5 c2: applyDrive turned it 0.36 rad in 0.1 s on top of the
 * hit's spin). In the open the J-turn keeps its full lock.
 */
const SPIN_NEAR = 4.6;
const SPIN_HOLD = 0.6;
const SPIN_EASE = 3.5;
const SPIN_LET_GO = 4.5;
const SPIN_LAG = 0.05;
/** A charge boosts only with the target this close (m)… */
const BOOST_RANGE = 25;
/**
 * …and lets go this close to it (m): the last run-in coasts off the boost. Boosting through the hit took the ten-car
 * contact-spin peak of seed 4 to 6.73 rad/s (limit 6.5, `derby-ai.test.ts`); letting go at 8 m reads 4.30–4.61 over seeds 1–8.
 */
const BOOST_RELEASE = 8;
/** …and this far ahead: the target's bearing within ~25° of the nose (cosine of the angle)… */
const BOOST_CONE = 0.9;
/**
 * …and never into a nose: head-on is banned in every rule book, and a boosted one doubles the closing speed (the target
 * facing us past this cosine of its nose to our bearing). Without it a six-car heat's seed 17 lost two engines to one
 * boosted nose-to-nose hit at 7.5 s (`derby.test.ts`: none before 8 s).
 */
const BOOST_FACED = 0.5;

/** What a driver is doing this tick (`tacticOf`). */
const TACTICS = ["idle", "unstick", "hold", "layback", "reverse", "jturn", "nose", "swing", "sideswipe"] as const;
type Tactic = (typeof TACTICS)[number];
const T_IDLE = 0;
const T_UNSTICK = 1;
const T_HOLD = 2;
const T_LAYBACK = 3;
const T_REVERSE = 4;
const T_JTURN = 5;
const T_NOSE = 6;
const T_SWING = 7;
const T_SIDESWIPE = 8;

/**
 * Layered derby driver (one per match, memory per car id), modelled on real derby driving
 * (docs/DERBY_AI.md):
 * L0 unstick: throttle without motion (or a slow shove on the target) -> back off toward open space.
 * L1 boards: bend onto the tangent before the wall, J-turn off it when nosed in.
 * L2 target: utility over reach time, the target's exposed front, damage, mood and hunters already on it,
 *    with commitment so picks don't flicker and an orbit breaker so pairs don't circle.
 * L3 strike, by the shared aggression model (`mood`): keep clear until the hit clock runs down, or
 *    hit — tail first into the front wheel by default, a handbrake swing of the tail into a passing
 *    nose, a sideswipe on a car alongside, the nose only for a driver spoiling for it. Never head-on,
 *    never the driver's door.
 */
export class DerbyBrain {
  /** Bowl radius (the match sets it per field size). */
  radius: number;
  private readonly out: DriveInput = idleDrive();
  private readonly traits: Personality[] = [];
  private readonly aggression = new Float64Array(MAX_CARS);
  private readonly target = new Int16Array(MAX_CARS);
  private readonly claims = new Int16Array(MAX_CARS);
  private readonly held = new Float64Array(MAX_CARS);
  private readonly rescoreIn = new Float64Array(MAX_CARS);
  private readonly closest = new Float64Array(MAX_CARS);
  private readonly chase = new Float64Array(MAX_CARS);
  private readonly shunId = new Int16Array(MAX_CARS);
  private readonly shunFor = new Float64Array(MAX_CARS);
  private readonly stuck = new Float64Array(MAX_CARS);
  private readonly recover = new Float64Array(MAX_CARS);
  private readonly recoverThrottle = new Float64Array(MAX_CARS);
  private readonly recoverSteer = new Float64Array(MAX_CARS);
  private readonly tighten = new Float64Array(MAX_CARS);
  private readonly mode = new Uint8Array(MAX_CARS);
  private readonly lastThrottle = new Float64Array(MAX_CARS);
  private readonly age = new Float64Array(MAX_CARS);
  private readonly freedAt = new Float64Array(MAX_CARS);
  private readonly tactic = new Uint8Array(MAX_CARS);
  /** A committed swing or sideswipe: seconds left, its steer and kind. */
  private readonly moveFor = new Float64Array(MAX_CARS);
  private readonly moveSteer = new Float64Array(MAX_CARS);
  private readonly moveKind = new Uint8Array(MAX_CARS);
  /** Heading at the last decision, the yaw rate seen since (rad/s, SPIN_LAG low-pass) and seconds left near a car. */
  private readonly yawWas = new Float64Array(MAX_CARS);
  private readonly spin = new Float64Array(MAX_CARS);
  private readonly nearFor = new Float64Array(MAX_CARS);
  /** Deadlock breaker (`DerbyPocket`): the sandbagger that paces in one pocket goes bold. */
  private readonly pocket = new DerbyPocket();
  /** Boost meter per car, 0–1: the seat's (`BOOST`), earned by takedowns and kept by `driveBoost`. */
  readonly meter = new Float64Array(MAX_CARS);
  private readonly caution = new OpeningWatch();

  constructor(radius = DERBY_RADIUS) {
    this.radius = radius;
    for (let i = 0; i < MAX_CARS; i++) this.traits.push(personality(i));
    this.aggression.fill(0.5);
    this.reset();
  }

  reset(): void {
    this.target.fill(-1);
    this.claims.fill(0);
    this.held.fill(0);
    this.rescoreIn.fill(0);
    this.closest.fill(Infinity);
    this.chase.fill(0);
    this.shunId.fill(-1);
    this.shunFor.fill(0);
    this.stuck.fill(0);
    this.recover.fill(0);
    this.recoverThrottle.fill(0);
    this.recoverSteer.fill(0);
    this.tighten.fill(0);
    this.mode.fill(MODE_REV);
    this.lastThrottle.fill(0);
    this.age.fill(0);
    this.freedAt.fill(-Infinity);
    this.tactic.fill(T_IDLE);
    this.moveFor.fill(0);
    this.yawWas.fill(Number.NaN);
    this.spin.fill(0);
    this.nearFor.fill(0);
    this.pocket.reset();
    this.caution.reset();
    this.meter.fill(1);
  }

  /** Driver `id`'s aggression, 0 … 1 (the match rolls it with `fieldAggression`). */
  setAggression(id: number, a: number): void {
    this.aggression[id] = Math.max(0, Math.min(1, a));
  }

  /** A bonus (a takedown's `BOOST.takedown`) onto driver `id`'s meter, as `DriverSeat.addBoost` does for the player. */
  addBoost(id: number, amount: number): void {
    this.meter[id] = topUpBoost(this.meter[id] ?? 0, amount);
  }

  aggressionOf(id: number): number {
    return this.aggression[id] ?? 0;
  }

  /** How many cars are currently hunting `id`. */
  huntersOf(id: number): number {
    return this.claims[id] ?? 0;
  }

  recovering(id: number): boolean {
    return (this.recover[id] ?? 0) > 0;
  }

  tacticOf(id: number): Tactic {
    return TACTICS[this.tactic[id] ?? T_IDLE]!;
  }

  /**
   * One decision for `self`. The returned input is scratch owned by the brain —
   * apply it before the next call.
   */
  think(self: AiCar, others: readonly AiCar[], dt: number): DriveInput {
    const out = this.decide(self, others, dt);
    const i = self.id;
    if (i < 0 || i >= MAX_CARS || dt <= 0) return out;
    this.driveBoost(self, others, out, dt);
    this.caution.apply(out, self, others, this.age[i]!);
    if (Number.isNaN(this.yawWas[i]!)) this.yawWas[i] = self.yaw;
    const rate = wrapPi(self.yaw - this.yawWas[i]!) / dt;
    this.yawWas[i] = self.yaw;
    this.spin[i]! += (rate - this.spin[i]!) * Math.min(1, dt / SPIN_LAG);
    this.nearFor[i]! -= dt;
    for (let q = 0; q < others.length; q++) {
      const o = others[q]!;
      if (o.id !== i && hypot2(o.x - self.x, o.z - self.z) < SPIN_NEAR) this.nearFor[i] = SPIN_HOLD;
    }
    if (this.nearFor[i]! > 0 && out.steer * this.spin[i]! > 0) out.steer *= 1 - smooth(SPIN_EASE, SPIN_LET_GO, Math.abs(this.spin[i]!));
    return out;
  }

  /**
   * Boost by the seat's rules (`BOOST`, `chargeBoost`): on while this driver charges its target nose first, the target
   * between BOOST_RELEASE and BOOST_RANGE m away, within BOOST_CONE of its heading and not facing back at us (BOOST_FACED),
   * on the gas, with meter left. The meter drains while boosting and refills otherwise; a takedown tops it up (`addBoost`).
   */
  private driveBoost(self: AiCar, others: readonly AiCar[], out: DriveInput, dt: number): void {
    const i = self.id;
    const tgt = this.tactic[i] === T_NOSE ? findCar(others, this.target[i]!) : null;
    let want = false;
    if (tgt && tgt.alive && out.throttle > 0.05) {
      const dx = tgt.x - self.x;
      const dz = tgt.z - self.z;
      const d = hypot2(dx, dz);
      const ahead = detSin(self.yaw) * dx + detCos(self.yaw) * dz;
      const faced = -(detSin(tgt.yaw) * dx + detCos(tgt.yaw) * dz) / d;
      want = d < BOOST_RANGE && d > BOOST_RELEASE && ahead > d * BOOST_CONE && faced < BOOST_FACED;
    }
    const m = this.meter[i]!;
    out.boost = want && m > 0.02;
    this.meter[i] = chargeBoost(m, want && m > 0, dt);
  }

  private decide(self: AiCar, others: readonly AiCar[], dt: number): DriveInput {
    const out = clearDrive(this.out);
    const i = self.id;
    if (i < 0 || i >= MAX_CARS) return out;
    this.tactic[i] = T_IDLE;
    if (!self.alive) {
      this.setTarget(i, -1);
      this.lastThrottle[i] = 0;
      this.recover[i] = 0;
      this.moveFor[i] = 0;
      return out;
    }
    const p = this.traits[i]!;
    const a = this.aggression[i]!;
    const speed = hypot2(self.vx, self.vz);
    this.age[i]! += dt;

    // L0 — unstick.
    if (this.recover[i]! > 0) {
      this.recover[i]! -= dt;
      out.throttle = this.recoverThrottle[i]!;
      out.steer = this.recoverSteer[i]!;
      this.lastThrottle[i] = 0;
      this.tactic[i] = T_UNSTICK;
      if (this.recover[i]! <= 0) this.rescoreIn[i] = 0;
      return out;
    }
    // Wedged (no motion) or grinding a shove against the target: back off for a run-up.
    const prev = findCar(others, this.target[i]!);
    const near = prev != null && hypot2(prev.x - self.x, prev.z - self.z) < GRIND_RANGE;
    const pushing = Math.abs(this.lastThrottle[i]!) > 0.35;
    if (pushing && speed < STUCK_SPEED) this.stuck[i]! += dt;
    else if (pushing && near && speed < GRIND_SPEED) this.stuck[i]! += dt * 0.6;
    else this.stuck[i] = Math.max(0, this.stuck[i]! - dt * 2);
    if (this.stuck[i]! > p.patience) {
      this.beginRecovery(self, others, p);
      out.throttle = this.recoverThrottle[i]!;
      out.steer = this.recoverSteer[i]!;
      this.lastThrottle[i] = 0;
      this.moveFor[i] = 0;
      this.tactic[i] = T_UNSTICK;
      return out;
    }

    // L2 — target.
    this.held[i]! += dt;
    this.rescoreIn[i]! -= dt;
    if (this.shunFor[i]! > 0) this.shunFor[i]! -= dt;
    if (this.tighten[i]! > 0) this.tighten[i]! -= dt;
    let tgt = findCar(others, this.target[i]!);
    if (tgt && !tgt.alive) tgt = null;
    if (!tgt || this.rescoreIn[i]! <= 0) {
      tgt = this.pick(self, others, p, a, tgt);
      this.rescoreIn[i] = RESCORE + 0.1 * hash01(i, 8);
    }
    if (!tgt) {
      this.lastThrottle[i] = 0;
      return out;
    }

    const dx = tgt.x - self.x;
    const dz = tgt.z - self.z;
    const d = hypot2(dx, dz) || 1e-3;
    this.trackProgress(i, d, others, tgt, p, dt);

    // L3 — strike.
    if (this.age[i]! < p.hold) {
      // At the horn some drivers stand on the brakes and line up; the field stops moving as one ring.
      out.brake = 1;
      out.steer = clamp(wrapPi(Math.atan2(dx, dz) - self.yaw) * 2, -1, 1);
      this.lastThrottle[i] = 0;
      this.tactic[i] = T_HOLD;
      return out;
    }
    // Keep clear while the mood says so and three or more rivals are left to soften each other up, until
    // the hit clock is half gone (well inside the judge's count; the cautious end of the field sandbags
    // legally). Aggression 0 never hits.
    const due = self.idle > DERBY_RULES.hitClock * (0.5 - 0.3 * a);
    const m = mood(a, self.damage, tgt.damage);
    let rivals = 0;
    for (let q = 0; q < others.length; q++) if (others[q]!.alive && others[q]!.id !== i) rivals++;
    const clear = m <= 0 && !due && rivals > 2;
    const brave = a > 0 && this.pocket.bold(i, self.x, self.z, self.idle, clear, dt);
    if (a <= 0 || (clear && !brave)) {
      this.layBack(self, others, p, speed);
      this.tactic[i] = T_LAYBACK;
      this.moveFor[i] = 0;
    } else if (!this.opening(self, others, a, due, speed, dt)) {
      this.chooseMode(self, p, m);
      if (this.mode[i] === MODE_FWD) {
        this.attackForward(self, tgt, p, d, speed);
        this.tactic[i] = T_NOSE;
      } else {
        this.tactic[i] = this.attackReverse(self, tgt, p, d) ? T_JTURN : T_REVERSE;
      }
    }
    if (this.tighten[i]! > 0 && out.throttle > 0.42) out.throttle = 0.42;
    this.lastThrottle[i] = out.throttle;
    return out;
  }

  private setTarget(i: number, id: number): void {
    const prev = this.target[i]!;
    if (prev === id) return;
    if (prev >= 0) this.claims[prev]!--;
    this.target[i] = id;
    if (id >= 0) this.claims[id]!++;
    this.held[i] = 0;
    this.chase[i] = 0;
    this.closest[i] = Infinity;
  }

  private cost(self: AiCar, o: AiCar, a: number, speed: number, curId: number): number {
    const i = self.id;
    const dx = o.x - self.x;
    const dz = o.z - self.z;
    const d = hypot2(dx, dz) || 1e-3;
    // Where we sit around the target: +1 at its nose, -1 behind it.
    const cosA = -(detSin(o.yaw) * dx + detCos(o.yaw) * dz) / d;
    const nose = Math.max(0, cosA);
    const rev = this.mode[i] !== MODE_FWD;
    const heading = rev ? self.yaw + Math.PI : self.yaw;
    const turn = Math.abs(wrapPi(Math.atan2(dx, dz) - heading));
    let c = (d / Math.max(speed, 7) + turn * 0.5) * 2.2;
    // A car running away at our speed is never caught; a parked one is a gift.
    const flee = (o.vx * dx + o.vz * dz) / d;
    if (flee > 0) c += flee * 0.15;
    // Tail first, its front is the target; the nose would rather have its flank.
    if (rev) c -= nose * 0.8;
    else c += nose * (2.2 - 1.6 * a) - (1 - Math.abs(cosA)) * 1.4;
    // Weakened cars first, more so the hungrier the driver (mood carries both cars' damage).
    c -= 2 * mood(a, self.damage, o.damage);
    // Spread out: the cautious end of the field won't pile on; a car about to drop is fair game.
    const hunters = this.claims[o.id]! - (curId === o.id ? 1 : 0);
    c += hunters * (1.2 + 1.8 * (1 - a)) * (o.damage > 0.75 ? 0.3 : 1);
    if (o.id === curId) c -= 0.9;
    if (this.shunId[i] === o.id && this.shunFor[i]! > 0) c += 8;
    if (o.id >= 0 && o.id < MAX_CARS && this.target[o.id] === i && d < 12) c -= 0.6 * a;
    return c;
  }

  private pick(self: AiCar, others: readonly AiCar[], p: Personality, a: number, cur: AiCar | null): AiCar | null {
    const i = self.id;
    const curId = cur ? cur.id : -1;
    const speed = hypot2(self.vx, self.vz);
    let best: AiCar | null = null;
    let bestCost = Infinity;
    let curCost = Infinity;
    for (let q = 0; q < others.length; q++) {
      const o = others[q]!;
      if (o.id === i || !o.alive) continue;
      const c = this.cost(self, o, a, speed, curId);
      if (o.id === curId) curCost = c;
      if (c < bestCost) {
        bestCost = c;
        best = o;
      }
    }
    // Committed: only a clearly better target may cut in before `commit` runs out.
    if (cur && best !== cur && this.held[i]! < p.commit && bestCost > curCost - 2) best = cur;
    this.setTarget(i, best ? best.id : -1);
    return best;
  }

  /** Orbit breaker: no closing-in for a few seconds → drop the target or tighten the turn. */
  private trackProgress(i: number, d: number, others: readonly AiCar[], tgt: AiCar, p: Personality, dt: number): void {
    if (d < ENGAGED || d < this.closest[i]! - 0.8) {
      this.closest[i] = d;
      this.chase[i] = 0;
      return;
    }
    this.chase[i]! += dt;
    if (this.chase[i]! < 2 + p.patience * 1.6) return;
    let alternatives = 0;
    for (let q = 0; q < others.length; q++) if (others[q]!.alive && others[q]!.id !== i && others[q]!.id !== tgt.id) alternatives++;
    if (alternatives > 0) {
      this.shunId[i] = tgt.id;
      this.shunFor[i] = 2.5;
      this.rescoreIn[i] = 0;
    }
    this.tighten[i] = 0.9;
    this.chase[i] = 0;
    this.closest[i] = d;
  }

  /**
   * The tail is the bumper (the engine and radiator live in the nose). The nose only for a driver
   * spoiling for it with a nose to spare, or once the tail is the worse end.
   */
  private chooseMode(self: AiCar, p: Personality, m: number): void {
    const i = self.id;
    const fwd = this.mode[i] === MODE_FWD;
    const brawl = self.front < 0.3 && m > 0.35 + 0.4 * p.reverse - (fwd ? 0.1 : 0);
    const tailSpent = self.rear > 0.7 && self.rear > self.front + (fwd ? 0.05 : 0.2);
    this.mode[i] = brawl || tailSpent ? MODE_FWD : MODE_REV;
  }

  /**
   * Chances that pass by: a handbrake swing that whips our tail into a nose beside our rear wheel,
   * or a sideswipe on a car coming alongside. Committed for a beat once started.
   */
  private opening(self: AiCar, others: readonly AiCar[], a: number, due: boolean, speed: number, dt: number): boolean {
    const i = self.id;
    if (this.moveFor[i]! > 0) {
      this.moveFor[i]! -= dt;
      if (speed < 1.5) {
        this.moveFor[i] = 0;
        return false;
      }
      this.applyMove(i);
      return true;
    }
    const fx = detSin(self.yaw);
    const fz = detCos(self.yaw);
    const fwd = self.vx * fx + self.vz * fz;
    if (fwd < 4) return false;
    for (let q = 0; q < others.length; q++) {
      const o = others[q]!;
      if (o.id === i || !o.alive) continue;
      const rx = o.x - self.x;
      const rz = o.z - self.z;
      if (rx * rx + rz * rz > 36) continue;
      if (!due && mood(a, self.damage, o.damage) <= -0.2) continue;
      const ofx = detSin(o.yaw);
      const ofz = detCos(o.yaw);
      // Its nose in our frame (along +forward, lateral +left).
      const nx = rx + ofx * NOSE;
      const nz = rz + ofz * NOSE;
      const na = nx * fx + nz * fz;
      const nl = nx * fz - nz * fx;
      const facing = -Math.sign(nl) * (ofx * fz - ofz * fx);
      if (fwd < 13 && na > -3.2 && na < -0.6 && Math.abs(nl) > 0.9 && Math.abs(nl) < 3.2 && facing > 0.3) {
        // Its nose sits by our rear wheel: handbrake and steer away, the tail swings into its radiator.
        this.moveKind[i] = T_SWING;
        this.moveSteer[i] = -Math.sign(nl) * 0.85;
        this.moveFor[i] = 0.45;
        this.applyMove(i);
        return true;
      }
      const ca = rx * fx + rz * fz;
      const cl = rx * fz - rz * fx;
      const passing = (o.vx - self.vx) * fx + (o.vz - self.vz) * fz;
      // Us in its frame: is its driver's door the side we'd rub?
      const ua = -(rx * ofx + rz * ofz);
      const ul = -(rx * ofz - rz * ofx);
      const door = ul * DRIVER_SIDE > 0 && ua > -1 && ua < 1.1;
      if (!door && passing < -2 && ca > -1.5 && ca < 3 && Math.abs(cl) > 1.7 && Math.abs(cl) < 4.2) {
        this.moveKind[i] = T_SIDESWIPE;
        this.moveSteer[i] = Math.sign(cl) * 0.55;
        this.moveFor[i] = 0.4;
        this.applyMove(i);
        return true;
      }
    }
    return false;
  }

  private applyMove(i: number): void {
    const out = this.out;
    out.steer = this.moveSteer[i]!;
    const swing = this.moveKind[i] === T_SWING;
    out.ebrake = swing;
    out.throttle = swing ? 0 : 0.8;
    this.tactic[i] = this.moveKind[i]!;
  }

  private intercept(self: AiCar, tgt: AiCar, p: Personality, ownSpeed: number, aim: { x: number; z: number }): void {
    let px = tgt.x;
    let pz = tgt.z;
    for (let k = 0; k < 2; k++) {
      const tau = Math.min(1.4, hypot2(px - self.x, pz - self.z) / ownSpeed) * p.lead;
      px = tgt.x + tgt.vx * tau;
      pz = tgt.z + tgt.vz * tau;
    }
    const lim = this.radius - 2.4;
    const r = hypot2(px, pz);
    if (r > lim) {
      px *= lim / r;
      pz *= lim / r;
    }
    aim.x = px;
    aim.z = pz;
  }

  /** Nose first: at its front wheel from the side, never head-on (banned in every rule book). */
  private attackForward(self: AiCar, tgt: AiCar, p: Personality, d: number, speed: number): void {
    const out = this.out;
    this.intercept(self, tgt, p, Math.max(speed, DERBY_PACE * p.cruise * 0.7), _aim);
    const ofx = detSin(tgt.yaw);
    const ofz = detCos(tgt.yaw);
    const rx = self.x - _aim.x;
    const rz = self.z - _aim.z;
    const rd = hypot2(rx, rz) || 1e-3;
    const cosA = (ofx * rx + ofz * rz) / rd;
    const lat = (ofz * rx - ofx * rz) / rd;
    const side = lat > 0.05 ? 1 : lat < -0.05 ? -1 : p.side;
    // Its front wheel; on the driver's side the bumper corner, clear of the door.
    const reach = side === DRIVER_SIDE ? 2 : 1.5;
    let ax = _aim.x + ofx * reach;
    let az = _aim.z + ofz * reach;
    // In its front cone: swing out to its flank instead of trading noses.
    const w = smooth(0.15, 0.5, cosA);
    if (w > 0) {
      const wx = _aim.x + ofz * side * 4.5 - ofx * 0.5;
      const wz = _aim.z - ofx * side * 4.5 - ofz * 0.5;
      ax += (wx - ax) * w;
      az += (wz - az) * w;
    }
    const lim = this.radius - 4;
    const ar = hypot2(ax, az);
    if (ar > lim) {
      ax *= lim / ar;
      az *= lim / ar;
    }
    const err = wrapPi(Math.atan2(ax - self.x, az - self.z) - self.yaw);
    const ae = Math.abs(err);
    out.steer = clamp(err * 2, -1, 1);
    out.throttle = ae < 0.3 ? p.cruise : ae < 0.8 ? 0.72 : ae < 1.5 ? 0.5 : 0.38;
    if (ae > 1 && speed > 9) out.ebrake = true;
    if (d < 5 && ae < 0.5 && w < 0.5) {
      out.throttle = 1;
      out.ebrake = false;
      return;
    }
    if (ae > 2.3 && d < 8) {
      // Target right behind: J-turn — back up while swinging the nose round.
      out.throttle = -0.75;
      out.steer = Math.sign(err) || p.side;
      out.ebrake = false;
      return;
    }
    this.boards(self, p, speed);
  }

  /**
   * Tail first into its front wheel on our side (the bumper corner on the driver's side). From beside or
   * behind it, stage wide of that corner so the run-in meets the wheel, not the door. Nose toward it and
   * rolling: a handbrake J-turn brings the tail round in one go. Returns true while J-turning.
   */
  private attackReverse(self: AiCar, tgt: AiCar, p: Personality, d: number): boolean {
    const out = this.out;
    this.intercept(self, tgt, p, DRIVE.maxRev * 0.85, _aim);
    const ofx = detSin(tgt.yaw);
    const ofz = detCos(tgt.yaw);
    const rx = self.x - tgt.x;
    const rz = self.z - tgt.z;
    const rd = hypot2(rx, rz) || 1e-3;
    const lat = (ofz * rx - ofx * rz) / rd;
    const ahead = (ofx * rx + ofz * rz) / rd;
    const side = lat > 0.1 ? 1 : lat < -0.1 ? -1 : p.side;
    // Its radiator and front wheel on our side, square on so the push packs its block back: aim down a
    // lane out from its nose, the further out the further off its axis we are, so the run-in straightens.
    // Circling without closing in (it keeps its own tail to us): take whatever end is there, tail to tail.
    const direct = this.chase[self.id]! > 1.2 || this.tighten[self.id]! > 0;
    const reach = direct ? 0 : (side === DRIVER_SIDE ? 2.1 : 1.6) + Math.min(6, 0.45 * d) * (1 - Math.max(0, ahead));
    const wide = direct ? 0 : (0.3 + 3.1 * smooth(-0.3, 0.5, -ahead)) * side;
    let ax = _aim.x + ofx * reach + ofz * wide;
    let az = _aim.z + ofz * reach - ofx * wide;
    const lim = this.radius - 3;
    const ar = hypot2(ax, az);
    if (ar > lim) {
      ax *= lim / ar;
      az *= lim / ar;
    }
    const err = wrapPi(Math.atan2(ax - self.x, az - self.z) - self.yaw - Math.PI);
    const ae = Math.abs(err);
    out.steer = clamp(err * 1.8, -1, 1);
    out.throttle = ae < 0.45 ? -1 : ae < 1.2 ? -0.75 : -0.5;
    if (ae > 2.3 && d > 6) {
      out.steer = Math.sign(err) || p.side;
      const fwd = self.vx * detSin(self.yaw) + self.vz * detCos(self.yaw);
      if (fwd > 5) {
        // Rolling at it nose first: handbrake and lock, the tail comes round (just under 5 rad/s).
        out.throttle = 0;
        out.steer *= 0.85;
        out.ebrake = true;
        return true;
      }
      // Slow: pivot forward to bring the tail round.
      out.throttle = 0.45;
    }
    const r = hypot2(self.x, self.z);
    if (r > this.radius - 3.6 && out.throttle < 0) {
      const tailOut = -(detSin(self.yaw) * self.x + detCos(self.yaw) * self.z) / r;
      if (tailOut > 0.4 && !(d < 5 && ae < 0.5)) {
        // Backing into the boards: pull forward and let the swing bring the tail round.
        out.throttle = 0.6;
        out.steer = Math.sign(err) || p.side;
      }
    }
    return false;
  }

  /**
   * Keeping clear: rolling (a parked car is a target and a sandbagger), away from anyone within ~10 m,
   * whichever end points away (forward away shows it the bumper), off the boards.
   */
  private layBack(self: AiCar, others: readonly AiCar[], p: Personality, speed: number): void {
    const out = this.out;
    const r = hypot2(self.x, self.z);
    this.openSpace(self, others, 14, 0.8 * smooth(this.radius - 9, this.radius - 4, r), _aim);
    if (hypot2(_aim.x, _aim.z) < 0.25) {
      out.throttle = 0.35;
      this.boards(self, p, speed);
      return;
    }
    const away = Math.atan2(_aim.x, _aim.z);
    const err = wrapPi(away - self.yaw);
    if (Math.abs(err) < 2) {
      out.steer = clamp(err * 2, -1, 1);
      out.throttle = 0.55;
      this.boards(self, p, speed);
    } else {
      out.steer = clamp(wrapPi(away - self.yaw - Math.PI) * 1.8, -1, 1);
      out.throttle = -0.55;
    }
  }

  /** Bend onto the tangent before the wall; J-turn off it when nosed in. */
  private boards(self: AiCar, p: Personality, speed: number): void {
    const out = this.out;
    const r = hypot2(self.x, self.z);
    if (r < this.radius - 6) return;
    const nx = self.x / r;
    const nz = self.z / r;
    const fx = detSin(self.yaw);
    const fz = detCos(self.yaw);
    const noseOut = fx * nx + fz * nz;
    if (r > this.radius - 3.4 && noseOut > 0.55 && speed < 4) {
      out.throttle = -0.8;
      out.steer = Math.sign(wrapPi(Math.atan2(-nx, -nz) - self.yaw)) || p.side;
      out.ebrake = false;
      return;
    }
    const look = 0.55;
    const lx = self.x + self.vx * look;
    const lz = self.z + self.vz * look;
    if (hypot2(lx, lz) < this.radius - 2.9 || self.vx * nx + self.vz * nz < 0.5) return;
    let tx = -nz;
    let tz = nx;
    if (fx * tx + fz * tz < 0) {
      tx = -tx;
      tz = -tz;
    }
    const want = Math.atan2(tx - nx * 0.6, tz - nz * 0.6);
    out.steer = clamp(wrapPi(want - self.yaw) * 2, -1, 1);
    if (noseOut > 0.55 && speed > 7) out.ebrake = true;
  }

  /** Direction (into `dir`) away from whoever is inside `reach`, plus `pull` toward the middle. */
  private openSpace(self: AiCar, others: readonly AiCar[], reach: number, pull: number, dir: { x: number; z: number }): void {
    const r = Math.max(1, hypot2(self.x, self.z));
    let ox = (-self.x * pull) / r;
    let oz = (-self.z * pull) / r;
    for (let q = 0; q < others.length; q++) {
      const o = others[q]!;
      if (o.id === self.id) continue;
      const dx = o.x - self.x;
      const dz = o.z - self.z;
      const dd = hypot2(dx, dz);
      if (dd > reach || dd < 1e-3) continue;
      const w = (reach - dd) / reach / dd;
      ox -= dx * w;
      oz -= dz * w;
    }
    dir.x = ox;
    dir.z = oz;
  }

  private beginRecovery(self: AiCar, others: readonly AiCar[], p: Personality): void {
    const i = self.id;
    this.openSpace(self, others, 7, hypot2(self.x, self.z) > 6 ? 1 : 0.3, _aim);
    const err = wrapPi(Math.atan2(_aim.x, _aim.z) - self.yaw);
    // Either gear swings the nose the same way in this drive model.
    this.recoverSteer[i] = Math.abs(err) < 0.15 ? p.side : Math.sign(err);
    // Opposite of the gear that got us here — unless the last escape just ended
    // and we are wedged again: then that way is blocked too, try the other.
    const again = this.age[i]! - this.freedAt[i]! < 1.5;
    const prev = this.recoverThrottle[i]!;
    this.recoverThrottle[i] = again && prev !== 0 ? -prev : this.lastThrottle[i]! > 0 ? -0.95 : 0.95;
    this.recover[i] = 0.55 + p.patience * 0.5;
    this.freedAt[i] = this.age[i]! + this.recover[i]!;
    this.stuck[i] = 0;
  }
}

const _aim = { x: 0, z: 0 };

function findCar(cars: readonly AiCar[], id: number): AiCar | null {
  if (id < 0) return null;
  const fast = cars[id];
  if (fast && fast.id === id) return fast;
  for (let q = 0; q < cars.length; q++) if (cars[q]!.id === id) return cars[q]!;
  return null;
}

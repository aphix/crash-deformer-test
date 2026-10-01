import { DRIVE, idleDrive, type DriveInput } from "./car-drive.ts";
import { DERBY_RADIUS } from "./derby-arena.ts";
import { MAX_CARS } from "./fleet.ts";

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
};

export function blankAiCar(id: number): AiCar {
  return { id, x: 0, z: 0, yaw: 0, vx: 0, vz: 0, alive: true, damage: 0, front: 0, rear: 0 };
}

export type Personality = {
  /** 0 cautious … 1 brawler: head-on and dogpile tolerance. */
  aggression: number;
  /** 0 … 1: how early a crumpled nose turns the car around to back in. */
  reverse: number;
  /** Seconds of throttle without motion before backing out. */
  patience: number;
  /** Seconds a target is held before a merely-better one may replace it. */
  commit: number;
  /** Tie-break side for flanking and unsticking, so a field never mirrors itself. */
  side: number;
  /** Intercept lead multiplier. */
  lead: number;
  /** Throttle used once lined up. */
  cruise: number;
  /** Seconds braking and lining up at the horn; 0 = charges straight away. */
  hold: number;
};

function hash01(id: number, k: number): number {
  const x = Math.sin(id * 127.1 + k * 311.7 + 17.13) * 43758.5453;
  return x - Math.floor(x);
}

/** Same id → same driver, every match. */
export function personality(id: number): Personality {
  return {
    aggression: 0.2 + 0.8 * hash01(id, 1),
    reverse: hash01(id, 2),
    patience: 0.55 + 0.4 * hash01(id, 3),
    commit: 1 + 2 * hash01(id, 4),
    side: hash01(id, 5) < 0.5 ? -1 : 1,
    lead: 0.75 + 0.4 * hash01(id, 6),
    cruise: 0.82 + 0.18 * hash01(id, 7),
    hold: hash01(id, 9) < 0.45 ? 0 : 0.35 + 1.1 * hash01(id, 10),
  };
}

function wrapPi(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

function clamp1(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

function smooth(lo: number, hi: number, v: number): number {
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

/** Below this with throttle held, the car is pinned or wedged. */
export const STUCK_SPEED = 1;
/** Shoving the target this slowly counts (at 60 %) toward backing off for a run-up. */
const GRIND_SPEED = 2.5;
const GRIND_RANGE = 4.6;
const RESCORE = 0.14;
/** Contact range: closer than this counts as engaged, not orbiting. */
const ENGAGED = 3.8;
const MODE_FWD = 0;
const MODE_ARMOUR = 1;
const MODE_TACTICAL = 2;

/**
 * Layered derby driver (one per match, memory per car id):
 *  L0 unstick: throttle without motion (or a slow shove on the target) → back off toward open space, then re-engage
 *  L1 boards: bend onto the tangent before the wall, J-turn off it when nosed in
 *  L2 target: utility over reach time, exposed flank/rear, damage, attackers already on it,
 *     with commitment so picks don't flicker and an orbit breaker so pairs don't circle
 *  L3 strike: lead the target, T-bone its front quarter, swing wide of its nose unless clearly healthier,
 *     back in with the tail once our own nose is spent (or the target sits right behind us)
 */
export class DerbyBrain {
  readonly radius: number;
  private readonly out: DriveInput = idleDrive();
  private readonly traits: Personality[] = [];
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

  constructor(radius = DERBY_RADIUS) {
    this.radius = radius;
    for (let i = 0; i < MAX_CARS; i++) this.traits.push(personality(i));
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
    this.mode.fill(MODE_FWD);
    this.lastThrottle.fill(0);
    this.age.fill(0);
    this.freedAt.fill(-Infinity);
  }

  /** How many cars are currently hunting `id`. */
  huntersOf(id: number): number {
    return this.claims[id] ?? 0;
  }

  recovering(id: number): boolean {
    return (this.recover[id] ?? 0) > 0;
  }

  /**
   * One decision for `self`. The returned input is scratch owned by the brain —
   * apply it before the next call.
   */
  think(self: AiCar, others: readonly AiCar[], dt: number): DriveInput {
    const out = this.out;
    out.throttle = 0;
    out.steer = 0;
    out.brake = 0;
    out.ebrake = false;
    out.boost = false;
    const i = self.id;
    if (i < 0 || i >= MAX_CARS) return out;
    if (!self.alive) {
      this.setTarget(i, -1);
      this.lastThrottle[i] = 0;
      this.recover[i] = 0;
      return out;
    }
    const p = this.traits[i]!;
    const speed = Math.hypot(self.vx, self.vz);
    this.age[i]! += dt;

    // L0 — unstick.
    if (this.recover[i]! > 0) {
      this.recover[i]! -= dt;
      out.throttle = this.recoverThrottle[i]!;
      out.steer = this.recoverSteer[i]!;
      this.lastThrottle[i] = 0;
      if (this.recover[i]! <= 0) this.rescoreIn[i] = 0;
      return out;
    }
    // Wedged (no motion) or grinding a shove against the target: back off for a run-up.
    const prev = findCar(others, this.target[i]!);
    const near = prev != null && Math.hypot(prev.x - self.x, prev.z - self.z) < GRIND_RANGE;
    const pushing = Math.abs(this.lastThrottle[i]!) > 0.35;
    if (pushing && speed < STUCK_SPEED) this.stuck[i]! += dt;
    else if (pushing && near && speed < GRIND_SPEED) this.stuck[i]! += dt * 0.6;
    else this.stuck[i] = Math.max(0, this.stuck[i]! - dt * 2);
    if (this.stuck[i]! > p.patience) {
      this.beginRecovery(self, others, p);
      out.throttle = this.recoverThrottle[i]!;
      out.steer = this.recoverSteer[i]!;
      this.lastThrottle[i] = 0;
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
      tgt = this.pick(self, others, p, tgt);
      this.rescoreIn[i] = RESCORE + 0.1 * hash01(i, 8);
    }
    if (!tgt) {
      this.lastThrottle[i] = 0;
      return out;
    }

    const dx = tgt.x - self.x;
    const dz = tgt.z - self.z;
    const d = Math.hypot(dx, dz) || 1e-3;
    this.trackProgress(i, d, others, tgt, p, dt);

    // L3 — strike.
    const bearing = wrapPi(Math.atan2(dx, dz) - self.yaw);
    if (this.age[i]! < p.hold) {
      // At the horn some drivers stand on the brakes and line up; the field stops moving as one ring.
      out.brake = 1;
      out.steer = clamp1(bearing * 2);
      this.lastThrottle[i] = 0;
      return out;
    }
    this.chooseMode(self, p, bearing, d);
    if (this.mode[i] === MODE_FWD) this.attackForward(self, tgt, p, d, speed);
    else this.attackReverse(self, tgt, p, d);
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

  private cost(self: AiCar, o: AiCar, p: Personality, speed: number, curId: number): number {
    const i = self.id;
    const dx = o.x - self.x;
    const dz = o.z - self.z;
    const d = Math.hypot(dx, dz) || 1e-3;
    // Where we sit around the target: +1 at its nose, -1 behind it.
    const cosA = -(Math.sin(o.yaw) * dx + Math.cos(o.yaw) * dz) / d;
    const flank = 1 - Math.abs(cosA);
    const behind = Math.max(0, -cosA);
    const nose = Math.max(0, cosA);
    const rev = this.mode[i] !== MODE_FWD;
    const heading = rev ? self.yaw + Math.PI : self.yaw;
    const turn = Math.abs(wrapPi(Math.atan2(dx, dz) - heading));
    let c = (d / Math.max(speed, 7) + turn * 0.5) * 2.2;
    // A car running away at our speed is never caught; a parked one is a gift.
    const flee = (o.vx * dx + o.vz * dz) / d;
    if (flee > 0) c += flee * 0.15;
    if (rev) c -= nose * 0.8;
    else c += nose * (2.2 - 1.6 * p.aggression) - flank * 1.4 - behind * 0.6;
    const weak = o.damage;
    c -= weak * 2;
    const hunters = this.claims[o.id]! - (curId === o.id ? 1 : 0);
    c += hunters * (1.2 + 1.8 * (1 - p.aggression)) * (weak > 0.75 ? 0.4 : 1);
    if (o.id === curId) c -= 0.9;
    if (this.shunId[i] === o.id && this.shunFor[i]! > 0) c += 8;
    if (o.id >= 0 && o.id < MAX_CARS && this.target[o.id] === i && d < 12) c -= 0.6 * p.aggression;
    return c;
  }

  private pick(self: AiCar, others: readonly AiCar[], p: Personality, cur: AiCar | null): AiCar | null {
    const i = self.id;
    const curId = cur ? cur.id : -1;
    const speed = Math.hypot(self.vx, self.vz);
    let best: AiCar | null = null;
    let bestCost = Infinity;
    let curCost = Infinity;
    for (const o of others) {
      if (o.id === i || !o.alive) continue;
      const c = this.cost(self, o, p, speed, curId);
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
    for (const o of others) if (o.alive && o.id !== i && o.id !== tgt.id) alternatives++;
    if (alternatives > 0) {
      this.shunId[i] = tgt.id;
      this.shunFor[i] = 2.5;
      this.rescoreIn[i] = 0;
    }
    this.tighten[i] = 0.9;
    this.chase[i] = 0;
    this.closest[i] = d;
  }

  private chooseMode(self: AiCar, p: Personality, bearing: number, d: number): void {
    const i = self.id;
    const m = this.mode[i]!;
    // Armour: nose spent past this driver's comfort, tail still the better bumper.
    const margin = m === MODE_ARMOUR ? -0.1 : 0.1;
    if (self.front > 0.55 - 0.3 * p.reverse && self.rear + margin < self.front) {
      this.mode[i] = MODE_ARMOUR;
      return;
    }
    // Tactical: target sat right behind — back into it instead of a three-point turn.
    const ab = Math.abs(bearing);
    const behind = m === MODE_TACTICAL ? ab > 1.9 && d < 8 : ab > 2.35 && d < 6;
    this.mode[i] = p.reverse > 0.5 && self.rear < 0.6 && behind ? MODE_TACTICAL : MODE_FWD;
  }

  private intercept(self: AiCar, tgt: AiCar, p: Personality, ownSpeed: number, aim: { x: number; z: number }): void {
    let px = tgt.x;
    let pz = tgt.z;
    for (let k = 0; k < 2; k++) {
      const tau = Math.min(1.4, Math.hypot(px - self.x, pz - self.z) / ownSpeed) * p.lead;
      px = tgt.x + tgt.vx * tau;
      pz = tgt.z + tgt.vz * tau;
    }
    const lim = this.radius - 2.4;
    const r = Math.hypot(px, pz);
    if (r > lim) {
      px *= lim / r;
      pz *= lim / r;
    }
    aim.x = px;
    aim.z = pz;
  }

  private attackForward(self: AiCar, tgt: AiCar, p: Personality, d: number, speed: number): void {
    const out = this.out;
    this.intercept(self, tgt, p, Math.max(speed, DRIVE.maxFwd * p.cruise * 0.7), _aim);
    const ofx = Math.sin(tgt.yaw);
    const ofz = Math.cos(tgt.yaw);
    const rx = self.x - _aim.x;
    const rz = self.z - _aim.z;
    const rd = Math.hypot(rx, rz) || 1e-3;
    const cosA = (ofx * rx + ofz * rz) / rd;
    const lat = (ofz * rx - ofx * rz) / rd;
    const side = lat > 0.05 ? 1 : lat < -0.05 ? -1 : p.side;
    const headOnOk = self.front + 0.25 < tgt.front && p.aggression > 0.45;
    // Front quarter from the side: the engine bay, not the bumper.
    let ax = _aim.x + ofx * 0.8;
    let az = _aim.z + ofz * 0.8;
    if (!headOnOk) {
      // In its front cone: swing out to its flank instead of trading noses.
      const w = smooth(0.15, 0.5, cosA);
      if (w > 0) {
        const wx = _aim.x + ofz * side * 4.5 - ofx * 0.5;
        const wz = _aim.z - ofx * side * 4.5 - ofz * 0.5;
        ax += (wx - ax) * w;
        az += (wz - az) * w;
      }
    }
    const lim = this.radius - 4;
    const ar = Math.hypot(ax, az);
    if (ar > lim) {
      ax *= lim / ar;
      az *= lim / ar;
    }
    const err = wrapPi(Math.atan2(ax - self.x, az - self.z) - self.yaw);
    const ae = Math.abs(err);
    out.steer = clamp1(err * 2);
    out.throttle = ae < 0.3 ? p.cruise : ae < 0.8 ? 0.72 : ae < 1.5 ? 0.5 : 0.38;
    if (ae > 1 && speed > 9) out.ebrake = true;
    const striking = d < 5 && ae < 0.5;
    if (striking) {
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

  /** Tail first: what's left of our nose stays out of it. */
  private attackReverse(self: AiCar, tgt: AiCar, p: Personality, d: number): void {
    const out = this.out;
    this.intercept(self, tgt, p, DRIVE.maxRev * 0.85, _aim);
    const err = wrapPi(Math.atan2(_aim.x - self.x, _aim.z - self.z) - self.yaw - Math.PI);
    const ae = Math.abs(err);
    out.steer = clamp1(err * 1.8);
    out.throttle = ae < 0.45 ? -1 : ae < 1.2 ? -0.75 : -0.5;
    if (ae > 2.3 && d > 9) {
      // Nose toward a distant target: pivot forward to bring the tail round.
      out.throttle = 0.45;
      out.steer = Math.sign(err) || p.side;
    }
    const r = Math.hypot(self.x, self.z);
    if (r > this.radius - 3.6 && out.throttle < 0) {
      const tailOut = -(Math.sin(self.yaw) * self.x + Math.cos(self.yaw) * self.z) / r;
      if (tailOut > 0.4 && !(d < 5 && ae < 0.5)) {
        // Backing into the boards: pull forward and let the swing bring the tail round.
        out.throttle = 0.6;
        out.steer = Math.sign(err) || p.side;
      }
    }
  }

  /** Bend onto the tangent before the wall; J-turn off it when nosed in. */
  private boards(self: AiCar, p: Personality, speed: number): void {
    const out = this.out;
    const r = Math.hypot(self.x, self.z);
    if (r < this.radius - 6) return;
    const nx = self.x / r;
    const nz = self.z / r;
    const fx = Math.sin(self.yaw);
    const fz = Math.cos(self.yaw);
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
    if (Math.hypot(lx, lz) < this.radius - 2.9 || self.vx * nx + self.vz * nz < 0.5) return;
    let tx = -nz;
    let tz = nx;
    if (fx * tx + fz * tz < 0) {
      tx = -tx;
      tz = -tz;
    }
    const want = Math.atan2(tx - nx * 0.6, tz - nz * 0.6);
    out.steer = clamp1(wrapPi(want - self.yaw) * 2);
    if (noseOut > 0.55 && speed > 7) out.ebrake = true;
  }

  private beginRecovery(self: AiCar, others: readonly AiCar[], p: Personality): void {
    const i = self.id;
    const r = Math.hypot(self.x, self.z);
    // Open space: toward the middle, away from whoever is close.
    const centre = r > 6 ? 1 / r : 0.3 / Math.max(r, 1);
    let ox = -self.x * centre;
    let oz = -self.z * centre;
    for (const o of others) {
      if (o.id === i) continue;
      const dx = o.x - self.x;
      const dz = o.z - self.z;
      const dd = Math.hypot(dx, dz);
      if (dd > 7 || dd < 1e-3) continue;
      const w = (7 - dd) / 7 / dd;
      ox -= dx * w;
      oz -= dz * w;
    }
    const err = wrapPi(Math.atan2(ox, oz) - self.yaw);
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
  for (const c of cars) if (c.id === id) return c;
  return null;
}

import * as THREE from "three";
import type { DeformableCar } from "./car.ts";
import type { ExitPane } from "./car-core.ts";
import { CLASSES, killClass, killTravel } from "./vehicle-classes.ts";

/** Velocity samples per car, one per 1/60 s of sim time (`SAMPLE`): 0.53 s, past `PRE`. */
const RING = 32;
const SAMPLE = 1 / 60;
/** How far back (s) "before the hit" is: the block dies 25-40 ms into a frontal hit, a derby kill up to 0.3 s after its last contact. */
const PRE = 0.35;
/** A car whose centre is within this (m) of the impact point is the one that hit; none: a wall. */
const OTHER_REACH = 3.5;
/**
 * Closing speed (m/s) the disabling hit needs to throw the driver out: the peak, over the `PRE` s before the
 * drivetrain died, of how fast the striker (the nearest car to the impact point, or a wall at rest) came at this
 * car along the hit's inward normal. It tracks the contact code's own `impulse`.
 * Lane ragdoll's probe: every single-hit frontal kill closed at >= 15.6 (56 km/h wall; 2x56 head-on 31.1, 40 %
 * offset at 64 17.8). The 20 derby kills over five six-car heats were 16 tail, 4 side, 0 front; the side ones
 * peaked at 9.8, 7.9, 6.8 and 1.9 m/s here (`impulse` 7.2-10.6). 6 m/s (22 km/h) throws on every frontal kill
 * and a solid side blow, not on a car shoved into its last bit of wear.
 */
const EJECT_CLOSING = 6;

/**
 * Barrier speed (m/s) of the slowest square hit that throws the driver of a durability-1 car (a sedan): it packs the
 * block to `killTravel` at realism 1, whatever the HUD's realism. Measured into the range's barrier at the HUD's
 * defaults: lane ragdoll's probe 56 km/h, lane ragdoll-glass (1 km/h steps) 55 km/h (15.3 m/s). A class's is this ×
 * √durability (`killSpeed`): measured 58 km/h muscle, 60 truck and police, 68 monster against the root's 60, 63, 64
 * and 73, so it errs 2-5 km/h high for the tough ones.
 */
const KILL_EBS = 15.6;

/**
 * The barrier speed (m/s) at which a square hit throws `car`'s driver (`KILL_EBS` × √ its kill class's durability): the
 * sandbox's slow-mo predicts a throw by it (`throwComing`), and a car that slams a door into a hit at least this fast
 * of its own throws its driver out of that door (`EjectionWatch`), as hard a blow to him as the nose-first kill.
 */
export function killSpeed(car: DeformableCar): number {
  return KILL_EBS * Math.sqrt(CLASSES[killClass(car)].durability);
}

/**
 * A hit is square on a door, for the slam throw, when its inward normal's across-the-car part is over this × its
 * along-the-car part: within 27 degrees of straight in from the side (owner, 2026-10-07: the case is a car sliding in
 * sideways). A front- or rear-quarter hit stays a frontal one's (a kill): with the side window at 45 degrees, police
 * cruisers driving into race walls 13-45 degrees off at 9-42 m/s threw 12 drivers out of a door in 10 seeded oval and
 * stunt races (main: none).
 */
const DOOR_SQUARE = 2;

/** The throw: out of the pane, up, and a somersault over his shoulder line (owner, 2026-10-02: arcade, set by eye). */
export const THROW_OUT = 3;
const THROW_UP = 3.5;
const TUMBLE = 3;
/** Head centre above the torso's, once he leans out (m): the dummy's `PARTS` head 0.52 m over the torso. */
const HEAD_UP = 0.52;
/** Head first out of the pane, superman style: 80 degrees from upright toward the exit, chest down. */
const LEAN = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (80 * Math.PI) / 180);
const Y = new THREE.Vector3(0, 1, 0);

/**
 * A driver thrown out of a car: where and how, enough to launch the same dummy again (the live ragdoll, a highlight
 * replay, a netplay peer). Every number is f32-exact (`Math.fround`), so the copy that crossed the wire or sat in a
 * saved clip is the one the host launched. When it happened is its holder's stamp (a clip's step, a message's clock).
 */
export type Ejection = {
  /** Car slot (index into the live cars). */
  car: number;
  exit: ExitPane;
  /** A police driver (his uniform). */
  cop: boolean;
  /** The torso's centre as he leaves, in the world and in the car's frame. */
  pos: THREE.Vector3;
  local: THREE.Vector3;
  /** Unit vector out of the pane, in the world. */
  dir: THREE.Vector3;
  /** The torso's orientation, leaning out head first. */
  quat: THREE.Quaternion;
  /** His velocity relative to the car (world axes, m/s), and the car's own that step: his own is their sum. */
  rel: THREE.Vector3;
  carVel: THREE.Vector3;
  /** The somersault (world rad/s). */
  spin: THREE.Vector3;
};

/** A fresh event record (decoders fill it). */
export function blankEjection(): Ejection {
  return {
    car: 0,
    exit: "windshield",
    cop: false,
    pos: new THREE.Vector3(),
    local: new THREE.Vector3(),
    dir: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    rel: new THREE.Vector3(),
    carVel: new THREE.Vector3(),
    spin: new THREE.Vector3(),
  };
}

/** The dummy's launch velocity (world, m/s) from an event: the car's plus his own. */
export function ejectionVelocity(e: Ejection, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(e.carVel).add(e.rel);
}

const _qx = new THREE.Quaternion();
const _inv = new THREE.Quaternion();
const _out = new THREE.Vector3();
const _p = new THREE.Vector3();
const _up = new THREE.Vector3();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _hit = new THREE.Vector3();
const _pre = new THREE.Vector3();
const NONE: readonly Ejection[] = [];

const f32 = (v: THREE.Vector3): THREE.Vector3 => v.set(Math.fround(v.x), Math.fround(v.y), Math.fround(v.z));

/** Car `i`'s driver leaving through `exit` at world velocity `pre` (the car's, before the hit), as the sim has the car now. */
function launch(car: DeformableCar, i: number, exit: ExitPane, pre: THREE.Vector3): Ejection {
  const e = blankEjection();
  const g = car.group;
  e.car = i;
  e.exit = exit;
  e.cop = car.style.id === "police";
  // The way out: z out of the pane (a side throw is the windshield's turned a quarter about the car's up). Leaning
  // out along it, his shoulders stay level, so they fit the side window's height.
  const side = exit === "windshield" ? 0 : exit === "doorL" ? -1 : 1;
  _qx.setFromAxisAngle(Y, (side * Math.PI) / 2).multiply(LEAN);
  e.quat.copy(g.quaternion).multiply(_qx);
  e.quat.set(Math.fround(e.quat.x), Math.fround(e.quat.y), Math.fround(e.quat.z), Math.fround(e.quat.w));
  _out.set(side, 0, side === 0 ? 1 : 0).applyQuaternion(g.quaternion);
  e.dir.copy(_out);
  f32(e.dir);
  // Car-local: on the pane's height (a windshield's on the driver's side, -x), the torso down the lean behind it,
  // so he leaves through the opening, clear of the bonnet or door below and the roof above.
  car.glassWorld(exit, _p).sub(g.position).applyQuaternion(_inv.copy(g.quaternion).invert());
  const paneY = _p.y;
  if (side === 0) _p.x -= 0.25;
  _p.addScaledVector(_up.set(0, 1, 0).applyQuaternion(_qx), -HEAD_UP);
  _p.y = paneY;
  e.local.copy(_p);
  f32(e.local);
  e.pos.copy(_p).applyQuaternion(g.quaternion).add(g.position);
  f32(e.pos);
  // Tumble: a somersault over his shoulder line (the car's x axis out of the windshield, its z axis out of a side).
  e.spin.set(side === 0 ? 1 : 0, 0, side === 0 ? 0 : -side).applyQuaternion(g.quaternion).multiplyScalar(TUMBLE);
  f32(e.spin);
  f32(e.carVel.copy(car.velocity));
  _v.set(pre.x + _out.x * THROW_OUT, THROW_UP, pre.z + _out.z * THROW_OUT);
  f32(e.rel.copy(_v).sub(e.carVel));
  return e;
}

/**
 * Watches every car for a hit that throws its driver out. A disabling hit (the drivetrain dying, `drivetrainAlive`:
 * derby engine-kill and wreck, race DNF by damage; or the block packed as far as kills it at the realistic end of the
 * slider, whatever the slider) throws him when it closed fast enough (`EJECT_CLOSING`), head-on or from the side, never
 * from behind. A hit square on a door (`DOOR_SQUARE`) that the car slammed into at its `killSpeed` or faster throws him
 * out of that door's window though the car runs on (owner, 2026-10-07: a handbrake slide sideways into a wall): a side
 * blow never packs the block (the range at 23-25 m/s, 66-83 degrees off: 0.02-0.16 m), so no kill would ever throw
 * him. Slammed: both its own speed into the hit and the closing are that fast, so a car shunted from standstill (a
 * T-bone's struck car) stays in, and so does one trading doors at speed with a car alongside going its way. The
 * decision is SIM state: `step` runs once per fixed step, at the end of `stepWorld`, on the step's own dt, and reads
 * only the cars' deform state, poses and velocities, so the same steps give the same ejections on every run at every
 * frame rate. A hit that throws sets `car.driverOut` (until the car is put back: `resetVisual`) and queues an
 * `Ejection` for `take`. Clients never run it: the flag rides the snapshot, the event its own message. Either way the
 * hit is a fresh one on that car, begun (`beginCrush`, a re-armed `rearmHit`) at most `PRE` s ago: a drivetrain that
 * dies with no new hit, long after the one whose normal is still in its deform state, is a damaged car on a crest or a
 * bank, not a throw, and so is a graze that only touched it.
 */
export class EjectionWatch {
  /** Kill context (`armKill`'s): a derby's limits or anywhere else's; the engine sets it per scene. */
  ctx: "derby" | "default" = "default";
  private cap = 0;
  private vel = new Float32Array(0);
  private head = new Int32Array(0);
  private count = new Int32Array(0);
  /** -1 unseen, 0 disabled, 1 intact. */
  private alive = new Int8Array(0);
  private acc = 0;
  private pending: Ejection[] = [];

  private grow(n: number): void {
    this.cap = n;
    this.vel = new Float32Array(n * RING * 2);
    this.head = new Int32Array(n);
    this.count = new Int32Array(n);
    this.alive = new Int8Array(n).fill(-1);
  }

  /** A new run (a race start, a scene reset): no history, no pending events. */
  reset(): void {
    this.head.fill(0);
    this.count.fill(0);
    this.alive.fill(-1);
    this.acc = 0;
    this.pending = [];
  }

  /** The events since the last call, oldest first (a shared empty array when there are none). */
  take(): readonly Ejection[] {
    if (this.pending.length === 0) return NONE;
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /** One fixed step of `dt` sim seconds, after the world moved the cars. */
  step(cars: readonly DeformableCar[], dt: number): void {
    const n = cars.length;
    if (n > this.cap) this.grow(n);
    this.acc += dt;
    const sample = this.acc >= SAMPLE;
    if (sample) this.acc %= SAMPLE;
    for (let i = 0; i < n; i++) {
      const car = cars[i]!;
      if (car.falling || car.vaporized) continue;
      // Disabled, or the block packed past the context's kill travel at the realistic end (the sourced 0.15 m x
      // durability, x the derby scale in one). At the HUD's default realism (0.25) a fleet sedan dies only at 0.45 m
      // and one head-on tops out at 0.36 m from 2x24 m/s up: without this no race or sandbox car is ever disabled by one hit.
      const now = car.deform.drivetrainAlive && car.deform.engineTravel < killTravel(killClass(car), 1, this.ctx) ? 1 : 0;
      const was = this.alive[i]!;
      this.alive[i] = now;
      if (car.driverOut !== null || car.deform.sinceHit() > PRE + dt) continue;
      if (was === 1 && now === 0) this.judge(cars, i, true);
      else if (now === 1 && car.deform.massActive && Math.abs(car.deform.impactInward.x) > DOOR_SQUARE * Math.abs(car.deform.impactInward.z)) this.judge(cars, i, false);
    }
    if (!sample) return;
    for (let i = 0; i < n; i++) {
      const o = (i * RING + this.head[i]!) * 2;
      this.vel[o] = cars[i]!.velocity.x;
      this.vel[o + 1] = cars[i]!.velocity.z;
      this.head[i] = (this.head[i]! + 1) % RING;
      this.count[i] = Math.min(RING, this.count[i]! + 1);
    }
  }

  /**
   * Car i was just disabled (`killed`), or runs on in a fresh hit on a door: was that hit head-on or from the side, and
   * hard enough? A kill against the closing speed, a door slam against the lesser of the car's own speed into it and
   * the closing (`killSpeed`).
   */
  private judge(cars: readonly DeformableCar[], i: number, killed: boolean): void {
    const car = cars[i]!;
    // The struck end: inward points from the contact into the car.
    const ix = car.deform.impactInward.x;
    const iz = car.deform.impactInward.z;
    let exit: ExitPane;
    if (Math.abs(ix) > Math.abs(iz)) exit = ix > 0 ? "doorL" : "doorR";
    else if (iz < 0) exit = "windshield";
    else return;
    _n.copy(car.deform.impactInward).applyQuaternion(car.group.quaternion);
    let other = -1;
    _hit.copy(car.deform.impactLocal).applyQuaternion(car.group.quaternion).add(car.group.position);
    let best = OTHER_REACH;
    for (let j = 0; j < cars.length; j++) {
      if (j === i) continue;
      const d = cars[j]!.group.position.distanceTo(_hit);
      if (d < best) {
        best = d;
        other = j;
      }
    }
    // Peak over the samples since PRE s back: the cars were still closing (or speeding up into it) until contact.
    const back = Math.min(this.count[i]!, other >= 0 ? this.count[other]! : RING, Math.round(PRE / SAMPLE));
    let closing = -Infinity;
    let sx = car.velocity.x;
    let sz = car.velocity.z;
    for (let k = 1; k <= back; k++) {
      const a = (i * RING + ((this.head[i]! - k + RING) % RING)) * 2;
      let c = -(this.vel[a]! * _n.x + this.vel[a + 1]! * _n.z);
      if (other >= 0) {
        const b = (other * RING + ((this.head[other]! - k + RING) % RING)) * 2;
        const close = c + this.vel[b]! * _n.x + this.vel[b + 1]! * _n.z;
        c = killed ? close : Math.min(c, close);
      }
      if (c <= closing) continue;
      closing = c;
      sx = this.vel[a]!;
      sz = this.vel[a + 1]!;
    }
    if (closing < (killed ? EJECT_CLOSING : killSpeed(car))) return;
    car.driverOut = exit;
    this.pending.push(launch(car, i, exit, _pre.set(sx, 0, sz)));
  }
}

import * as THREE from "three";
import type { DeformableCar } from "./car.ts";
import { bodyContact, makeBox, partContact } from "./external-contact.ts";

/**
 * The door/mirror knock scenes of `docs/door-mirror-sketch.png`, on a car parked at the origin
 * facing +Z (yaw 0, at rest):
 * - `mirror` (A): the door is shut; a ram runs rear→front past the side with a small gap to the
 *   skin and catches only the mirror.
 * - `overOpen` (B): the door is open; the ram runs rear→front into it and drives it past the stop.
 * - `shut` (C): the door is open; the ram runs front→rear into it and drives it shut.
 * The ram is kinematic apart from the momentum it trades with the car; it is a striker box in the
 * shared contact (`external-contact.ts`): the door and mirror colliders a car running down the
 * side meets too, and the body contact if a lane reaches the skin (the stock lanes do not).
 */
export const DOOR_SCENARIOS = ["mirror", "overOpen", "shut"] as const;
export type DoorScenario = (typeof DOOR_SCENARIOS)[number];

export type RamLane = {
  /** Travel along the car: +1 rear→front, −1 front→rear. */
  dir: 1 | -1;
  /** |x| of the face's inner edge (m); the door skin ends at ~0.91. */
  inner: number;
  /** Face width outward from `inner` (m). */
  width: number;
  /** Face bottom and top (m above the ground). */
  bottom: number;
  top: number;
  /** Door angle when the shot starts (rad); 0 is shut and latched. */
  open: number;
};

export const DOOR_LANES: Readonly<Record<DoorScenario, RamLane>> = {
  // 4 cm of air to the shut door, 3 cm outside the mirror base: only the mirror is in the lane.
  mirror: { dir: 1, inner: 0.95, width: 0.4, bottom: 0.5, top: 1.1, open: 0 },
  // Below the mirror (0.82–0.91 m) so only the door slab is in the lane.
  overOpen: { dir: 1, inner: 0.95, width: 0.6, bottom: 0.3, top: 0.75, open: (55 * Math.PI) / 180 },
  // Outside the mirror head on the open door, so the ram meets the slab first.
  shut: { dir: -1, inner: 1.1, width: 0.6, bottom: 0.3, top: 0.75, open: (55 * Math.PI) / 180 },
};

export const RAM_DEFAULTS = { kph: 12, kg: 300 } as const;

export const RAM = {
  /** Head length along its travel (m). */
  length: 0.5,
  /** The face starts this far behind the car's centre along its travel (m)... */
  start: 2.8,
  /** ...and the run ends once it is this far past it. */
  end: 3.4,
  /** Contact substep (s): 8 mm per step at 60 km/h. */
  substep: 0.0005,
  /** Hold after the ram stops or runs past, so a swinging door can latch or reach its stop (s). */
  settle: 1.5,
} as const;

export type RamPhase = "idle" | "run" | "settle";

export type RamShot = {
  /** Parts off the car; a mirror riding its torn door counts. */
  detached: string[];
  /** Struck door's angle at the end (deg). */
  doorDeg: number;
  latched: boolean;
  mirrorFoldDeg: number;
  /** Energy the struck door's hinges took at the stop (J). */
  hingeLoadJ: number;
  /** The ram was stopped by the car rather than running past. */
  ramStopped: boolean;
  /** Largest control-particle and skinned body-vertex move since the shot began (mm). */
  bodyParticleMm: number;
  bodyVertexMm: number;
};

const D2R = Math.PI / 180;
const _c = new THREE.Vector3();

/** DOM-free door rig: the engine's doors scene and the tests run the same `step`. */
export class DoorRig {
  car: DeformableCar | null = null;
  scenario: DoorScenario = "mirror";
  /** −1 left door, +1 right. */
  side: -1 | 1 = 1;
  kph: number = RAM_DEFAULTS.kph;
  kg: number = RAM_DEFAULTS.kg;
  phase: RamPhase = "idle";
  /** Head length along the travel (m). */
  length: number = RAM.length;
  /** Leading face along car z (m). */
  face = -RAM.start;
  /** Speed along the travel (m/s). */
  u = 0;
  /** First touch since `fire` (FX hook; cleared by the caller). */
  touched = false;
  stopped = false;
  private settled = 0;
  private particles0 = new Float64Array(0);
  private verts0 = new Float32Array(0);
  private readonly box = makeBox();

  /** A head of another shape on the scenario's lane (a car-shaped striker for docs/CONTACT_PARITY.md). */
  shape: Partial<Pick<RamLane, "bottom" | "top" | "width">> | null = null;

  get lane(): RamLane {
    const lane = DOOR_LANES[this.scenario];
    return this.shape ? { ...lane, ...this.shape } : lane;
  }

  attach(car: DeformableCar): void {
    this.car = car;
    this.phase = "idle";
    this.u = 0;
    this.face = -this.lane.dir * RAM.start;
    this.particles0 = new Float64Array(car.deform.masses.length * 3);
    this.verts0 = new Float32Array((car.body.geometry.getAttribute("position") as THREE.BufferAttribute).array.length);
  }

  /** Set the door for the scenario and launch the ram. Speed in km/h, mass in kg. */
  fire(scenario: DoorScenario, side: -1 | 1, kph = this.kph, kg = this.kg): void {
    const car = this.car;
    if (!car) return;
    this.scenario = scenario;
    this.side = side;
    this.kph = THREE.MathUtils.clamp(kph, 1, 120);
    this.kg = THREE.MathUtils.clamp(kg, 5, 5000);
    car.setDoorOpen(side, this.lane.open);
    const masses = car.deform.masses;
    for (let i = 0; i < masses.length; i++) masses[i]!.local.toArray(this.particles0, i * 3);
    this.verts0.set((car.body.geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array);
    this.face = -this.lane.dir * RAM.start;
    this.u = this.kph / 3.6;
    this.phase = "run";
    this.touched = false;
    this.stopped = false;
    this.settled = 0;
  }

  /** Ram travel, mirror and door contact, and the hinge swing, in `RAM.substep` slices. */
  step(dt: number): void {
    const car = this.car;
    if (!car) return;
    const n = Math.max(1, Math.ceil(dt / RAM.substep));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      if (this.phase === "run") {
        this.face += this.lane.dir * this.u * h;
        this.hit(car, h);
        if (this.u <= 0.01) {
          this.u = 0;
          this.stopped = true;
          this.phase = "settle";
        } else if (this.lane.dir * this.face - this.length > RAM.end - RAM.length) {
          this.phase = "settle";
        }
      } else if (this.phase === "settle") {
        this.settled += h;
        if (this.settled > RAM.settle) this.phase = "idle";
      }
      car.swingDoors(h);
    }
    // A dented body runs the same structure step as every other crash.
    if (car.deform.massActive) {
      car.deform.stepStructure(dt);
      car.syncPose(dt);
    }
  }

  /** Ram centre (car space) for the visuals. */
  centre(out: THREE.Vector3): THREE.Vector3 {
    const lane = this.lane;
    return out.set(
      this.side * (lane.inner + lane.width * 0.5),
      (lane.bottom + lane.top) * 0.5,
      this.face - lane.dir * this.length * 0.5,
    );
  }

  result(): RamShot {
    const car = this.car!;
    const detached: string[] = [];
    for (const p of car.snapshot().parts as { name: string; detached: boolean }[]) if (p.detached) detached.push(p.name);
    for (const name of ["mirrorL", "mirrorR"] as const) if (!detached.includes(name) && car.partOff(name)) detached.push(name);
    const door = car.doorHinge(this.side);
    let particle = 0;
    const masses = car.deform.masses;
    for (let i = 0; i < masses.length; i++) {
      const m = masses[i]!.local;
      const o = this.particles0;
      particle = Math.max(particle, Math.hypot(m.x - o[i * 3]!, m.y - o[i * 3 + 1]!, m.z - o[i * 3 + 2]!));
    }
    let vertex = 0;
    const now = (car.body.geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
    for (let i = 0; i < now.length; i += 3) {
      const v0 = this.verts0;
      vertex = Math.max(vertex, Math.hypot(now[i]! - v0[i]!, now[i + 1]! - v0[i + 1]!, now[i + 2]! - v0[i + 2]!));
    }
    return {
      detached,
      doorDeg: door.theta / D2R,
      latched: door.latched,
      mirrorFoldDeg: Math.abs(door.mirrorFold) / D2R,
      hingeLoadJ: door.load,
      ramStopped: this.stopped,
      bodyParticleMm: particle * 1000,
      bodyVertexMm: vertex * 1000,
    };
  }

  /**
   * The ram as a striker box riding the car's frame (its kinematic travel plus the speed it
   * keeps), through the same door, mirror and body contact every scene uses.
   */
  private hit(car: DeformableCar, h: number): void {
    const lane = this.lane;
    const box = this.box;
    this.centre(_c);
    const p = car.group.position;
    const r = car.rightFlat;
    const f = car.fwdFlat;
    box.x = p.x + r.x * _c.x + f.x * _c.z;
    box.y = p.y + _c.y;
    box.z = p.z + r.z * _c.x + f.z * _c.z;
    box.hx = lane.width * 0.5;
    box.hy = (lane.top - lane.bottom) * 0.5;
    box.hz = this.length * 0.5;
    box.yaw = Math.atan2(f.x, f.z) + (lane.dir > 0 ? 0 : Math.PI);
    box.vx = car.velocity.x + f.x * lane.dir * this.u;
    box.vz = car.velocity.z + f.z * lane.dir * this.u;
    box.kg = this.kg;
    box.hardness = 1;
    const hit = partContact(car, box);
    if (hit.touched) this.touched = true;
    this.u = Math.max(0, this.u - hit.du);
    // A lane that reaches the skin dents it through the same body contact the other rigs use.
    const taken = bodyContact(car, box, h, true);
    if (taken > 0) this.touched = true;
    this.u = Math.max(0, this.u - taken / this.kg);
  }
}

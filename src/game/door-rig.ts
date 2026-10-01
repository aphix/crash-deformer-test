import * as THREE from "three";
import { DOOR, DOOR_INERTIA, DOOR_OPEN_MAX, HINGE_TEAR_J, MIRROR_BREAK_J, MIRROR_FOLD_MAX, type DeformableCar } from "./car.ts";

/**
 * The door/mirror knock scenes of `docs/door-mirror-sketch.png`, on a car parked at the origin
 * facing +Z (yaw 0, at rest):
 * - `mirror` (A): the door is shut; a ram runs rear→front past the side with a small gap to the
 *   skin and catches only the mirror.
 * - `overOpen` (B): the door is open; the ram runs rear→front into it and drives it past the stop.
 * - `shut` (C): the door is open; the ram runs front→rear into it and drives it shut.
 * The ram is kinematic apart from the momentum it trades with the door and the mirror, and it
 * only ever touches the door and mirror colliders: it never meets the body particles or hulls.
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
  /** Ram ↔ door restitution. */
  restitution: 0.2,
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
const _push = new THREE.Vector3();

/**
 * How far along the run the mirror cap's trailing face has swung at fold `phi` (m, from the
 * base): the face pins the cap where the lane's inner edge crosses it (`gap` out from the base),
 * never inboard of the cap itself (0.11 m).
 */
function mirrorSweep(phi: number, gap: number): number {
  const r = Math.max(gap / Math.cos(phi), 0.11);
  return r * Math.sin(phi) - DOOR.mirrorHalfDepth * Math.cos(phi);
}

/** DOM-free door rig: the engine's doors scene and the tests run the same `step`. */
export class DoorRig {
  car: DeformableCar | null = null;
  scenario: DoorScenario = "mirror";
  /** −1 left door, +1 right. */
  side: -1 | 1 = 1;
  kph: number = RAM_DEFAULTS.kph;
  kg: number = RAM_DEFAULTS.kg;
  phase: RamPhase = "idle";
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

  get lane(): RamLane {
    return DOOR_LANES[this.scenario];
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
        this.hitMirror(car);
        this.hitDoor(car);
        if (this.u <= 0.01) {
          this.u = 0;
          this.stopped = true;
          this.phase = "settle";
        } else if (this.lane.dir * this.face > RAM.end) {
          this.phase = "settle";
        }
      } else if (this.phase === "settle") {
        this.settled += h;
        if (this.settled > RAM.settle) this.phase = "idle";
      }
      car.swingDoors(h);
    }
  }

  /** Ram centre (car space) for the visuals. */
  centre(out: THREE.Vector3): THREE.Vector3 {
    const lane = this.lane;
    return out.set(
      this.side * (lane.inner + lane.width * 0.5),
      (lane.bottom + lane.top) * 0.5,
      this.face - lane.dir * RAM.length * 0.5,
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
   * Mirror on a shut door: the face pins the cap's trailing face and folds it about its base;
   * at `MIRROR_FOLD_MAX` the stop either stops the ram or, past `MIRROR_BREAK_J`, snaps off.
   * ponytail: shut doors only; an open door's mirror sits above the B/C lanes.
   */
  private hitMirror(car: DeformableCar): void {
    const lane = this.lane;
    const side = this.side;
    if (car.partOff(side < 0 ? "mirrorL" : "mirrorR")) return;
    const door = car.doorHinge(side);
    if (door.theta > 1e-4) return;
    const y = DOOR.hingeY + DOOR.mirrorY;
    if (lane.bottom > y + 0.05 || lane.top < y - 0.04) return;
    const gap = lane.inner - (DOOR.hingeX + DOOR.mirrorX);
    const s = lane.dir;
    // Face travel past the base along the run, against how far the cap's trailing face has swung.
    const reach = s * (this.face - DOOR.hingeZ);
    const fold = Math.abs(door.mirrorFold);
    if (reach <= mirrorSweep(fold, gap) || gap / Math.cos(fold) > DOOR.mirrorReach) return;
    this.touched = true;
    if (reach <= mirrorSweep(MIRROR_FOLD_MAX, gap)) {
      let lo = fold;
      let hi = MIRROR_FOLD_MAX;
      for (let k = 0; k < 16; k++) {
        const mid = (lo + hi) * 0.5;
        if (mirrorSweep(mid, gap) < reach) lo = mid;
        else hi = mid;
      }
      car.setMirrorFold(side, -side * s * hi);
      return;
    }
    // Folded flat and still in the lane: the stop takes the ram.
    const energy = 0.5 * this.kg * this.u * this.u;
    if (energy < MIRROR_BREAK_J) {
      car.setMirrorFold(side, -side * s * MIRROR_FOLD_MAX);
      this.u = 0;
      return;
    }
    this.u = Math.sqrt(this.u * this.u - (2 * MIRROR_BREAK_J) / this.kg);
    car.breakMirror(side, _push.set(side * 0.8, 0.6, s * this.u));
  }

  /**
   * Door slab (top view: hinge → trailing edge) against the face. Free door: one restitution
   * impulse through the door's effective mass I/k² at the contact (k = lever across the travel).
   * Door on its stop and pushed open: the car is rigid, so the strap takes the ram's closing energy.
   */
  private hitDoor(car: DeformableCar): void {
    const lane = this.lane;
    const side = this.side;
    if (car.partOff(side < 0 ? "doorL" : "doorR")) return;
    if (lane.bottom > DOOR.hingeY + DOOR.halfHeight || lane.top < DOOR.hingeY - DOOR.halfHeight) return;
    const door = car.doorHinge(side);
    const sin = Math.sin(door.theta);
    if (sin < 1e-3) return;
    const cos = Math.cos(door.theta);
    const rLo = (lane.inner - DOOR.hingeX) / sin;
    const rHi = Math.min(DOOR.length, (lane.inner + lane.width - DOOR.hingeX) / sin);
    if (rLo > rHi || rHi <= 0) return;
    const s = lane.dir;
    // A rear→front face meets the trailing (lowest-z) end of the slab in the lane first.
    const r = s > 0 ? rHi : Math.max(rLo, 0);
    const depth = s * (this.face - (DOOR.hingeZ - r * cos));
    if (depth <= 0 || depth > RAM.length) return;
    this.touched = true;
    const k = Math.max(r * sin, 0.02);
    const closing = this.u - s * k * door.omega;
    if (s > 0 && door.theta >= DOOR_OPEN_MAX - 1e-4) {
      if (closing <= 0) return;
      const before = door.load;
      const energy = 0.5 * this.kg * closing * closing;
      // What the ram still carries after paying for the tear.
      const left = Math.sqrt(Math.max(0, this.u * this.u - (2 * Math.max(0, HINGE_TEAR_J - before)) / this.kg));
      if (car.loadDoorStop(side, energy, _push.set(side * 0.9, 0.8, s * Math.max(left, 1)))) this.u = left;
      else {
        this.u = 0;
        door.omega = 0;
      }
      return;
    }
    if (closing > 0) {
      const mEff = DOOR_INERTIA / (k * k);
      const j = ((1 + RAM.restitution) * closing) / (1 / this.kg + 1 / mEff);
      this.u -= j / this.kg;
      door.omega += (s * j * k) / DOOR_INERTIA;
    }
    // Push the slab out of the face.
    door.theta = THREE.MathUtils.clamp(door.theta + (s * depth) / k, 0, DOOR_OPEN_MAX);
  }
}

/** Fire one shot on a parked car and run it out at 60 Hz the way the engine does. */
export function fireRam(
  car: DeformableCar,
  scenario: DoorScenario,
  opts: { kph: number; kg: number; side?: -1 | 1 },
): RamShot {
  const rig = new DoorRig();
  rig.attach(car);
  rig.fire(scenario, opts.side ?? 1, opts.kph, opts.kg);
  const dt = 1 / 60;
  for (let t = 0; t < 30 && rig.phase !== "idle"; t += dt) {
    car.integrate(dt);
    rig.step(dt);
    car.updateDeform(dt);
  }
  return rig.result();
}

import * as THREE from "three";
import { hypot2 } from "../kernel/physics-core.js";
import { NO_TARGET, SHOT_RING, type LawnGuard } from "../scenes/lawn-guard.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import type { Ground } from "../world/ground.ts";
import { insidePolygon } from "../world/terrain.ts";
import type { GuardSpec } from "../world/track-schema.ts";
import { HAIRS, type DriverLook } from "./driver-look.ts";
import { JOINTS, PARTS, SHOULDER_Y } from "./ragdoll-body.ts";
import { DummyMesh } from "./ragdoll-mesh.ts";

/** The limbs' joints standing (m, feet at y = 0), off `JOINTS`: shoulders, elbows, hips, knees, each side. */
const SHOULDER = JOINTS[1]!;
const ELBOW = JOINTS[2]!;
const HIP = JOINTS[5]!;
const KNEE = JOINTS[6]!;
/** Body parts (`PARTS`) by limb: upper and lower arm, thigh and shin, for the figure's right side (-x) and left (+x). */
const ARM_UPPER = [2, 4] as const;
const ARM_LOWER = [3, 5] as const;
const THIGH = [6, 8] as const;
const SHIN = [7, 9] as const;
/** The side the gun is held on (index into the limb tables): his right hand. */
const GUN_SIDE = 0;
/** A handgun (m): across, along the arm, and how far its muzzle stands past the hand. */
const GUN = { w: 0.05, len: 0.22, depth: 0.1, muzzle: 0.14 };
/** How long (s) a muzzle flash and a shot's tracer show (a frame or three at 60 Hz); the most tracers in the air at once. */
const FLASH_S = 0.05;
const TRACER_S = 0.07;
const TRACERS = 24;
/** A muzzle flash's radius (m) and its colour; a tracer's colour (sRGB). */
const FLASH_R = 0.14;
const FLASH_RGB = 0xfff1b8;
const TRACER_RGB = 0xffcf6a;
/** Arm and leg swing (rad) at a walk's widest, and the knee's bend on the leg swinging through (guessed, by eye). */
const LEG_SWING = 0.5;
const ARM_SWING = 0.4;
const KNEE_BEND = 0.6;
/** Seated: the thighs level forward, the shins hanging, the forearms forward over the lap (rad). */
const SIT = { thigh: -Math.PI / 2, knee: Math.PI / 2, arm: -0.35, elbow: -0.9 };
/** Aiming: the gun arm straight out level, the other hand up under it (rad). */
const AIM = { arm: -Math.PI / 2, elbow: 0, support: -1.2, supportElbow: -0.5 };

/** The guards: their run out and back (m/s, guessed: a sprint in kit) and the metres a whole stride covers at it. */
const GUARD_RUN = 4.5;
const GUARD_STRIDE = 1.8;
/** Their places off a door: the first rank this far out (m), the next ranks `RANK_GAP` further, `FILE_GAP` apart across a rank. */
const LINE_OUT = 7;
const RANK_GAP = 4;
const FILE_GAP = 4.5;
/** Seconds between one guard coming out of a door and the next; how far (m) inside the door he appears, under the portico. */
const STAGGER_S = 0.18;
const PORTICO_DEPTH = 3;
/** A guard this close (m) to where he is going is there. */
const ARRIVE = 0.3;
/** A plain-clothes agent: a black suit, dark hair (the other half of the squad wears the uniformed division's navy, `cop`). */
const AGENT: DriverLook = { woman: false, shirt: 0x16181d, pants: 0x16181d, hair: HAIRS[2]!, hat: null, mustache: false };
/** A shot's aim (m over the car's origin), how far (m) a miss goes past it, and the sparks a hit throws (`RaceHost.hitFx`'s impulse). */
const AIM_Y = 0.7;
const MISS_WIDE = 2.5;
const HIT_SPARKS = 4;

/** The VIP: portly, in a navy-blue suit with a red tie, his golden-blond hair swept back. */
const VIP_LOOK: DriverLook = { woman: false, shirt: 0x1f3463, pants: 0x1f3463, hair: 0xe8bf6c, hat: null, mustache: false, portly: true };
/** His walk to the car (m/s, a brisk walk) and the metres a whole stride covers. */
const VIP_WALK = 2.2;
const VIP_STRIDE = 1.5;
/** He gets in once this close (m) to the passenger door's spot and the car is slower than `BOARD_SPEED` (m/s): it waits for him. */
const BOARD_REACH = 1.2;
const BOARD_SPEED = 2.5;
/** How far (m) outside the passenger door he stands to get in; he goes back in when the car is `GIVE_UP` m off and off the grounds. */
const DOOR_OUT = 1.1;
const GIVE_UP = 45;
/** In his seat: hips this far (m) in from the passenger window's middle, down from it, and back of it. */
const SEAT = { in: 0.42, down: 0.92, back: 0.15 };
/** How far (m) from the driver's torso a thrown passenger leaves: beside him (car +x) out of the windshield, behind him out of a door. */
const BESIDE = 0.75;
const BEHIND = 0.8;
/** The secret's flash (ms; the owner: "a slow bright flash"): its swell, hold at full glare, and fade. */
const NUKE_FLASH = { rise: 1800, hold: 500, fade: 4200 } as const;

const X = new THREE.Vector3(1, 0, 0);
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _q = new THREE.Quaternion();
const _turn = new THREE.Quaternion();
const _gun = new THREE.Quaternion();
const _inv = new THREE.Quaternion();
const _c = new THREE.Vector3();
const _j = new THREE.Vector3();
const _k = new THREE.Vector3();
const _r = new THREE.Vector3();
const _p = new THREE.Vector3();
const _hand = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _s = new THREE.Vector3();
const _at = new THREE.Vector3();
const _n = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _pane = new THREE.Vector3();
const _root = new THREE.Vector3();
const _door = new THREE.Vector3();
const _off = new THREE.Vector3();
const _m = new THREE.Matrix4();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

/** A figure's limb angles (rad, about his own x axis; negative swings a limb forward), shoulders, elbows, hips and knees per side. */
type Stance = { arm: [number, number]; elbow: [number, number]; thigh: [number, number]; knee: [number, number] };

/** A blank stance: standing straight. */
function blankStance(): Stance {
  return { arm: [0, 0], elbow: [0, 0], thigh: [0, 0], knee: [0, 0] };
}

/** A walk's stance at stride phase `phase` (rad: a whole stride per 2π), `aiming` with the gun arm out level. */
function walkStance(phase: number, aiming: boolean, out: Stance): Stance {
  const s = Math.sin(phase);
  out.thigh[0] = -LEG_SWING * s;
  out.thigh[1] = LEG_SWING * s;
  out.knee[0] = KNEE_BEND * Math.max(0, s);
  out.knee[1] = KNEE_BEND * Math.max(0, -s);
  out.arm[0] = aiming ? AIM.arm : ARM_SWING * s;
  out.arm[1] = aiming ? AIM.support : -ARM_SWING * s;
  out.elbow[0] = aiming ? AIM.elbow : -0.2;
  out.elbow[1] = aiming ? AIM.supportElbow : -0.2;
  return out;
}

/** Sitting in a seat, hands in the lap. */
function seatedStance(out: Stance): Stance {
  for (let side = 0; side < 2; side++) {
    out.thigh[side] = SIT.thigh;
    out.knee[side] = SIT.knee;
    out.arm[side] = SIT.arm;
    out.elbow[side] = SIT.elbow;
  }
  return out;
}

/**
 * The course's people drawn (the guards of `GuardSquad`, the VIP of `VipEscort`): the thrown dummy's body (`DummyMesh`, `PARTS`)
 * posed by hand instead of by Rapier, standing, walking, aiming or seated, each slot in its own look; a handgun in each aiming hand,
 * its muzzle flash and the shot's tracer. Cosmetic only.
 */
export class People {
  readonly group = new THREE.Group();
  private readonly mesh: DummyMesh;
  private readonly guns: THREE.InstancedMesh;
  private readonly flashes: THREE.InstancedMesh;
  private readonly tracers: THREE.LineSegments;
  private readonly tracerAt = new Float32Array(TRACERS * 6);
  private readonly tracerAge = new Float32Array(TRACERS).fill(Infinity);
  private readonly flashAge: Float32Array;
  private readonly muzzles: Float32Array;
  private tracerNext = 0;

  constructor(slots: number) {
    this.mesh = new DummyMesh(slots);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.guns = new THREE.InstancedMesh(new THREE.BoxGeometry(GUN.w, GUN.len, GUN.depth), new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.5, metalness: 0.6 }), slots);
    this.flashes = new THREE.InstancedMesh(new THREE.OctahedronGeometry(FLASH_R), new THREE.MeshBasicMaterial({ color: FLASH_RGB, toneMapped: false }), slots);
    for (const m of [this.guns, this.flashes]) {
      m.frustumCulled = false;
      for (let i = 0; i < slots; i++) m.setMatrixAt(i, HIDDEN);
    }
    this.flashAge = new Float32Array(slots).fill(Infinity);
    this.muzzles = new Float32Array(slots * 3);
    const geo = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(this.tracerAt, 3));
    this.tracers = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: TRACER_RGB, toneMapped: false, transparent: true, opacity: 0.85 }));
    this.tracers.frustumCulled = false;
    this.group.add(this.mesh, this.guns, this.flashes, this.tracers);
  }

  dress(slot: number, cop: boolean, look: DriverLook): void {
    this.mesh.dress(slot, cop, look);
  }

  /** Slot `slot` standing on (x, y, z) facing `yaw` (forward (sin yaw, cos yaw)) in `stance`, the gun out when `armed`. */
  stand(slot: number, x: number, y: number, z: number, yaw: number, stance: Stance, armed: boolean): void {
    _turn.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
    this.pose(slot, _hand.set(x, y, z), _turn, stance, armed);
  }

  /** Slot `slot` in `stance` with his feet's origin at `root`, turned `turn` (his +z forward), the gun out when `armed`. */
  pose(slot: number, root: THREE.Vector3, turn: THREE.Quaternion, stance: Stance, armed: boolean): void {
    this.part(slot, 0, root, turn, _c.fromArray(PARTS[0]!.c), _qa.identity());
    this.part(slot, 1, root, turn, _c.fromArray(PARTS[1]!.c), _qa.identity());
    for (let side = 0; side < 2; side++) {
      const sign = side * 2 - 1;
      this.limb(slot, root, turn, sign, SHOULDER, ELBOW, ARM_UPPER[side], ARM_LOWER[side], stance.arm[side]!, stance.elbow[side]!);
      this.limb(slot, root, turn, sign, HIP, KNEE, THIGH[side], SHIN[side], stance.thigh[side]!, stance.knee[side]!);
    }
    if (!armed) return this.holster(slot);
    // The hand at the forearm's far end, the gun along it, its muzzle past the hand.
    this.handAt(root, turn, stance, _c);
    _gun.copy(turn).multiply(_qb.setFromAxisAngle(X, stance.arm[GUN_SIDE]! + stance.elbow[GUN_SIDE]!));
    _dir.set(0, -1, 0).applyQuaternion(_gun);
    this.guns.setMatrixAt(slot, _m.compose(_s.copy(_c).addScaledVector(_dir, GUN.len / 2 - 0.04), _gun, _r.set(1, 1, 1)));
    this.guns.instanceMatrix.needsUpdate = true;
    _s.copy(_c).addScaledVector(_dir, GUN.muzzle + GUN.len / 2).toArray(this.muzzles, slot * 3);
  }

  /** Slot `slot`'s gun fires at (x, y, z): its muzzle flashes and a tracer runs from the muzzle to the point. */
  fire(slot: number, x: number, y: number, z: number): void {
    this.flashAge[slot] = 0;
    const k = this.tracerNext;
    this.tracerNext = (k + 1) % TRACERS;
    this.tracerAge[k] = 0;
    for (let i = 0; i < 3; i++) this.tracerAt[k * 6 + i] = this.muzzles[slot * 3 + i]!;
    this.tracerAt[k * 6 + 3] = x;
    this.tracerAt[k * 6 + 4] = y;
    this.tracerAt[k * 6 + 5] = z;
  }

  /** Where slot `slot`'s muzzle stood at its last pose. */
  muzzle(slot: number, out: THREE.Vector3): THREE.Vector3 {
    return out.fromArray(this.muzzles, slot * 3);
  }

  hide(slot: number): void {
    this.mesh.hide(slot);
    this.holster(slot);
  }

  /** Once per frame after the poses: the flashes and tracers age `dt` s and go out. */
  update(dt: number): void {
    for (let s = 0; s < this.flashAge.length; s++) {
      this.flashAge[s] = this.flashAge[s]! + dt;
      const on = this.flashAge[s]! <= FLASH_S;
      this.flashes.setMatrixAt(s, on ? _m.makeTranslation(this.muzzles[s * 3]!, this.muzzles[s * 3 + 1]!, this.muzzles[s * 3 + 2]!) : HIDDEN);
    }
    this.flashes.instanceMatrix.needsUpdate = true;
    for (let k = 0; k < TRACERS; k++) {
      this.tracerAge[k] = this.tracerAge[k]! + dt;
      if (this.tracerAge[k]! > TRACER_S) this.tracerAt.fill(0, k * 6, k * 6 + 6);
    }
    this.tracers.geometry.getAttribute("position").needsUpdate = true;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
    for (const m of [this.guns, this.flashes]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
    this.tracers.geometry.dispose();
    (this.tracers.material as THREE.Material).dispose();
  }

  private holster(slot: number): void {
    this.guns.setMatrixAt(slot, HIDDEN);
    this.guns.instanceMatrix.needsUpdate = true;
  }

  /** Body part `k` whose centre stands at `at` in his frame, turned `local` in it. */
  private part(slot: number, k: number, root: THREE.Vector3, turn: THREE.Quaternion, at: THREE.Vector3, local: THREE.Quaternion): void {
    _p.copy(at).applyQuaternion(turn).add(root);
    this.mesh.pose(slot, k, _p, _q.copy(turn).multiply(local));
  }

  /** A two-part limb from joint `top` through joint `mid`, its upper part swung `a` and its lower `a + b` about his x axis. */
  private limb(slot: number, root: THREE.Vector3, turn: THREE.Quaternion, side: number, top: readonly number[], mid: readonly number[], upper: number, lower: number, a: number, b: number): void {
    _j.set(side * Math.abs(top[2]!), top[3]!, top[4]!);
    _qa.setFromAxisAngle(X, a);
    const cu = PARTS[upper]!.c;
    _r.set(cu[0] - _j.x, cu[1] - _j.y, cu[2] - _j.z).applyQuaternion(_qa).add(_j);
    this.part(slot, upper, root, turn, _r, _qa);
    _k.set(side * Math.abs(mid[2]!), mid[3]!, mid[4]!).sub(_j).applyQuaternion(_qa).add(_j);
    _qb.setFromAxisAngle(X, a + b);
    const cl = PARTS[lower]!.c;
    _r.set(cl[0] - side * Math.abs(mid[2]!), cl[1] - mid[3]!, cl[2] - mid[4]!).applyQuaternion(_qb).add(_k);
    this.part(slot, lower, root, turn, _r, _qb);
  }

  /** The gun hand's place (world): the gun arm's elbow, then the forearm's length on. */
  private handAt(root: THREE.Vector3, turn: THREE.Quaternion, stance: Stance, out: THREE.Vector3): THREE.Vector3 {
    _j.set((GUN_SIDE * 2 - 1) * Math.abs(SHOULDER[2]!), SHOULDER_Y, 0);
    _qa.setFromAxisAngle(X, stance.arm[GUN_SIDE]!);
    _k.set(0, ELBOW[3]! - SHOULDER_Y, 0).applyQuaternion(_qa).add(_j);
    _qb.setFromAxisAngle(X, stance.arm[GUN_SIDE]! + stance.elbow[GUN_SIDE]!);
    return out.set(0, -(ELBOW[3]! - PARTS[ARM_LOWER[GUN_SIDE]]!.c[1]) * 2, 0).applyQuaternion(_qb).add(_k).applyQuaternion(turn).add(root);
  }
}

/** One guard: where he stands and faces, his stride, whether he is out, and his place in the ranks and inside his door. */
type Guard = { x: number; z: number; yaw: number; phase: number; out: boolean; spotX: number; spotZ: number; homeX: number; homeZ: number };

/**
 * The guards drawn (`LawnGuard` decides who fires and what hits): with the alarm up each runs out of his door, in turn, to his
 * place in the ranks before it, turns to the target and aims; each shot the sim fired flashes at its guard's muzzle and its tracer
 * runs to the car (a hit throws sparks off it) or past it. With the alarm down they run back in and are gone. Cosmetic only: the
 * walk is the frame's, not the sim's.
 */
export class GuardSquad {
  private readonly guards: Guard[] = [];
  private readonly stance = blankStance();
  private drawn = 0;
  private readonly ground: Ground;
  private readonly people: People;

  constructor(spec: GuardSpec, ground: Ground, people: People) {
    this.ground = ground;
    this.people = people;
    const doors = spec.doors.length;
    const perRank = Math.ceil(Math.ceil(spec.count / doors) / 2);
    for (let i = 0; i < spec.count; i++) {
      const d = spec.doors[i % doors]!;
      const j = Math.floor(i / doors);
      const fx = Math.sin(d.yaw);
      const fz = Math.cos(d.yaw);
      const out = LINE_OUT + Math.floor(j / perRank) * RANK_GAP;
      const across = ((j % perRank) - (perRank - 1) / 2) * FILE_GAP;
      this.guards.push({
        x: 0, z: 0, yaw: d.yaw, phase: 0, out: false,
        spotX: d.x + fx * out + fz * across,
        spotZ: d.z + fz * out - fx * across,
        homeX: d.x - fx * PORTICO_DEPTH,
        homeZ: d.z - fz * PORTICO_DEPTH,
      });
      people.dress(i, i % 2 === 0, AGENT);
    }
  }

  /** A race starts: everyone inside, no shot drawn yet. */
  reset(): void {
    this.drawn = 0;
    for (let i = 0; i < this.guards.length; i++) {
      this.guards[i]!.out = false;
      this.people.hide(i);
    }
  }

  /** One frame of `dt` s: the guards move and aim by the sim's alarm, and its new shots are drawn (`sparks` at a hit). */
  frame(dt: number, guard: LawnGuard, cars: readonly DeformableCar[], sparks: (at: THREE.Vector3, normal: THREE.Vector3, impulse: number) => void): void {
    if (guard.shots < this.drawn) this.drawn = 0;
    for (let i = 0; i < this.guards.length; i++) this.move(i, dt, guard, cars);
    for (; this.drawn < guard.shots; this.drawn++) {
      if (guard.shots - this.drawn > SHOT_RING) continue;
      const k = this.drawn % SHOT_RING;
      const g = guard.shotGuard[k]!;
      const car = cars[guard.shotCar[k]!];
      if (!car || !this.guards[g]?.out) continue;
      this.people.muzzle(g, _muzzle);
      _at.copy(car.group.position);
      _at.y += AIM_Y;
      _n.copy(_muzzle).sub(_at).normalize();
      const hit = guard.shotHit[k];
      // A miss flies past the car, off to one side by the shot's number.
      if (!hit) _at.addScaledVector(_n, -MISS_WIDE).add(_muzzle.set(_n.z, 0, -_n.x).multiplyScalar(this.drawn % 2 ? MISS_WIDE : -MISS_WIDE));
      this.people.fire(g, _at.x, _at.y, _at.z);
      if (hit) sparks(_at, _n, HIT_SPARKS);
    }
  }

  private move(i: number, dt: number, guard: LawnGuard, cars: readonly DeformableCar[]): void {
    const g = this.guards[i]!;
    const called = guard.alarm >= Math.floor(i / 2) * STAGGER_S;
    if (called && !g.out) {
      g.out = true;
      g.x = g.homeX;
      g.z = g.homeZ;
    }
    if (!g.out) return;
    const dx = (called ? g.spotX : g.homeX) - g.x;
    const dz = (called ? g.spotZ : g.homeZ) - g.z;
    const left = hypot2(dx, dz);
    if (!called && left < ARRIVE) {
      g.out = false;
      return this.people.hide(i);
    }
    const target = guard.target !== NO_TARGET ? cars[guard.target] : undefined;
    const running = left >= ARRIVE;
    if (running) {
      const step = Math.min(left, GUARD_RUN * dt);
      g.x += (dx / left) * step;
      g.z += (dz / left) * step;
      g.phase += (step / GUARD_STRIDE) * 2 * Math.PI;
      g.yaw = Math.atan2(dx, dz);
    } else if (target) {
      g.yaw = Math.atan2(target.group.position.x - g.x, target.group.position.z - g.z);
    }
    walkStance(running ? g.phase : 0, called && !running && target !== undefined, this.stance);
    this.people.stand(i, g.x, this.ground.heightAt(g.x, g.z), g.z, g.yaw, this.stance, called);
  }
}

type Phase = "in" | "walking" | "riding" | "thrown";

/**
 * The VIP, once the course's secret is out (the Konami code: the guards stay in). When the player drives onto the grounds he
 * walks out of the nearest door to the car's passenger door; once the car waits for him there he gets in and rides in the
 * passenger seat, until the driver is thrown out of the car (`DeformableCar.driverOut`): then he is thrown with him
 * (`throwPassenger`, the dummies' world) and the ride is over. Cosmetic only: the sim never knows he is there.
 */
export class VipEscort {
  private phase: Phase = "in";
  private car = -1;
  private x = 0;
  private z = 0;
  private yaw = 0;
  private stride = 0;
  private readonly stance = blankStance();
  private readonly spec: GuardSpec;
  private readonly ground: Ground;
  private readonly people: People;
  private readonly slot: number;

  constructor(spec: GuardSpec, ground: Ground, people: People, slot: number) {
    this.spec = spec;
    this.ground = ground;
    this.people = people;
    this.slot = slot;
    people.dress(slot, false, VIP_LOOK);
  }

  /** A race starts: he is back inside, whatever happened in the last one. */
  reset(): void {
    this.phase = "in";
    this.car = -1;
    this.people.hide(this.slot);
  }

  /** The car he rides in (-1: none): its driver's throw throws him too. */
  get ridingIn(): number {
    return this.phase === "riding" ? this.car : -1;
  }

  /**
   * One frame of `dt` s. `out`: the secret is out; `player`: the car this browser drives (-1 none); `throwPassenger` throws him out
   * of car `car` with its driver.
   */
  frame(dt: number, out: boolean, player: number, cars: readonly DeformableCar[], throwPassenger: (car: number, look: DriverLook) => void): void {
    const car = player >= 0 ? cars[player] : undefined;
    if (this.phase === "in") {
      if (!out || !car || !car.deform.drivetrainAlive || !insidePolygon(this.spec.lawn, car.group.position.x, car.group.position.z)) return;
      this.comeOut(player, car);
    }
    if (this.phase === "walking") this.walk(dt, cars);
    if (this.phase !== "riding") return;
    const ride = cars[this.car];
    if (!ride) return this.reset();
    if (ride.driverOut === null) return this.sit(ride);
    throwPassenger(this.car, VIP_LOOK);
    this.phase = "thrown";
    this.people.hide(this.slot);
  }

  /** Out of the door nearest the car, toward it. */
  private comeOut(player: number, car: DeformableCar): void {
    let best = Infinity;
    for (const d of this.spec.doors) {
      const far = hypot2(d.x - car.group.position.x, d.z - car.group.position.z);
      if (far >= best) continue;
      best = far;
      this.x = d.x;
      this.z = d.z;
      this.yaw = d.yaw;
    }
    this.car = player;
    this.phase = "walking";
  }

  /** A stride toward the car's passenger door; in when it waits for him there, back inside when it has left him. */
  private walk(dt: number, cars: readonly DeformableCar[]): void {
    const car = cars[this.car];
    if (!car) return this.reset();
    _door.set(DOOR_OUT, 0, 0).applyQuaternion(car.group.quaternion);
    car.glassWorld("doorR", _pane).add(_door);
    const dx = _pane.x - this.x;
    const dz = _pane.z - this.z;
    const left = hypot2(dx, dz);
    const gone = !insidePolygon(this.spec.lawn, car.group.position.x, car.group.position.z) && left > GIVE_UP;
    if (gone || !car.deform.drivetrainAlive) return this.reset();
    if (left < BOARD_REACH && car.speed < BOARD_SPEED) {
      this.phase = "riding";
      return;
    }
    const step = Math.min(left, VIP_WALK * dt);
    if (left > 1e-3) {
      this.x += (dx / left) * step;
      this.z += (dz / left) * step;
      this.yaw = Math.atan2(dx, dz);
    }
    this.stride += (step / VIP_STRIDE) * 2 * Math.PI;
    walkStance(this.stride, false, this.stance);
    this.people.stand(this.slot, this.x, this.ground.heightAt(this.x, this.z), this.z, this.yaw, this.stance, false);
  }

  /** In the passenger seat: hips in from the right-hand window, facing the car's way (`HIP[3]`: the hips' height standing). */
  private sit(car: DeformableCar): void {
    const g = car.group;
    car.glassWorld("doorR", _pane).sub(g.position).applyQuaternion(_inv.copy(g.quaternion).invert());
    _root.set(_pane.x - SEAT.in, _pane.y - SEAT.down - HIP[3]!, _pane.z - SEAT.back).applyQuaternion(g.quaternion).add(g.position);
    this.people.pose(this.slot, _root, g.quaternion, seatedStance(this.stance), false);
  }
}

/** `at` (the driver's torso place, just out of `car`) moved to where his passenger is thrown from: off it by `BESIDE` or `BEHIND`, toward the passenger side. */
export function passengerThrow(car: DeformableCar, at: THREE.Vector3): void {
  if (car.driverOut === "windshield" || car.driverOut === null) _off.set(BESIDE, 0, 0);
  else _off.set(car.driverOut === "doorL" ? BEHIND : -BEHIND, 0, 0);
  at.add(_off.applyQuaternion(car.group.quaternion));
}

/**
 * The secret's flash (`TrackArt.reveal`): a white-gold glare over the whole view that swells slowly, holds, and fades out over a few
 * seconds, `atPeak` running at its height (where the mushroom cloud appears). A DOM layer over the canvas, so it lights the HUD too
 * and needs no pass of the renderer's.
 */
export function nukeFlash(over: HTMLElement, atPeak: () => void): void {
  const glare = document.createElement("div");
  glare.style.cssText =
    "position:absolute;inset:0;pointer-events:none;z-index:50;opacity:0;" +
    "background:radial-gradient(ellipse at 50% 40%, #fffef6 0%, #fff4cc 45%, #ffd27a 100%);";
  over.appendChild(glare);
  const { rise, hold, fade } = NUKE_FLASH;
  const total = rise + hold + fade;
  const run = glare.animate(
    [
      { opacity: 0, easing: "ease-in" },
      { opacity: 1, offset: rise / total },
      { opacity: 1, offset: (rise + hold) / total, easing: "ease-out" },
      { opacity: 0 },
    ],
    { duration: total, fill: "forwards" },
  );
  setTimeout(atPeak, rise);
  run.onfinish = () => glare.remove();
}

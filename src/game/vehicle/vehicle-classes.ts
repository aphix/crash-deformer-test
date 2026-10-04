/**
 * Vehicle classes: how each body drives, how much punishment it takes, and the
 * one arcade ↔ realistic axis (`HANDLING.realism`) that scales assists, grip
 * and when damage kills. Read by `applyDrive`, race AI (`classStats`) and the HUD.
 */
import * as THREE from "three";
import type { CarStyleId } from "./car-variants.ts";

export type VehicleClassId = "sedan" | "muscle" | "truck" | "monster" | "police";
/** Netplay wire order (a snapshot sends the index): append only. */
export const VEHICLE_CLASS_IDS: readonly VehicleClassId[] = ["sedan", "muscle", "truck", "monster", "police"];

export interface ClassStats {
  id: VehicleClassId;
  label: string;
  /** Body mesh this class spawns with. */
  style: CarStyleId;
  /** Kerb mass (kg). Drives launch / brake feel (accel, brake) and the HUD; contact masses stay the shared rig's. */
  mass: number;
  /** Forward / reverse top speed on asphalt (m/s). */
  topSpeed: number;
  revSpeed: number;
  /**
   * Gear buckets, low to high: each gear's top end (× `topSpeed`) and its fixed thrust (m/s²) at the arcade and
   * the realistic end of `HANDLING.realism` (lerped between), falling as the gears rise. No clutch or revs: the
   * pull steps down at each shift. The realistic thrusts give the sourced 0–100 km/h (docs/HANDLING.md § Acceleration).
   */
  gears: readonly (readonly [upTo: number, arcade: number, real: number])[];
  /** 0–1 torque feel: how much the rear spins up on a launch. */
  torque: number;
  /** Service brake (m/s²). */
  brake: number;
  /** Full-lock yaw rate at speed (rad/s). */
  turn: number;
  /** Lateral grip on dry asphalt at the arcade end (m/s²). */
  grip: number;
  /** 0–1: how readily the tail steps out under power and how loose it stays. */
  drift: number;
  /** Boost multipliers on top speed and acceleration. */
  boostTop: number;
  boostAccel: number;
  /** Damage tolerance: × the realistic engine-kill travel (see `killTravel`). */
  durability: number;
  /** Visual body lift above the stock ride (m) and wheel scale; collision hulls stay stock. */
  lift: number;
  wheelScale: number;
}

const SEDAN: ClassStats = {
  id: "sedan",
  label: "Sedan",
  style: "sedan",
  mass: 1400,
  topSpeed: 200 / 3.6,
  revSpeed: 11,
  gears: [
    [0.24, 17.2, 6.9],
    [0.42, 10.7, 4.3],
    [0.6, 6.1, 2.44],
    [0.8, 3.5, 1.93],
    [1, 2, 1.1],
  ],
  torque: 0.3,
  brake: 28,
  turn: 1.55,
  grip: 39,
  drift: 0.35,
  boostTop: 1.2,
  boostAccel: 1.55,
  durability: 1,
  lift: 0,
  wheelScale: 1,
};

/**
 * Stat budget: what a class wins on the straights it pays back in corners, so
 * a mixed loop lands within ~5 % (vehicle-classes.test.ts runs that lap).
 */
export const CLASSES: Readonly<Record<VehicleClassId, ClassStats>> = {
  sedan: SEDAN,
  muscle: {
    id: "muscle",
    label: "Muscle",
    style: "coupe",
    mass: 1650,
    topSpeed: 210 / 3.6,
    revSpeed: 11,
    gears: [
      [0.24, 20.4, 9.2],
      [0.42, 12.7, 5.73],
      [0.6, 7.7, 3.47],
      [0.8, 4.7, 2.43],
      [1, 2.8, 1.45],
    ],
    torque: 0.6,
    brake: 26,
    turn: 1.36,
    grip: 35.5,
    drift: 0.85,
    boostTop: 1.2,
    boostAccel: 1.55,
    durability: 1.15,
    lift: 0,
    wheelScale: 1.04,
  },
  truck: {
    id: "truck",
    label: "Truck",
    style: "pickup",
    mass: 2100,
    topSpeed: 195 / 3.6,
    revSpeed: 10,
    gears: [
      [0.3, 16.3, 5],
      [0.53, 7.8, 2.48],
      [0.76, 4.3, 2.2],
      [1, 1.8, 1.08],
    ],
    torque: 0.5,
    brake: 24,
    turn: 1.5,
    grip: 38.5,
    drift: 0.25,
    boostTop: 1.22,
    boostAccel: 1.6,
    durability: 1.25,
    lift: 0.08,
    wheelScale: 1.12,
  },
  monster: {
    id: "monster",
    label: "Monster",
    style: "pickup",
    mass: 2900,
    topSpeed: 190 / 3.6,
    revSpeed: 10,
    gears: [
      [0.3, 17.1, 8.4],
      [0.53, 11.5, 5.65],
      [0.76, 5, 2.45],
      [1, 1.8, 0.88],
    ],
    torque: 0.7,
    brake: 22,
    turn: 1.3,
    grip: 37,
    drift: 0.2,
    boostTop: 1.22,
    boostAccel: 1.6,
    durability: 1.7,
    lift: 0.48,
    wheelScale: 1.7,
  },
  /**
   * The sedan's drive on the black-and-white body with the light bar. An AI police unit takes a little more
   * before it dies: ×1.3 gives +16 % kill travel at the HUD's default realism (0.45 → 0.52 m; ×1.25 gives only +13.5 %),
   * +14.5 % at the arcade end, where `KILL_CEILING` caps it, and +30 % at the realistic end. A player's police
   * car keeps the sedan's (`killClass`).
   */
  police: { ...SEDAN, id: "police", label: "Police", style: "police", durability: 1.3 },
};

/** The class each body style drives as unless assigned another (the monster truck rides the pickup body). */
export const STYLE_CLASS: Readonly<Record<CarStyleId, VehicleClassId>> = {
  sedan: "sedan",
  hatchback: "sedan",
  wagon: "sedan",
  coupe: "muscle",
  pickup: "truck",
  police: "police",
};

export function classStats(id: VehicleClassId): ClassStats {
  return CLASSES[id];
}

/** The gear bucket (0-based) forward speed `v` (m/s) sits in, past the top gear's end (a boost) still top: the bucket `applyDrive`'s pedals pull in. */
export function gearAt(k: ClassStats, v: number): number {
  let g = 0;
  while (g < k.gears.length - 1 && v >= k.gears[g]![0] * k.topSpeed) g++;
  return g;
}

/** Where the arcade ↔ realistic slider starts: arcade-leaning, per the design pillars. */
export const DEFAULT_REALISM = 0.25;

/** The arcade ↔ realistic axis. 0 = Burnout (assists on, near-indestructible), 1 = sourced crash data. */
export const HANDLING = { realism: DEFAULT_REALISM };

const assigned = new WeakMap<object, VehicleClassId>();

/** A car's class: assigned at spawn, else its body style's. */
export function carClass(car: { style: { id: CarStyleId } }): VehicleClassId {
  return assigned.get(car) ?? STYLE_CLASS[car.style.id];
}

/** The gauge's gear for a car: its forward speed's bucket 1-based (`gearAt`), 0 rolling backwards. */
export function carGear(car: { style: { id: CarStyleId }; velocity: { x: number; z: number }; fwdFlat: { x: number; z: number } }): number {
  const along = car.velocity.x * car.fwdFlat.x + car.velocity.z * car.fwdFlat.z;
  return along < -0.5 ? 0 : gearAt(CLASSES[carClass(car)], along) + 1;
}

/** Revs (0-1 of the dial) at the foot of a gear bucket; a shift drops back to it. */
const REV_FLOOR = 0.3;
/** Revs at a stopped or reversing car. */
const REV_IDLE = 0.18;

/**
 * The gauge's fake revs 0-1: there is no engine model, so they climb with forward speed through the current gear bucket
 * (`gearAt`): `REV_FLOOR` at the bucket's foot, 1 (the redline) at its top, and back down at the next gear's foot.
 * Pure function of speed and class, so it matches the gear shown beside it exactly.
 */
export function carRpm(car: { style: { id: CarStyleId }; velocity: { x: number; z: number }; fwdFlat: { x: number; z: number } }): number {
  const along = car.velocity.x * car.fwdFlat.x + car.velocity.z * car.fwdFlat.z;
  if (along < 0) return REV_IDLE;
  const k = CLASSES[carClass(car)];
  const g = gearAt(k, along);
  const lo = g === 0 ? 0 : k.gears[g - 1]![0] * k.topSpeed;
  const hi = k.gears[g]![0] * k.topSpeed;
  const share = Math.min(1, (along - lo) / (hi - lo));
  return g === 0 ? REV_IDLE + (1 - REV_IDLE) * share : REV_FLOOR + (1 - REV_FLOOR) * share;
}

/** The class whose durability arms a car's kill limits: a police cruiser in the player's slot (car 0) keeps the sedan's, so only AI police units are tougher. */
export function killClass(car: { style: { id: CarStyleId }; group: { userData: Record<string, unknown> } }): VehicleClassId {
  const cls = carClass(car);
  return cls === "police" && car.group.userData.carIndex === 0 ? "sedan" : cls;
}

// --- arcade ↔ realistic -----------------------------------------------------

/** Rearward engine travel (m) that kills a sedan at the realistic end: streamed-deform's sourced ENGINE_KILL_TRAVEL. */
const REAL_KILL_TRAVEL = 0.15;
/** Arcade-end kill travel (m) for a sedan: three 50 km/h wall hits leave ~0.48 m, the fourth ~0.64 m. */
const ARCADE_KILL_TRAVEL = 0.55;
/** Worst travel the block reaches by accumulated wrecking (~0.64 m): stay under it so a wreck can still die. */
const KILL_CEILING = 0.63;

/**
 * Derby kill limits: travel × the race/fleet value, plus wear (`StreamedDeformation.wreckEnergy`: every hit's
 * EBS² capped at 36 m²/s², summed over all ends); the travel share and the wear share add. Lane
 * crash-realism-8 swept the scale alone (ten-car derby, seeds 1–5, 300 s): ×0.46 wrecks 3/5, first death
 * 10.6 s; ×0.36 4/5 but first death 2.6 s: below ×0.46 one hard hit kills before any wrecking has added up.
 * crash-realism-10, on the contact-spin fix: ×0.46 alone 3/5 wrecks, every death by travel alone. With wear
 * (seeds 1–5): ×0.79 / 400 wrecks 5/5, first deaths 14.1–36.9 s, every heat tail first; ×0.69 / 400 4/5 but
 * seed 1 nose-heavy (F55/R64); ×0.69 / 300 a death at 4.7 s; ×0.69 / 500 3/5. A derby is a wrecking
 * contest; a race or fleet car keeps the sourced tolerance and no wear limit.
 */
const DERBY_KILL_SCALE = 0.7935;
const DERBY_WRECK_ENERGY = 400;

/** Engine-kill travel (m) for a class at `realism`, in a derby or anywhere else. */
export function killTravel(id: VehicleClassId, realism: number, ctx: "derby" | "default"): number {
  const d = CLASSES[id].durability;
  const arcade = Math.min(KILL_CEILING, ARCADE_KILL_TRAVEL * (1 + (d - 1) * 0.5));
  const real = Math.min(KILL_CEILING, REAL_KILL_TRAVEL * d);
  return THREE.MathUtils.lerp(arcade, real, THREE.MathUtils.clamp(realism, 0, 1)) * (ctx === "derby" ? DERBY_KILL_SCALE : 1);
}

/** A car's kill limits for its context: engine travel, plus the wreck energy in a derby. */
export function armKill(deform: { killTravel: number; wreckEnergy: number }, id: VehicleClassId, realism: number, ctx: "derby" | "default"): void {
  deform.killTravel = killTravel(id, realism, ctx);
  deform.wreckEnergy = ctx === "derby" ? DERBY_WRECK_ENERGY : Infinity;
}

/** Lateral grip share kept at the realistic end (the arcade end is 1). */
const REAL_GRIP = 0.62;

/** The slowest self-right delay (s) the slider gives, reached just under the realistic end where only R rights a car. */
export const SELF_RIGHT_SLOWEST = 3;

export type Assists = {
  /** × class grip. */
  grip: number;
  /** Max slip angle (rad) the drift assist lets the body reach before carrying the velocity round. */
  slipCap: number;
  /** Slide decay rate (1/s) once the slide is released: the auto-catch. */
  catchRate: number;
  /** Share of lateral speed scrubbed (lost) as the tyres bite; the rest turns back into forward speed. */
  scrub: number;
  /** Seconds on its roof / side before the driven car rights itself; Infinity = R key only. */
  selfRight: number;
};

export function assists(realism: number, out: Assists): Assists {
  const r = THREE.MathUtils.clamp(realism, 0, 1);
  out.grip = THREE.MathUtils.lerp(1, REAL_GRIP, r);
  out.slipCap = THREE.MathUtils.lerp(0.62, 1.45, r);
  out.catchRate = THREE.MathUtils.lerp(4.5, 1.1, r);
  out.scrub = THREE.MathUtils.lerp(0.2, 1, r);
  out.selfRight = r < 0.6 ? THREE.MathUtils.lerp(1.2, SELF_RIGHT_SLOWEST, r / 0.6) : Infinity;
  return out;
}

// --- damage → drivability ---------------------------------------------------

type DamageStage = "healthy" | "dented" | "damaged" | "limping" | "dead";

/** Top speed never drops below this share of the class's until the drivetrain dies. */
export const LIMP_FLOOR = 0.6;
/** Health bands: above DENT it only looks hit, above LIMP it pulls and loses a little. */
const DENT = 0.6;
const LIMP = 0.25;

export type Drivability = {
  stage: DamageStage;
  /** × acceleration. */
  power: number;
  /** × top speed. */
  top: number;
  /** Yaw bias (rad/s, + = left) the driver has to hold off. */
  pull: number;
};

/**
 * Graded damage. `health` is the drivetrain's 0–1 (`deform.drivetrainHealth`),
 * `wheelsOn` 0–4, `pullSide` the struck side (+1 left, −1 right).
 * The arcade end softens every loss; nothing falls below LIMP_FLOOR until dead.
 */
export function drivability(
  alive: boolean,
  crashed: boolean,
  health: number,
  wheelsOn: number,
  pullSide: number,
  realism: number,
  out: Drivability,
): Drivability {
  if (!alive) {
    out.stage = "dead";
    out.power = 0;
    out.top = 0;
    out.pull = 0;
    return out;
  }
  const sev = THREE.MathUtils.lerp(0.55, 1, THREE.MathUtils.clamp(realism, 0, 1));
  const lost = Math.max(0, 4 - wheelsOn);
  const hurt = THREE.MathUtils.clamp((DENT - health) / (DENT - LIMP), 0, 1);
  const limp = THREE.MathUtils.clamp((LIMP - health) / LIMP, 0, 1);
  const loss = sev * (0.12 * hurt + 0.14 * limp + 0.12 * lost);
  out.top = Math.max(LIMP_FLOOR, 1 - loss);
  out.power = Math.max(LIMP_FLOOR - 0.1, 1 - loss * 1.3);
  out.pull = pullSide * sev * (0.1 * hurt + 0.12 * limp + 0.16 * Math.min(2, lost));
  out.stage =
    health <= LIMP || lost >= 2 ? "limping" : health <= DENT || lost > 0 ? "damaged" : crashed ? "dented" : "healthy";
  return out;
}

const _stage: Drivability = { stage: "healthy", power: 1, top: 1, pull: 0 };

type DamagedCar = {
  crashed: boolean;
  deform: { drivetrainAlive: boolean; drivetrainHealth: number; wheelsOn: number; impactInward: { x: number } };
};

/** A car's damage stage right now (HUD, smoke). */
export function damageStage(car: DamagedCar): DamageStage {
  return carDrivability(car, HANDLING.realism, _stage).stage;
}

export function carDrivability(car: DamagedCar, realism: number, out: Drivability): Drivability {
  const d = car.deform;
  // Car +x is the driver's left: a hit there drives the impact inward along −x, and the crushed corner drags left.
  const side = d.impactInward.x < 0 ? 1 : d.impactInward.x > 0 ? -1 : 0;
  return drivability(d.drivetrainAlive, car.crashed, d.drivetrainHealth, d.wheelsOn, side, realism, out);
}

// --- planning helpers (race AI, tests) ---------------------------------------

/** Fastest a class should take a corner of radius `r` (m) on grip `mu` without sliding or running out of lock. */
export function cornerSpeed(s: ClassStats, r: number, mu = 1, realism = HANDLING.realism): number {
  const grip = s.grip * mu * THREE.MathUtils.lerp(1, REAL_GRIP, THREE.MathUtils.clamp(realism, 0, 1));
  const steerAuth = 0.45 + 0.55 * mu;
  return Math.min(s.topSpeed, Math.sqrt(grip * r), s.turn * steerAuth * r);
}

// --- class dressing (visual lift / wheel scale) -------------------------------

type Dressable = {
  readonly group: THREE.Group;
  readonly wheels: readonly THREE.Object3D[];
  readonly style: { id: CarStyleId };
};

/** Wheel radius of the shared mesh (m); a scaled wheel is lifted to keep its tyre on the ground. */
const WHEEL_RADIUS = 0.32;

/**
 * Give `car` a class: stats for `applyDrive`, plus the monster / truck stance.
 * Body parts ride a lift group and the wheels a hub group inside the car's
 * group, so the physics frame (masses, hulls, contacts) stays stock. Run it
 * again after every respawn: a re-attached part lands back on the plain group.
 */
export function assignClass(car: Dressable, id: VehicleClassId): void {
  assigned.set(car, id);
  const s = CLASSES[id];
  const g = car.group;
  let body = g.getObjectByName("classLift");
  let hubs = g.getObjectByName("classHubs");
  if (!body) {
    body = new THREE.Group();
    body.name = "classLift";
    hubs = new THREE.Group();
    hubs.name = "classHubs";
    g.add(body, hubs);
  }
  const wheelLift = WHEEL_RADIUS * (s.wheelScale - 1);
  body.position.y = s.lift;
  hubs!.position.y = wheelLift;
  for (let i = g.children.length - 1; i >= 0; i--) {
    const c = g.children[i]!;
    if (c === body || c === hubs) continue;
    if (car.wheels.includes(c)) hubs!.add(c);
    else body.add(c);
  }
  for (const w of car.wheels) w.scale.setScalar(s.wheelScale);
}

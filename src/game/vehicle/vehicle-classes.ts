/**
 * Vehicle classes: how each body drives, how much punishment it takes, and the
 * one arcade ↔ realistic axis (`HANDLING.realism`) that scales assists, grip
 * and when damage kills. Read by `applyDrive`, race AI (`classStats`) and the HUD.
 */
import * as THREE from "three";
import type { CarStyleId } from "./car-variants.ts";
import { CLASS_HUBS, CLASS_LIFT } from "./constants.ts";
import { WHEEL_POS } from "./car-mesh.ts";
import { MU_TYRE } from "../world/surfaces.ts";
import { SURFACES } from "../world/catalog.ts";
import { FRICTION_G } from "../deform/physics-util.ts";

export type VehicleClassId = "sedan" | "muscle" | "truck" | "monster" | "police";
/** Netplay wire order (a snapshot sends the index): append only. */
export const VEHICLE_CLASS_IDS: readonly VehicleClassId[] = ["sedan", "muscle", "truck", "monster", "police"];

/**
 * Which axles the engine turns: `fwd` / `rwd` one axle; `awd` both through an open centre differential (the torque split evenly, so the
 * first axle to slip limits both: Uncharted 4 13:11–13:26); `4wd` both locked together (the axles' grip adds).
 */
export type Driveline = "fwd" | "rwd" | "awd" | "4wd";

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
  /** Gear buckets, low to high: each gear's top end as a share of `topSpeed`. The gauge's gear, the shift kick's and the AI's; the pull does not step at them (`enginePull`). */
  gears: readonly number[];
  /**
   * The engine's pull on the driven wheels (m/s²) from a standstill, at the arcade and the realistic end of `HANDLING.realism` (lerped):
   * flat until the class's `power` is reached (the knee, `power / launch`), then constant power. The realistic end with `power` gives
   * the sourced 0–100 km/h on asphalt (docs/HANDLING.md § Acceleration), so both are net of asphalt's rolling resistance and air drag.
   */
  launch: readonly [arcade: number, real: number];
  /** Constant power per kilogram (W/kg) the pull tails along past the knee, `power / wheelSpeed`, through every gear (one power: the pull is continuous across a shift). Fitted to the sourced 0–100 with `launch` (docs/HANDLING.md § Acceleration). */
  power: readonly [arcade: number, real: number];
  /** The driveline layout: the axles whose grip and load carry the engine's pull (`tractionLimit`) and lay the stripes. */
  drive: Driveline;
  /** Height of the centre of gravity over the ground (m): the load the launch moves between the axles (`tractionLimit`) and the drawn squat / dive (`LoadTransfer`). */
  cgHeight: number;
  /** The engine's redline (rpm): the motor voice's top (`motorRpm`) and the driveline's overall ratio at a wheel speed (`rotatingShare`). */
  redlineRpm: number;
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
  gears: [0.24, 0.42, 0.6, 0.8, 1],
  launch: [17.2, 6.9],
  power: [179.7, 72.2],
  drive: "fwd", // the sourced car (2018 Accord Sport) is front-drive, as are the hatchback and wagon bodies that borrow its stats
  cgHeight: 0.5,
  redlineRpm: 6800,
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
    gears: [0.24, 0.42, 0.6, 0.8, 1],
    launch: [20.4, 9.2],
    power: [230.5, 104.8],
    drive: "rwd", // 2018 Mustang GT: rear-drive muscle
    cgHeight: 0.5,
    redlineRpm: 6200,
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
    gears: [0.3, 0.53, 0.76, 1],
    launch: [16.3, 5],
    power: [178.2, 57.1],
    drive: "4wd", // 2026 Tacoma TRD Off-Road: part-time 4WD, a locked transfer case
    cgHeight: 0.8,
    redlineRpm: 5000,
    brake: 27,
    turn: 1.5,
    grip: 41,
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
    gears: [0.3, 0.53, 0.76, 1],
    launch: [17.1, 8.4],
    power: [243.6, 123.4],
    drive: "4wd", // Monster Jam trucks: solid axles, all four driven and locked
    cgHeight: 1.2,
    redlineRpm: 5500,
    brake: 26,
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
   * The sedan's drive on the black-and-white body with the light bar, rear-driven: the archetype is a rear-drive pursuit sedan
   * (Crown Victoria, Charger Pursuit). An AI police unit takes a little more before it dies: ×1.3 gives +16 % kill travel at the
   * HUD's default realism (0.45 → 0.52 m; ×1.25 gives only +13.5 %), +14.5 % at the arcade end, where `KILL_CEILING` caps it, and
   * +30 % at the realistic end. A player's police car keeps the sedan's (`killClass`).
   */
  police: { ...SEDAN, id: "police", label: "Police", style: "police", drive: "rwd", redlineRpm: 7000, durability: 1.3 },
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

/** Wheel radius of the shared mesh (m); a scaled wheel is lifted to keep its tyre on the ground (`assignClass`) and its tread speed is the hub's × its scale (`rotatingShare`). */
export const WHEEL_RADIUS = 0.32;

export function classStats(id: VehicleClassId): ClassStats {
  return CLASSES[id];
}

/** The gear bucket (0-based) a wheel speed `v` (m/s) sits in, past the top gear's end (a boost) still top. */
export function gearAt(k: ClassStats, v: number): number {
  let g = 0;
  while (g < k.gears.length - 1 && v >= k.gears[g]! * k.topSpeed) g++;
  return g;
}

/** Where gear `g`'s bucket starts and ends (m/s): `lo` 0 for 1st. */
export function gearLo(k: ClassStats, g: number): number {
  return g === 0 ? 0 : k.gears[g - 1]! * k.topSpeed;
}
export function gearHi(k: ClassStats, g: number): number {
  return k.gears[g]! * k.topSpeed;
}

/** The class's constant power (W/kg) at `realism`. */
export function enginePower(k: ClassStats, realism: number): number {
  return k.power[0] + (k.power[1] - k.power[0]) * realism;
}

/**
 * The engine's pull (m/s²) with the driven wheels at `ws` m/s: the class's launch pull until its power is reached, then constant
 * power tailing off as 1/ws through every gear (masterclass 14:38, gears tail off toward the next gear's working range; one power
 * for all gears, so the pull is continuous across each shift and a road's drag meets it mid-gear, never at a shift's step).
 */
export function enginePull(k: ClassStats, ws: number, realism: number): number {
  const launch = k.launch[0] + (k.launch[1] - k.launch[0]) * realism;
  return Math.min(launch, enginePower(k, realism) / Math.max(ws, 1e-6));
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

/** The driven wheels' tread speed along the nose (m/s): the body's speed plus what the tread runs ahead of it (`drive.spinSpeed`). */
function wheelSpeed(car: { velocity: { x: number; z: number }; fwdFlat: { x: number; z: number }; drive: { spinSpeed: number } }): number {
  const along = car.velocity.x * car.fwdFlat.x + car.velocity.z * car.fwdFlat.z;
  return along < 0 ? along : along + car.drive.spinSpeed;
}

/** The gauge's gear for a car: its driven wheels' speed's bucket 1-based (`gearAt`), 0 rolling backwards. */
export function carGear(car: { style: { id: CarStyleId }; velocity: { x: number; z: number }; fwdFlat: { x: number; z: number }; drive: { spinSpeed: number } }): number {
  const ws = wheelSpeed(car);
  return ws < -0.5 ? 0 : gearAt(CLASSES[carClass(car)], ws) + 1;
}

/** Revs (0-1 of the dial) at the foot of a gear bucket; a shift drops back to it. */
const REV_FLOOR = 0.3;
/** Revs at a stopped or reversing car. */
export const REV_IDLE = 0.18;

/**
 * The gauge's revs 0-1: they climb with the driven wheels' speed through its gear bucket (`gearAt`): `REV_FLOOR` at the bucket's foot,
 * 1 (the redline) at its top, and back down at the next gear's foot. Wheelspin revs the dial with the wheels, not the body (Uncharted 4
 * 13:28: next frame's rpm from the fastest-spinning wheel). Pure function of the car's state and class, so it matches the gear shown beside it.
 */
export function carRpm(car: { style: { id: CarStyleId }; velocity: { x: number; z: number }; fwdFlat: { x: number; z: number }; drive: { spinSpeed: number } }): number {
  const ws = wheelSpeed(car);
  if (ws < 0) return REV_IDLE;
  const k = CLASSES[carClass(car)];
  const g = gearAt(k, ws);
  const lo = gearLo(k, g);
  const hi = gearHi(k, g);
  const share = Math.min(1, (ws - lo) / (hi - lo));
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
 * Retuned with the re-armed hit's damage base (`DeformHit.rearmHit`: read in the frame the clamp keeps, no longer
 * relative to the cell's planted offset): the offset had counted up to 0.12 m of crush into every re-hit, and with
 * it gone 5 of 40 six-car matches (seeds 1–40, 90 s) ended by elimination, against 33 of 40 on the base before.
 * The scale stays (lowering it limps cars earlier and kills fewer: 0.7 → 0/20, 0.6 → 1/20), the wear share takes
 * the lost lethality: 400 → 250 is 53 of 80 matches against the base's 56 of 80, 378 deaths in both.
 */
const DERBY_KILL_SCALE = 0.7935;
const DERBY_WRECK_ENERGY = 250;

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

export type DamageStage = "healthy" | "dented" | "damaged" | "limping" | "dead";

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
  // Lost wheels cost top speed and thrust in `wheelLoss` (the wheels still on), not here.
  const loss = sev * (0.12 * hurt + 0.14 * limp);
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

/** The rolling resistance (m/s²) a driven car feels on a surface of coefficient `crr`: its excess over asphalt's (the sourced launch and power already carry asphalt's share). */
export function rollingOver(crr: number): number {
  return (crr - SURFACES.asphalt.roll) * FRICTION_G;
}

/**
 * Fastest a class holds flat out on a road costing `roll` m/s² over asphalt (`scale`: the boost's thrust): where its constant power meets the
 * drag, `power · scale / roll`; Infinity when that is past the class top (the top, boosted or drafted, caps then).
 */
export function terminalSpeed(s: ClassStats, roll: number, scale = 1, realism = HANDLING.realism): number {
  if (roll <= 0) return Infinity;
  const v = (enginePower(s, realism) * scale) / roll;
  return v >= s.topSpeed ? Infinity : v;
}

/** Fastest a class should take a corner of radius `r` (m) on grip `mu` without sliding or running out of lock. */
export function cornerSpeed(s: ClassStats, r: number, mu = 1, realism = HANDLING.realism): number {
  const grip = s.grip * mu * THREE.MathUtils.lerp(1, REAL_GRIP, THREE.MathUtils.clamp(realism, 0, 1));
  const steerAuth = 0.45 + 0.55 * mu;
  return Math.min(s.topSpeed, Math.sqrt(grip * r), s.turn * steerAuth * r);
}

/** Driven-axle bits of a class's driveline: 1 the front axle, 2 the rear. */
export function drivenAxles(k: ClassStats): number {
  return k.drive === "fwd" ? 1 : k.drive === "rwd" ? 2 : 3;
}

/** Gillespie, Fundamentals of Vehicle Dynamics, ch. 2 "Acceleration Performance": the mass factor (M + M_r) / M ≈ 1 + 0.04 + 0.0025 · N², N the overall engine:wheel ratio. */
const ROTATING_FIXED = 0.04;
const ROTATING_PER_RATIO2 = 0.0025;

/**
 * The driveline's rotating mass as a share of the car's, with the driven wheels at `ws` m/s (Gillespie's mass factor less 1): N is the
 * overall ratio that puts the engine at its redline at `ws`, held at 1st's top below it. Gillespie's per-gear value at every gear's top,
 * continuous between: a per-gear step fed the gear back into the spin and hunted at a bucket edge.
 */
export function rotatingShare(k: ClassStats, ws: number): number {
  const ratio = (((k.redlineRpm * 2 * Math.PI) / 60) * WHEEL_RADIUS * k.wheelScale) / Math.max(ws, gearHi(k, 0));
  return ROTATING_FIXED + ROTATING_PER_RATIO2 * ratio * ratio;
}

/**
 * Gillespie ch. 2 traction-limited acceleration, in g, for the class's driveline on front and rear tyre μ `f`, `r`: the static 50/50 split
 * (`WHEEL_POS` ±AXLE) and the longitudinal transfer a·h/L (h the class CG height, L the wheelbase) give front load share ½ − h·a/(gL), rear
 * ½ + h·a/(gL); fwd a = μF g (½ − h a/(gL)) → ½ μF / (1 + μF h/L); rwd ½ μR / (1 − μR h/L); awd (open centre, equal torque) 2 × the weaker
 * axle's limit; 4wd (locked) the axles' limits add with the transfer moving load from front to rear: ½ (μF + μR) / (1 + (h/L)(μF − μR)).
 */
function tractionG(k: ClassStats, f: number, r: number): number {
  const h = k.cgHeight / (2 * WHEEL_POS[0]![2]);
  return k.drive === "fwd" ? (0.5 * f) / (1 + f * h) : k.drive === "rwd" ? (0.5 * r) / (1 - r * h) : k.drive === "awd" ? Math.min(f / (1 + 2 * f * h), r / (1 - 2 * r * h)) : (0.5 * (f + r)) / (1 + h * (f - r));
}

/**
 * The most forward pull (m/s²) the driven axles pass to the road at `realism`, from the front and rear axle grips (1 = dry asphalt). On dry
 * asphalt it is the class's launch pull at every slider setting: the sourced 0–100 behind `launch` was driven on real tyres, so their traction
 * is in it already, and a cap under it would count the tyre twice. A surface scales that: at the arcade end by the driven axles' grip alone
 * (no load transfer: masterclass 23:19, assists "as subtle as possible"), at the realistic end by what Gillespie's law (`tractionG`, μ = grip ×
 * `MU_TYRE`) gives the layout there against dry asphalt, so a front-driven car loses more of its launch on a loose surface than a rear-driven
 * one and a locked 4wd the least.
 */
export function tractionLimit(k: ClassStats, muF: number, muR: number, realism: number): number {
  const arcade = k.launch[0] * (k.drive === "fwd" ? muF : k.drive === "rwd" ? muR : k.drive === "awd" ? Math.min(muF, muR) : 0.5 * (muF + muR));
  const real = (k.launch[1] * tractionG(k, muF * MU_TYRE, muR * MU_TYRE)) / tractionG(k, MU_TYRE, MU_TYRE);
  return arcade + (real - arcade) * realism;
}

// --- class dressing (visual lift / wheel scale) -------------------------------

type Dressable = {
  readonly group: THREE.Group;
  readonly wheels: readonly THREE.Object3D[];
  /** Lamp seats ride the lift like the body they sit on (bare objects, not children of the group). */
  readonly lamps: readonly { readonly seat: THREE.Object3D }[];
  readonly style: { id: CarStyleId };
};


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
  let body = g.getObjectByName(CLASS_LIFT);
  let hubs = g.getObjectByName(CLASS_HUBS);
  if (!body) {
    body = new THREE.Group();
    body.name = CLASS_LIFT;
    hubs = new THREE.Group();
    hubs.name = CLASS_HUBS;
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
  for (const lamp of car.lamps) lamp.seat.parent = body;
}

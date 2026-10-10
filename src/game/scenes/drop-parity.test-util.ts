import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { makeCar, makeWorld, tickWorld } from "../contact/crash-scenarios.test-util.ts";
import { armSolids, Surface } from "../world/surfaces.ts";
import { carState } from "./contact-parity.test-util.ts";
import { firePiston, fitRigid, PISTON_FAR } from "./piston-rig.test-util.ts";
import { PISTON, type PistonId } from "./piston-rig.ts";

/**
 * A car dropped onto each point the Piston scene's rams strike, set against the ram's own hit
 * (docs/UNIFIED_CONTACT.md section 5, stage 4). Not a test file itself.
 *
 * What is matched: the energy handed to the car. The ram gives a struck car
 * E = hardness * (1/2) * mu * v^2 with mu = M*m/(M+m) (`PistonRig.shotEnergy`, read back as `head.energy`)
 * and sizes its crush by the equivalent barrier speed `head.ebs = sqrt(2E/m)`: the speed at which the car,
 * driven square into an uncrushable face, takes exactly E. The drop delivers that with the car's own
 * weight: it reaches the solid at `ebs`, i.e. falls ebs^2 / (2 g) from its first touch, so its kinetic
 * energy there is m g h = E (one implementation: the rig's own `ebs`, the sim's own `g`).
 * Energy is the invariant because crush is work along the structure's force-stroke curve: the same
 * structure at the same point reaches the same stroke at the same work. Impulse is not: a struck car
 * leaves a ram hit with the shared velocity (J = mu*v) while the dropped car gives all of its momentum
 * to the solid (J = m*ebs, sqrt(hardness*(M+m)/M) times larger), so matching J would crush a different
 * depth; and the peak force is the structure's own property, which is what is being compared.
 *
 * Crush window: from first touch until the deepest particle has stopped sinking (a 1 mm step) for 20 ms,
 * at most 0.3 s: later motion (a car toppling off its corner, settling) is not part of the hit.
 */

const FRAME = 1 / 60;
/** The crush window never runs longer than this after first touch (s). */
const WINDOW_CAP = 0.3;
/** The window ends once the deepest particle has not sunk a further `GROW_MM` for this long (s): the crush has peaked. */
const STALL_S = 0.02;
const GROW_MM = 1;
/** A hit that has crushed nothing deeper than this (mm) has not begun to peak: its window runs to the cap. */
const MIN_CRUSH_MM = 5;
/** A slice whose vertical speed change differs from free fall by more than this (m/s) is the first touch. */
const TOUCH_DV = 0.02;
/** The release height is corrected until the touch speed is within this share of the matched one, at most `SPEED_TRIES` times (the sim's slicing moves it a few %). */
const SPEED_TOL = 0.01;
const SPEED_TRIES = 4;
/** Height of the box's top above the ground (m). */
const BOX_TOP = 0.5;
/** Release height (m) of the car's origin for finding where the first touch is: above every matched fall. */
const PROBE_Y = 40;
const UP = new THREE.Vector3(0, 1, 0);
const RAD = 180 / Math.PI;

/** Where on the car a hit lands, and the face that delivers it (car frame, plan view). */
type Face = {
  /** First paint the face meets, at the face's height (`PISTON.faceY`). */
  x: number;
  z: number;
  /** Unit direction the face pushes the car in (inward). */
  nx: number;
  nz: number;
  width: number;
  height: number;
};

/** A ram's shot: speed (km/h), mass (kg) and face hardness (1 steel, lower is honeycomb). */
type Shot = { kph: number; kg: number; hardness: number };

/** What one hit did to the car inside its crush window. */
type Crush = {
  /** Per body particle (wheel hubs excluded): deepest travel from rest, rigid motion fitted out on the particles far from the strike (mm). */
  travelMm: Record<string, number>;
  /** Engine block travel toward the cabin (mm), cabin intrusion (mm: the largest change between two cabin particles). */
  engineMm: number;
  cabinMm: number;
  /** Parts, mirrors and wheels off the car at the window's end, sorted. */
  off: string[];
  drivetrainAlive: boolean;
  windowMs: number;
};

type PistonHit = Crush & { face: Face; ebs: number; energyJ: number };

/** How the dropped car met the solid, read at its first touch. */
type Landing = {
  /** The angle (deg) between the face's push direction and straight up, at release and at the touch. */
  releaseTiltDeg: number;
  touchTiltDeg: number;
  /** Fall speed just before the touch (m/s). */
  speed: number;
};

type DropHit = Crush & { landing: Landing; fromM: number };

/** Corner rams strike a corner on the ground; the others a box under the point. */
const ON_BOX: Readonly<Record<PistonId, boolean>> = {
  frontLeft: false,
  front: true,
  frontRight: false,
  right: true,
  rearRight: false,
  rear: true,
  rearLeft: false,
  left: true,
};

const REGIONS = {
  nose: ["bumperFL", "bumperFR"],
  frontBay: ["railL", "railR", "engineL", "engineR", "wingFL", "wingFR"],
  cabin: ["cell", "doorL", "doorR", "roof"],
  rear: ["tank", "axleR", "bumperRL", "bumperRR"],
} as const;

const HUBS = ["hubFL", "hubFR", "hubRL", "hubRR"] as const;

const _s = new THREE.Vector3();
const _n = new THREE.Vector3();

let gravity = 0;

/** The sim's gravity (m/s^2), read back from a car in free fall high above the ground. */
function fallAcceleration(): number {
  if (gravity === 0) {
    const car = makeCar("shape");
    car.spawnFacing(0, 0, 0, 0);
    car.group.position.y = 500;
    car.airborne = true;
    const w = makeWorld([car], false, false);
    let t = 0;
    w.world.afterCar = (_c, h) => void (t += h);
    tickWorld(w, FRAME);
    gravity = -car.velocity.y / t;
  }
  return gravity;
}

/** The car's centre-of-mass velocity along unit `axis` (m/s). */
function along(car: DeformableCar, axis: THREE.Vector3): number {
  const d = car.deform;
  if (!d.massActive) return car.velocity.dot(axis);
  let p = 0;
  let mass = 0;
  for (const m of d.masses) {
    if (!m.dynamic) continue;
    p += m.mass * (m.vel.x * axis.x + m.vel.y * axis.y + m.vel.z * axis.z);
    mass += m.mass;
  }
  return mass > 0 ? p / mass : 0;
}

/** Deepest travel so far per body particle, plan-view rigid motion fitted out on the particles far from the strike; returns the deepest one now (mm). */
function sampleTravel(car: DeformableCar, face: Face, peak: Record<string, number>): number {
  const d = car.deform;
  const fit = fitRigid(d.masses, (m) => !m.hub && Math.hypot(m.rest.x - face.x, m.rest.z - face.z) > PISTON_FAR);
  let deepest = 0;
  for (const m of d.masses) {
    if (m.hub) continue;
    const mm = fit(m.local.x, m.local.y, m.local.z).distanceTo(m.rest) * 1000;
    if (mm > (peak[m.name] ?? 0)) peak[m.name] = mm;
    deepest = Math.max(deepest, mm);
  }
  return deepest;
}

/** One hit's measuring state: peaks per particle, the deepest so far and when it last grew, window time, cabin intrusion. */
type Run = { peak: Record<string, number>; deepest: number; grewAt: number; seconds: number; cabinMm: number };

function startRun(car: DeformableCar): Run {
  const peak: Record<string, number> = {};
  for (const m of car.deform.masses) if (!m.hub) peak[m.name] = 0;
  return { peak, deepest: 0, grewAt: 0, seconds: 0, cabinMm: 0 };
}

/** One slice of the window, `dt` long: sample the car; true once the window is over (the crush stopped growing, or the cap). */
function sampleWindow(car: DeformableCar, face: Face, run: Run, dt: number): boolean {
  run.seconds += dt;
  const now = sampleTravel(car, face, run.peak);
  run.cabinMm = Math.max(run.cabinMm, carState(car).cabinMm);
  if (now > run.deepest + GROW_MM) {
    run.deepest = now;
    run.grewAt = run.seconds;
  }
  return run.seconds >= WINDOW_CAP || (run.deepest >= MIN_CRUSH_MM && run.seconds - run.grewAt >= STALL_S);
}

/** The window's measures, read at its end. */
function finish(car: DeformableCar, run: Run): Crush {
  const travelMm: Record<string, number> = {};
  for (const name of Object.keys(run.peak)) travelMm[name] = Math.round(run.peak[name]!);
  const off = [...carState(car).detached];
  for (const hub of HUBS) if (car.deform.hubPopped(hub)) off.push(hub);
  return {
    travelMm,
    engineMm: Math.round(car.deform.engineTravel * 1000),
    cabinMm: run.cabinMm,
    off: off.sort(),
    drivetrainAlive: car.deform.drivetrainAlive,
    windowMs: Math.round(run.seconds * 1000),
  };
}

/** One piston hit on a free car at the origin, in the engine's frame order, measured every slice from first touch. */
function pistonHit(id: PistonId, shot: Shot): PistonHit {
  const car = makeCar("shape");
  const run = startRun(car);
  let face: Face | null = null;
  let over = false;
  const result = firePiston(car, id, {
    speedKph: shot.kph,
    massKg: shot.kg,
    hardness: shot.hardness,
    after: WINDOW_CAP,
    onSlice: (rig, head) => {
      if (over || !head.contacted) return over;
      face ??= {
        x: head.ax + head.nx * head.skinS,
        z: head.az + head.nz * head.skinS,
        nx: head.nx,
        nz: head.nz,
        width: rig.config.faceWidth,
        height: rig.config.faceHeight,
      };
      over = sampleWindow(car, face, run, FRAME / 2);
      return over;
    },
  });
  if (face === null) throw new Error(`piston ${id} never touched the car`);
  return { ...finish(car, run), face, ebs: result.ebs, energyJ: result.energy };
}

/** The box: its middle on the origin, `hw` half-width along unit (ax, az), `hh` half-depth across it. */
type Box = { ax: number; az: number; hw: number; hh: number };

/** The uncrushable box standing `BOX_TOP` high on the flat grip-1 ground, armed as the scene's solids (`armSolids(null)` takes it away). */
function armBox(b: Box): void {
  const solids = new Surface();
  solids.addPrism({ x: 0, z: 0, yaw: Math.atan2(-b.az, b.ax), hx: b.hw, hz: b.hh, base: 0, top: BOX_TOP, id: 0 });
  armSolids(solids);
}

/** The turn that takes the face's push direction to straight up: nose down for a front hit, onto its side for a side hit, onto its corner for a corner hit. */
function turnUp(face: Face): THREE.Quaternion {
  return new THREE.Quaternion().setFromUnitVectors(_n.set(face.nx, 0, face.nz), UP);
}

/** Angle (deg) between the face's push direction, in the car's current pose, and straight up. */
function tiltOf(car: DeformableCar, face: Face): number {
  return Math.acos(Math.min(1, _n.set(face.nx, 0, face.nz).applyQuaternion(car.group.quaternion).y)) * RAD;
}

/** A fresh car at rest turned by `turnUp`, its origin `y` m up and the strike point over the origin of the plan, about to fall. */
function hang(face: Face, y: number): DeformableCar {
  const car = makeCar("shape");
  car.spawnFacing(0, 0, 0, 0);
  const turn = turnUp(face);
  _s.set(face.x, PISTON.faceY, face.z).applyQuaternion(turn);
  car.group.position.set(-_s.x, y, -_s.z);
  car.group.quaternion.copy(turn);
  car.airborne = true;
  car.velocity.set(0, 0, 0);
  car.angular.set(0, 0, 0);
  car.deform.bindKinematic(car.group, car.velocity, car.angular);
  car.refreshBasis();
  return car;
}

/** A fall from `y`: how it met the solid and, with `windowed`, what the hit did to the car. `fell` is the height (m) dropped before the touch slice. */
type Fall = { landing: Landing; fell: number; crush: Crush | null };

function fall(face: Face, y: number, windowed: boolean): Fall {
  const g = fallAcceleration();
  const car = hang(face, y);
  const releaseTiltDeg = tiltOf(car, face);
  const w = makeWorld([car], false, false);
  const run = startRun(car);
  const state = { landing: null as Landing | null, fell: 0, prev: 0, crush: null as Crush | null };
  w.world.afterCar = (c, h) => {
    const vy = along(c, UP);
    if (state.landing === null && Math.abs(vy - (state.prev - g * h)) > TOUCH_DV) {
      state.landing = { releaseTiltDeg, touchTiltDeg: tiltOf(c, face), speed: -state.prev };
      state.fell = (state.prev * state.prev) / (2 * g);
    }
    state.prev = vy;
    if (state.landing === null || state.crush !== null) return;
    if (!windowed || sampleWindow(c, face, run, h)) state.crush = finish(c, run);
  };
  for (let f = 0; f < 60 * 20 && state.crush === null; f++) tickWorld(w, FRAME);
  if (state.landing === null || state.crush === null) throw new Error("the dropped car never touched anything");
  return { landing: state.landing, fell: state.fell, crush: windowed ? state.crush : null };
}

/**
 * Drop a fresh car at rest, its hit direction straight up (see `turnUp`), so that it reaches the solid at the
 * ram's `ebs`: first found where its first touch is (a fall from far above), released `ebs^2 / (2 g)` above
 * that, then the height corrected by what the sim's slicing made of the touch speed. Corners fall on the flat
 * ground; the others on an uncrushable box the size of the ram's face, its middle under the strike point.
 * Measured like the ram's hit: from first touch until the crush stops growing.
 */
function dropHit(id: PistonId, face: Face, ebs: number): DropHit {
  const g = fallAcceleration();
  const fromM = (ebs * ebs) / (2 * g);
  const turn = turnUp(face);
  const across = _n.set(-face.nz, 0, face.nx).applyQuaternion(turn);
  const box: Box = { ax: across.x, az: across.z, hw: face.width * 0.5, hh: face.height * 0.5 };
  if (ON_BOX[id]) armBox(box);
  try {
    let y = PROBE_Y - fall(face, PROBE_Y, false).fell + fromM;
    for (let k = 0; k < SPEED_TRIES; k++) {
      const speed = fall(face, y, false).landing.speed;
      if (Math.abs(speed - ebs) <= SPEED_TOL * ebs) break;
      y += (ebs * ebs - speed * speed) / (2 * g);
    }
    const hit = fall(face, y, true);
    return { ...hit.crush!, landing: hit.landing, fromM };
  } finally {
    armSolids(null);
  }
}

/** Per figure the hit and the drop agree within 15 % or 10 mm, whichever is larger (E4's band). */
function within(drop: number, piston: number): boolean {
  return Math.abs(drop - piston) <= Math.max(10, 0.15 * Math.max(drop, piston));
}

/**
 * Every way the drop's crush differs from the piston hit's, as `figure drop / piston` lines; empty when they
 * agree: crush per particle and per region, the engine block's travel, cabin intrusion, parts off, drivetrain.
 */
export function dropMismatch(drop: Crush, piston: Crush): string[] {
  const out: string[] = [];
  for (const name of Object.keys(piston.travelMm)) {
    const d = drop.travelMm[name]!;
    const p = piston.travelMm[name]!;
    if (!within(d, p)) out.push(`${name} crush ${d} / ${p} mm`);
  }
  for (const [region, names] of Object.entries(REGIONS)) {
    const d = Math.max(...names.map((n) => drop.travelMm[n]!));
    const p = Math.max(...names.map((n) => piston.travelMm[n]!));
    if (!within(d, p)) out.push(`${region} deepest ${d} / ${p} mm`);
  }
  if (!within(drop.engineMm, piston.engineMm)) out.push(`engine block travel ${drop.engineMm} / ${piston.engineMm} mm`);
  if (!within(drop.cabinMm, piston.cabinMm)) out.push(`cabin intrusion ${drop.cabinMm} / ${piston.cabinMm} mm`);
  if (drop.off.join() !== piston.off.join()) out.push(`parts off [${drop.off}] / [${piston.off}]`);
  if (drop.drivetrainAlive !== piston.drivetrainAlive) out.push(`drivetrain alive ${drop.drivetrainAlive} / ${piston.drivetrainAlive}`);
  return out;
}

/** What is wrong with how the drop met the solid (not with its crush): wrong speed or a hit axis off vertical. Empty when it is right. */
export function landingMismatch(landing: Landing, ebs: number): string[] {
  const out: string[] = [];
  if (Math.abs(landing.speed - ebs) > 0.03 * ebs) out.push(`touch speed ${landing.speed.toFixed(2)} / ${ebs.toFixed(2)} m/s`);
  if (landing.releaseTiltDeg > 0.1) out.push(`hit axis ${landing.releaseTiltDeg.toFixed(2)} deg off vertical at release`);
  if (landing.touchTiltDeg > 2) out.push(`hit axis ${landing.touchTiltDeg.toFixed(1)} deg off vertical at touch`);
  return out;
}

const runs = new Map<string, { piston: PistonHit; drop: DropHit }>();

/** The ram's hit and the matched drop for one point and shot; each pair is run once and shared. */
export function strikeAndDrop(id: PistonId, shot: Shot): { piston: PistonHit; drop: DropHit } {
  const key = `${id} ${shot.kph} ${shot.kg} ${shot.hardness}`;
  let run = runs.get(key);
  if (run === undefined) {
    const piston = pistonHit(id, shot);
    run = { piston, drop: dropHit(id, piston.face, piston.ebs) };
    runs.set(key, run);
  }
  return run;
}

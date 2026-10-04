import * as THREE from "three";
import { applyDrive, type DriveInput } from "./car-drive.ts";
import { DeformableCar } from "./car.ts";
import { UNDERSIDE } from "./car-suspension.ts";
import { HULL } from "./car-air.ts";
import { assignClass, CLASSES, type VehicleClassId } from "./vehicle-classes.ts";
import { paint } from "./test-support.ts";
import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { newWorld, stepWorld, type World } from "../engine/world-step.ts";
import { setGround, type Ground } from "../world/ground.ts";
import { blankPoint, blankProjection, pointOn, type Track } from "../world/track.ts";

/**
 * How a car sits on ANY `Ground`, read straight off its drawn pose, for the drop matrix (`ground-fit.test.ts`) and the
 * driving sweeps: every tyre's clearance, the body's pitch and roll against the ground under its hubs, and how deep its
 * underside is in the ground. All of it asks `Ground.heightAt` (the one door wheels, hull and FX use); there is no
 * ramp, bank or crest path. Not a test file itself.
 */
export const FRAME = 1 / 60;
export const DEG = 180 / Math.PI;

/** The tyre's tread as `TYRE_PROFILE` draws it (wheel-local, axle along x): crown and shoulders, [axle offset, radius]. */
const TREAD_RINGS = [
  [0, 0.32],
  [0.082, 0.314],
  [-0.082, 0.314],
  [0.104, 0.298],
  [-0.104, 0.298],
] as const;
const TREAD: THREE.Vector3[] = [];
for (let a = 0; a < 48; a++) {
  const t = (a / 48) * Math.PI * 2;
  for (const [x, r] of TREAD_RINGS) TREAD.push(new THREE.Vector3(x, Math.cos(t) * r, Math.sin(t) * r));
}
/** The body's front bumper corners, over the underside samples (car-local x, y, z; `HULL` in car-air.ts). */
const BUMPERS = [-1, 1].flatMap((sx) => [-1, 1].map((sz): [number, number, number] => [sx * 0.88, 0.35, sz * 2.22]));

/** Height hints are the asking point plus this (m): the layer rule (`STEP_UP`, a ramp's kerb) reads them. */
const HINT_ABOVE = 1;

export type Fit = {
  airborne: boolean;
  /** Per tyre (`WHEEL_POS` order): its lowest tread point's height above the ground under it (m; < 0 sunk in). */
  gaps: number[];
  /** Drawn body pitch (nose up +) and roll (+x side up), and the ground's under the four hubs (deg). */
  pitch: number;
  groundPitch: number;
  roll: number;
  groundRoll: number;
  /** Angle (deg) between the drawn body's up and the mean ground normal under the four hubs. */
  tilt: number;
  /** The physics frame's own pitch / roll (deg), before the springs. */
  framePitch: number;
  frameRoll: number;
  /** Deepest underside or bumper point under the ground as the physics reads it (each point asks `heightAt` at its own
   *  height: a face more than a kerb above it is a wall, not floor) (m, ≥ 0), and where. */
  pen: number;
  penAt: string;
  /** The same, asking at the body's height + 1 m: a wall's depth too (a fleet ramp's side face the car is inside). */
  overlap: number;
  overlapAt: string;
  /** Lowest clearance of any underside or bumper point over the ground as the physics reads it (m; negative is `pen`).
   *  Within 2 cm, the hull is resting on the ground, so a tyre hanging in the air is the belly on a crest, not a float. */
  hull: number;
  /** Angle (deg) of the mean ground normal under the four hubs from vertical: how steep the ground is under the car. */
  slope: number;
  /** How far the ground under the four hubs is from one plane (m): the height one hub sits off the plane of the other
   *  three. Above a couple of cm no rigid body sits on all four hubs, so no pose bound is fair there. */
  warp: number;
  /** The most (deg) a hub's ground normal differs from the mean one: a crease or a curved crest under the car, where
   *  "tilt from the mean normal" is not a pose the four tyres can all take. */
  spread: number;
  /** Half the tread's width (m): a tyre turned `t` deg off the ground it stands on digs its outer shoulder `shoulder · sin t` in. */
  shoulder: number;
  /** The deepest face crush (m, `load-crush.ts`): a car lying on a face yields it by its weight, and the hull points follow
   *  the crushed face inward, so a probe at the stock face reads that much penetration for a body that is where it should be. */
  crush: number;
};

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m = new THREE.Vector3();
const _hub: THREE.Vector3[] = [0, 1, 2, 3].map(() => new THREE.Vector3());
const _g = [0, 0, 0, 0];

export function makeCar(cls: VehicleClassId): DeformableCar {
  const car = new DeformableCar(paint(), new THREE.Scene(), null, CLASSES[cls].style);
  assignClass(car, cls);
  return car;
}

/** One rendered frame at 60 Hz (the engine's slicing); `input` null leaves the car undriven. */
export function frame(w: World, input: DriveInput | null, st: { acc: number }): void {
  st.acc = Math.min(0.05, st.acc + FRAME);
  while (st.acc > 1e-5) {
    const h = physicsSlice(st.acc, sliceSpeed(w.cars));
    if (input) for (const c of w.cars) applyDrive(c, input, h);
    stepWorld(w, h);
    for (const c of w.cars) c.stepBreakage(h);
    st.acc -= h;
  }
  for (const c of w.cars) c.updateSkin();
}

export function worldOf(car: DeformableCar, collide: ((c: DeformableCar) => unknown) | null = null): World {
  const w = newWorld([car]);
  if (collide) w.collide = (c) => void collide(c);
  return w;
}

function axisPitch(e: ArrayLike<number>, o: number): number {
  return Math.asin(Math.max(-1, Math.min(1, e[o + 1]! / Math.hypot(e[o]!, e[o + 1]!, e[o + 2]!)))) * DEG;
}

/** How `car` sits on `ground` now. */
export function fit(car: DeformableCar, ground: Ground): Fit {
  car.group.updateWorldMatrix(true, true);
  const body = car.group.getObjectByName("classLift")!;
  const e = body.matrixWorld.elements;
  const gy = car.group.position.y;
  const gaps: number[] = [];
  car.wheels.forEach((wh, i) => {
    wh.getWorldPosition(_hub[i]!);
    const hint = _hub[i]!.y;
    let gap = Infinity;
    for (const t of TREAD) {
      _p.copy(t).applyMatrix4(wh.matrixWorld);
      const g = ground.heightAt(_p.x, _p.z, hint);
      if (g !== -Infinity) gap = Math.min(gap, _p.y - g);
    }
    gaps.push(gap);
    _g[i] = ground.heightAt(_hub[i]!.x, _hub[i]!.z, hint);
  });
  const mid = (a: number, b: number, c: "x" | "z") => (_hub[a]![c] + _hub[b]![c]) / 2;
  const planFB = Math.hypot(mid(0, 1, "x") - mid(2, 3, "x"), mid(0, 1, "z") - mid(2, 3, "z"));
  const planLR = Math.hypot(mid(1, 3, "x") - mid(0, 2, "x"), mid(1, 3, "z") - mid(0, 2, "z"));
  const groundPitch = Math.atan2((_g[0]! + _g[1]!) / 2 - (_g[2]! + _g[3]!) / 2, planFB) * DEG;
  const groundRoll = Math.atan2((_g[1]! + _g[3]!) / 2 - (_g[0]! + _g[2]!) / 2, planLR) * DEG;
  _m.set(0, 0, 0);
  for (let i = 0; i < 4; i++) _m.add(ground.normalAt(_hub[i]!.x, _hub[i]!.z, _n, _hub[i]!.y));
  _m.normalize();
  let spread = 0;
  for (let i = 0; i < 4; i++) {
    spread = Math.max(spread, Math.acos(Math.min(1, ground.normalAt(_hub[i]!.x, _hub[i]!.z, _n, _hub[i]!.y).dot(_m))) * DEG);
  }
  const up = _p.set(e[4]!, e[5]!, e[6]!).normalize();
  const tilt = Math.acos(Math.min(1, up.dot(_m))) * DEG;
  const slope = Math.acos(Math.min(1, _m.y)) * DEG;
  const warp = Math.abs(_g[0]! - _g[1]! - _g[2]! + _g[3]!);
  let pen = 0;
  let penAt = "";
  let overlap = 0;
  let overlapAt = "";
  let hull = Infinity;
  const probe = (name: string, x: number, y: number, z: number) => {
    _p.set(x, y, z).applyMatrix4(body.matrixWorld);
    const own = ground.heightAt(_p.x, _p.z, _p.y);
    if (own !== -Infinity) {
      hull = Math.min(hull, _p.y - own);
      if (own - _p.y > pen) {
        pen = own - _p.y;
        penAt = name;
      }
    }
    const wide = ground.heightAt(_p.x, _p.z, gy + HINT_ABOVE);
    if (wide !== -Infinity && wide - _p.y > overlap) {
      overlap = wide - _p.y;
      overlapAt = name;
    }
  };
  for (const [x, z, h] of UNDERSIDE) probe(`under(${x},${z})`, x, h, z);
  for (const [x, y, z] of BUMPERS) probe(`bumper(${x > 0 ? "+" : "-"}x,${z > 0 ? "front" : "rear"})`, x, y, z);
  // Beltline and roof corners (`HULL` in car-air.ts, as the drawn body carries them), so a car on its side or roof is judged on
  // the points it lies on.
  for (let i = 4; i < HULL.length; i++) {
    const [x, y, z] = HULL[i]!;
    probe(`hull(${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)})`, x, y, z);
  }
  const ge = car.group.matrixWorld.elements;
  return {
    airborne: car.airborne,
    gaps,
    pitch: axisPitch(e, 8),
    groundPitch,
    roll: axisPitch(e, 0),
    groundRoll,
    tilt,
    framePitch: axisPitch(ge, 8),
    frameRoll: axisPitch(ge, 0),
    pen,
    penAt,
    overlap,
    overlapAt,
    hull,
    slope,
    warp,
    spread,
    shoulder: 0.104 * car.wheels[0]!.scale.x,
    crush: Math.max(...car.deform.crush),
  };
}

/** Largest |gap| of the four tyres (m). */
export function worstGap(f: Fit): number {
  return Math.max(...f.gaps.map(Math.abs));
}

const BRAKE: DriveInput = { throttle: 0, steer: 0, brake: 1, ebrake: true, boost: false };

export type Drop = Fit & { slide: number; speed: number };

/**
 * One car dropped `height` m above the ground at (x, z) facing `yaw` and held (brake and handbrake) for `seconds`:
 * where it ends up and how it sits. `ground` is made the active one; the caller restores it.
 */
export function drop(
  ground: Ground,
  cls: VehicleClassId,
  x: number,
  z: number,
  yaw: number,
  o: { height?: number; seconds?: number; hint?: number; collide?: ((c: DeformableCar) => unknown) | null } = {},
): Drop {
  setGround(ground);
  const car = makeCar(cls);
  car.spawnFacing(x, z, yaw, 0);
  car.group.position.y = ground.heightAt(x, z, o.hint) + (o.height ?? 0.5);
  const w = worldOf(car, o.collide ?? null);
  const st = { acc: 0 };
  for (let f = 0; f < (o.seconds ?? 3) / FRAME; f++) frame(w, BRAKE, st);
  const r = fit(car, ground);
  const slide = Math.hypot(car.group.position.x - x, car.group.position.z - z);
  const speed = car.velocity.length();
  car.dispose();
  return { ...r, slide, speed };
}

export type Sample = Fit & { s: number; lateral: number; speed: number; y: number };

/**
 * One car driven down `track`'s main loop from `s0` to `s1` (m along it) at `lateral` m left of the centreline, its
 * throttle holding `pace(s)` m/s (a pursuit line steers it), one `Fit` per rendered frame. The car starts `lead` m
 * before `s0` at `pace(s0)` so it arrives in its stride. From `brakeFrom` (m along) on, the throttle is released and
 * the brake held, and the run ends two seconds after the car stops. `ground` is made the active one; the caller
 * restores it.
 */
export function drive(
  track: Track,
  cls: VehicleClassId,
  s0: number,
  s1: number,
  pace: (s: number) => number,
  o: { lateral?: number; lead?: number; brakeFrom?: number; each?: (car: DeformableCar, f: Sample) => void } = {},
): Sample[] {
  const path = track.path;
  const ground = track.ground();
  setGround(ground);
  const car = makeCar(cls);
  const pt = blankPoint();
  const lat = o.lateral ?? 0;
  const at = (s: number) => {
    pointOn(path, s, pt);
    return [pt.x + pt.tz * lat, pt.z - pt.tx * lat] as const;
  };
  const start = s0 - (o.lead ?? 40);
  const [x0, z0] = at(start);
  car.spawnFacing(x0, z0, Math.atan2(pt.tx, pt.tz), pace(start));
  car.group.position.y = ground.heightAt(x0, z0, pt.y + 0.5);
  const w = worldOf(car);
  const st = { acc: 0 };
  const proj = blankProjection();
  const input: DriveInput = { throttle: 0, steer: 0, brake: 0, ebrake: false, boost: false };
  const out: Sample[] = [];
  let still = 0;
  const maxFrames = Math.ceil(((s1 - start) / 4) * 60);
  for (let n = 0; n < maxFrames; n++) {
    const p = car.group.position;
    const s = track.project(p.x, p.z, proj.k, proj).s;
    if (s > s1 && s < s1 + 100) break;
    const [tx, tz] = at(s + 8 + car.speed * 0.4);
    const err = Math.atan2(tx - p.x, tz - p.z) - car.yaw;
    input.steer = Math.max(-1, Math.min(1, 2.5 * Math.atan2(Math.sin(err), Math.cos(err))));
    const braking = s >= (o.brakeFrom ?? Infinity);
    const v = pace(s);
    input.throttle = !braking && car.speed < v ? 1 : 0;
    input.brake = braking || car.speed > v + 2 ? 1 : 0;
    frame(w, input, st);
    if (s >= s0) {
      const f: Sample = { ...fit(car, ground), s, lateral: proj.lateral, speed: car.speed, y: car.group.position.y };
      out.push(f);
      o.each?.(car, f);
    }
    still = braking && car.speed < 0.05 ? still + 1 : 0;
    if (still > 120) break;
  }
  car.dispose();
  return out;
}

/** One matrix cell: a drop's `Fit`; `slide` is how far the car moved (a rolled-to-stop car: how far it rolled). */
export type Cell = Fit & { slide: number };

const WIDTHS = [38, 8, 27, 7, 5, 10, 9, 6, 7, 7, 6, 10, 7];
const HEADS = ["site", "heading", "gaps cm [F-x F+x R-x R+x]", "hull cm", "tilt°", "pitch err°", "roll err°", "slope°", "warp cm", "spread°", "pen cm", "overlap cm", "slide m"];
const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
const num = (v: number, digits: number, i: number) => v.toFixed(digits).padStart(WIDTHS[i]!);

/** The header of the matrix table (two lines): a valid markdown table together with the rows of `matrixRow`. */
export const MATRIX_HEAD = `${line([...HEADS.map((h, i) => (i < 2 ? h.padEnd(WIDTHS[i]!) : h.padStart(WIDTHS[i]!))), "flags"])}\n|${[...WIDTHS, 5].map((w) => "-".repeat(w + 2)).join("|")}|`;

/**
 * One aligned markdown row for `site` at `heading`: the tyre gaps (cm; < 0 sunk), the hull's lowest clearance, the body
 * tilt from the mean ground normal, pitch and roll error against the ground under the hubs, how steep and how warped
 * the ground under the hubs is, the deepest underside point in the ground (`pen`) and in a wall (`overlap`), and the
 * slide (m). `flags` names the failed bounds.
 */
export function matrixRow(site: string, heading: string, r: Cell, flags = ""): string {
  return line([
    site.padEnd(WIDTHS[0]!),
    heading.padEnd(WIDTHS[1]!),
    r.gaps.map((g) => (g * 100).toFixed(1).padStart(6)).join(" "),
    num(r.hull * 100, 1, 3),
    num(r.tilt, 2, 4),
    num(r.pitch - r.groundPitch, 2, 5),
    num(r.roll - r.groundRoll, 2, 6),
    num(r.slope, 1, 7),
    num(r.warp * 100, 1, 8),
    num(r.spread, 1, 9),
    num(r.pen * 100, 1, 10),
    num(r.overlap * 100, 1, 11),
    num(r.slide, 2, 12),
    flags,
  ]);
}

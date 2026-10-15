import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { COM_Y, G, TOUCH } from "../vehicle/car-air-body.ts";
import { JerseyBarrier } from "./engine-props.ts";
import { FleetRamps, RAMP } from "./fleet-ramps.ts";
import { collideOn } from "./ramp-collide.test-util.ts";
import { setGround } from "../world/ground.ts";
import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { paint } from "../vehicle/test-support.ts";
import { newWorld, stepWorld, type World } from "../engine/world-step.ts";
import { applyDrive, idleDrive } from "../vehicle/car-drive.ts";
import { assignClass, type VehicleClassId } from "../vehicle/vehicle-classes.ts";
import { frame, FRAME } from "../vehicle/ground-probe.test-util.ts";

/**
 * The fleet ramps' headless harness (`fleet-ramps.test.ts` and the neighbourhood sweeps of `fleet-ramps.ai-long-run.ts`): the scene,
 * the engine's frame, two cars head-on up the two ramps, and the ballistic watch of a car's height. Not a test file itself.
 */
/** The most (m) a slice's resting contact may lift a body that has stopped on its belly: the tolerance of the dy bound below. */
const REST_LIFT = 0.02;
/** How far (m) a frame with an end on the ground may drop its origin beyond the speeds: a wreck's origin lands onto its floor band by up to this in a slice. */
const WRECK_DROP = 0.1;
/** The rise of a ramp's face per metre along it (`RAMP`). */
const RAMP_SLOPE = RAMP.top / RAMP.len;
const DEG = 180 / Math.PI;

/** Ramps on a slab whose long axis is +z (the engine's end-on placement), and one car `x0` across, `z0` along. */
export function scene(withSlab: boolean): { ramps: FleetRamps; w: World; car: DeformableCar } {
  const three = new THREE.Scene();
  const ramps = new FleetRamps(three);
  const slab = withSlab ? new JerseyBarrier(three, new THREE.Group()) : null;
  slab?.reset();
  ramps.place(0, slab);
  setGround(ramps);
  const car = new DeformableCar(paint(), three);
  const w = newWorld([car], slab);
  w.collide = collideOn(ramps);
  return { ramps, w, car };
}

/** Runs the world for `seconds` of frames: `slice` after every physics slice, `each` after every frame. */
export function run(w: World, seconds: number, each: () => void, slice?: (h: number) => void): void {
  let acc = 0;
  for (let t = 0; t < seconds; t += FRAME) {
    for (const c of w.cars) if (c.crashed && c.deform.drivetrainAlive) applyDrive(c, idleDrive(), FRAME);
    acc = Math.min(0.05, acc + FRAME);
    while (acc > 1e-5) {
      const h = physicsSlice(acc, sliceSpeed(w.cars));
      stepWorld(w, h);
      for (const c of w.cars) c.stepBreakage(h);
      acc -= h;
      slice?.(h);
    }
    for (const c of w.cars) c.updateSkin();
    each();
  }
}

/** Two cars head-on up the two ramps (no slab): `vA` from −z, `vB` from +z, `dx` m apart across. */
export function pair(vA: number, vB: number, dx = 0.4): { w: World; cars: [DeformableCar, DeformableCar] } {
  const { ramps, w } = scene(false);
  const b = new DeformableCar(paint(), new THREE.Scene());
  w.cars[0]!.spawnFacing(0, -14, 0, vA);
  b.spawnFacing(dx, 14, Math.PI, vB);
  const w2 = newWorld([w.cars[0]!, b]);
  w2.collide = collideOn(ramps);
  return { w: w2, cars: [w.cars[0]!, b] };
}

/**
 * Ballistic check per frame: the height a car moves in a frame must be what its vertical speeds say, give or take a
 * snap's 2 cm (a snap to the ground, or a height that never moves under a stale speed, falls outside). In flight at both
 * ends the height is the centre of mass's, whose speed `velocity` is (`stepAir`); on the ground it is the origin's.
 *
 * The speeds are every slice's (`slice`), not the frame's two ends: a slice's contact can reverse a speed inside the
 * frame, and the frame's end speeds alone then put the same motion in or out of its bound by which slice the frame ended
 * on (a landing wreck's frame 101 moved 3.3 cm inside the speeds of its first slice and outside those at its end).
 * `stepAir` is semi-implicit: `v −= G·h`, `y += v·h`, then the contacts' impulses and lift. So:
 *  - Without an impulse in the frame, y moved by Σ vₖ·hₖ over the slices' speeds: dy ∈ [vmin, vmax]·F, ±2 cm.
 *  - With one (a slice's speed changed by more than gravity, or a car on the ground), a slice moved by the speed before
 *    its impulse (at least vmin − G·h), and the contact then lifted by at most the depth it had fallen in, which its
 *    impulse took the speed of: dy ∈ [(vmin − G·hmax)·F, max(vmax, 0)·F], ±(`TOUCH` + `REST_LIFT`): the two ways a slice's
 *    contact moves a body with no speed (a wheel that close counts as down; a body stopped on its belly lifts out of the
 *    belly's depth, up to `REST_LIFT` a slice).
 *  - A shove along a ramp's face (two cars meeting, or a car struck): it moves a body along the plan by at most the closing speed of
 *    the pair (a car alone: its own speed) over the frame, and the face under its tyres rises by its slope (`RAMP_SLOPE`) times that
 *    travel; the contact lifts the body out of it in the frame: the same bound again, plus that lift, with no speed to show for it.
 *  - A frame with an end on the ground measures the group's origin, which a wreck's pose keeps in a band over
 *    its floor: the frame drops onto the band by up to `WRECK_DROP` in a slice (beyond that the wreck goes aloft instead), so
 *    a drop is allowed that much (measured over the cells below: 0.0116 m past the speeds, 16/9/0.4 car B frame 121). A rise
 *    is not: a wreck in flight lands on a wedge's end only from within `WRECK_DROP` and its fall under its top (under that the end is
 *    a wall: its frame rose 0.24 m with no speed, and the masses were shoved after it, on main). A snap past that (a struck
 *    flier dropped 1.85 m onto the ground) is still outside.
 */
export function watch(cars: readonly DeformableCar[]): { list: string[]; frame: () => void; slice: (h: number) => void } {
  const heights = (c: DeformableCar): [number, number] => {
    const q = c.group.quaternion;
    return [c.group.position.y, c.group.position.y + COM_Y * (1 - 2 * (q.x * q.x + q.z * q.z))];
  };
  const last = cars.map((c) => [...heights(c), c.velocity.y, c.airborne] as const);
  const vmin = cars.map((c) => c.velocity.y);
  const vmax = [...vmin];
  const prev = [...vmin];
  const touch = cars.map((c) => !c.airborne);
  let hmax = 0;
  let approach = 0;
  const list: string[] = [];
  let n = 0;
  return {
    list,
    slice: (h) => {
      hmax = Math.max(hmax, h);
      const [first, second] = cars;
      approach = Math.max(approach, Math.hypot(first!.velocity.x - (second?.velocity.x ?? 0), first!.velocity.z - (second?.velocity.z ?? 0)));
      for (const [i, c] of cars.entries()) {
        const vy = c.velocity.y;
        vmin[i] = Math.min(vmin[i]!, vy);
        vmax[i] = Math.max(vmax[i]!, vy);
        if (!c.airborne || Math.abs(vy - prev[i]! + G * h) > 1e-6) touch[i] = true;
        prev[i] = vy;
      }
    },
    frame: () => {
      n++;
      for (const [i, c] of cars.entries()) {
        const [o0, com0, vy0, air0] = last[i]!;
        const [o, com] = heights(c);
        const flying = air0 && c.airborne;
        const y0 = flying ? com0 : o0;
        const y = flying ? com : o;
        const dy = y - y0;
        const tol = touch[i] ? TOUCH + REST_LIFT + RAMP_SLOPE * approach * FRAME : 0.02;
        const lo = (touch[i] ? vmin[i]! - G * hmax : vmin[i]!) * FRAME - tol - (flying ? 0 : WRECK_DROP);
        const hi = (touch[i] ? Math.max(vmax[i]!, 0) : vmax[i]!) * FRAME + tol;
        if (dy < lo || dy > hi) {
          list.push(`car ${i} frame ${n}: y ${y0.toFixed(3)} → ${y.toFixed(3)}, vy ${vy0.toFixed(2)} → ${c.velocity.y.toFixed(2)} (slices ${vmin[i]!.toFixed(2)}..${vmax[i]!.toFixed(2)})`);
        }
        last[i] = [o, com, c.velocity.y, c.airborne];
        vmin[i] = vmax[i] = prev[i] = c.velocity.y;
        touch[i] = !c.airborne;
      }
      hmax = 0;
      approach = 0;
    },
  };
}

/**
 * A car driven by the game's own drive model (`applyDrive`: throttle holding 3 m/s, steering never, so it pushes only while
 * its tyres grip) at the +z ramp's side from 3.3 m out, `off` deg off the run (90 = square to the side), aimed so its centre
 * line meets the side wall where the wall stands `wall` m high. Its worst roll about its own nose (deg, the lean of its right
 * side) and highest point while it enters: until its centre passes the ramp's midline, comes within 1 m of the high end (where
 * a jump starts), or `frames` (default 360: 6 s) are up. `dx` moves the spawn along +x (m).
 */
export function approachSide(cls: VehicleClassId, off: number, wall: number, { frames = 360, dx = 0 } = {}): { roll: number; high: number; z: number } {
  const { w, car } = scene(false);
  assignClass(car, cls);
  const th = off / DEG;
  const zWall = RAMP.start + ((RAMP.top - wall) * RAMP.len) / RAMP.top;
  car.spawnFacing(RAMP.halfW + 3.3 + dx, zWall + 3.3 / Math.tan(th), Math.PI + th, 0);
  const q = car.group.quaternion;
  const right = new THREE.Vector3();
  const input = { throttle: 0, steer: 0, brake: 0, ebrake: false, boost: false };
  const st = { acc: 0 };
  let roll = 0;
  let high = 0;
  const p = car.group.position;
  for (let f = 0; f < frames && p.z > RAMP.start + 1 && p.x > 0; f++) {
    input.throttle = Math.max(0, Math.min(1, (3 - car.speed) / 1.5));
    frame(w, input, st);
    roll = Math.max(roll, Math.abs(Math.asin(Math.max(-1, Math.min(1, right.set(1, 0, 0).applyQuaternion(q).y)))) * DEG);
    high = Math.max(high, p.y);
  }
  const out = { roll, high, z: p.z };
  car.dispose();
  return out;
}


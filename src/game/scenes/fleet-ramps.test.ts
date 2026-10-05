import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { COM_Y, G, REST_LIFT, TOUCH } from "../vehicle/car-air.ts";
import { CAR_HALF } from "../vehicle/car-mesh.ts";
import { LIFT_OFF } from "../deform/deform-contact.ts";
import { JerseyBarrier } from "./engine-props.ts";
import { FleetRamps, RAMP } from "./fleet-ramps.ts";
import { setGround } from "../world/ground.ts";
import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { paint } from "../vehicle/test-support.ts";
import { newWorld, stepWorld, type World } from "../engine/world-step.ts";
import { assignClass, VEHICLE_CLASS_IDS, type VehicleClassId } from "../vehicle/vehicle-classes.ts";
import { frame } from "../vehicle/ground-probe.test-util.ts";

const FRAME = 1 / 60;
const TYRE_CENTRE = 0.32;
const DEG = 180 / Math.PI;

/** Ramps on a slab whose long axis is +z (the engine's end-on placement), and one car `x0` across, `z0` along. */
function scene(withSlab: boolean): { ramps: FleetRamps; w: World; car: DeformableCar } {
  const three = new THREE.Scene();
  const ramps = new FleetRamps(three);
  const slab = withSlab ? new JerseyBarrier(three, new THREE.Group()) : null;
  slab?.reset();
  ramps.place(0, slab);
  setGround(ramps);
  const car = new DeformableCar(paint(), three);
  const w = newWorld([car], slab);
  w.collide = (c, _i, h) => void ramps.contact(c, h);
  return { ramps, w, car };
}

/** Runs the world for `seconds` of frames: `slice` after every physics slice, `each` after every frame. */
function run(w: World, seconds: number, each: () => void, slice?: (h: number) => void): void {
  let acc = 0;
  for (let t = 0; t < seconds; t += FRAME) {
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
function pair(vA: number, vB: number, dx = 0.4): { w: World; cars: [DeformableCar, DeformableCar] } {
  const { ramps, w } = scene(false);
  const b = new DeformableCar(paint(), new THREE.Scene());
  w.cars[0]!.spawnFacing(0, -14, 0, vA);
  b.spawnFacing(dx, 14, Math.PI, vB);
  const w2 = newWorld([w.cars[0]!, b]);
  w2.collide = (c, _i, h) => void ramps.contact(c, h);
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
 *  - A frame with an end on the ground measures the group's origin, which a wreck's pose (`followGroup`) keeps in a band over
 *    its floor: the frame drops onto the band by up to `LIFT_OFF` in a slice (beyond that the wreck goes aloft instead), so
 *    a drop is allowed that much (measured over the cells below: 0.0116 m past the speeds, 16/9/0.4 car B frame 121). A rise
 *    is not: a wreck in flight lands on a wedge's end only from within `LIFT_OFF` and its fall under its top (under that the end is
 *    a wall: its frame rose 0.24 m with no speed, and the masses were shoved after it, on main). A snap past that (a struck
 *    flier dropped 1.85 m onto the ground) is still outside.
 */
function watch(cars: readonly DeformableCar[]): { list: string[]; frame: () => void; slice: (h: number) => void } {
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
  const list: string[] = [];
  let n = 0;
  return {
    list,
    slice: (h) => {
      hmax = Math.max(hmax, h);
      cars.forEach((c, i) => {
        const vy = c.velocity.y;
        vmin[i] = Math.min(vmin[i]!, vy);
        vmax[i] = Math.max(vmax[i]!, vy);
        if (!c.airborne || Math.abs(vy - prev[i]! + G * h) > 1e-6) touch[i] = true;
        prev[i] = vy;
      });
    },
    frame: () => {
      n++;
      cars.forEach((c, i) => {
        const [o0, com0, vy0, air0] = last[i]!;
        const [o, com] = heights(c);
        const flying = air0 && c.airborne;
        const y0 = flying ? com0 : o0;
        const y = flying ? com : o;
        const dy = y - y0;
        const tol = touch[i] ? TOUCH + REST_LIFT : 0.02;
        const lo = (touch[i] ? vmin[i]! - G * hmax : vmin[i]!) * FRAME - tol - (flying ? 0 : LIFT_OFF);
        const hi = (touch[i] ? Math.max(vmax[i]!, 0) : vmax[i]!) * FRAME + tol;
        if (dy < lo || dy > hi) {
          list.push(`car ${i} frame ${n}: y ${y0.toFixed(3)} → ${y.toFixed(3)}, vy ${vy0.toFixed(2)} → ${c.velocity.y.toFixed(2)} (slices ${vmin[i]!.toFixed(2)}..${vmax[i]!.toFixed(2)})`);
        }
        last[i] = [o, com, c.velocity.y, c.airborne];
        vmin[i] = vmax[i] = prev[i] = c.velocity.y;
        touch[i] = !c.airborne;
      });
      hmax = 0;
    },
  };
}

type Jump = { air: number; peak: number; noseOff: number; turn: number; sink: number; gaps: number[]; endZ: number; slabHit: boolean; crashed: boolean };

/**
 * One car at `v` m/s up the −z ramp, end-on over the slab. Flight: frames with every tyre more than 5 cm off the
 * ground. noseOff: the most the nose's elevation strays from the flight path's (deg) after the first 0.1 s of
 * flight; turn: the most the nose's elevation changes in one frame (deg) from takeoff to 0.5 s after touchdown (a
 * snap); sink: the deepest any tyre gets into the ground over the run (m).
 */
function jump(v: number): Jump {
  const { ramps, w, car } = scene(true);
  car.spawnFacing(0, -14, 0, v);
  const p = car.group.position;
  const q = car.group.quaternion;
  const wp = new THREE.Vector3();
  const f = new THREE.Vector3();
  const gaps = [0, 0, 0, 0];
  let air = 0;
  let peak = 0;
  let noseOff = 0;
  let turn = 0;
  let sink = 0;
  let since = -1;
  let lastNose = 0;
  run(w, 3, () => {
    car.group.updateWorldMatrix(true, true);
    car.wheels.forEach((wh, i) => {
      wh.getWorldPosition(wp);
      gaps[i] = wp.y - TYRE_CENTRE - ramps.heightAt(wp.x, wp.z, wp.y);
    });
    sink = Math.max(sink, -Math.min(...gaps));
    peak = Math.max(peak, p.y);
    const nose = Math.asin(f.set(0, 0, 1).applyQuaternion(q).y) * DEG;
    const path = Math.atan2(car.velocity.y, Math.hypot(car.velocity.x, car.velocity.z)) * DEG;
    const flying = Math.min(...gaps) > 0.05;
    if (flying) {
      air += FRAME;
      since = 0;
      if (air > 0.1) noseOff = Math.max(noseOff, Math.abs(nose - path));
    } else if (since >= 0) since += FRAME;
    if (air > 0 && since < 0.5) turn = Math.max(turn, Math.abs(nose - lastNose));
    lastNose = nose;
  });
  return { air, peak, noseOff, turn, sink, gaps, endZ: p.z, slabHit: w.barrierHits[0] === true, crashed: car.crashed };
}

/**
 * A car driven by the game's own drive model (`applyDrive`: throttle holding 3 m/s, steering never, so it pushes only while
 * its tyres grip) at the +z ramp's side from 3.3 m out, `off` deg off the run (90 = square to the side), aimed so its centre
 * line meets the side wall where the wall stands `wall` m high. Its worst roll about its own nose (deg, the lean of its right
 * side) and highest point while it enters: until its centre passes the ramp's midline, comes within 1 m of the high end (where
 * a jump starts), or `frames` (default 360: 6 s) are up. `dx` moves the spawn along +x (m).
 */
function approachSide(cls: VehicleClassId, off: number, wall: number, { frames = 360, dx = 0 } = {}): { roll: number; high: number; z: number } {
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

/**
 * How far along +x (m) the car's body reaches: a live car's box, a wreck's crush hulls and body masses (a crushed nose is
 * shorter than the box it was built in, so the box no longer says where the car is).
 */
function bodyReachX(car: DeformableCar): number {
  const p = car.group.position;
  const c = Math.cos(car.yaw);
  const s = Math.sin(car.yaw);
  let x = -Infinity;
  const add = (lx: number, lz: number): void => void (x = Math.max(x, p.x + lx * c + lz * s));
  if (!car.deform.massActive) for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(sx * CAR_HALF.x, sz * CAR_HALF.z);
  else {
    for (const h of car.crushHulls()) for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(h.cx + sx * h.hx, h.cz + sz * h.hz);
    for (const m of car.deform.masses) if (!m.hub) x = Math.max(x, m.world.x);
  }
  return x;
}

describe("given a car driven end-on up a ramp, with a slab between the ramps", () => {
  afterEach(() => setGround(null));

  for (const [v, name, landZ] of [
    [14, "flies the slab end-on and lands on the flat past the far ramp", RAMP.start + RAMP.len],
    [11, "flies the slab end-on and lands on the far ramp's face", RAMP.start],
  ] as const) {
    it(`when it drives up at ${v} m/s, then it ${name}, its nose follows the flight path, no tyre sinks or snaps on landing and all four wheels end on the ground`, (t) => {
      const r = jump(v);
      t.diagnostic(
        `air ${r.air.toFixed(2)} s, peak ${r.peak.toFixed(2)} m, nose off path ≤ ${r.noseOff.toFixed(1)}°, most turn in a frame ${r.turn.toFixed(1)}°, deepest tyre ${r.sink.toFixed(3)} m, end z ${r.endZ.toFixed(1)}, gaps ${r.gaps.map((g) => g.toFixed(3)).join("/")} m, slab hit ${r.slabHit}`,
      );
      const failures: string[] = [];
      if (r.air < 0.6) failures.push(`air ${r.air.toFixed(2)} s`);
      if (r.peak < RAMP.top + 0.3) failures.push(`peak ${r.peak.toFixed(2)} m`);
      if (r.slabHit) failures.push("touched the slab");
      if (r.crashed) failures.push("crashed");
      if (r.endZ < landZ) failures.push(`ended at z ${r.endZ.toFixed(1)}, short of ${landZ.toFixed(1)}`);
      if (r.noseOff > 3) failures.push(`nose ${r.noseOff.toFixed(1)}° off the flight path`);
      if (r.turn > 6) failures.push(`nose turned ${r.turn.toFixed(1)}° in one frame`);
      if (r.sink > 0.02) failures.push(`a tyre ${r.sink.toFixed(3)} m into the ground`);
      r.gaps.forEach((g, i) => {
        if (Math.abs(g) > 0.02) failures.push(`wheel ${i} gap ${g.toFixed(3)} m`);
      });
      assert.deepEqual(failures, []);
    });
  }

  it("when it jumps the slab at 14 m/s in every vehicle class, then the springs take the landing and stop swinging (all under 1 cm) within 2 s, and the body's sill stays off the ground", (t) => {
    const failures: string[] = [];
    const sill = new THREE.Vector3();
    for (const cls of VEHICLE_CLASS_IDS) {
      const { ramps, w, car } = scene(true);
      car.spawnFacing(0, -14, 0, 14);
      assignClass(car, cls);
      const body = car.group.getObjectByName("classLift")!;
      let touch = -1;
      let flew = false;
      let peak = 0;
      let swung = 0;
      let low = Infinity;
      let time = 0;
      // 4 s: 2.2 s past touchdown, before the car rolls off the disc's rim.
      run(w, 4, () => {
        time += FRAME;
        if (car.airborne && !car.airContact) flew = true;
        if (flew && touch < 0 && (car.airContact || !car.airborne)) touch = time;
        if (touch < 0) return;
        const o = car.suspension.offset;
        peak = Math.min(peak, ...o);
        if (Math.max(...o.map(Math.abs)) > 0.01) swung = time - touch;
        car.group.updateWorldMatrix(true, true);
        body.localToWorld(sill.set(0, 0.25, 0));
        low = Math.min(low, sill.y - ramps.heightAt(sill.x, sill.z, sill.y));
      });
      t.diagnostic(`${cls}: peak compression ${(-peak * 100).toFixed(1)} cm, swinging until ${swung.toFixed(2)} s after touchdown, sill ≥ ${low.toFixed(3)} m`);
      if (touch < 0) failures.push(`${cls} never came down`);
      if (peak > -0.02) failures.push(`${cls} springs took ${(-peak * 100).toFixed(1)} cm`);
      if (swung > 2) failures.push(`${cls} still swinging ${swung.toFixed(2)} s after touchdown`);
      if (low < 0.05) failures.push(`${cls} sill ${low.toFixed(3)} m off the ground`);
      car.dispose();
    }
    assert.deepEqual(failures, []);
  });
});

describe("given the ramps with no slab between them", () => {
  afterEach(() => setGround(null));

  it("when a car is driven end-on at 8 m/s, then it comes down across the far ramp's high end and rides its face down, not launched off the step", (t) => {
    const { w, car } = scene(false);
    car.spawnFacing(0, -14, 0, 8);
    const p = car.group.position;
    let peak = 0;
    // 4 s: since landing across the high end sinks into its springs (`SUPPORT`), at 3 s it was still on the far foot (z 7.8).
    run(w, 4, () => {
      peak = Math.max(peak, p.y);
    });
    t.diagnostic(`peak ${peak.toFixed(2)} m, end z ${p.z.toFixed(1)} y ${p.y.toFixed(3)} vy ${car.velocity.y.toFixed(2)} m/s`);
    assert.ok(peak < RAMP.top + 0.4 && p.y < 0.01, `peak ${peak.toFixed(2)} m, end y ${p.y.toFixed(2)} m`);
  });

  it("when a car is driven square into a ramp's high end, then it stops at the face, never climbing up or through it", (t) => {
    const { ramps, w, car } = scene(false);
    // Square to the +z ramp's side 1 m from its high end (face 0.94 m up), from 6 m out on −x.
    const z = RAMP.start + 1;
    car.spawnFacing(-6, z, Math.PI / 2, 10);
    const p = car.group.position;
    let deepest = -Infinity;
    let highest = 0;
    run(w, 2, () => {
      // How far the body reached past the ramp's side face.
      deepest = Math.max(deepest, bodyReachX(car) + RAMP.halfW);
      highest = Math.max(highest, p.y);
    });
    t.diagnostic(`face ${ramps.heightAt(0, z).toFixed(2)} m high; nose reached ${deepest.toFixed(3)} m past it, highest ${highest.toFixed(3)} m, end vx ${car.velocity.x.toFixed(2)} m/s, crashed ${car.crashed}`);
    const failures: string[] = [];
    if (deepest > 0.15) failures.push(`nose ${deepest.toFixed(3)} m into the ramp`);
    if (highest > 0.05) failures.push(`climbed to ${highest.toFixed(3)} m`);
    if (car.velocity.x > 0.1) failures.push(`still driving in at ${car.velocity.x.toFixed(2)} m/s`);
    assert.deepEqual(failures, []);
  });
});

describe("given a car driven at 14 m/s up the ramp and over the slab", () => {
  afterEach(() => setGround(null));

  it("when it is struck just before touchdown and then comes to a stop, then it is a wreck: once it has stopped it is not flying (its drive is idled)", (t) => {
    const { ramps, w, car } = scene(true);
    car.spawnFacing(0, -14, 0, 14);
    const p = car.group.position;
    let hitAt = -1;
    let time = 0;
    let stopped = 0;
    let stuck = 0;
    run(w, 6, () => {
      time += FRAME;
      if (hitAt < 0 && car.airborne && time > 0.5 && p.y - ramps.heightAt(p.x, p.z, p.y) < 0.4) {
        hitAt = time;
        car.applyImpact(new THREE.Vector3(p.x + 1, p.y + 0.5, p.z), new THREE.Vector3(-1, 0, 0), 20, 12);
      }
      if (hitAt < 0 || car.velocity.length() > 0.3) return;
      stopped += FRAME;
      if (car.airborne) stuck += FRAME;
    });
    t.diagnostic(`struck at ${hitAt.toFixed(2)} s, stopped ${stopped.toFixed(2)} s, of it flying ${stuck.toFixed(2)} s; masses ${car.deform.massActive}`);
    assert.ok(hitAt > 0 && stopped > 1, `struck at ${hitAt.toFixed(2)} s, stopped ${stopped.toFixed(2)} s`);
    assert.ok(stuck < 0.25, `stopped yet flying for ${stuck.toFixed(2)} s`);
  });
});

describe("given two cars driving head-on at each other up the two ramps, with no slab between them", () => {
  afterEach(() => setGround(null));

  // The cell is vB 11, not 8: at 8 m/s the car on the ramp was passed over with 0.26 m between its roof and the other's tyres, and
  // the strike this case guarded was the plan SAT's, from a height band that a pitched car's box stretched over a roof it did not
  // touch (`shareHeight`: a car above another's roof is stacked on it, whatever its pitch). At 11 m/s they meet nose to roof, 1.58 m up.
  it("when the car still on its ramp strikes the other mid-air, then the struck car keeps a ballistic height: no frame moves its height away from what its speeds say", (t) => {
    const { w, cars } = pair(16, 11);
    const [a] = cars;
    let struckAt = -1;
    let struckY = 0;
    let lastY = a.group.position.y;
    let time = 0;
    const flags = watch(cars);
    run(w, 4, () => {
      time += FRAME;
      if (struckAt < 0 && a.crashed) {
        struckAt = time;
        struckY = lastY;
      }
      lastY = a.group.position.y;
      flags.frame();
    }, flags.slice);
    t.diagnostic(`struck at ${struckAt.toFixed(2)} s, ${struckY.toFixed(2)} m up; flagged ${flags.list.length}: ${flags.list.slice(0, 4).join("; ")}`);
    assert.ok(struckAt > 0 && struckY > 1, `struck at ${struckAt.toFixed(2)} s, ${struckY.toFixed(2)} m up: not a mid-air hit`);
    assert.deepEqual(flags.list, []);
  });

  // The case above passed on main for its own cell only: on the speeds and offsets around it, 23 of 75 cells flagged (a wreck
  // coming down beside another was lifted its whole depth into the other's flank, up to 0.45 m in one slice). The whole
  // neighbourhood is the test: a result that holds for one realisation of a chaotic pile-up and not its neighbours is a defect.
  it("when the speeds and offsets around that case are swept (first car 15–17 m/s, second 7–9 m/s, 0.3–0.5 m across: 75 combinations), then no frame of any of them moves a car's height away from its speeds", (t) => {
    const failures: string[] = [];
    let frames = 0;
    for (const vA of [15, 15.5, 16, 16.5, 17]) {
      for (const vB of [7, 7.5, 8, 8.5, 9]) {
        for (const dx of [0.3, 0.4, 0.5]) {
          const { w, cars } = pair(vA, vB, dx);
          const flags = watch(cars);
          run(w, 4, flags.frame, flags.slice);
          frames += flags.list.length;
          if (flags.list.length > 0) failures.push(`${vA}/${vB}/${dx}: ${flags.list.length} frames, first ${flags.list[0]}`);
          for (const c of cars) c.dispose();
        }
      }
    }
    t.diagnostic(`${failures.length} of 75 cells flagged, ${frames} frames`);
    assert.deepEqual(failures, []);
  });
});

describe("given the ramps with no slab between them, and a car that is or becomes a wreck on them", () => {
  afterEach(() => setGround(null));

  // The 15/9/0.3 cell's last flight slice, as one wreck: a struck car falling at a wedge's high end with its front tyres a hair
  // over the face and its tail over the gap, the wedge's top (1.15 m) at its middle 0.41 m over its origin. Two wheels down and
  // upright counted as landed whatever the depth; the ground sim then set the frame on the face and lifted the masses with it:
  // 0.38 m in one slice on a speed of −4.5 m/s. A middle that deep is in the wedge's end, not on its wheels: still flying.
  it("when it is falling at a ramp's high end with its middle under the ramp's top and one physics slice runs, then it does not rise: it is not landed onto the ramp", (t) => {
    const { ramps, w, car } = scene(false);
    car.crashed = true;
    car.airborne = true;
    car.group.position.set(0, 0.7771, RAMP.start + 0.1918);
    car.group.rotation.set(-0.062, 0, 0, "YXZ");
    car.velocity.set(0, -4.505, -0.43);
    car.angular.set(0.043, 0, 0);
    car.refreshBasis();
    const y0 = car.group.position.y;
    const top = ramps.heightAt(car.group.position.x, car.group.position.z, y0);
    stepWorld(w, 0.0079);
    const rise = car.group.position.y - y0;
    t.diagnostic(`wedge top ${top.toFixed(2)} m over a middle at ${y0.toFixed(2)} m; one slice: y ${y0.toFixed(4)} → ${car.group.position.y.toFixed(4)} (${rise >= 0 ? "+" : ""}${rise.toFixed(4)}), vy ${car.velocity.y.toFixed(2)}, flying ${car.airborne}, masses ${car.deform.massActive}`);
    assert.ok(rise <= 0, `a wreck falling at ${car.velocity.y.toFixed(1)} m/s rose ${rise.toFixed(3)} m in one slice (landed ${!car.airborne})`);
  });

  it("when a car driven at 15 m/s up the ramp is struck so it slides off the lip, then it is wrecked, flies past the lip and lands, with no frame moving its height away from its speed", (t) => {
    const { ramps, w, car } = scene(false);
    car.spawnFacing(0, -14, 0, 15);
    const p = car.group.position;
    const flags = watch([car]);
    let struck = false;
    let flew = 0;
    run(w, 3, () => {
      if (!struck && p.z > -(RAMP.start + RAMP.len * 0.6)) {
        struck = true;
        car.applyImpact(car.group.localToWorld(new THREE.Vector3(0.9, 0.5, 0.4)), car.right.clone().negate(), 8, 8);
      }
      if (struck && p.z > -RAMP.start) flew = Math.max(flew, p.y - ramps.heightAt(p.x, p.z, p.y));
      flags.frame();
    }, flags.slice);
    t.diagnostic(`crashed ${car.crashed}; past the lip ${flew.toFixed(2)} m over the ground; end y ${p.y.toFixed(3)} at z ${p.z.toFixed(1)}; flagged ${flags.list.length}: ${flags.list.slice(0, 4).join("; ")}`);
    assert.ok(car.crashed, "the hit did not wreck the car");
    assert.ok(flew > 0.5, `past the lip only ${flew.toFixed(2)} m over the ground: it did not fly`);
    assert.ok(Math.abs(p.y - ramps.heightAt(p.x, p.z, p.y)) < 0.15, `ended ${p.y.toFixed(2)} m up: it did not land`);
    assert.deepEqual(flags.list, []);
  });

  it("when that struck car has landed and come to rest, then it has no vertical speed and takes the flat ground's pitch and roll", (t) => {
    const { w, car } = scene(false);
    car.spawnFacing(0, -14, 0, 15);
    const p = car.group.position;
    let struck = false;
    let stale = 0;
    let lastY = p.y;
    run(w, 7, () => {
      if (!struck && p.z > -(RAMP.start + RAMP.len * 0.6)) {
        struck = true;
        car.applyImpact(car.group.localToWorld(new THREE.Vector3(0.9, 0.5, 0.4)), car.right.clone().negate(), 8, 8);
      }
      // In flight its apex holds y still under up to g·frame/2 of speed; the stale speed this guards is a landed one.
      if (!car.airborne && Math.abs(p.y - lastY) < 1e-4) stale = Math.max(stale, Math.abs(car.velocity.y));
      lastY = p.y;
    });
    const pitch = car.group.rotation.x;
    const roll = car.group.rotation.z;
    t.diagnostic(`at rest: y ${p.y.toFixed(3)}, vy ${car.velocity.y.toFixed(3)}, worst vy with y still ${stale.toFixed(3)} m/s, pitch ${pitch.toFixed(3)}, roll ${roll.toFixed(3)} rad`);
    assert.ok(stale < 0.05, `y still while vy ${stale.toFixed(3)} m/s`);
    assert.ok(Math.abs(pitch) < 0.03 && Math.abs(roll) < 0.03, `pitch ${pitch.toFixed(3)}, roll ${roll.toFixed(3)} rad on flat ground`);
  });
});

describe("given a parked car lying across the track, with another car flying 2 m over it", () => {
  afterEach(() => setGround(null));

  it("when the flying car passes over, then the two never touch: no contact is reported, the flying car gets past and neither car is crashed", (t) => {
    setGround(null);
    const three = new THREE.Scene();
    const low = new DeformableCar(paint(), three);
    const high = new DeformableCar(paint(), three);
    low.spawnFacing(0, 0, Math.PI / 2, 0);
    high.spawnFacing(0, -6, 0, 14);
    high.group.position.y = 2.2;
    high.velocity.y = 3;
    high.airborne = true;
    const w = newWorld([low, high]);
    let hits = 0;
    w.pairHit = () => void hits++;
    run(w, 0.7, () => {});
    t.diagnostic(`pair hits ${hits}; crashed low ${low.crashed} high ${high.crashed}; high at z ${high.group.position.z.toFixed(1)} y ${high.group.position.y.toFixed(2)}`);
    assert.ok(high.group.position.z > 3 && high.group.position.y > 1.9, `the high car is at z ${high.group.position.z.toFixed(1)} y ${high.group.position.y.toFixed(2)}: it never passed over`);
    assert.equal(hits, 0);
    assert.ok(!low.crashed && !high.crashed, "a car crashed");
  });
});

describe("given a car driven at walking pace into a ramp's side", () => {
  afterEach(() => setGround(null));

  it("when it is driven at every vehicle class, at 30°, 45°, 60° and 90° off the run and at wall heights from 0.05 m to 0.9 m, then it stops at the wall or climbs the low toe and never rolls over", (t) => {
    const failures: string[] = [];
    const rows: string[] = [];
    for (const cls of VEHICLE_CLASS_IDS) {
      for (const off of [30, 45, 60, 90]) {
        for (const wall of [0.05, 0.2, 0.4, 0.6, 0.9]) {
          const r = approachSide(cls, off, wall);
          rows.push(`${cls} ${off}° off the run, wall ${wall} m: worst roll ${r.roll.toFixed(0)}°, highest ${r.high.toFixed(2)} m, reached z ${r.z.toFixed(1)}`);
          if (r.roll > 30) failures.push(rows[rows.length - 1]!);
        }
      }
    }
    t.diagnostic(`\n${rows.join("\n")}`);
    assert.deepEqual(failures, []);
  });

  it("when it is run for 12 s with the spawn a few mm either way, at 30° and 45° off the run and at wall heights from 0.05 m to 0.4 m, then it still never rolls over", (t) => {
    // The monster driven at the flank at 30° crept up it on one tyre, took off at the high end (z 3.4) and tipped onto the wall
    // (72° on main). That lands between 4.3 and 5.8 s, so the 6 s window above passed 7 of 21 throttle draws at wall 0.2 m and all 21 at 0.05 m by timing alone.
    const failures: string[] = [];
    let n = 0;
    for (const cls of VEHICLE_CLASS_IDS) {
      for (const off of [30, 45]) {
        for (const wall of [0.05, 0.2, 0.4]) {
          for (const dx of [-0.003, 0, 0.003]) {
            const r = approachSide(cls, off, wall, { frames: 720, dx });
            n++;
            if (r.roll > 30) failures.push(`${cls} ${off}° off the run, wall ${wall} m, spawn ${dx * 1000} mm: worst roll ${r.roll.toFixed(0)}°, reached z ${r.z.toFixed(1)}`);
          }
        }
      }
    }
    t.diagnostic(`${n} runs, ${failures.length} over 30°`);
    assert.deepEqual(failures, []);
  });
});

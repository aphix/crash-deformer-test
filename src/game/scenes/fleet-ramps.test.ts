import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { COM_Y, G, TOUCH } from "../vehicle/car-air-body.ts";
import { CAR_HALF } from "../vehicle/car-mesh.ts";
import { RAMP } from "./fleet-ramps.ts";
import { approachSide, pair, run, scene, watch } from "./fleet-ramps.test-util.ts";
import { FRAME } from "../vehicle/ground-probe.test-util.ts";
import { setGround } from "../world/ground.ts";
import { paint } from "../vehicle/test-support.ts";
import { newWorld, stepWorld } from "../engine/world-step.ts";
import { assignClass, VEHICLE_CLASS_IDS } from "../vehicle/vehicle-classes.ts";
import { droop, SPRINGS } from "../vehicle/car-suspension.ts";
import { fit } from "../vehicle/ground-probe.test-util.ts";

/** Long enough for a car wedged between the ramps to stop sliding (main settles at about 6 s). */
const SETTLE_S = 8;
const TYRE_CENTRE = 0.32;
const DEG = 180 / Math.PI;
/** The springs have settled when no corner is out of its rest length by more than this (m); a landing they took moved them past it. */
const SETTLED = 0.01;
/** A tyre this far (m) off the ground is out of its springs' reach: the car's class (the default, a sedan) pushes it up no more. */
const SPRING_REACH = droop("sedan") + TOUCH;
/** A jump's origin rises at least this far (m) over the lip it leaves. */
const PEAK_OVER = 0.3;
/**
 * The least flight (s) of a jump that peaks `PEAK_OVER` over its lip and comes down on ground no higher than the lip (the slab and the
 * far face are under it): its tyres hang a droop under the origin and fly once a spring's reach clear, so the origin flies while it is
 * more than droop + reach over the lip, a rise and fall of the rest of `PEAK_OVER` under gravity.
 */
const LEAST_AIR = 2 * Math.sqrt((2 * (PEAK_OVER - droop("sedan") - SPRING_REACH)) / G);

type Jump = { air: number; peak: number; flightError: number; spinChange: number; turn: number; sink: number; gaps: number[]; endZ: number; slabHit: boolean; crashed: boolean };

const _com = new THREE.Vector3();
const _expected = new THREE.Vector3();
const _expectedVelocity = new THREE.Vector3();
const _flownCom = new THREE.Vector3();
const _flownVelocity = new THREE.Vector3();
const _flownSpin = new THREE.Vector3();
/** Float error of a flight frame's closed-form step: the rounding of one slice's sum (of the largest coordinate a course has), over the slices a frame is cut into. */
const COORDINATE_SCALE = 100;
const SLICES_PER_FRAME = 24;
const FLIGHT_FLOAT = Number.EPSILON * COORDINATE_SCALE * SLICES_PER_FRAME;

/**
 * One car at `v` m/s up the −z ramp, end-on over the slab. Flight: frames with every tyre beyond its springs' reach off the
 * ground (`SPRING_REACH`: no spring pushes it) and no part of the body resting on it (its underside, bumpers and hull all more than 2 cm clear: a nose that
 * strikes the ground first has landed). flightError: the most a flight frame's centre and velocity stray (m, m/s) from the closed
 * form of the frame before (gravity alone), over frames clear of the slab (whose own contact reaches a car passing over it); spinChange: the most its spin changes (rad/s) between them; turn: the most the
 * nose's elevation changes in one frame (deg) from takeoff to 0.5 s after touchdown (a snap); sink: the deepest any tyre
 * gets into the ground over the run (m).
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
  let flightError = 0;
  let spinChange = 0;
  let flown = false;
  let turn = 0;
  let sink = 0;
  let since = -1;
  let lastNose = 0;
  run(w, 3, () => {
    car.group.updateWorldMatrix(true, true);
    for (const [i, wh] of car.wheels.entries()) {
      wh.getWorldPosition(wp);
      gaps[i] = wp.y - TYRE_CENTRE - ramps.heightAt(wp.x, wp.z, wp.y);
    }
    sink = Math.max(sink, -Math.min(...gaps));
    peak = Math.max(peak, p.y);
    const nose = Math.asin(f.set(0, 0, 1).applyQuaternion(q).y) * DEG;
    const flying = Math.min(...gaps) > SPRING_REACH && fit(car, ramps).hull > 0.02;
    const pastSlab = Math.abs(p.z) > RAMP.start + CAR_HALF.z;
    _com.set(0, COM_Y, 0).applyQuaternion(q).add(p);
    if (flying) {
      air += FRAME;
      since = 0;
      if (flown) {
        // One frame of flight under gravity alone: the centre at its last velocity less g/2 of the frame, the velocity less g of it.
        _expected.copy(_flownCom).addScaledVector(_flownVelocity, FRAME);
        _expected.y -= 0.5 * G * FRAME * FRAME;
        _expectedVelocity.copy(_flownVelocity).y -= G * FRAME;
        flightError = Math.max(flightError, _com.distanceTo(_expected), car.velocity.distanceTo(_expectedVelocity));
        spinChange = Math.max(spinChange, car.angular.distanceTo(_flownSpin));
      }
    } else if (since >= 0) since += FRAME;
    flown = flying && pastSlab;
    _flownCom.copy(_com);
    _flownVelocity.copy(car.velocity);
    _flownSpin.copy(car.angular);
    if (air > 0 && since < 0.5) turn = Math.max(turn, Math.abs(nose - lastNose));
    lastNose = nose;
  });
  return { air, peak, flightError, spinChange, turn, sink, gaps, endZ: p.z, slabHit: w.barrierHits[0] === true, crashed: car.crashed };
}

/**
 * How far along +x (m) the car's body reaches: its cage's plan box (the drawn body, crushed as drawn) and, for a wreck, its body
 * masses.
 */
function bodyReachX(car: DeformableCar): number {
  const p = car.group.position;
  const c = Math.cos(car.yaw);
  const s = Math.sin(car.yaw);
  let x = -Infinity;
  const add = (lx: number, lz: number): void => void (x = Math.max(x, p.x + lx * c + lz * s));
  car.refitCage();
  const box = car.cage.fields.planBox;
  for (const ix of [0, 1]) for (const iz of [2, 3]) add(box[ix]!, box[iz]!);
  if (car.deform.massActive) for (const m of car.deform.masses) if (!m.hub) x = Math.max(x, m.world.x);
  return x;
}

describe("given a car driven end-on up a ramp, with a slab between the ramps", () => {
  afterEach(() => setGround(null));

  for (const [v, name, landZ] of [
    [14, "flies the slab end-on and lands on the flat past the far ramp", RAMP.start + RAMP.len],
    [11, "flies the slab end-on and lands on the far ramp's face", RAMP.start],
  ] as const) {
    it(`when it drives up at ${v} m/s, then it ${name}, its centre on the parabola of its velocity and its spin unchanged while it flies, no tyre sinks or snaps on landing and all four wheels end on the ground`, (t) => {
      const r = jump(v);
      t.diagnostic(
        `air ${r.air.toFixed(2)} s, peak ${r.peak.toFixed(2)} m, centre off the parabola ≤ ${r.flightError.toExponential(1)} m, spin change ≤ ${r.spinChange.toExponential(1)} rad/s, most turn in a frame ${r.turn.toFixed(1)}°, deepest tyre ${r.sink.toFixed(3)} m, end z ${r.endZ.toFixed(1)}, gaps ${r.gaps.map((g) => g.toFixed(3)).join("/")} m, slab hit ${r.slabHit}`,
      );
      const failures: string[] = [];
      if (r.air < LEAST_AIR) failures.push(`air ${r.air.toFixed(2)} s`);
      if (r.peak < RAMP.top + PEAK_OVER) failures.push(`peak ${r.peak.toFixed(2)} m`);
      if (r.slabHit) failures.push("touched the slab");
      if (r.crashed) failures.push("crashed");
      if (r.endZ < landZ) failures.push(`ended at z ${r.endZ.toFixed(1)}, short of ${landZ.toFixed(1)}`);
      if (r.flightError > FLIGHT_FLOAT) failures.push(`centre ${r.flightError} m off the parabola of its velocity`);
      if (r.spinChange > FLIGHT_FLOAT) failures.push(`spin changed ${r.spinChange} rad/s in flight`);
      if (r.turn > 6) failures.push(`nose turned ${r.turn.toFixed(1)}° in one frame`);
      if (r.sink > 0.02) failures.push(`a tyre ${r.sink.toFixed(3)} m into the ground`);
      for (const [i, g] of r.gaps.entries()) {
        if (Math.abs(g) > 0.02) failures.push(`wheel ${i} gap ${g.toFixed(3)} m`);
      }
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
        if (car.airborne) flew = true;
        if (flew && touch < 0 && !car.airborne) touch = time;
        if (touch < 0) return;
        // The springs are the physics tyres' own (`stepFree`): each drawn wheel's lift off its rest hub is its spring's compression.
        const compression = car.suspension.seat;
        peak = Math.max(peak, ...compression);
        if (Math.max(...Array.from(compression, Math.abs)) > SETTLED) swung = time - touch;
        car.group.updateWorldMatrix(true, true);
        body.localToWorld(sill.set(0, 0.25, 0));
        low = Math.min(low, sill.y - ramps.heightAt(sill.x, sill.z, sill.y));
      });
      t.diagnostic(`${cls}: peak compression ${(peak * 100).toFixed(1)} cm, swinging until ${swung.toFixed(2)} s after touchdown, sill ≥ ${low.toFixed(3)} m`);
      if (touch < 0) failures.push(`${cls} never came down`);
      if (peak < SETTLED) failures.push(`${cls} springs took ${(peak * 100).toFixed(1)} cm`);
      if (swung > 2) failures.push(`${cls} still swinging ${swung.toFixed(2)} s after touchdown`);
      if (low < 0.05) failures.push(`${cls} sill ${low.toFixed(3)} m off the ground`);
      car.dispose();
    }
    assert.deepEqual(failures, []);
  });
});

describe("given the ramps with no slab between them", () => {
  afterEach(() => setGround(null));

  it("when a car is driven end-on at 8 m/s, then it comes down between the ramps at the far one's high end, never launched off the step, and comes to rest in the gap, its origin between the high ends and its tail no higher than the near lip", (t) => {
    const { w, car } = scene(false);
    car.spawnFacing(0, -14, 0, 8);
    const p = car.group.position;
    let peak = 0;
    // The car leaves the lip at about 6 m/s and meets the far end's wall under its top: it crashes there and falls into the gap
    // (the ramps' high ends stand 4 m apart, a car is 4.4 m long): it wedges between the walls, its tail on the near lip or on the road, and
    // comes to rest there as friction and its weight decide, a few seconds later.
    run(w, SETTLE_S, () => {
      peak = Math.max(peak, p.y);
    });
    const tail = car.group.localToWorld(new THREE.Vector3(0, 0, -CAR_HALF.z));
    const speed = Math.hypot(car.velocity.x, car.velocity.z);
    t.diagnostic(`peak ${peak.toFixed(2)} m, end z ${p.z.toFixed(1)} y ${p.y.toFixed(3)} tail y ${tail.y.toFixed(3)} speed ${speed.toFixed(3)} m/s`);
    assert.ok(peak < RAMP.top + 0.4, `peak ${peak.toFixed(2)} m`);
    assert.ok(Math.abs(p.z) < RAMP.start, `origin z ${p.z.toFixed(2)} m: not in the gap between the high ends (±${RAMP.start.toFixed(2)} m)`);
    assert.ok(tail.y < RAMP.top + 0.05, `tail ${tail.y.toFixed(3)} m up, over the lip's ${RAMP.top} m`);
    assert.ok(speed < 0.1, `still moving at ${speed.toFixed(3)} m/s`);
  });

  it("when a car is driven square into a ramp's high end, then it stops at the face, never climbing up or through it", (t) => {
    const { ramps, w, car } = scene(false);
    // Square to the +z ramp's side 1 m from its high end (face 0.94 m up), from 6 m out on −x.
    const z = RAMP.start + 1;
    assignClass(car, "sedan");
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
    if (highest > SPRINGS.sedan.travel) failures.push(`climbed to ${highest.toFixed(3)} m`);
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
      // Just before touchdown: coming down with its lowest point, body or tyre, within 0.2 m of the ground. Not the origin's
      // height: a nose-down landing touches the keel with the origin still 0.68 m up.
      if (hitAt < 0 && car.airborne && time > 0.5 && car.velocity.y < 0) {
        const f = fit(car, ramps);
        if (Math.min(f.hull, ...f.gaps) < 0.2) {
          hitAt = time;
          car.applyImpact(new THREE.Vector3(p.x + 1, p.y + 0.5, p.z), new THREE.Vector3(-1, 0, 0), 20, 12);
        }
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

/**
 * The two rows below were todos while the 16/11/0.4 cell's one slice of contact (A 1.32 m up, 4.25 m/s down onto B on the ramp) was a
 * knife edge of the plan SAT at first touch, and while a wreck's belly sank 17 cm into a ramp lip between two body points (the 15/8.5/0.5
 * cell: the tail point entered the end face at 6.2 m/s and `followGroup` took the group 1.1 m back in one frame). Both hold now: 0 of 75 cells flagged.
 */
describe("given two cars driving head-on at each other up the two ramps, with no slab between them", () => {
  afterEach(() => setGround(null));

  // The cell is vB 11, not 8: at 8 m/s the car on the ramp was passed over with 0.26 m between its roof and the other's tyres, and
  // the strike this case guarded was the plan SAT's, from a height band that a pitched car's box stretched over a roof it did not
  // touch (the old box-band gate; now the cages' own heights decide). At 11 m/s they meet nose to roof, 1.58 m up.
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

  // The cells the neighbourhood sweep (fleet-ramps.ai-long-run.ts: 75 combinations around the case above) caught, each staged alone: the
  // 15/8.5/0.5 cell's wreck belly sank 17 cm into a ramp lip between two body points (its tail point entered the end face at 6.2 m/s and the
  // pose took the group 1.1 m back in one frame); the 15/9/0.3 cell's struck car fell at a wedge's high end with its middle under the wedge's top
  // (also staged to its one slice below).
  const caughtCells = [
    { it: "when the car on its ramp at 15 m/s meets the other at 8.5 m/s 0.5 m across, then no frame moves a car's height away from its speeds", vA: 15, vB: 8.5, dx: 0.5 },
    { it: "when the car on its ramp at 15 m/s meets the other at 9 m/s 0.3 m across, then no frame moves a car's height away from its speeds", vA: 15, vB: 9, dx: 0.3 },
  ];
  for (const testCase of caughtCells) {
    it(testCase.it, (t) => {
      const { w, cars } = pair(testCase.vA, testCase.vB, testCase.dx);
      const flags = watch(cars);
      run(w, 4, flags.frame, flags.slice);
      t.diagnostic(`flagged ${flags.list.length}: ${flags.list.slice(0, 4).join("; ")}`);
      assert.deepEqual(flags.list, []);
    });
  }
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

  it("when the monster truck is driven at the flank at 30° off the run for 12 s, at wall heights of 0.05 m and 0.2 m, then it still never rolls over", (t) => {
    // The monster driven at the flank at 30° crept up it on one tyre, took off at the high end (z 3.4) and tipped onto the wall
    // (72° on main). That lands between 4.3 and 5.8 s, so a 6 s run passed it by timing alone: the run is 12 s, each wall height alone.
    const rows: string[] = [];
    for (const wall of [0.05, 0.2]) {
      const r = approachSide("monster", 30, wall, { frames: 720 });
      rows.push(`wall ${wall} m: worst roll ${r.roll.toFixed(0)}°, reached z ${r.z.toFixed(1)}`);
      assert.ok(r.roll <= 30, `monster 30° off the run, wall ${wall} m: worst roll ${r.roll.toFixed(0)}°, reached z ${r.z.toFixed(1)}`);
    }
    t.diagnostic(rows.join("; "));
  });
});

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { COM_Y } from "../vehicle/car-air.ts";
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
  w.collide = (c) => void ramps.contact(c);
  return { ramps, w, car };
}

function run(w: World, seconds: number, each: () => void): void {
  let acc = 0;
  for (let t = 0; t < seconds; t += FRAME) {
    acc = Math.min(0.05, acc + FRAME);
    while (acc > 1e-5) {
      const h = physicsSlice(acc, sliceSpeed(w.cars));
      stepWorld(w, h);
      for (const c of w.cars) c.stepBreakage(h);
      acc -= h;
    }
    for (const c of w.cars) c.updateSkin();
    each();
  }
}

/** Two cars head-on up the two ramps (no slab): `vA` from −z, `vB` from +z, 0.4 m apart across. */
function pair(vA: number, vB: number): { w: World; cars: [DeformableCar, DeformableCar] } {
  const { ramps, w } = scene(false);
  const b = new DeformableCar(paint(), new THREE.Scene());
  w.cars[0]!.spawnFacing(0, -14, 0, vA);
  b.spawnFacing(0.4, 14, Math.PI, vB);
  const w2 = newWorld([w.cars[0]!, b]);
  w2.collide = (c) => void ramps.contact(c);
  return { w: w2, cars: [w.cars[0]!, b] };
}

/**
 * Ballistic check per frame: a car's height change must lie between its start and end vertical speeds × the frame,
 * give or take 2 cm (a snap to the ground, or a height that never moves under a stale speed, falls outside). In
 * flight at both ends the height is the centre of mass's, whose speed `velocity` is (`stepAir`).
 */
function watch(cars: readonly DeformableCar[]): { list: string[]; frame: () => void } {
  const heights = (c: DeformableCar): [number, number] => {
    const q = c.group.quaternion;
    return [c.group.position.y, c.group.position.y + COM_Y * (1 - 2 * (q.x * q.x + q.z * q.z))];
  };
  const last = cars.map((c) => [...heights(c), c.velocity.y, c.airborne] as const);
  const list: string[] = [];
  let n = 0;
  return {
    list,
    frame: () => {
      n++;
      cars.forEach((c, i) => {
        const [o0, com0, vy0, air0] = last[i]!;
        const [o, com] = heights(c);
        const flying = air0 && c.airborne;
        const y0 = flying ? com0 : o0;
        const y = flying ? com : o;
        const vy = c.velocity.y;
        const dy = y - y0;
        if (dy < Math.min(vy0, vy) * FRAME - 0.02 || dy > Math.max(vy0, vy) * FRAME + 0.02) {
          list.push(`car ${i} frame ${n}: y ${y0.toFixed(3)} → ${y.toFixed(3)}, vy ${vy0.toFixed(2)} → ${vy.toFixed(2)}`);
        }
        last[i] = [o, com, vy, c.airborne];
      });
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
 * a jump starts), or 6 s are up.
 */
function approachSide(cls: VehicleClassId, off: number, wall: number): { roll: number; high: number; z: number } {
  const { w, car } = scene(false);
  assignClass(car, cls);
  const th = off / DEG;
  const zWall = RAMP.start + ((RAMP.top - wall) * RAMP.len) / RAMP.top;
  car.spawnFacing(RAMP.halfW + 3.3, zWall + 3.3 / Math.tan(th), Math.PI + th, 0);
  const q = car.group.quaternion;
  const right = new THREE.Vector3();
  const input = { throttle: 0, steer: 0, brake: 0, ebrake: false, boost: false };
  const st = { acc: 0 };
  let roll = 0;
  let high = 0;
  const p = car.group.position;
  for (let f = 0; f < 360 && p.z > RAMP.start + 1 && p.x > 0; f++) {
    input.throttle = Math.max(0, Math.min(1, (3 - car.speed) / 1.5));
    frame(w, input, st);
    roll = Math.max(roll, Math.abs(Math.asin(Math.max(-1, Math.min(1, right.set(1, 0, 0).applyQuaternion(q).y)))) * DEG);
    high = Math.max(high, p.y);
  }
  const out = { roll, high, z: p.z };
  car.dispose();
  return out;
}

describe("fleet ramps", () => {
  afterEach(() => setGround(null));

  for (const [v, name, landZ] of [
    [14, "flies the slab end-on and lands on the flat past the far ramp", RAMP.start + RAMP.len],
    [11, "flies the slab end-on and lands on the far ramp's face", RAMP.start],
  ] as const) {
    it(`${v} m/s up a ramp: ${name}; the nose follows the flight path, no tyre sinks or snaps on landing, all four end on the ground`, (t) => {
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

  it("14 m/s jump, every class: the springs take the landing and stop swinging (all under 1 cm) within 2 s, the body's sill stays off the ground", (t) => {
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

  it("8 m/s without the slab: comes down across the far ramp's high end and rides its face down, not launched off the step", (t) => {
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

  it("a ramp's side is a wall: a car driven square into its high end stops at the face, never up or through it", (t) => {
    const { ramps, w, car } = scene(false);
    // Square to the +z ramp's side 1 m from its high end (face 0.94 m up), from 6 m out on −x.
    const z = RAMP.start + 1;
    car.spawnFacing(-6, z, Math.PI / 2, 10);
    const p = car.group.position;
    let deepest = -Infinity;
    let highest = 0;
    run(w, 2, () => {
      // How far the nose (2.22 m ahead of the centre) reached past the ramp's side face.
      deepest = Math.max(deepest, p.x + 2.22 + RAMP.halfW);
      highest = Math.max(highest, p.y);
    });
    t.diagnostic(`face ${ramps.heightAt(0, z).toFixed(2)} m high; nose reached ${deepest.toFixed(3)} m past it, highest ${highest.toFixed(3)} m, end vx ${car.velocity.x.toFixed(2)} m/s, crashed ${car.crashed}`);
    const failures: string[] = [];
    if (deepest > 0.15) failures.push(`nose ${deepest.toFixed(3)} m into the ramp`);
    if (highest > 0.05) failures.push(`climbed to ${highest.toFixed(3)} m`);
    if (car.velocity.x > 0.1) failures.push(`still driving in at ${car.velocity.x.toFixed(2)} m/s`);
    assert.deepEqual(failures, []);
  });

  it("a car struck just before touchdown is a wreck on its masses: once it stops it is not flying (drive idled)", (t) => {
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

  it("D1: a car struck mid-air by one still on its ramp keeps a ballistic height: no frame moves y more than 2 cm off its velocity", (t) => {
    const { w, cars } = pair(16, 8);
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
    });
    t.diagnostic(`struck at ${struckAt.toFixed(2)} s, ${struckY.toFixed(2)} m up; flagged ${flags.list.length}: ${flags.list.slice(0, 4).join("; ")}`);
    assert.ok(struckAt > 0 && struckY > 1, `struck at ${struckAt.toFixed(2)} s, ${struckY.toFixed(2)} m up: not a mid-air hit`);
    assert.deepEqual(flags.list, []);
  });

  it("D2: a wreck sliding off a ramp's lip flies and lands, with no frame off its velocity", (t) => {
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
    });
    t.diagnostic(`crashed ${car.crashed}; past the lip ${flew.toFixed(2)} m over the ground; end y ${p.y.toFixed(3)} at z ${p.z.toFixed(1)}; flagged ${flags.list.length}: ${flags.list.slice(0, 4).join("; ")}`);
    assert.ok(car.crashed, "the hit did not wreck the car");
    assert.ok(flew > 0.5, `past the lip only ${flew.toFixed(2)} m over the ground: it did not fly`);
    assert.ok(Math.abs(p.y - ramps.heightAt(p.x, p.z, p.y)) < 0.15, `ended ${p.y.toFixed(2)} m up: it did not land`);
    assert.deepEqual(flags.list, []);
  });

  it("D2: a landed wreck at rest has no vertical speed and takes the flat ground's pitch", (t) => {
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

  it("D3: a car flying 2 m over another never touches it", (t) => {
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

  it("a car driven at walking pace into a wedge's side, at any angle, any class, stops at the wall or climbs the low toe: it never rolls over", (t) => {
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
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { StreamedDeformation } from "./streamed-deform.ts";
import { TYRE_R } from "./deform-state.ts";
import { ENGINE_KILL_TRAVEL, type DeformMode } from "./deform-rig.ts";
import { CRASH, crushStroke, leftoverCrumple } from "./physics-util.ts";
import { DT, MODES, assertSameDigest, dummyGeom, mass } from "../vehicle/test-support.ts";
import { runPair } from "../contact/crash-scenarios.test-util.ts";
import { warmCrashPath } from "../engine/world-step.ts";

/** ~50 km/h NCAP-style rigid barrier. */
const FRONTAL_MPS = 14;

function momentumZ(d: StreamedDeformation): number {
  return d.masses.reduce((s, m) => s + m.vel.z * m.mass, 0);
}

function spawn(
  impactX = 0,
  speed = FRONTAL_MPS,
  inward = new THREE.Vector3(0, 0, -1),
  impact?: THREE.Vector3,
  mode: DeformMode = "lattice",
): { d: StreamedDeformation; group: THREE.Group; vel: THREE.Vector3; omega: THREE.Vector3; geom: THREE.BufferGeometry } {
  const geom = dummyGeom();
  const d = new StreamedDeformation(geom);
  d.mode = mode;
  const group = new THREE.Group();
  group.position.set(0, 0, 0);
  group.rotation.set(0, 0, 0);
  group.updateMatrixWorld();
  const vel = new THREE.Vector3(0, 0, speed);
  const omega = new THREE.Vector3();
  d.beginCrush(impact ?? new THREE.Vector3(impactX, 0.36, 2.06), inward, Math.abs(speed), Math.abs(speed), group, vel, omega);
  return { d, group, vel, omega, geom };
}

function forModes(title: string, fn: (spawnFn: typeof spawn, mode: DeformMode) => void): void {
  for (const mode of MODES) {
    describe(`${title}, in ${mode} deform mode`, () => {
      const spawnFn: typeof spawn = (impactX, speed, inward, impact) =>
        spawn(impactX, speed, inward, impact, mode);
      fn(spawnFn, mode);
    });
  }
}

/** Contact then lattice — the order the engine should use. */
function stepWall(
  s: ReturnType<typeof spawn>,
  dt: number,
  overlap = 0.08,
  contactX?: number,
  n = new THREE.Vector3(0, 0, -1),
): void {
  s.d.notifyContact();
  const fl = mass(s.d, "bumperFL").world;
  const fr = mass(s.d, "bumperFR").world;
  const contact = new THREE.Vector3(
    contactX ?? (fl.x + fr.x) * 0.5,
    (fl.y + fr.y) * 0.5,
    (fl.z + fr.z) * 0.5,
  );
  const closing = Math.max(0, -s.vel.dot(n));
  s.d.feedOverlap(contact, n, overlap, closing, dt);
  const leftover = Math.max(0, closing) * 0.18;
  if (leftover > 0.3) s.d.applyImpulse(n.x, n.y, n.z, leftover * s.d.totalMass * dt * 4);
  s.d.stepStructure(dt);
  s.d.followGroup(s.group, s.vel, s.omega, dt);
  s.d.stepCrush(dt, true);
  s.d.update(s.geom);
}

function travel(d: StreamedDeformation, name: string): number {
  return mass(d, name).local.distanceTo(mass(d, name).rest);
}

function alongZ(d: StreamedDeformation, name: string): number {
  const m = mass(d, name);
  return m.local.z - m.rest.z;
}

describe("given the crash constants (the researched sedan barrier numbers every crash uses)", () => {
  it("when the pulse time, crush distance and friction values are read, then the pulse lasts 0.09 to 0.16 s, the crush is 0.4 to 0.85 m, sliding friction exceeds scuffing friction and peak friction is at least sliding friction", () => {
    assert.ok(CRASH.pulseSec >= 0.09 && CRASH.pulseSec <= 0.16);
    assert.ok(CRASH.crushMeters >= 0.4 && CRASH.crushMeters <= 0.85);
    assert.ok(CRASH.muSlide > CRASH.muScuff);
    assert.ok(CRASH.muPeak >= CRASH.muSlide);
  });
});

const centredImpactCases = [
  { it: "when the hit lands dead centre (0 m off the centreline), then the hit point stays within 0.22 m of the centreline, so both front corners share the crush", impactX: 0 },
  { it: "when the hit lands 0.199 m off centre, just inside the 0.2 m centre band, then the hit point still counts as centred (within 0.22 m of the centreline)", impactX: 0.199 },
] as const;

const rightImpactCases = [
  { it: "when the hit lands at the right-front corner (0.62 m right of the centreline), then the hit point stays on the right, more than 0.28 m from the centreline", impactX: 0.62, minSnappedX: 0.28 },
  { it: "when the hit lands exactly 0.2 m right of the centreline, then it already counts as a right hit (more than 0.25 m right), because only offsets under 0.2 m count as centred", impactX: 0.2, minSnappedX: 0.25 },
] as const;

forModes("given a car hit at the front, where the hit point snaps to the centre or to the nearest front corner", (spawn) => {
  for (const testCase of centredImpactCases) {
    it(testCase.it, () => {
      const { d } = spawn(testCase.impactX);
      assert.ok(Math.abs(d.impactLocal.x) < 0.22, `x=${testCase.impactX} snapped off-centre to ${d.impactLocal.x}`);
    });
  }

  for (const testCase of rightImpactCases) {
    it(testCase.it, () => {
      const { d } = spawn(testCase.impactX);
      assert.ok(d.impactLocal.x > testCase.minSnappedX, `x=${testCase.impactX} should snap right but landed at x=${d.impactLocal.x}`);
    });
  }

  it("when the hit lands at the left-front corner (0.62 m left of the centreline), then the hit point stays on the left, more than 0.28 m from the centreline", () => {
    const { d } = spawn(-0.62);
    assert.ok(d.impactLocal.x < -0.28, `left hit flipped to x=${d.impactLocal.x}`);
  });

  it("when the hit lands dead centre and both front bumpers are equally far away, then the hit point is not pulled to the left-front corner (it stays right of -0.15 m), as it would be if ties went to the first bumper", () => {
    const { d } = spawn(0);
    assert.ok(d.impactLocal.x > -0.15, `head-on became a left-corner at x=${d.impactLocal.x}`);
  });
});

forModes("given a car meeting a wall at 20 m/s or more for the first time, where a bad contact solver could fling it off the map", (spawn, mode) => {
  it("when a wall overlaps it by 25 cm for ten 1/60 s steps at 20 m/s head-on, then every body particle stays finite, under the maximum particle speed and within 8 m sideways, 12 m along and 4 m up, and the car as a whole stays within 6 m and under that speed", () => {
    const s = spawn(0, 20);
    for (let i = 0; i < 10; i++) stepWall(s, DT, 0.25);
    for (const m of s.d.masses) {
      assert.ok(Number.isFinite(m.world.x + m.vel.x), `${m.name} went NaN [${mode}]`);
      assert.ok(m.vel.length() < CRASH.maxMassMps + 0.1, `${m.name} vel ${m.vel.length().toFixed(1)} [${mode}]`);
      assert.ok(Math.abs(m.world.x) < 8 && Math.abs(m.world.z) < 12 && m.world.y < 4, `${m.name} at ${m.world.x.toFixed(1)},${m.world.y.toFixed(1)},${m.world.z.toFixed(1)}`);
    }
    assert.ok(s.group.position.length() < 6, `group flew to ${s.group.position.toArray()} [${mode}]`);
    assert.ok(s.vel.length() < CRASH.maxMassMps + 0.1, `group vel ${s.vel.length()} [${mode}]`);
  });

  it("when the wall hits it 0.7 m off centre at 22 m/s with a 30 cm overlap for twelve steps, then its passenger cell (the stiff middle of the car) stays within 10 m of the start and under the maximum particle speed", () => {
    const s = spawn(0.7, 22);
    for (let i = 0; i < 12; i++) stepWall(s, DT, 0.3, mass(s.d, "bumperFR").world.x);
    const cell = mass(s.d, "cell");
    assert.ok(cell.world.length() < 10, `cell ${cell.world.toArray()} [${mode}]`);
    assert.ok(cell.vel.length() < CRASH.maxMassMps + 0.1);
  });
});

forModes("given a car driving straight into a rigid wall at about 50 km/h (14 m/s)", (spawn, mode) => {
  it("when the impact pulse plays out over 12 steps, then the nose crushes in gradually, not all at once (shape mode: it moves over 4 cm; lattice mode: it is folding by 50 ms, keeps growing, never springs back and ends between 12 cm and the 14 m/s barrier crush distance)", () => {
    const s = spawn(0);
    const samples: number[] = [];
    for (let i = 0; i < 12; i++) {
      stepWall(s, DT, 0.1);
      samples.push((-alongZ(s.d, "bumperFL") + -alongZ(s.d, "bumperFR")) * 0.5);
    }
    if (mode === "shape") {
      const moved = (travel(s.d, "bumperFL") + travel(s.d, "bumperFR")) * 0.5;
      assert.ok(moved > 0.04, `shape nose never moved ${moved}`);
    } else {
      assert.ok(samples[2]! > 0.02, "should have started folding by ~50ms");
      assert.ok(samples[2]! > samples[0]!, "crush should grow across the pulse, not pop");
      // B1: a 14 m/s hit crushes to its equivalent-barrier stroke, then holds — no spring-back.
      assert.ok(samples[11]! >= samples[2]! - 0.01, `nose sprang back: ${samples[2]} → ${samples[11]}`);
      assert.ok(samples[11]! > 0.12, `nose crush too small: ${samples[11]}`);
      assert.ok(samples[11]! <= crushStroke(FRONTAL_MPS, 0.4) + 0.01, `crush past the 14 m/s stroke: ${samples[11]}`);
    }
  });

  it("when the wall crushes the nose for 24 steps, then the rear bumper is not pushed out backward by more than 16 cm nor sucked forward by more than 20 cm", () => {
    const s = spawn(0);
    for (let i = 0; i < 24; i++) stepWall(s, DT, 0.1);
    const rear = (alongZ(s.d, "bumperRL") + alongZ(s.d, "bumperRR")) * 0.5;
    assert.ok(rear > -0.16, `rear extruded backward by ${-rear}m`);
    assert.ok(rear < 0.2, `rear sucked forward by ${rear}m`);
  });

  it("when 3 steps (50 ms) of the impact have passed, then the rear axle is still moving at least 1.5 m/s faster than the bumpers and above 35 % of the impact speed, so the rear keeps piling into the stopped nose", () => {
    const s = spawn(0, FRONTAL_MPS);
    for (let i = 0; i < 3; i++) stepWall(s, DT, 0.12);
    const rear = mass(s.d, "axleR").vel.z;
    const nose = (mass(s.d, "bumperFL").vel.z + mass(s.d, "bumperFR").vel.z) * 0.5;
    assert.ok(rear > nose + 1.5, `rear ${rear.toFixed(2)} should still be piling into nose ${nose.toFixed(2)}`);
    assert.ok(rear > FRONTAL_MPS * 0.35, `rear lost all speed too fast: ${rear}`);
  });

  it("when the wall crushes the front for 18 steps, then the bumper crushes most, the frame rail less than the bumper but at least 40 % as far as the passenger cell (the stiff middle of the car), and the cell less than the bumper (shape mode: the bumper moves over 4 cm and the cell at most 8 cm more than it)", () => {
    const s = spawn(0);
    for (let i = 0; i < 18; i++) stepWall(s, DT, 0.1);
    const nose = travel(s.d, "bumperFL");
    const rail = travel(s.d, "railL");
    const cell = travel(s.d, "cell");
    if (mode === "shape") {
      assert.ok(nose > 0.04, `shape bumper never crushed ${nose}`);
      assert.ok(cell <= nose + 0.08, "passenger cell collapsed more than the bumper");
    } else {
      assert.ok(nose > rail, `bumper ${nose} should crush more than rail ${rail}`);
      assert.ok(rail >= cell * 0.4, `rails disconnected from crush (rail ${rail}, cell ${cell})`);
      assert.ok(cell < nose, "passenger cell should not collapse as much as the bumper");
    }
  });

  it("when the wall crush plays out over 30 steps, then the car stays on the road instead of lofting: the body ends under 22 cm up, the cabin never climbs past 1.15 m and ends falling slower than 8 m/s", () => {
    const s = spawn(0);
    let maxY = 0;
    for (let i = 0; i < 30; i++) {
      stepWall(s, DT, 0.12);
      maxY = Math.max(maxY, s.group.position.y, mass(s.d, "cell").world.y);
    }
    assert.ok(s.group.position.y < 0.22, `group lofted to ${s.group.position.y.toFixed(3)}`);
    assert.ok(maxY < 1.15, `cabin world.y climbed to ${maxY.toFixed(3)}`);
    assert.ok(mass(s.d, "cell").vel.y > -8, `cell slammed down at ${mass(s.d, "cell").vel.y.toFixed(2)}`);
  });

  it("when it has not been crushed yet, then its whole crumple zone is still left (over 1.2 m of remaining crush travel) and the leftover-crumple share reads 1, not 0", () => {
    const { d } = spawn(0);
    const travelLeft = d.crumpleTravel();
    assert.ok(travelLeft > 1.2, `rest crumpleTravel ${travelLeft} looks like already-crushed`);
    assert.equal(leftoverCrumple(travelLeft), 1);
  });

  it("when it closes on the wall at the graze speed (a scrape, not a crash) for 10 steps, then the crush stays under 35 cm instead of being treated as a crash (shape mode: the car does not lift above 22 cm)", () => {
    const s = spawn(0, CRASH.grazeMps);
    for (let i = 0; i < 10; i++) stepWall(s, DT, 0.02);
    const crush = -alongZ(s.d, "bumperFL");
    if (mode === "shape") {
      assert.ok(s.group.position.y < 0.22, `graze lofted to ${s.group.position.y}`);
    } else {
      assert.ok(crush < 0.35, `graze crushed ${crush}m — treated as a crash`);
    }
  });

  it("when one car's squash slider (how soft the body is) is 0.9 and an identical car's is 0.2 over the same 14-step pulse, then the 0.9 car's bumper crushes at least 12 % more", () => {
    const lo = spawn(0);
    lo.d.squash = 0.2;
    const hi = spawn(0);
    hi.d.squash = 0.9;
    for (let i = 0; i < 14; i++) {
      stepWall(lo, DT, 0.1);
      stepWall(hi, DT, 0.1);
    }
    const a = -alongZ(lo.d, "bumperFL");
    const b = -alongZ(hi.d, "bumperFL");
    assert.ok(b > a * 1.12, `squash 0.9 crushed ${b.toFixed(3)} vs 0.2 → ${a.toFixed(3)}`);
  });
});

forModes("given a car whose front corner hits a rigid wall 0.62 m off the centreline", (spawn, mode) => {
  it("when the right-front corner takes the hit for 20 steps, then it crushes more than the left-front corner (lattice mode: over 1.25 times as far and over 8 cm; shape mode: at least 90 % as far, or over 4 cm)", () => {
    const s = spawn(0.62);
    for (let i = 0; i < 20; i++) stepWall(s, DT, 0.12, mass(s.d, "bumperFR").world.x);
    const right = -alongZ(s.d, "bumperFR");
    const left = -alongZ(s.d, "bumperFL");
    if (mode === "shape") {
      const rMove = travel(s.d, "bumperFR");
      const lMove = travel(s.d, "bumperFL");
      assert.ok(rMove >= lMove * 0.9 || rMove > 0.04, `expected right-front to move more, R=${rMove.toFixed(3)} L=${lMove.toFixed(3)}`);
    } else {
      assert.ok(right > left * 1.25 && right > 0.08, `expected right-front crush, got R=${right.toFixed(3)} L=${left.toFixed(3)}`);
    }
  });

  it("when the right-front corner takes the hit for 22 steps, then the hit corner tucks in but the nose does not fold over itself: the right-front bumper stays more than 0.7 m to the right of the left-front one", () => {
    const s = spawn(0.62);
    for (let i = 0; i < 22; i++) stepWall(s, DT, 0.12, mass(s.d, "bumperFR").world.x);
    const r = mass(s.d, "bumperFR").local.x;
    const l = mass(s.d, "bumperFL").local.x;
    assert.ok(r > l + 0.7, `no banana: FL.x=${l.toFixed(3)} FR.x=${r.toFixed(3)}`);
  });

  it("when the left-front corner takes the hit for 20 steps, then it crushes more than the right-front corner, not the other way round (lattice mode: over 1.2 times as far; shape mode: at least 90 % as far)", () => {
    const s = spawn(-0.62);
    for (let i = 0; i < 20; i++) stepWall(s, DT, 0.12, mass(s.d, "bumperFL").world.x);
    const left = -alongZ(s.d, "bumperFL");
    const right = -alongZ(s.d, "bumperFR");
    if (mode === "shape") {
      const lMove = travel(s.d, "bumperFL");
      const rMove = travel(s.d, "bumperFR");
      assert.ok(lMove >= rMove * 0.9, `inverted: L=${lMove.toFixed(3)} R=${rMove.toFixed(3)}`);
    } else {
      assert.ok(left > right * 1.2, `inverted: L=${left.toFixed(3)} R=${right.toFixed(3)}`);
    }
  });

  it("when the right-front corner takes the hit for 18 steps, then the left-front corner takes under 40 % of the struck corner's crush in lattice mode (shape mode: no more than 5 % above it)", () => {
    const s = spawn(0.62);
    for (let i = 0; i < 18; i++) stepWall(s, DT, 0.12, mass(s.d, "bumperFR").world.x);
    const hit = -alongZ(s.d, "bumperFR");
    const opp = -alongZ(s.d, "bumperFL");
    if (mode === "shape") {
      const hitM = travel(s.d, "bumperFR");
      const oppM = travel(s.d, "bumperFL");
      assert.ok(hitM > 0.03);
      assert.ok(oppM <= hitM * 1.05, `opposite leaked ${oppM.toFixed(3)} vs hit ${hitM.toFixed(3)}`);
    } else {
      assert.ok(hit > 0.05);
      assert.ok(opp < hit * 0.4, `opposite leaked ${opp.toFixed(3)} vs hit ${hit.toFixed(3)} — 0.22 floor on impactWeight?`);
    }
  });
});

forModes("given a car receiving an impulse (a sudden change of momentum) from a wall or another car", (spawn) => {
  it("when two mirror-image cars, one driving each way at 12 m/s, each take a 600 N·s impulse against their motion, then their momentum changes are equal and opposite (within 8 N·s), each over 200 N·s", () => {
    const a = spawn(0, 12);
    const b = spawn(0, 12);
    for (const m of b.d.masses) {
      m.vel.z *= -1;
      m.world.z *= -1;
    }
    b.vel.z = -12;
    const pA0 = momentumZ(a.d);
    const pB0 = momentumZ(b.d);
    const j = 600;
    a.d.applyImpulse(0, 0, -1, j);
    b.d.applyImpulse(0, 0, 1, j);
    const dA = momentumZ(a.d) - pA0;
    const dB = momentumZ(b.d) - pB0;
    assert.ok(Math.abs(dA + dB) < 8, `ΔP not opposite: ${dA} vs ${dB}`);
    assert.ok(dA < -200 && dB > 200, `impulse signs wrong dA=${dA} dB=${dB}`);
  });

  it("when an 800 N·s impulse hits the front, then the bumper's speed drops at least 0.4 m/s more than the passenger cell's (the stiff middle of the car), so the impulse lands on the crumple face and the cabin keeps coming", () => {
    const s = spawn(0, 14);
    const bumper0 = mass(s.d, "bumperFL").vel.z;
    const cell0 = mass(s.d, "cell").vel.z;
    s.d.applyImpulse(0, 0, -1, 800);
    const dBumper = mass(s.d, "bumperFL").vel.z - bumper0;
    const dCell = mass(s.d, "cell").vel.z - cell0;
    assert.ok(dBumper < dCell - 0.4, `cabin took the hit (bumper Δv ${dBumper.toFixed(3)}, cell ${dCell.toFixed(3)})`);
  });

  it("when a zero impulse is applied, and then (after a reset, before any new crash starts) a 900 N·s impulse is applied, then neither changes the bumper's speed", () => {
    const s = spawn(0, 10);
    const z0 = mass(s.d, "bumperFL").vel.z;
    s.d.applyImpulse(0, 0, -1, 0);
    assert.equal(mass(s.d, "bumperFL").vel.z, z0);
    s.d.reset();
    mass(s.d, "bumperFL").vel.z = 10;
    s.d.applyImpulse(0, 0, -1, 900);
    assert.equal(mass(s.d, "bumperFL").vel.z, 10, "impulse applied while massActive=false");
  });

  it("when a 700 N·s impulse is applied along a horizontal wall normal (the direction the wall pushes), then it adds no vertical momentum to the car (below 0.000001)", () => {
    const s = spawn(0, 14);
    const y0 = s.d.masses.reduce((sum, m) => sum + m.vel.y * m.mass, 0);
    s.d.applyImpulse(0, 0, -1, 700);
    const y1 = s.d.masses.reduce((sum, m) => sum + m.vel.y * m.mass, 0);
    assert.ok(Math.abs(y1 - y0) < 1e-6, `planar impulse leaked ΔPy=${y1 - y0}`);
  });

  it("when a 500 N·s impulse is applied along the axis, then the car's total momentum changes by exactly that amount (within 0.001 N·s), however the impulse is shared between its parts", () => {
    const s = spawn(0, 14);
    const p0 = momentumZ(s.d);
    const j = 500;
    s.d.applyImpulse(0, 0, -1, j);
    const dp = momentumZ(s.d) - p0;
    assert.ok(Math.abs(dp + j) < 1e-3, `ΔP ${dp} vs -j ${-j} — weights not unit-sum`);
  });
});

// A 25 m/s hit: its energy reaches far past ENGINE_KILL_TRAVEL, so the counted travel is the block's own
// (updateDrivetrain caps a nose hit's travel at what its energy-equivalent stroke reaches).
forModes("given a car whose drivetrain (engine and driven wheels) is working", (spawn) => {
  it("when a 25 m/s wall hit has pushed the engine block back past the distance that kills it (forced 5 cm past it if the crash fell short), then the drivetrain is dead", () => {
    const s = spawn(0, 25);
    assert.equal(s.d.drivetrainAlive, true);
    for (let i = 0; i < 24; i++) stepWall(s, DT, 0.14);
    const eng = Math.max(travel(s.d, "engineL"), travel(s.d, "engineR"));
    if (eng > ENGINE_KILL_TRAVEL) {
      assert.equal(s.d.drivetrainAlive, false);
    } else {
      mass(s.d, "engineL").local.z -= ENGINE_KILL_TRAVEL + 0.05;
      s.d.updateDrivetrain();
      assert.equal(s.d.drivetrainAlive, false);
    }
  });

  it("when the drivetrain is dead and the drive is cut for 0.05 s, then the wheel hubs slow down but the passenger cell (the stiff middle of the car) keeps its forward speed exactly", () => {
    const s = spawn(0, 14);
    s.d.drivetrainAlive = false;
    const cell0 = mass(s.d, "cell").vel.z;
    const hub0 = mass(s.d, "hubFL").vel.z;
    s.d.cutDrive(0.05);
    assert.equal(mass(s.d, "cell").vel.z, cell0);
    assert.ok(mass(s.d, "hubFL").vel.z < hub0, "hubs should lose driven traction");
  });

  it("when the drive is cut for 0.05 s while the drivetrain is still alive, then the wheel hubs keep their speed", () => {
    const s = spawn(0, 14);
    assert.equal(s.d.drivetrainAlive, true);
    const hub0 = mass(s.d, "hubFL").vel.z;
    s.d.cutDrive(0.05);
    assert.equal(mass(s.d, "hubFL").vel.z, hub0);
  });

  it("when the engine block is pushed back 1 cm short of the distance that kills it and then 1 cm past it, then the drivetrain is still alive at first and dead after", () => {
    const s = spawn(0, 25);
    const eng = mass(s.d, "engineL");
    eng.local.copy(eng.rest);
    eng.local.z -= ENGINE_KILL_TRAVEL - 0.01;
    s.d.updateDrivetrain();
    assert.equal(s.d.drivetrainAlive, true, `${(ENGINE_KILL_TRAVEL - 0.01).toFixed(3)} m is not yet wrecked`);
    eng.local.z = eng.rest.z - (ENGINE_KILL_TRAVEL + 0.01);
    s.d.updateDrivetrain();
    assert.equal(s.d.drivetrainAlive, false);
  });

  // CrushCalibration's seed-7 derby: live cars ran with the block 0.25 m back, because a side- or
  // rear-classed later hit made updateDrivetrain return early or measure the other way.
  it("when an earlier nose hit pushed the engine block back 3 cm past the distance that kills it and the latest hit comes from the side or from behind, then the drivetrain is still dead and its health is 0", () => {
    for (const inward of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)]) {
      const s = spawn(0);
      const eng = mass(s.d, "engineL");
      eng.local.z = eng.rest.z - (ENGINE_KILL_TRAVEL + 0.03);
      s.d.impactInward.copy(inward);
      s.d.updateDrivetrain();
      assert.equal(s.d.drivetrainAlive, false, `block ${(ENGINE_KILL_TRAVEL + 0.03).toFixed(2)} m back survived a hit along ${inward.toArray().join(",")}`);
      assert.equal(s.d.drivetrainHealth, 0);
    }
  });

  it("when both engine mounts are stretched 0.35 m forward of their rest position while the passenger cell is at rest, then the drivetrain is still alive, because a forward stretch is not a crushed engine block", () => {
    const s = spawn(0);
    for (const name of ["engineL", "engineR"]) {
      const eng = mass(s.d, name);
      eng.local.copy(eng.rest);
      eng.local.z += 0.35;
    }
    s.d.updateDrivetrain();
    assert.equal(s.d.drivetrainAlive, true, "forward stretch is not a dead block");
  });
});

describe("given a car whose body is a lattice of spring beams, in lattice deform mode", () => {
  it("when the unbroken beams are followed outward from the passenger cell (the stiff middle of the car), then every body particle of the car is reached, so none is cut off", () => {
    const { d } = spawn(0, FRONTAL_MPS, new THREE.Vector3(0, 0, -1), undefined, "lattice");
    const snap = d.snapshot() as { beams: { a: string; b: string; alive: boolean }[] };
    const adj = new Map<string, string[]>();
    for (const m of d.masses) adj.set(m.name, []);
    for (const b of snap.beams) {
      if (!b.alive) continue;
      adj.get(b.a)!.push(b.b);
      adj.get(b.b)!.push(b.a);
    }
    const seen = new Set<string>(["cell"]);
    const q = ["cell"];
    while (q.length) {
      const n = q.pop()!;
      for (const k of adj.get(n) ?? []) {
        if (seen.has(k)) continue;
        seen.add(k);
        q.push(k);
      }
    }
    assert.equal(seen.size, d.masses.length, `disconnected: ${d.masses.map((m) => m.name).filter((n) => !seen.has(n))}`);
  });

  it("when the engine block is pushed 12 cm back toward the cabin and one physics step runs, then the squeezed beams push it forward again (its forward speed rises)", () => {
    const s = spawn(0, FRONTAL_MPS, new THREE.Vector3(0, 0, -1), undefined, "lattice");
    const a = mass(s.d, "engineL");
    const b = mass(s.d, "railL");
    const rest = a.world.distanceTo(b.world);
    a.world.z -= 0.12;
    const vz0 = a.vel.z;
    s.d.stepStructure(DT);
    assert.ok(a.vel.z > vz0, `no restoring spring (vz ${a.vel.z} vs ${vz0}), rest was ${rest}`);
  });

  it("when the squeezed engine block is already separating from its neighbouring rail (its own speed set to 2 m/s), then the beams still push on it: after one physics step its speed has changed and stays above half of 2 m/s", () => {
    const s = spawn(0, FRONTAL_MPS, new THREE.Vector3(0, 0, -1), undefined, "lattice");
    const a = mass(s.d, "engineL");
    mass(s.d, "railL");
    a.world.z -= 0.12;
    a.vel.z = 2;
    const vz0 = a.vel.z;
    s.d.stepStructure(DT);
    assert.ok(a.vel.z > vz0 * 0.5, "separating compressed beam went slack");
    assert.ok(a.vel.z !== vz0, "no force at all while separating");
  });
});

forModes("given a car set up for a head-on crash into a wall", (spawn, mode) => {
  it("when the wall crushes the nose for 20 steps, then the rear bumper does not crumple: it moves less than 18 cm (28 cm in shape mode) and, in lattice mode, its bar keeps its rest length within 2 cm", () => {
    const s = spawn(0);
    for (let i = 0; i < 20; i++) stepWall(s, DT, 0.12);
    const rearTravel = (travel(s.d, "bumperRL") + travel(s.d, "bumperRR")) * 0.5;
    assert.ok(rearTravel < (mode === "shape" ? 0.28 : 0.18), `rear crumpled ${rearTravel.toFixed(3)} [${mode}]`);
    if (mode === "lattice") {
      const snap = s.d.snapshot() as { beams: { a: string; b: string; rest: number; plastic: number }[] };
      const rear = snap.beams.find((b) => b.a === "bumperRL" && b.b === "bumperRR");
      assert.ok(rear);
      assert.ok(Math.abs(rear!.plastic - rear!.rest) < 0.02, `rear bar plastic ${rear!.plastic} vs rest ${rear!.rest}`);
    }
  });

  it("when the front-left bumper is pressed 18 cm back from rest and one physics step runs, then it springs back toward rest (lattice mode: by at least 4 mm; shape mode: without overshooting rest by 20 cm)", () => {
    const s = spawn(0);
    const a = mass(s.d, "bumperFL");
    const z0 = a.world.z;
    a.world.z -= 0.18;
    a.vel.z = 0;
    s.d.stepStructure(DT);
    if (mode === "shape") {
      // Plastic shape-matching holds the dent; it must not explode outward past rest.
      assert.ok(a.world.z < z0 + 0.2, `shape exploded past rest ${a.world.z} vs ${z0}`);
    } else {
      assert.ok(a.world.z > z0 - 0.18 + 0.004, `no restore [${mode}] z ${a.world.z} from ${z0 - 0.18}`);
    }
  });
});

forModes("given a car and kickNearestHub (the call that hops only the wheel hub nearest a point, not the whole car)", (spawn) => {
  it("when the point is on the front-left hub and the upward kick strength is 26, then that hub is kicked up (its name is returned and it rises faster than 0.8 m/s) while the front-right hub and the passenger cell do not move", () => {
    const s = spawn(0);
    const p = mass(s.d, "hubFL").world.clone();
    const name = s.d.kickNearestHub(p, 26);
    assert.equal(name, "hubFL");
    assert.ok(mass(s.d, "hubFL").vel.y > 0.8);
    assert.ok(Math.abs(mass(s.d, "hubFR").vel.y) < 1e-6);
    assert.ok(Math.abs(mass(s.d, "cell").vel.y) < 1e-6);
  });

  it("when the point is on the engine block and the kick strength is 26, then a wheel hub is still kicked (the returned name starts with hub), never the engine", () => {
    const s = spawn(0);
    const name = s.d.kickNearestHub(mass(s.d, "engineL").world.clone(), 26);
    assert.ok(name && name.startsWith("hub"), `kicked ${name}`);
  });

  it("when the kick strength is 0, then it returns null and the hub's vertical speed does not change", () => {
    const s = spawn(0);
    const y0 = mass(s.d, "hubFL").vel.y;
    assert.equal(s.d.kickNearestHub(mass(s.d, "hubFL").world.clone(), 0), null);
    assert.equal(mass(s.d, "hubFL").vel.y, y0);
  });

  it("when the point is on the engine block, which is closer than any hub, and the kick strength is 52, then exactly one wheel hub is kicked up and the engine block itself is not", () => {
    const s = spawn(0);
    // Place the query at engineL; engine is closer than any hub in Euclidean 3D,
    // but the API is hubs-only.
    const eng = mass(s.d, "engineL").world.clone();
    s.d.kickNearestHub(eng, 52);
    assert.ok(Math.abs(mass(s.d, "engineL").vel.y) < 1e-6, "engine got the hub kick");
    const hubs = ["hubFL", "hubFR", "hubRL", "hubRR"] as const;
    const kicked = hubs.filter((h) => mass(s.d, h).vel.y > 0.1);
    assert.equal(kicked.length, 1, `kicked ${kicked.join(",")}`);
  });
});

forModes("given a car whose right-front corner is crushed against a wall 0.62 m off the centreline", (spawn) => {
  it("when the right-front corner is crushed for 18 steps, then the right-front wing's damage sensor reads over twice the left-front wing's", () => {
    const s = spawn(0.62);
    for (let i = 0; i < 18; i++) stepWall(s, DT, 0.12, mass(s.d, "bumperFR").world.x);
    assert.ok(s.d.sensorCompression(5) > s.d.sensorCompression(4) * 2, "wingFR sensor should dominate wingFL");
  });

  it("when the right-front corner is crushed for 18 steps, then the front bumper as a whole reads crushed (over 0.05) while the right bumper sensor reads over 1.5 times the left one's, so a corner nick does not break both headlamps", () => {
    const s = spawn(0.62);
    for (let i = 0; i < 18; i++) stepWall(s, DT, 0.12, mass(s.d, "bumperFR").world.x);
    const shared = s.d.partCompression("bumperFront");
    const leftBumper = s.d.sensorCompression(1);
    const rightBumper = s.d.sensorCompression(2);
    assert.ok(shared > 0.05, "front bumper did crush");
    assert.ok(rightBumper > leftBumper * 1.5, `left bumper sensor ${leftBumper} rode the shared part (${shared})`);
  });

  it("when the right-front corner is crushed for 16 steps, then the left headlamp's own corner sensor stays at a graze (under 0.25, or under half the right one's) whatever the centre bumper sensor reads", () => {
    const s = spawn(0.62);
    for (let i = 0; i < 16; i++) stepWall(s, DT, 0.14, mass(s.d, "bumperFR").world.x);
    // Right-hit: sensor 0 (center) may be mid, sensor 1 (left) must stay a graze.
    assert.ok(s.d.sensorCompression(1) < 0.25 || s.d.sensorCompression(1) < s.d.sensorCompression(2) * 0.5);
  });
});

forModes("given a car hit from behind at 14 m/s", (spawn) => {
  it("when the rear is crushed for 16 steps, then the tail's bumpers move more than 4 cm further than the nose's", () => {
    const s = spawn(0, -14, new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0.36, -2.06));
    const n = new THREE.Vector3(0, 0, 1);
    for (let i = 0; i < 16; i++) {
      s.vel.z = -14;
      stepWall(s, DT, 0.12, 0, n);
    }
    const tail = (travel(s.d, "bumperRL") + travel(s.d, "bumperRR")) * 0.5;
    const nose = (travel(s.d, "bumperFL") + travel(s.d, "bumperFR")) * 0.5;
    assert.ok(tail > nose + 0.04, `rear hit crushed nose ${nose.toFixed(3)} more than tail ${tail.toFixed(3)}`);
  });
});

forModes("given a car whose right side is pushed in at 10 m/s", (spawn) => {
  it("when the side is pushed in for 14 steps, then the right door and right-front wing crush further than the left ones (lattice mode: by over 5 %; shape mode: the right side moves over 6 cm)", () => {
    const s = spawn(0.7, 10, new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0.78, 0.5, 0.08));
    const n = new THREE.Vector3(-1, 0, 0);
    s.vel.set(10, 0, 0);
    for (let i = 0; i < 14; i++) {
      s.vel.x = 10;
      const door = mass(s.d, "doorR").world;
      s.d.notifyContact();
      s.d.feedOverlap(door, n, 0.1, 10, DT);
      s.d.applyImpulse(n.x, 0, n.z, 80);
      s.d.stepStructure(DT);
      s.d.followGroup(s.group, s.vel, s.omega, DT);
      s.d.stepCrush(DT, true);
      s.d.update(s.geom);
    }
    const L = travel(s.d, "doorL") + travel(s.d, "wingFL");
    const R = travel(s.d, "doorR") + travel(s.d, "wingFR");
    if (s.d.mode === "shape") {
      assert.ok(R > 0.06, `right side never moved R=${R.toFixed(3)}`);
    } else {
      assert.ok(R > L * 1.05, `side hit not local L=${L.toFixed(3)} R=${R.toFixed(3)}`);
    }
  });
});

forModes("given a car struck at its nose or its tail", (spawn) => {
  it("when a 600 N·s frontal impulse is applied, then the bumper's speed changes by more than twice as much as the door's, so the doors do not absorb the hit like a second bumper", () => {
    const s = spawn(0, 14);
    const door0 = mass(s.d, "doorL").vel.z;
    const bump0 = mass(s.d, "bumperFL").vel.z;
    s.d.applyImpulse(0, 0, -1, 600);
    const dDoor = Math.abs(mass(s.d, "doorL").vel.z - door0);
    const dBump = Math.abs(mass(s.d, "bumperFL").vel.z - bump0);
    assert.ok(dBump > dDoor * 2, `doors ate the frontal impulse (door ${dDoor.toFixed(3)} bumper ${dBump.toFixed(3)})`);
  });

  // A frontal hit's far end is the tail: its bumpers are not the facing crumple zone, so a push along the struck line
  // (`separateAlong`, a pair's or a wall's shove) carries them with the cabin. Weighted as a second face they took
  // 12 % of every push and pumped ~730 J of internal kinetic energy into a pinned wreck (derby wreck residue).
  for (const [end, nz, far] of [
    ["nose", -1, ["bumperRL", "bumperRR"]],
    ["tail", 1, ["bumperFL", "bumperFR"]],
  ] as const) {
    it(`when a push along the line of a ${end} hit moves the cabin, then the bumpers at the far end move with it by the same distance and speed, as one rigid body`, () => {
      const s = spawn(0, 14, new THREE.Vector3(0, 0, nz), new THREE.Vector3(0, 0.36, -nz * 2.06));
      const cell = mass(s.d, "cell");
      const cell0 = { z: cell.world.z, v: cell.vel.z };
      const was = far.map((n) => ({ z: mass(s.d, n).world.z, v: mass(s.d, n).vel.z }));
      s.d.separateAlong(0, 0, nz, 0.02, 2);
      for (const [i, n] of far.entries()) {
        const m = mass(s.d, n);
        assert.ok(Math.abs(m.world.z - was[i]!.z - (cell.world.z - cell0.z)) < 1e-9, `${n} moved ${((m.world.z - was[i]!.z) * 1000).toFixed(2)} mm, cabin ${((cell.world.z - cell0.z) * 1000).toFixed(2)} mm`);
        assert.ok(Math.abs(m.vel.z - was[i]!.v - (cell.vel.z - cell0.v)) < 1e-9, `${n} dv ${(m.vel.z - was[i]!.v).toFixed(3)} m/s, cabin ${(cell.vel.z - cell0.v).toFixed(3)} m/s`);
      }
    });
  }
});

forModes("given a car set up for a wall crash", (spawn) => {
  it("when 0.4 s of simulation pass and then a contact is reported, then its quiet time (seconds since it was last touched) is 0 at the start, 0.4 s after the wait and 0 again right after the touch", () => {
    const s = spawn(0);
    assert.equal(s.d.quietTime(), 0);
    s.d.stepStructure(0.4);
    assert.ok(Math.abs(s.d.quietTime() - 0.4) < 1e-6);
    s.d.notifyContact();
    assert.equal(s.d.quietTime(), 0);
  });
});

forModes("given a car that has never been crashed (its body simulation is idle)", (spawn, mode) => {
  // A car whose masses are idle has no contact window: `elapsed` stands still, so a touch marked then (a wall, a prop or a ramp's
  // flank below a crash) read "just touched" for good, and no keyframe carries it for a car that is no wreck (engine-replay seed 30
  // with the far-end bumper weight: the replay's bystander was quiet, the live one not, a wreck's masses met it live and not replayed).
  it("when a wall touches it, then its body simulation stays idle and its quiet time (seconds since it was last touched) stays what it was for a car never touched, over 1 s", () => {
    const d = new StreamedDeformation(dummyGeom());
    d.mode = mode;
    const untouched = d.quietTime();
    d.notifyContact();
    assert.equal(d.massActive, false);
    assert.equal(d.quietTime(), untouched, `an idle car touched reads ${d.quietTime()} s quiet, untouched ${untouched} s`);
    assert.ok(d.quietTime() > 1, `an idle car is not in a contact window: ${d.quietTime()} s`);
  });
});

forModes("given a car that has been crushed against a wall for 12 steps", (spawn) => {
  it("when it is reset, then it is back at rest: drivetrain alive, body simulation idle, front-left bumper at its rest position, sensor 0 uncompressed and the crush clock at 0", () => {
    const s = spawn(0);
    for (let i = 0; i < 12; i++) stepWall(s, DT, 0.12);
    s.d.reset();
    assert.equal(s.d.drivetrainAlive, true);
    assert.equal(s.d.massActive, false);
    assert.equal(travel(s.d, "bumperFL"), 0);
    assert.ok(s.d.sensorCompression(0) === 0, `sensor 0 still compressed ${s.d.sensorCompression(0)}`);
    assert.equal(s.d.crushElapsed, 0);
  });
});

forModes("given a freshly built car whose body simulation is idle", (spawn, mode) => {
  it("when its body simulation is armed for a speed bump at 8 m/s, then the simulation is on but no crush animation has started, the drivetrain is alive and the impact point is at the centre (within 1 cm)", () => {
    const geom = dummyGeom();
    const d = new StreamedDeformation(geom);
    d.mode = mode;
    const group = new THREE.Group();
    d.armMasses(group, new THREE.Vector3(0, 0, 8), new THREE.Vector3());
    assert.equal(d.massActive, true);
    assert.equal(d.drivetrainAlive, true);
    assert.equal(d.crushElapsed, 0);
    assert.ok(Math.abs(d.impactLocal.x) < 0.01);
  });

  it("when a crash begins with an impulse of 2 and then again with 400, then the stored impulse is raised to the minimum of 4 for the first and capped at 70 for the second", () => {
    const geom = dummyGeom();
    const d = new StreamedDeformation(geom);
    d.mode = mode;
    const group = new THREE.Group();
    d.beginCrush(new THREE.Vector3(0, 0.36, 2.06), new THREE.Vector3(0, 0, -1), 2, 2, group, new THREE.Vector3(), new THREE.Vector3());
    assert.equal(d.impulseValue, 4);
    d.beginCrush(new THREE.Vector3(0, 0.36, 2.06), new THREE.Vector3(0, 0, -1), 400, 400, group, new THREE.Vector3(), new THREE.Vector3());
    assert.equal(d.impulseValue, 70);
  });
});

forModes("given feedOverlap (the call that turns the wall's overlap into crush and returns the closing speed left over)", (spawn, mode) => {
  it("when a car crashing at 14 m/s is fed 8 cm of wall overlap at 14 m/s closing speed, then the leftover closing speed is between 0 and 14 m/s and below 14, because the crush absorbs some", () => {
    const s = spawn(0, 14);
    const remain = s.d.feedOverlap(mass(s.d, "bumperFL").world, new THREE.Vector3(0, 0, -1), 0.08, 14, DT);
    assert.ok(remain >= 0 && remain <= 14);
    assert.ok(remain < 14, "should absorb some closing");
  });

  it("when a car with no crash set up is fed 20 m/s of closing speed, then the call returns the 20 m/s unchanged because nothing is absorbed", () => {
    const geom = dummyGeom();
    const d = new StreamedDeformation(geom);
    d.mode = mode;
    const r = d.feedOverlap(new THREE.Vector3(), new THREE.Vector3(0, 0, -1), 1, 20, DT);
    assert.equal(r, 20);
  });

  it("when a car crashing at 14 m/s is fed only 1 cm of overlap, then the bumper moves less than 5 cm: a nibble is not a teleport", () => {
    const s = spawn(0, 14);
    const z0 = mass(s.d, "bumperFL").world.z;
    s.d.feedOverlap(mass(s.d, "bumperFL").world.clone(), new THREE.Vector3(0, 0, -1), 0.01, 14, DT);
    const dz = Math.abs(mass(s.d, "bumperFL").world.z - z0);
    assert.ok(dz < 0.05, `nibble was a teleport (${dz}m)`);
  });

  it("when one car is fed a 1/60 s step and another car two 1/120 s steps with the same overlap, then the two half steps move the bumper less than 1.7 times as far as the one full step, because feeds scale with time, not with the number of calls", () => {
    const once = spawn(0, 14);
    const z0 = mass(once.d, "bumperFL").world.z;
    once.d.feedOverlap(mass(once.d, "bumperFL").world.clone(), new THREE.Vector3(0, 0, -1), 0.1, 14, DT);
    const d1 = Math.abs(mass(once.d, "bumperFL").world.z - z0);

    const twice = spawn(0, 14);
    const z1 = mass(twice.d, "bumperFL").world.z;
    const p = mass(twice.d, "bumperFL").world.clone();
    twice.d.feedOverlap(p, new THREE.Vector3(0, 0, -1), 0.1, 14, DT / 2);
    twice.d.feedOverlap(mass(twice.d, "bumperFL").world.clone(), new THREE.Vector3(0, 0, -1), 0.1, 14, DT / 2);
    const d2 = Math.abs(mass(twice.d, "bumperFL").world.z - z1);
    assert.ok(d2 < d1 * 1.7, `half-dt×2 crushed ${d2.toFixed(4)} vs full ${d1.toFixed(4)} — per-call teleport`);
  });
});

forModes("given a wheel hub driven down into the pavement", (spawn, mode) => {
  it("when the front-left hub is 10 cm up and moving down at 4 m/s and one physics step runs, then the road stops it: the hub is lifted to at least 27 cm and keeps at most 0.05 m/s of downward speed (0.15 m/s in shape mode)", () => {
    const s = spawn(0);
    const h = mass(s.d, "hubFL");
    h.world.y = 0.1;
    h.vel.y = -4;
    s.d.stepStructure(DT);
    assert.ok(h.world.y >= 0.27);
    assert.ok(h.vel.y >= (mode === "shape" ? -0.15 : -0.05), `restitution bounce vel.y=${h.vel.y}`);
  });
});

forModes("given a car with its total mass, the sum of the masses of all its body particles", (spawn) => {
  it("when the wall crushes it for 10 steps, then its total mass is the lumped sum of its parts (between 600 and 1200 kg, not 1) and the crush does not change it", () => {
    const s = spawn(0);
    const m0 = s.d.totalMass;
    assert.ok(m0 > 600 && m0 < 1200, `sedan mass ${m0}`);
    for (let i = 0; i < 10; i++) stepWall(s, DT, 0.1);
    assert.equal(s.d.totalMass, m0);
  });
});

forModes("given a car whose wheels stay on until a hard enough hit knocks them off", (spawn, mode) => {
  it("when the wall crushes the front for 22 steps at 16 m/s, then every wheel that stays on has moved less than 8 cm and every wheel that pops off has moved at least 0.45 of its radius, so the crush does not drag wheels through the wheel arch", () => {
    const s = spawn(0, 16);
    for (let i = 0; i < 22; i++) stepWall(s, DT, 0.14);
    for (const name of ["hubFL", "hubFR", "hubRL", "hubRR"] as const) {
      const h = mass(s.d, name);
      const xz = Math.hypot(h.local.x - h.rest.x, h.local.z - h.rest.z);
      if (!h.popped) {
        assert.ok(xz < 0.08, `${name} slid ${xz.toFixed(3)} without popping [${mode}]`);
      } else {
        assert.ok(xz >= h.radius * 0.5 * 0.9, `${name} popped but barely moved`);
      }
    }
  });

  // C4: a wheel leaves only when a hard (≥ 54 km/h EBS) off-centre hit crushes its corner onto the tyre.
  const crushCorner = (speed: number, impactX: number, inward = new THREE.Vector3(0, 0, -1)) => {
    const s = spawn(impactX, speed, inward);
    const b = mass(s.d, "bumperFR");
    b.local.z = b.rest.z - 0.34;
    b.world.copy(b.local);
    for (const name of ["hubFL", "hubFR", "hubRL", "hubRR"] as const) {
      const h = mass(s.d, name);
      h.local.z = h.rest.z - 0.2;
      h.world.copy(h.local);
    }
    s.group.updateMatrixWorld();
    s.d.followGroup(s.group, s.vel, s.omega, DT);
    return s;
  };
  const popped = (s: ReturnType<typeof spawn>) => (["hubFL", "hubFR", "hubRL", "hubRR"] as const).filter((n) => mass(s.d, n).popped);

  it("when a 64 km/h hit on the right-front corner has crushed that corner onto the tyre, then only the right-front wheel pops off", () => {
    assert.deepEqual(popped(crushCorner(64 / 3.6, 0.62)), ["hubFR"]);
  });

  it("when the same corner crush happens at 50 km/h, or square on (centred) at 64 km/h, then every wheel stays on", () => {
    assert.deepEqual(popped(crushCorner(50 / 3.6, 0.62)), [], "50 km/h corner");
    assert.deepEqual(popped(crushCorner(64 / 3.6, 0)), [], "64 km/h square");
  });

  it("when a deep crush (walls past both wheel midpoints, so the cage may yield) is switched on and the front-left hub is moved 10 cm forward of its rest position, then the wheel stays on and the hub is not pinned back to rest (it stays over 4 cm away)", () => {
    const s = spawn(0);
    s.d.deepCrush = true;
    s.d.bidirectional = true;
    const h = mass(s.d, "hubFL");
    h.local.z = h.rest.z + 0.1;
    h.world.copy(h.local);
    s.d.followGroup(s.group, s.vel, s.omega, DT);
    assert.equal(h.popped, false);
    assert.ok(Math.abs(h.local.z - h.rest.z) > 0.04, "deepCrush pinned the hub anyway");
  });

  // A planted wreck's frame sits on the mean of its hubs, each held at its pin (`rest` + shove) in the car frame while its
  // world position stands wherever the world left it. A hub knocked 0.3 m off its axle stood 0.22 m off its pin in the
  // anchor's read; the hub then popping re-anchored the frame on the other three and jumped the whole wreck by the
  // difference of the means (derby seeds 25/38/61: 0.10-0.20 m in one step; 0.075 m here).
  it("when a wreck that has settled in place for 1 s has its front-left wheel knocked 30 cm off its axle, held there for 0.5 s, and that wheel then pops off, then the frame and every other body particle stay within 1 cm of where they were", () => {
    const s = spawn(0, 0);
    const settle = (n: number) => {
      for (let i = 0; i < n; i++) {
        s.d.stepStructure(DT);
        s.d.followGroup(s.group, s.vel, s.omega, DT);
      }
    };
    settle(60);
    assert.ok(s.d.quietTime() > 0.5, "not planted");
    const fl = mass(s.d, "hubFL");
    fl.world.x -= 0.3;
    settle(30);
    assert.equal(fl.popped, false);
    const before = s.d.masses.map((m) => m.world.clone());
    const frame = s.group.position.clone();
    s.d.popHub(fl);
    settle(1);
    assert.equal(fl.popped, true);
    assert.ok(s.group.position.distanceTo(frame) < 0.01, `frame jumped ${s.group.position.distanceTo(frame).toFixed(3)} m at the pop`);
    for (const [i, m] of s.d.masses.entries()) {
      if (m !== fl) assert.ok(m.world.distanceTo(before[i]!) < 0.01, `${m.name} jumped ${m.world.distanceTo(before[i]!).toFixed(3)} m at the pop`);
    }
  });

  it("when a squeezing wall face reaches 10 cm into the tread of the front-left tyre of a standing car, then the hub is shoved back over 9 cm, stays shoved on the next step and the wheel stays on", () => {
    const s = spawn(0, 0);
    s.d.bidirectional = true;
    const h = mass(s.d, "hubFL");
    // A slab square to the car (normal −z) whose near face is 0.1 m inside the tyre (hub z + TYRE_R).
    const face = h.world.z + TYRE_R - 0.1;
    s.d.projectOutOfBox(h.world.x, face + 0.5, 0.5, 0.06, Math.PI / 2);
    s.d.followGroup(s.group, s.vel, s.omega, DT);
    assert.ok(h.local.z - h.rest.z < -0.09, `hub held at ${(h.local.z - h.rest.z).toFixed(3)} m: the face is inside the tyre`);
    s.d.followGroup(s.group, s.vel, s.omega, DT);
    assert.ok(h.local.z - h.rest.z < -0.09, "the pin pulled the hub back into the face");
    assert.equal(h.popped, false);
  });

  it("when a wall face shoves a standing car's front-right wheel back more than one wheel diameter, then the wheel tears off, whereas with wheel detaching switched off it stays on and moves at most one wheel diameter", () => {
    const on = spawn(0, 0);
    on.d.shoveHub(mass(on.d, "hubFR"), 0, -(2 * TYRE_R + 0.01));
    on.d.followGroup(on.group, on.vel, on.omega, DT);
    assert.equal(mass(on.d, "hubFR").popped, true, "a wheel diameter of shove left the wheel on");
    const held = spawn(0, 0);
    held.d.wheelsDetach = false;
    held.d.shoveHub(mass(held.d, "hubFR"), 0, -1);
    held.d.followGroup(held.group, held.vel, held.omega, DT);
    const hub = mass(held.d, "hubFR");
    assert.equal(hub.popped, false, "wheelsDetach off still popped the wheel");
    assert.ok(Math.abs(hub.local.z - hub.rest.z) <= 2 * TYRE_R + 1e-6, `shoved ${(hub.local.z - hub.rest.z).toFixed(3)} m past a diameter`);
  });

  it("when three wheels have popped off and then the fourth does too, then the drivetrain is still alive with three gone and dead once all four are gone, like a dead engine", () => {
    const s = spawn(0, 0);
    for (const name of ["hubFL", "hubFR", "hubRL"] as const) s.d.popHub(mass(s.d, name));
    s.d.followGroup(s.group, s.vel, s.omega, DT);
    assert.equal(s.d.drivetrainAlive, true, "three wheels gone already killed it");
    s.d.popHub(mass(s.d, "hubRR"));
    s.d.followGroup(s.group, s.vel, s.omega, DT);
    assert.equal(s.d.drivetrainAlive, false, "no wheels and still driving");
  });

  it("when frame crushing is switched off (race mode) and a deep crush is requested, then deep crush reads off, and switching frame crushing back on makes the requested deep crush read on", () => {
    const s = spawn(0);
    s.d.frameCrush = false;
    s.d.deepCrush = true;
    assert.equal(s.d.deepCrush, false);
    s.d.frameCrush = true;
    assert.equal(s.d.deepCrush, true, "the squeeze was forgotten while the frame was held");
  });
});

// Shape mode only (the game's default): the lattice's beams carry a wheel's speed into the body, which then moves for real.
describe("given a wreck that has just stopped being touched, in shape deform mode", () => {
  // A wheel written back every call keeps a velocity of its own, and contact impulses went on piling onto it with no
  // position to show for them (17–42 m/s against a body at 2 m/s at the plant of derby seed 65's pile). The plant freed
  // the wheels at that speed and the frame, anchored on them, followed 0.08 m a step.
  it("when the wheels carry a stale 30 m/s sideways speed and the car then sits untouched until it settles in place, then each wheel is held within 8 m/s of the body and the frame moves less than 8 m/s's worth (13 cm) per 1/60 s step, so the wheels' stale speed cannot carry the frame off", () => {
    const s = spawn(0, 0, undefined, undefined, "shape");
    const step = () => {
      s.d.stepStructure(DT);
      s.d.followGroup(s.group, s.vel, s.omega, DT);
    };
    for (let i = 0; i < 6; i++) step();
    assert.ok(s.d.quietTime() < 0.2, "already planted");
    for (const m of s.d.masses) if (m.hub) m.vel.x = 30;
    for (let i = 0; i < 12; i++) step();
    assert.ok(s.d.quietTime() > 0.25, "never planted");
    const cell = mass(s.d, "cell");
    for (const m of s.d.masses) if (m.hub) assert.ok(m.vel.x - cell.vel.x <= 8 + 1e-9, `${m.name} freed at ${(m.vel.x - cell.vel.x).toFixed(2)} m/s off the body`);
    let worst = 0;
    for (let i = 0; i < 6; i++) {
      const before = s.group.position.clone();
      step();
      worst = Math.max(worst, s.group.position.distanceTo(before));
    }
    assert.ok(worst < 8 * DT, `the frame followed the wheels ${worst.toFixed(3)} m in one 1/60 s step (8 m/s: ${(8 * DT).toFixed(3)})`);
  });
});

forModes("given a wreck that has settled in place with three wheels knocked off their axles, so its passenger cell stands off its rest position", (spawn) => {
  // A quiet wreck's frame sits on its hubs and its cell stands off its rest in it (here three wheels knocked off their
  // axles: 0.11 m). The first hit stores each mass's damage base, and the touch ends the plant in the same call: a base
  // taken cell-relative left the offset in every mass's travel, and the first live clamp dragged the whole body back by
  // it (derby seed 19 car 6 at 80.22 s: 0.11 m in one dt = 0 call, a zip).
  it("when a new hit touches it, then no body particle except the wheels jumps more than 3 cm, because the new hit does not drag the body back by how far the settled cabin stands off its rest position", () => {
    const s = spawn(0, 0);
    const settle = (n: number) => {
      for (let i = 0; i < n; i++) {
        s.d.stepStructure(DT);
        s.d.followGroup(s.group, s.vel, s.omega, DT);
      }
    };
    settle(120);
    for (const name of ["hubFL", "hubFR", "hubRL"]) {
      const h = mass(s.d, name);
      h.world.x -= 0.3;
      h.world.z += 0.15;
    }
    settle(30);
    const cell = mass(s.d, "cell");
    assert.ok(s.d.quietTime() > 2, "not planted");
    assert.ok(cell.local.distanceTo(cell.rest) > 0.05, `the cell stands ${cell.local.distanceTo(cell.rest).toFixed(3)} m off its rest: nothing to drag`);
    const before = s.d.masses.map((m) => m.world.clone());
    assert.equal(s.d.rearmHit(new THREE.Vector3(-0.95, 0.36, 0), new THREE.Vector3(1, 0, 0), 20, 6), true);
    s.d.followGroup(s.group, s.vel, s.omega, 0);
    for (const [i, m] of s.d.masses.entries()) {
      if (!m.hub) assert.ok(m.world.distanceTo(before[i]!) < 0.03, `${m.name} jumped ${m.world.distanceTo(before[i]!).toFixed(3)} m at the touch`);
    }
  });
});

forModes("given a car driving hard into a rigid wall (16 to 20 m/s)", (spawn, mode) => {
  it("when the right-front corner hits the wall 0.62 m off centre for 24 steps, then it crushes over 1.25 times as far as the left-front corner (1.15 times in shape mode) and over 8 cm", () => {
    const s = spawn(0.62, 16);
    for (let i = 0; i < 24; i++) stepWall(s, DT, 0.16, mass(s.d, "bumperFR").world.x);
    const fl = travel(s.d, "bumperFL");
    const fr = travel(s.d, "bumperFR");
    assert.ok(fr > fl * (mode === "shape" ? 1.15 : 1.25), `corners tied FL=${fl.toFixed(3)} FR=${fr.toFixed(3)} [${mode}]`);
    assert.ok(fr > 0.08, `right corner never crushed ${fr.toFixed(3)}`);
  });

  it("when a car-to-car-sized bite (18 cm of wall overlap per step) is taken head-on at 20 m/s for 18 steps, then the nose actually shortens by over 12 cm", () => {
    const s = spawn(0, 20);
    const z0 = (mass(s.d, "bumperFL").local.z + mass(s.d, "bumperFR").local.z) * 0.5;
    for (let i = 0; i < 18; i++) stepWall(s, DT, 0.18);
    const z1 = (mass(s.d, "bumperFL").local.z + mass(s.d, "bumperFR").local.z) * 0.5;
    assert.ok(z0 - z1 > 0.12, `skin/lattice did not eat overlap Δz=${(z0 - z1).toFixed(3)} [${mode}]`);
  });
});

forModes("given a car driving into a rigid wall at 16 m/s (about 58 km/h)", (spawn, mode) => {
  it("when the squash slider (how soft the body is) and the buckle setting are both 0 for 18 steps, then the nose barely folds (shape mode: under 58 cm of crush)", () => {
    const s = spawn(0, 16);
    s.d.squash = 0;
    s.d.buckle = 0;
    const z0 = mass(s.d, "bumperFL").local.z;
    for (let i = 0; i < 18; i++) stepWall(s, DT, 0.16);
    const crush = z0 - mass(s.d, "bumperFL").local.z;
    if (mode === "shape") {
      assert.ok(crush < 0.58, `squash=0 still ate ${crush.toFixed(3)}m [${mode}]`);
    }
  });

  it("when one car has the squash slider (how soft the body is) at 1 and an identical car has it at 0 over the same 16-step pulse, then the squash-1 car's bumper crushes more than 8 cm further", () => {
    const lo = spawn(0, 16);
    lo.d.squash = 0;
    const hi = spawn(0, 16);
    hi.d.squash = 1;
    for (let i = 0; i < 16; i++) {
      stepWall(lo, DT, 0.14);
      stepWall(hi, DT, 0.14);
    }
    const a = -alongZ(lo.d, "bumperFL");
    const b = -alongZ(hi.d, "bumperFL");
    assert.ok(b > a + 0.08, `slider dead 0→${a.toFixed(3)} 1→${b.toFixed(3)} [${mode}]`);
  });

  it("when the right-front corner is crushed 0.62 m off centre for 22 steps, then the leftover-crumple share (how much of the crumple zone is unused) drops below 1, or the struck corner has crushed over 90 % as far as the left-front one", () => {
    const s = spawn(0.62, 16);
    for (let i = 0; i < 22; i++) stepWall(s, DT, 0.16, mass(s.d, "bumperFR").world.x);
    const left = leftoverCrumple(s.d.crumpleTravelCorner());
    const fr = travel(s.d, "bumperFR");
    const fl = travel(s.d, "bumperFL");
    assert.ok(fr > fl * 0.9 || left < 1, `corner leftover ${left.toFixed(3)} FR=${fr.toFixed(3)} FL=${fl.toFixed(3)} [${mode}]`);
  });

  it("when the wall crushes it for 30 steps, then neither the passenger cell (the stiff middle of the car) nor the car as a whole is falling faster than 4.5 m/s, so it does not free-fall after the pulse", () => {
    const s = spawn(0, 16);
    for (let i = 0; i < 30; i++) stepWall(s, DT, 0.12);
    assert.ok(mass(s.d, "cell").vel.y > -4.5, `cell vy ${mass(s.d, "cell").vel.y.toFixed(2)} [${mode}]`);
    assert.ok(s.vel.y > -4.5, `car vy ${s.vel.y.toFixed(2)} [${mode}]`);
  });

  it("when the wall crushes it for 20 steps, then the roof does not sag more than 12 cm below its rest height", () => {
    const s = spawn(0, 16);
    const y0 = mass(s.d, "roof").rest.y;
    for (let i = 0; i < 20; i++) stepWall(s, DT, 0.14);
    const y = mass(s.d, "roof").local.y;
    assert.ok(y > y0 - 0.12, `roof sagged to ${y.toFixed(3)} from ${y0} [${mode}]`);
  });
});

const crushBySpeedCases = [
  { it: "when a 20 m/s car and a 5 m/s car take 6 steps of the same wall overlap, then the 20 m/s car's bumper crushes more than 4 cm further, so the crush grows with the speed of the hit", slowMps: 5, fastMps: 20, steps: 6, overlap: 0.1, minExtraCrush: 0.04 },
  { it: "when a 40 m/s car and a 14 m/s car take 3 steps of the same wall overlap, then the 40 m/s car's bumper crushes more than 2 cm further, so 40 m/s is a real crash, not a 14 m/s bump scaled up", slowMps: 14, fastMps: 40, steps: 3, overlap: 0.12, minExtraCrush: 0.02 },
] as const;

forModes("given a car driving into a rigid wall at a chosen speed", (spawn, mode) => {
  for (const testCase of crushBySpeedCases) {
    it(testCase.it, () => {
      const slow = spawn(0, testCase.slowMps);
      const fast = spawn(0, testCase.fastMps);
      for (let i = 0; i < testCase.steps; i++) {
        stepWall(slow, DT, testCase.overlap);
        stepWall(fast, DT, testCase.overlap);
      }
      const a = travel(slow.d, "bumperFL");
      const b = travel(fast.d, "bumperFL");
      assert.ok(b > a + testCase.minExtraCrush, `${testCase.fastMps} m/s crushed ${b.toFixed(3)} vs ${testCase.slowMps} m/s ${a.toFixed(3)} [${mode}]`);
    });
  }

  it("when a 5 m/s car takes 18 steps of wall overlap, then the passenger cell (the stiff middle of the car) moves less than 12 cm, so a 5 m/s bump does not fold the cabin", () => {
    const s = spawn(0, 5);
    for (let i = 0; i < 18; i++) stepWall(s, DT, 0.12);
    assert.ok(travel(s.d, "cell") < 0.12, `cabin budged ${travel(s.d, "cell").toFixed(3)} at 5 m/s [${mode}]`);
  });
});

forModes("given a car crashing into a rigid wall at 14 to 16 m/s", (spawn, mode) => {
  it("when one car is fed eight wall contacts in 1/240 s slow-motion steps and an identical car in 1/60 s steps, then the slow-motion bumper moves less than 8 m/s faster than the normal one and under 40 m/s, so slow motion does not rocket the bumper", () => {
    const slow = spawn(0, 16);
    const fast = spawn(0, 16);
    const n = new THREE.Vector3(0, 0, -1);
    for (let i = 0; i < 8; i++) {
      slow.d.notifyContact();
      slow.d.feedOverlap(new THREE.Vector3(0, 0.38, 2), n, 0.1, 16, 1 / 240);
      slow.d.stepStructure(1 / 240);
      slow.d.followGroup(slow.group, slow.vel, slow.omega, 1 / 240);
    }
    for (let i = 0; i < 8; i++) {
      fast.d.notifyContact();
      fast.d.feedOverlap(new THREE.Vector3(0, 0.38, 2), n, 0.1, 16, DT);
      fast.d.stepStructure(DT);
      fast.d.followGroup(fast.group, fast.vel, fast.omega, DT);
    }
    const vs = mass(slow.d, "bumperFL").vel.length();
    const vf = mass(fast.d, "bumperFL").vel.length();
    assert.ok(vs < vf + 8, `slomo rocket ${vs.toFixed(2)} vs 1/60 ${vf.toFixed(2)} [${mode}]`);
    assert.ok(vs < 40, `slomo bumper ${vs.toFixed(2)} m/s [${mode}]`);
  });

  it("when the crush plays out for 24 steps and the car then coasts 12 more steps with no wall contact, then its speed stays under 16 m/s, so it does not rebound above its 14 m/s impact speed", () => {
    const s = spawn(0, 14);
    for (let i = 0; i < 24; i++) stepWall(s, DT, 0.12);
    for (let i = 0; i < 12; i++) {
      s.d.stepStructure(DT);
      s.d.followGroup(s.group, s.vel, s.omega, DT);
    }
    assert.ok(s.vel.length() < 16, `rebound ${s.vel.length().toFixed(2)} m/s [${mode}]`);
  });
});

forModes("given a car crashing at 14 m/s whose front bumper hands a share of each stopping impulse on to the passenger cell (the stiff middle of the car), depending on how far it is crushed", (spawn, mode) => {
  it("when the bumper is not crushed, then the front passes on at most 0.12 of the impulse, and when it is crushed 5 % past its maximum travel it counts as packed and passes on all of it", () => {
    const s = spawn(0, 14);
    assert.ok(s.d.frontTransfer() <= 0.12, `rest transfer ${s.d.frontTransfer()}`);
    const fl = mass(s.d, "bumperFL");
    fl.local.z = fl.rest.z - fl.bands.max * 1.05;
    fl.world.copy(fl.local);
    assert.ok(s.d.nodePacked(fl), "travel past max should pack");
    assert.equal(s.d.nodeTransfer(fl), 1);
  });

  it("when the bumper is crushed to the middle of its travel and then to its maximum band, then it passes on exactly 0.5 of the impulse at the middle (not 0.1 or 0.62) and 0.62, or counts as packed, at the maximum", () => {
    const s = spawn(0, 14);
    const fl = mass(s.d, "bumperFL");
    fl.local.z = fl.rest.z - fl.bands.middle;
    fl.world.copy(fl.local);
    assert.equal(s.d.nodeTransfer(fl), 0.5);
    fl.local.z = fl.rest.z - fl.bands.max;
    fl.world.copy(fl.local);
    assert.ok(s.d.nodeTransfer(fl) === 0.62 || s.d.nodePacked(fl), `max band ${s.d.nodeTransfer(fl)}`);
  });

  it("when both front bumper corners are crushed 5 % past their maximum travel and a 4000 N·s impulse hits, then the packed car's cabin speed changes more than twice as much as an uncrushed car's, because a packed face dumps the stopping impulse onto the cabin", () => {
    const rest = spawn(0, 14);
    const packed = spawn(0, 14);
    const fl = mass(packed.d, "bumperFL");
    const fr = mass(packed.d, "bumperFR");
    fl.local.z = fl.rest.z - fl.bands.max * 1.05;
    fr.local.z = fr.rest.z - fr.bands.max * 1.05;
    fl.world.copy(fl.local);
    fr.world.copy(fr.local);
    const cell0 = mass(rest.d, "cell").vel.z;
    rest.d.applyImpulse(0, 0, -1, 4000);
    packed.d.applyImpulse(0, 0, -1, 4000);
    const dRest = Math.abs(mass(rest.d, "cell").vel.z - cell0);
    const dPack = Math.abs(mass(packed.d, "cell").vel.z - cell0);
    assert.ok(dPack > dRest * 2, `rest cabin ${dRest.toFixed(3)} packed ${dPack.toFixed(3)} [${mode}]`);
  });
});

describe("given the crash path's boot warm-up (a pre-run that compiles the crush path before the first real crash, see docs/PERF_HITCH.md)", () => {
  it("when two cars crash head-on at 48 km/h, the warm-up hits are run and the head-on is run again, then every warm-up hit crashes both cars and the second head-on is bit-identical to the first", () => {
    const before = runPair(48, 48, "head-on");
    assert.ok(warmCrashPath(), "a warm-up hit no longer crashes both cars, so it no longer compiles the crush path");
    assertSameDigest(runPair(48, 48, "head-on"), before, "48 km/h head-on after the warm-up");
  });
});

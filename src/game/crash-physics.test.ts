import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { StreamedDeformation, ENGINE_KILL_TRAVEL, type DeformMode } from "./streamed-deform.ts";
import { CRASH, leftoverCrumple } from "./physics-util.ts";

/** ~50 km/h NCAP-style rigid barrier. */
const FRONTAL_MPS = 14;
const DT = 1 / 60;
const MODES: DeformMode[] = ["lattice", "shape"];

function dummyGeom(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(1.7, 1.3, 4.3, 3, 2, 6);
}

function mass(d: StreamedDeformation, name: string) {
  const m = d.masses.find((n) => n.name === name);
  assert.ok(m, name);
  return m;
}

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
  d.squash = 0.4;
  d.buckle = 0.45;
  const group = new THREE.Group();
  group.position.set(0, 0, 0);
  group.rotation.set(0, 0, 0);
  group.updateMatrixWorld();
  const vel = new THREE.Vector3(0, 0, speed);
  const omega = new THREE.Vector3();
  d.beginCrush(impact ?? new THREE.Vector3(impactX, 0.36, 2.06), inward, Math.abs(speed), group, vel, omega);
  return { d, group, vel, omega, geom };
}

function forModes(title: string, fn: (spawnFn: typeof spawn, mode: DeformMode) => void): void {
  for (const mode of MODES) {
    describe(`${title} [${mode}]`, () => {
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
  s.d.update(dt, s.geom);
}

function travel(d: StreamedDeformation, name: string): number {
  return mass(d, name).local.distanceTo(mass(d, name).rest);
}

function alongZ(d: StreamedDeformation, name: string): number {
  const m = mass(d, name);
  return m.local.z - m.rest.z;
}

describe("crash constants", () => {
  it("matches researched sedan barrier pulse / friction", () => {
    assert.ok(CRASH.pulseSec >= 0.09 && CRASH.pulseSec <= 0.16);
    assert.ok(CRASH.crushMeters >= 0.4 && CRASH.crushMeters <= 0.85);
    assert.ok(CRASH.muSlide > CRASH.muScuff);
    assert.ok(CRASH.muPeak >= CRASH.muSlide);
  });
});

forModes("impact snap does not invert corners", (spawn) => {
  it("good: centered hit stays on the centerline so both corners share crush", () => {
    const { d } = spawn(0);
    assert.ok(Math.abs(d.impactLocal.x) < 0.22, `center snap drifted to x=${d.impactLocal.x}`);
  });

  it("good: right-front hit stays on the right", () => {
    const { d } = spawn(0.62);
    assert.ok(d.impactLocal.x > 0.28, `right hit flipped to x=${d.impactLocal.x}`);
  });

  it("good: left-front hit stays on the left", () => {
    const { d } = spawn(-0.62);
    assert.ok(d.impactLocal.x < -0.28, `left hit flipped to x=${d.impactLocal.x}`);
  });

  it("bad: snapping to the first bumper of two equal distances (bumperFL) is a left bias", () => {
    const { d } = spawn(0);
    assert.ok(d.impactLocal.x > -0.15, `head-on became a left-corner at x=${d.impactLocal.x}`);
  });

  it("edge: x just inside the center band stays centered", () => {
    const { d } = spawn(0.199);
    assert.ok(Math.abs(d.impactLocal.x) < 0.22, `0.199 snapped off-center to ${d.impactLocal.x}`);
  });

  it("close-but-wrong: threshold is < 0.2, so x=0.2 is already a right hit (not <= 0.2)", () => {
    const { d } = spawn(0.2);
    assert.ok(d.impactLocal.x > 0.25, `x=0.2 kept as center (${d.impactLocal.x}); used <= instead of <`);
  });
});

forModes("first contact must not light-speed off the map", (spawn, mode) => {
  it("bad: a wall nibble does not teleport masses or the group", () => {
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

  it("bad: a hard offset hit also stays in-bounds", () => {
    const s = spawn(0.7, 22);
    for (let i = 0; i < 12; i++) stepWall(s, DT, 0.3, mass(s.d, "bumperFR").world.x);
    const cell = mass(s.d, "cell");
    assert.ok(cell.world.length() < 10, `cell ${cell.world.toArray()} [${mode}]`);
    assert.ok(cell.vel.length() < CRASH.maxMassMps + 0.1);
  });
});

forModes("frontal rigid barrier ~50 km/h", (spawn, mode) => {
  it("good: nose crushes inward over the pulse, not all at once", () => {
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
      assert.ok(samples[11]! > samples[2]!, "crush should grow across the pulse, not pop");
      assert.ok(samples[11]! > 0.12, `nose crush too small: ${samples[11]}`);
      assert.ok(samples[11]! < 1.4, `nose vanished: ${samples[11]}`);
    }
  });

  it("good: rear bumper does not extrude", () => {
    const s = spawn(0);
    for (let i = 0; i < 24; i++) stepWall(s, DT, 0.1);
    const rear = (alongZ(s.d, "bumperRL") + alongZ(s.d, "bumperRR")) * 0.5;
    assert.ok(rear > -0.16, `rear extruded backward by ${-rear}m`);
    assert.ok(rear < 0.2, `rear sucked forward by ${rear}m`);
  });

  it("good: rear inertia piles in for ~100ms after the nose stops", () => {
    const s = spawn(0, FRONTAL_MPS);
    for (let i = 0; i < 3; i++) stepWall(s, DT, 0.12);
    const rear = mass(s.d, "axleR").vel.z;
    const nose = (mass(s.d, "bumperFL").vel.z + mass(s.d, "bumperFR").vel.z) * 0.5;
    assert.ok(rear > nose + 1.5, `rear ${rear.toFixed(2)} should still be piling into nose ${nose.toFixed(2)}`);
    assert.ok(rear > FRONTAL_MPS * 0.35, `rear lost all speed too fast: ${rear}`);
  });

  it("good: chassis springs — bumper > rail > cell", () => {
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

  it("good: stays on the road — wall hit bananas, it does not loft", () => {
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

  it("bad: leftover crumple at rest is a full zone, not 0 (travel is remaining length)", () => {
    const { d } = spawn(0);
    const travelLeft = d.crumpleTravel();
    assert.ok(travelLeft > 1.2, `rest crumpleTravel ${travelLeft} looks like already-crushed`);
    assert.equal(leftoverCrumple(travelLeft), 1);
  });

  it("edge: graze-scale closing still deforms a little but does not vanish the nose", () => {
    const s = spawn(0, CRASH.grazeMps);
    for (let i = 0; i < 10; i++) stepWall(s, DT, 0.02);
    const crush = -alongZ(s.d, "bumperFL");
    if (mode === "shape") {
      assert.ok(s.group.position.y < 0.22, `graze lofted to ${s.group.position.y}`);
    } else {
      assert.ok(crush < 0.35, `graze crushed ${crush}m — treated as a crash`);
    }
  });

  it("close-but-wrong: higher squash crushes more in the same pulse (slider is not inverted)", () => {
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

forModes("offset / corner barrier", (spawn, mode) => {
  it("good: hit corner crushes more than the opposite front corner", () => {
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

  it("good: bananas in plan view — hit-side nose tucks, opposite stays wider", () => {
    const s = spawn(0.62);
    for (let i = 0; i < 22; i++) stepWall(s, DT, 0.12, mass(s.d, "bumperFR").world.x);
    const r = mass(s.d, "bumperFR").local.x;
    const l = mass(s.d, "bumperFL").local.x;
    assert.ok(r > l + 0.7, `no banana: FL.x=${l.toFixed(3)} FR.x=${r.toFixed(3)}`);
  });

  it("bad: a left hit must not crush the right corner more (inverted cornerWeight)", () => {
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

  it("close-but-wrong: opposite front bumper still moves some (0.06 leak), but not ≥ 40% of the hit corner", () => {
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

forModes("Newton 3 / impulses", (spawn) => {
  it("good: equal-and-opposite ΔP on a head-on closing", () => {
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

  it("good: stopping impulse lands on the crumple face, cabin keeps coming", () => {
    const s = spawn(0, 14);
    const bumper0 = mass(s.d, "bumperFL").vel.z;
    const cell0 = mass(s.d, "cell").vel.z;
    s.d.applyImpulse(0, 0, -1, 800);
    const dBumper = mass(s.d, "bumperFL").vel.z - bumper0;
    const dCell = mass(s.d, "cell").vel.z - cell0;
    assert.ok(dBumper < dCell - 0.4, `cabin took the hit (bumper Δv ${dBumper.toFixed(3)}, cell ${dCell.toFixed(3)})`);
  });

  it("bad: j=0 and inactive lattice are no-ops (a sticky impulse would keep pushing)", () => {
    const s = spawn(0, 10);
    const z0 = mass(s.d, "bumperFL").vel.z;
    s.d.applyImpulse(0, 0, -1, 0);
    assert.equal(mass(s.d, "bumperFL").vel.z, z0);
    s.d.reset();
    mass(s.d, "bumperFL").vel.z = 10;
    s.d.applyImpulse(0, 0, -1, 900);
    assert.equal(mass(s.d, "bumperFL").vel.z, 10, "impulse applied while massActive=false");
  });

  it("edge: wall normal is planar — applyImpulse ny does not have to be used, and default wall n has ny=0", () => {
    const s = spawn(0, 14);
    const y0 = s.d.masses.reduce((sum, m) => sum + m.vel.y * m.mass, 0);
    s.d.applyImpulse(0, 0, -1, 700);
    const y1 = s.d.masses.reduce((sum, m) => sum + m.vel.y * m.mass, 0);
    assert.ok(Math.abs(y1 - y0) < 1e-6, `planar impulse leaked ΔPy=${y1 - y0}`);
  });

  it("close-but-wrong: total ΔP equals j along the axis (weights must be normalized, not raw crumpleWeight)", () => {
    const s = spawn(0, 14);
    const p0 = momentumZ(s.d);
    const j = 500;
    s.d.applyImpulse(0, 0, -1, j);
    const dp = momentumZ(s.d) - p0;
    assert.ok(Math.abs(dp + j) < 1e-3, `ΔP ${dp} vs -j ${-j} — weights not unit-sum`);
  });
});

forModes("drivetrain", (spawn) => {
  it("good: dies once the engine block has taken a real hit", () => {
    const s = spawn(0);
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

  it("good: cutDrive only bleeds hubs, cabin keeps XZ inertia", () => {
    const s = spawn(0, 14);
    s.d.drivetrainAlive = false;
    const cell0 = mass(s.d, "cell").vel.z;
    const hub0 = mass(s.d, "hubFL").vel.z;
    s.d.cutDrive(0.05);
    assert.equal(mass(s.d, "cell").vel.z, cell0);
    assert.ok(mass(s.d, "hubFL").vel.z < hub0, "hubs should lose driven traction");
  });

  it("bad: cutDrive is a no-op while the drivetrain is still alive", () => {
    const s = spawn(0, 14);
    assert.equal(s.d.drivetrainAlive, true);
    const hub0 = mass(s.d, "hubFL").vel.z;
    s.d.cutDrive(0.05);
    assert.equal(mass(s.d, "hubFL").vel.z, hub0);
  });

  it("close-but-wrong: just under ENGINE_KILL_TRAVEL is alive; just over is toast", () => {
    const s = spawn(0);
    const eng = mass(s.d, "engineL");
    eng.local.copy(eng.rest);
    eng.local.z -= ENGINE_KILL_TRAVEL - 0.01;
    s.d.updateDrivetrain();
    assert.equal(s.d.drivetrainAlive, true, `${(ENGINE_KILL_TRAVEL - 0.01).toFixed(3)} m is not yet wrecked`);
    eng.local.z = eng.rest.z - (ENGINE_KILL_TRAVEL + 0.01);
    s.d.updateDrivetrain();
    assert.equal(s.d.drivetrainAlive, false);
  });
});

describe("beams stay a live spring lattice [lattice]", () => {
  it("good: every mass is connected to the cell", () => {
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

  it("good: compressed beams still push back (not a one-way collapse)", () => {
    const s = spawn(0, FRONTAL_MPS, new THREE.Vector3(0, 0, -1), undefined, "lattice");
    const a = mass(s.d, "engineL");
    const b = mass(s.d, "railL");
    const rest = a.world.distanceTo(b.world);
    a.world.z -= 0.12;
    const vz0 = a.vel.z;
    s.d.stepStructure(DT);
    assert.ok(a.vel.z > vz0, `no restoring spring (vz ${a.vel.z} vs ${vz0}), rest was ${rest}`);
  });

  it("close-but-wrong: restoring force fires even while separating (relV >= 0), not only when approaching", () => {
    const s = spawn(0, FRONTAL_MPS, new THREE.Vector3(0, 0, -1), undefined, "lattice");
    const a = mass(s.d, "engineL");
    const b = mass(s.d, "railL");
    a.world.z -= 0.12;
    a.vel.z = 2;
    const vz0 = a.vel.z;
    s.d.stepStructure(DT);
    assert.ok(a.vel.z > vz0 * 0.5, "separating compressed beam went slack");
    assert.ok(a.vel.z !== vz0, "no force at all while separating");
  });
});

forModes("far-side / restoring still hold under both deformers", (spawn, mode) => {
  it("bad: a frontal crush must not crumple the rear bumper", () => {
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

  it("good: a compressed nose still restores toward rest (not a one-way collapse)", () => {
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

forModes("kickNearestHub is a one-node hop, not a car rocket", (spawn) => {
  it("good: only the nearest hub gets +Y", () => {
    const s = spawn(0);
    const p = mass(s.d, "hubFL").world.clone();
    const name = s.d.kickNearestHub(p, 26);
    assert.equal(name, "hubFL");
    assert.ok(mass(s.d, "hubFL").vel.y > 0.8);
    assert.ok(Math.abs(mass(s.d, "hubFR").vel.y) < 1e-6);
    assert.ok(Math.abs(mass(s.d, "cell").vel.y) < 1e-6);
  });

  it("bad: a point on the engine still picks a hub, never the engine block", () => {
    const s = spawn(0);
    const name = s.d.kickNearestHub(mass(s.d, "engineL").world.clone(), 26);
    assert.ok(name && name.startsWith("hub"), `kicked ${name}`);
  });

  it("edge: jUp=0 returns null and changes nothing", () => {
    const s = spawn(0);
    const y0 = mass(s.d, "hubFL").vel.y;
    assert.equal(s.d.kickNearestHub(mass(s.d, "hubFL").world.clone(), 0), null);
    assert.equal(mass(s.d, "hubFL").vel.y, y0);
  });

  it("close-but-wrong: kickNearestHub must not fall through to kickNearest on a valid hub (would hit engine if closer in 3D)", () => {
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

forModes("lamps / sensors are per-corner, not per-end", (spawn) => {
  it("good: a right-front crush lights wingFR, not wingFL", () => {
    const s = spawn(0.62);
    for (let i = 0; i < 18; i++) stepWall(s, DT, 0.12, mass(s.d, "bumperFR").world.x);
    assert.ok(s.d.sensorCompression(5) > s.d.sensorCompression(4) * 2, "wingFR sensor should dominate wingFL");
  });

  it("bad: sharing bumperFront partCompression would kill both headlights on any bumper nick", () => {
    const s = spawn(0.62);
    for (let i = 0; i < 18; i++) stepWall(s, DT, 0.12, mass(s.d, "bumperFR").world.x);
    const shared = s.d.partCompression("bumperFront");
    const leftBumper = s.d.sensorCompression(1);
    const rightBumper = s.d.sensorCompression(2);
    assert.ok(shared > 0.05, "front bumper did crush");
    assert.ok(rightBumper > leftBumper * 1.5, `left bumper sensor ${leftBumper} rode the shared part (${shared})`);
  });

  it("close-but-wrong: left head uses sensors [1,4], not the center bumper sensor 0", () => {
    const s = spawn(0.62);
    for (let i = 0; i < 16; i++) stepWall(s, DT, 0.14, mass(s.d, "bumperFR").world.x);
    // Right-hit: sensor 0 (center) may be mid, sensor 1 (left) must stay a graze.
    assert.ok(s.d.sensorCompression(1) < 0.25 || s.d.sensorCompression(1) < s.d.sensorCompression(2) * 0.5);
  });
});

forModes("rear / side impacts go the other way", (spawn) => {
  it("good: a rear inward (+Z) crushes the tail, not the nose", () => {
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

  it("good: a right-side inward crushes doorR/wingFR more than the left", () => {
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
      s.d.update(DT, s.geom);
    }
    const L = travel(s.d, "doorL") + travel(s.d, "wingFL");
    const R = travel(s.d, "doorR") + travel(s.d, "wingFR");
    if (s.d.mode === "shape") {
      assert.ok(R > 0.06, `right side never moved R=${R.toFixed(3)}`);
    } else {
      assert.ok(R > L * 1.05, `side hit not local L=${L.toFixed(3)} R=${R.toFixed(3)}`);
    }
  });

  it("close-but-wrong: frontal inward keeps door crumpleWeight capped, so doors are not a second bumper", () => {
    const s = spawn(0, 14);
    const door0 = mass(s.d, "doorL").vel.z;
    const bump0 = mass(s.d, "bumperFL").vel.z;
    s.d.applyImpulse(0, 0, -1, 600);
    const dDoor = Math.abs(mass(s.d, "doorL").vel.z - door0);
    const dBump = Math.abs(mass(s.d, "bumperFL").vel.z - bump0);
    assert.ok(dBump > dDoor * 2, `doors ate the frontal impulse (door ${dDoor.toFixed(3)} bumper ${dBump.toFixed(3)})`);
  });
});

forModes("time / quiet / reset / arm", (spawn, mode) => {
  it("good: quietTime only grows after the last notifyContact", () => {
    const s = spawn(0);
    assert.equal(s.d.quietTime(), 0);
    s.d.stepStructure(0.4);
    assert.ok(Math.abs(s.d.quietTime() - 0.4) < 1e-6);
    s.d.notifyContact();
    assert.equal(s.d.quietTime(), 0);
  });

  it("good: reset restores rest pose, drivetrain, and sensors", () => {
    const s = spawn(0);
    for (let i = 0; i < 12; i++) stepWall(s, DT, 0.12);
    s.d.reset();
    assert.equal(s.d.drivetrainAlive, true);
    assert.equal(s.d.massActive, false);
    assert.equal(travel(s.d, "bumperFL"), 0);
    assert.equal(s.d.sensorCompression(0), 0);
    assert.equal(s.d.crushElapsed, 0);
  });

  it("bad: armMasses (speed-bump) must not start a crush cinematic or kill the drivetrain", () => {
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

  it("close-but-wrong: beginCrush clamps impulse into [4,70] — 2 becomes 4, 400 becomes 70", () => {
    const geom = dummyGeom();
    const d = new StreamedDeformation(geom);
    d.mode = mode;
    const group = new THREE.Group();
    d.beginCrush(new THREE.Vector3(0, 0.36, 2.06), new THREE.Vector3(0, 0, -1), 2, group, new THREE.Vector3(), new THREE.Vector3());
    assert.equal(d.impulseValue, 4);
    d.beginCrush(new THREE.Vector3(0, 0.36, 2.06), new THREE.Vector3(0, 0, -1), 400, group, new THREE.Vector3(), new THREE.Vector3());
    assert.equal(d.impulseValue, 70);
  });
});

forModes("feedOverlap is a force-diff, not a teleport", (spawn, mode) => {
  it("good: returns leftover closing, never a bigger number than it ate", () => {
    const s = spawn(0, 14);
    const remain = s.d.feedOverlap(mass(s.d, "bumperFL").world, new THREE.Vector3(0, 0, -1), 0.08, 14, DT);
    assert.ok(remain >= 0 && remain <= 14);
    assert.ok(remain < 14, "should absorb some closing");
  });

  it("bad: inactive lattice returns closing unchanged", () => {
    const geom = dummyGeom();
    const d = new StreamedDeformation(geom);
    d.mode = mode;
    const r = d.feedOverlap(new THREE.Vector3(), new THREE.Vector3(0, 0, -1), 1, 20, DT);
    assert.equal(r, 20);
  });

  it("edge: tiny overlap does not pop the bumper a full cage width", () => {
    const s = spawn(0, 14);
    const z0 = mass(s.d, "bumperFL").world.z;
    s.d.feedOverlap(mass(s.d, "bumperFL").world.clone(), new THREE.Vector3(0, 0, -1), 0.01, 14, DT);
    const dz = Math.abs(mass(s.d, "bumperFL").world.z - z0);
    assert.ok(dz < 0.05, `nibble was a teleport (${dz}m)`);
  });

  it("close-but-wrong: two half-dt feeds must not crush ~2× one full-dt feed (dt-scaled, not per-call)", () => {
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

forModes("floor / hubs", (spawn, mode) => {
  it("good: a hub driven into the pavement stops, it does not bounce-launch", () => {
    const s = spawn(0);
    const h = mass(s.d, "hubFL");
    h.world.y = 0.1;
    h.vel.y = -4;
    s.d.stepStructure(DT);
    assert.ok(h.world.y >= 0.27);
    assert.ok(h.vel.y >= (mode === "shape" ? -0.15 : -0.05), `restitution bounce vel.y=${h.vel.y}`);
  });

  it("close-but-wrong: totalMass is the lumped sum, not 1, and is stable across a crush", () => {
    const s = spawn(0);
    const m0 = s.d.totalMass;
    assert.ok(m0 > 600 && m0 < 1200, `sedan mass ${m0}`);
    for (let i = 0; i < 10; i++) stepWall(s, DT, 0.1);
    assert.equal(s.d.totalMass, m0);
  });
});

forModes("hubs stay planted until they pop", (spawn, mode) => {
  it("good: a frontal crush does not drag the wheels through the arch", () => {
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

  it("bad: a 0.2m xz shove on one hub pops it, the other three stay", () => {
    const s = spawn(0);
    const h = mass(s.d, "hubFR");
    h.local.z = h.rest.z + 0.22;
    h.world.copy(h.local);
    s.group.updateMatrixWorld();
    s.d.followGroup(s.group, s.vel, s.omega, DT);
    assert.equal(h.popped, true, "hubFR should have popped");
    assert.equal(mass(s.d, "hubFL").popped, false);
    assert.equal(mass(s.d, "hubRL").popped, false);
  });

  it("close-but-wrong: deepCrush (press past the wells) is allowed to fold hubs without popping first", () => {
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
});

forModes("one corner can crush without the other", (spawn, mode) => {
  it("good: a right-front wall hit shortens bumperFR more than bumperFL", () => {
    const s = spawn(0.62, 16);
    for (let i = 0; i < 24; i++) stepWall(s, DT, 0.16, mass(s.d, "bumperFR").world.x);
    const fl = travel(s.d, "bumperFL");
    const fr = travel(s.d, "bumperFR");
    assert.ok(fr > fl * (mode === "shape" ? 1.15 : 1.25), `corners tied FL=${fl.toFixed(3)} FR=${fr.toFixed(3)} [${mode}]`);
    assert.ok(fr > 0.08, `right corner never crushed ${fr.toFixed(3)}`);
  });

  it("close-but-wrong: leftover overlap on a car-car-sized bite actually shortens the nose", () => {
    const s = spawn(0, 20);
    const z0 = (mass(s.d, "bumperFL").local.z + mass(s.d, "bumperFR").local.z) * 0.5;
    for (let i = 0; i < 18; i++) stepWall(s, DT, 0.18);
    const z1 = (mass(s.d, "bumperFL").local.z + mass(s.d, "bumperFR").local.z) * 0.5;
    assert.ok(z0 - z1 > 0.12, `skin/lattice did not eat overlap Δz=${(z0 - z1).toFixed(3)} [${mode}]`);
  });
});

forModes("squash slider + leftover + no sink", (spawn, mode) => {
  it("good: squash=0 barely folds the nose", () => {
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

  it("close-but-wrong: squash=1 crushes more than squash=0 on the same pulse", () => {
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

  it("good: crushing one front corner spends leftover crumple", () => {
    const s = spawn(0.62, 16);
    for (let i = 0; i < 22; i++) stepWall(s, DT, 0.16, mass(s.d, "bumperFR").world.x);
    const left = leftoverCrumple(s.d.crumpleTravelCorner());
    const fr = travel(s.d, "bumperFR");
    const fl = travel(s.d, "bumperFL");
    assert.ok(fr > fl * 0.9 || left < 1, `corner leftover ${left.toFixed(3)} FR=${fr.toFixed(3)} FL=${fl.toFixed(3)} [${mode}]`);
  });

  it("bad: cell vy must not free-fall after a frontal pulse", () => {
    const s = spawn(0, 16);
    for (let i = 0; i < 30; i++) stepWall(s, DT, 0.12);
    assert.ok(mass(s.d, "cell").vel.y > -4.5, `cell vy ${mass(s.d, "cell").vel.y.toFixed(2)} [${mode}]`);
    assert.ok(s.vel.y > -4.5, `car vy ${s.vel.y.toFixed(2)} [${mode}]`);
  });

  it("good: a front hit does not drop the roof particle", () => {
    const s = spawn(0, 16);
    const y0 = mass(s.d, "roof").rest.y;
    for (let i = 0; i < 20; i++) stepWall(s, DT, 0.14);
    const y = mass(s.d, "roof").local.y;
    assert.ok(y > y0 - 0.12, `roof sagged to ${y.toFixed(3)} from ${y0} [${mode}]`);
  });

  it("good: a 20 m/s pulse crushes the bumper more than a 5 m/s tap", () => {
    const tap = spawn(0, 5);
    const hit = spawn(0, 20);
    for (let i = 0; i < 6; i++) {
      stepWall(tap, DT, 0.1);
      stepWall(hit, DT, 0.1);
    }
    const a = travel(tap.d, "bumperFL");
    const b = travel(hit.d, "bumperFL");
    assert.ok(b > a + 0.04, `KE ignored tap=${a.toFixed(3)} crash=${b.toFixed(3)} [${mode}]`);
  });

  it("good: 40 m/s is a real crash, not a 14 m/s parking bump scaled up a bit", () => {
    const ncap = spawn(0, 14);
    const hard = spawn(0, 40);
    for (let i = 0; i < 3; i++) {
      stepWall(ncap, DT, 0.12);
      stepWall(hard, DT, 0.12);
    }
    const a = travel(ncap.d, "bumperFL");
    const b = travel(hard.d, "bumperFL");
    assert.ok(b > a + 0.02, `40 m/s ${b.toFixed(3)} vs 14 m/s ${a.toFixed(3)} [${mode}]`);
  });

  it("good: 5 m/s does not fold the UHSS cabin", () => {
    const s = spawn(0, 5);
    for (let i = 0; i < 18; i++) stepWall(s, DT, 0.12);
    assert.ok(travel(s.d, "cell") < 0.12, `cabin budged ${travel(s.d, "cell").toFixed(3)} at 5 m/s [${mode}]`);
  });

  it("bad: slomo dt must not raise closing speed after a wall nibble", () => {
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

  it("close-but-wrong: after the pulse, speed must not rebound above the impact speed", () => {
    const s = spawn(0, 14);
    for (let i = 0; i < 24; i++) stepWall(s, DT, 0.12);
    for (let i = 0; i < 12; i++) {
      s.d.stepStructure(DT);
      s.d.followGroup(s.group, s.vel, s.omega, DT);
    }
    assert.ok(s.vel.length() < 16, `rebound ${s.vel.length().toFixed(2)} m/s [${mode}]`);
  });

  it("good: rest bumper transfers ~0.1; packed dumps 100%", () => {
    const s = spawn(0, 14);
    assert.ok(s.d.frontTransfer() <= 0.12, `rest transfer ${s.d.frontTransfer()}`);
    const fl = mass(s.d, "bumperFL");
    fl.local.z = fl.rest.z - fl.bands.max * 1.05;
    fl.world.copy(fl.local);
    assert.ok(s.d.nodePacked(fl), "travel past max should pack");
    assert.equal(s.d.nodeTransfer(fl), 1);
  });

  it("close-but-wrong: middle crush steps to 0.5, not 0.1 and not 0.62", () => {
    const s = spawn(0, 14);
    const fl = mass(s.d, "bumperFL");
    fl.local.z = fl.rest.z - fl.bands.middle;
    fl.world.copy(fl.local);
    assert.equal(s.d.nodeTransfer(fl), 0.5);
    fl.local.z = fl.rest.z - fl.bands.max;
    fl.world.copy(fl.local);
    assert.ok(s.d.nodeTransfer(fl) === 0.62 || s.d.nodePacked(fl), `max band ${s.d.nodeTransfer(fl)}`);
  });

  it("good: packed face dumps the stopping impulse onto the cabin, rest face does not", () => {
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

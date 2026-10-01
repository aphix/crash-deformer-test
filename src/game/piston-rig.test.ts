import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeCar } from "./crash-scenarios.test-util.ts";
import {
  firePiston,
  pistonLocality,
  PISTON,
  PISTON_FAR,
  PISTON_IDS,
  PISTON_STRUCK,
  PistonRig,
  type PistonId,
  type PistonShot,
  type PistonShotResult,
} from "./piston-rig.ts";
import type { DeformMode } from "./streamed-deform.ts";

/**
 * Piston rig: eight impactors around a parked car (docs/PISTON_RIG.md).
 *
 * Standard shot: 1500 kg at 40 km/h, rigid face, car free to be shoved (no
 * hold). The rig car is 858 kg, so the car takes ½·μ·v² = 33.7 kJ: an
 * equivalent barrier speed (EBS) of 31.9 km/h. Damage is read in the car frame
 * with the rigid motion fitted out on the particles beyond 1.2 m, 1.5 s after
 * contact. Locality is the extra travel over a 3 km/h tap of the same piston
 * (0.2 kJ), because arming the crash already moves the skin.
 *
 * Real-world anchors (docs/RIG_ANALYSIS.md §3.3, sources [09][10]): frontal
 * crush at 56 km/h is 350–550 mm dynamic, 250–450 mm static; crush scales
 * with speed (linear spring), so at 32 km/h EBS 0.14–0.26 m static, ≤ 0.31 m
 * dynamic. IIHS side test (1500 kg MDB, 50 km/h): about 0.15–0.25 m of
 * B-pillar / door intrusion. Footwell / A-pillar Good < 5 cm.
 *
 * `todo` entries are hand-offs to the crash-realism lane: the expectation
 * stays; the measured value is what the current rig does.
 */

const STANDARD: PistonShot = { speedKph: 40, massKg: 1500, hardness: 1, holdCar: false };
const TAP: PistonShot = { ...STANDARD, speedKph: 3 };
const LOCAL_TOL = 0.03;
const CABIN_TOL = 0.05;

const cache = new Map<string, PistonShotResult>();
function shoot(id: PistonId, shot: PistonShot = STANDARD, mode: DeformMode = "shape"): PistonShotResult {
  const key = `${mode}|${id}|${JSON.stringify(shot)}`;
  let r = cache.get(key);
  if (!r) {
    r = firePiston(makeCar(mode), id, shot);
    cache.set(key, r);
  }
  return r;
}

/** Deepest inward travel among the particles this piston is aimed at (m). */
function crushOf(r: PistonShotResult): number {
  return Math.max(...r.struck.map((s) => s.inward));
}

const f3 = (n: number) => n.toFixed(3);
const isSide = (id: PistonId) => id === "left" || id === "right";
const isCorner = (id: PistonId) => id.length > 5;

/** Expectations the current rig misses: measured vs expected, and why. Keyed `${piston}:${metric}`. */
const TODO: Partial<Record<string, string>> = {
  "frontLeft:far-particles": "0.066 m (doorL) vs ≤ 0.03 m: the shove's inertia leaves a permanent set across the whole car",
  "front:far-particles": "0.066 m (axleR) vs ≤ 0.03 m: the tail takes a set from the 7 m/s shove",
  "frontRight:far-particles": "0.066 m (doorR) vs ≤ 0.03 m: the shove's inertia leaves a permanent set across the whole car",
  "right:far-particles": "0.147 m (bumperFR) vs ≤ 0.03 m: a door hit bends the same-side nose",
  "rearRight:far-particles": "0.137 m (bumperFL) vs ≤ 0.03 m: a rear-corner hit bends the far front corner",
  "rear:far-particles": "0.134 m (tank) vs ≤ 0.03 m: the tank / axle pair moves with the rear crush",
  "rearLeft:far-particles": "0.137 m (bumperFR) vs ≤ 0.03 m: a rear-corner hit bends the far front corner",
  "left:far-particles": "0.147 m (bumperFL) vs ≤ 0.03 m: a door hit bends the same-side nose",
  "frontLeft:far-skin": "0.066 m vs ≤ 0.03 m: follows the far particles",
  "front:far-skin": "0.087 m vs ≤ 0.03 m: follows the far particles",
  "frontRight:far-skin": "0.066 m vs ≤ 0.03 m: follows the far particles",
  "right:far-skin": "0.120 m vs ≤ 0.03 m: the bent nose carries its panels",
  "rearRight:far-skin": "0.236 m vs ≤ 0.03 m: follows the far particles",
  "rear:far-skin": "0.160 m vs ≤ 0.03 m: follows the far particles",
  "rearLeft:far-skin": "0.236 m vs ≤ 0.03 m: follows the far particles",
  "left:far-skin": "0.120 m vs ≤ 0.03 m: the bent nose carries its panels",
  "frontLeft:opposite-half": "0.064 m particle / 0.052 m skin vs ≤ 0.03 m",
  "front:opposite-half": "0.066 m particle / 0.080 m skin vs ≤ 0.03 m",
  "frontRight:opposite-half": "0.064 m particle / 0.052 m skin vs ≤ 0.03 m",
  "right:opposite-half": "0.062 m particle / 0.120 m skin vs ≤ 0.03 m",
  "rearRight:opposite-half": "0.137 m particle / 0.093 m skin vs ≤ 0.03 m",
  "rear:opposite-half": "0.105 m particle / 0.070 m skin vs ≤ 0.03 m",
  "rearLeft:opposite-half": "0.137 m particle / 0.093 m skin vs ≤ 0.03 m",
  "left:opposite-half": "0.062 m particle / 0.120 m skin vs ≤ 0.03 m",
  "right:cabin": "doorL 0.079 m vs ≤ 0.05 m: the far door closes on the cell as the cabin is shoved sideways",
  "left:cabin": "doorR 0.079 m vs ≤ 0.05 m: the far door closes on the cell as the cabin is shoved sideways",
  "rearRight:cabin": "doorL 0.0504 m vs ≤ 0.05 m: the rear-corner hit racks the cabin",
  "rearLeft:cabin": "doorR 0.0504 m vs ≤ 0.05 m: the rear-corner hit racks the cabin",
  "right:tap-particles": "doorL 0.034 m vs ≤ 0.03 m: arming the masses sags them",
  "left:tap-particles": "doorR 0.034 m vs ≤ 0.03 m: arming the masses sags them",
  "rearRight:tap-particles": "bumperRL 0.089 m vs ≤ 0.03 m: a 0.2 kJ rear-corner tap moves the other rear corner",
  "rearLeft:tap-particles": "bumperRR 0.089 m vs ≤ 0.03 m: a 0.2 kJ rear-corner tap moves the other rear corner",
  "frontLeft:tap-skin": "0.365 m (panels 0.093 m) vs ≤ 0.03 m: the wheel-arch skin folds ~0.34 m onto the hub once the crash skin runs, with no contact at all (also at 59ca5ba)",
  "front:tap-skin": "0.366 m (panels 0.064 m) vs ≤ 0.03 m: wheel-arch skin folds onto the hub once the crash skin runs",
  "frontRight:tap-skin": "0.365 m (panels 0.093 m) vs ≤ 0.03 m: wheel-arch skin folds onto the hub once the crash skin runs",
  "right:tap-skin": "0.352 m (panels 0.095 m) vs ≤ 0.03 m: wheel-arch skin folds onto the hub once the crash skin runs",
  "rearRight:tap-skin": "0.354 m (panels 0.150 m) vs ≤ 0.03 m: wheel-arch skin folds onto the hub once the crash skin runs",
  "rear:tap-skin": "0.355 m (panels 0.085 m) vs ≤ 0.03 m: wheel-arch skin folds onto the hub once the crash skin runs",
  "rearLeft:tap-skin": "0.354 m (panels 0.150 m) vs ≤ 0.03 m: wheel-arch skin folds onto the hub once the crash skin runs",
  "left:tap-skin": "0.352 m (panels 0.095 m) vs ≤ 0.03 m: wheel-arch skin folds onto the hub once the crash skin runs",
  "front:kill-ebs": "kills at 56 km/h = EBS 44.7 km/h vs (56, 64] km/h: the piston path kills the block at a lower EBS than the barrier path",
  "frontLeft:corner-kill": "kills at 52 km/h vs ≥ 56 km/h (front-middle): a 45° corner counts as frontal in updateDrivetrain and packs the block sooner",
  "frontRight:corner-kill": "kills at 52 km/h vs ≥ 56 km/h (front-middle): a 45° corner counts as frontal in updateDrivetrain and packs the block sooner",
  "frontLeft:lattice-tap-skin": "1.645 m vs ≤ 0.03 m: a rear-bumper vertex jumps 1.6 m in lattice skinning once crashed (also at 59ca5ba)",
  "front:lattice-tap-skin": "1.641 m vs ≤ 0.03 m: a rear-bumper vertex jumps 1.6 m in lattice skinning once crashed",
  "frontRight:lattice-tap-skin": "1.645 m vs ≤ 0.03 m: a rear-bumper vertex jumps 1.6 m in lattice skinning once crashed",
  "right:lattice-tap-skin": "1.654 m vs ≤ 0.03 m: a rear-bumper vertex jumps 1.6 m in lattice skinning once crashed",
  "rearRight:lattice-tap-skin": "1.644 m vs ≤ 0.03 m: a rear-bumper vertex jumps 1.6 m in lattice skinning once crashed",
  "rear:lattice-tap-skin": "0.348 m (panels 0.236 m) vs ≤ 0.03 m: wheel-arch fold, and the rear vertex jump is pinned by the rear face",
  "rearLeft:lattice-tap-skin": "1.644 m vs ≤ 0.03 m: a rear-bumper vertex jumps 1.6 m in lattice skinning once crashed",
  "left:lattice-tap-skin": "1.654 m vs ≤ 0.03 m: a rear-bumper vertex jumps 1.6 m in lattice skinning once crashed",
};

describe("piston rig geometry", () => {
  it("good: every face rests clear of the paint and its contact plane sits within 0.1 m of the paint", () => {
    const car = makeCar("shape");
    car.spawnFacing(0, 0, 0, 0);
    const rig = new PistonRig(STANDARD);
    rig.attach(car);
    for (const h of rig.heads) {
      assert.ok(Math.abs(h.skinS - h.face(rig.honey) - PISTON.restGap) < 1e-9, `${h.id} rest gap`);
      assert.ok(Math.abs(h.pad) < 0.1, `${h.id} particles sit ${f3(h.pad)} m off the paint`);
    }
  });

  it("good: corner axes are 45° and mid axes square to their side", () => {
    const rig = new PistonRig();
    for (const h of rig.heads) {
      const deg = (Math.atan2(Math.abs(h.nx), Math.abs(h.nz)) * 180) / Math.PI;
      const want = isCorner(h.id) ? 45 : isSide(h.id) ? 90 : 0;
      assert.ok(Math.abs(deg - want) < 1e-6, `${h.id} at ${deg.toFixed(1)}°`);
    }
  });

  it("bad: a soft face takes energy — the honeycomb crushes and the car gets its share only", () => {
    const soft = shoot("front", { ...STANDARD, hardness: 0.5 });
    assert.ok(soft.faceSet > 0.05, `honeycomb crushed ${f3(soft.faceSet)} m`);
    assert.ok(Math.abs(soft.energy - shoot("front").energy * 0.5) < 1, `car energy ${soft.energy.toFixed(0)} J`);
  });

  it("edge: holding the car keeps it in the rig and hands it the impactor's whole ½·M·v²", () => {
    const held = shoot("front", { ...STANDARD, holdCar: true });
    const free = shoot("front");
    assert.ok(held.shove < 0.5, `held car slid ${f3(held.shove)} m`);
    assert.ok(free.shove > 3, `free car slid only ${f3(free.shove)} m`);
    assert.ok(held.energy > free.energy * 2, `held ${held.energy.toFixed(0)} J vs free ${free.energy.toFixed(0)} J`);
    assert.ok(crushOf(held) > crushOf(free), `held crush ${f3(crushOf(held))} vs free ${f3(crushOf(free))}`);
  });
});

describe("piston rig: standard shot crushes the struck region (1500 kg, 40 km/h, rigid, free car)", () => {
  for (const id of PISTON_IDS) {
    it(`${id}: struck particles go in by the expected depth`, () => {
      const r = shoot(id);
      assert.ok(r.contacted, "never touched");
      const got = r.struck.map((s) => `${s.name}=${f3(s.inward)}`).join(" ");
      if (isCorner(id)) {
        // The corner's bumper particle takes the hit along the diagonal; the
        // wing behind it folds in less (graded from the tip). Rear corners
        // have no wing particle.
        const [bumper, wing] = r.struck;
        assert.ok(bumper!.inward >= 0.12, `${got}: corner bumper < 0.12 m`);
        if (wing) assert.ok(wing.inward > 0.02 && wing.inward < bumper!.inward, `${got}: wing not graded behind the bumper`);
      } else if (isSide(id)) {
        assert.ok(r.struck[0]!.inward >= 0.12, `${got}: door < 0.12 m (IIHS band scaled to 40 km/h)`);
      } else {
        const [l, rr] = r.struck;
        const min = id === "front" ? 0.14 : 0.11;
        assert.ok(l!.inward >= min && rr!.inward >= min, `${got}: < ${min} m`);
        assert.ok(l!.inward <= 0.31 && rr!.inward <= 0.31, `${got}: past the 0.31 m dynamic bound`);
        assert.ok(Math.abs(l!.inward - rr!.inward) <= 0.03, `${got}: L/R lopsided`);
      }
    });

    it(`${id}: the paint at the struck point dents with the particles`, () => {
      const l = pistonLocality(shoot(id), shoot(id, TAP));
      assert.ok(l.dent >= 0.05, `paint within 0.3 m went in ${f3(l.dent)} m`);
    });
  }

  it("good: mirrored pistons give mirrored damage", () => {
    for (const [a, b] of [["frontLeft", "frontRight"], ["rearLeft", "rearRight"], ["left", "right"]] as const) {
      assert.ok(Math.abs(crushOf(shoot(a)) - crushOf(shoot(b))) < 0.005, `${a} ${f3(crushOf(shoot(a)))} vs ${b} ${f3(crushOf(shoot(b)))}`);
    }
  });

  it("good: side MDB at the IIHS test's 1500 kg / 50 km/h dents the door 0.15–0.25 m", () => {
    for (const id of ["left", "right"] as const) {
      const door = shoot(id, { ...STANDARD, speedKph: 50 }).struck[0]!.inward;
      assert.ok(door >= 0.15 && door <= 0.25, `${id} door ${f3(door)} m`);
    }
  });
});

describe(`piston rig: standard shot leaves the rest of the car alone (> ${PISTON_FAR} m away, extra over a 3 km/h tap ≤ ${LOCAL_TOL} m)`, () => {
  for (const id of PISTON_IDS) {
    const loc = () => pistonLocality(shoot(id), shoot(id, TAP));
    it(`${id}: far particles stay put`, { todo: TODO[`${id}:far-particles`] }, () => {
      const l = loc();
      assert.ok(l.farParticle <= LOCAL_TOL, `${l.farParticleName} moved ${f3(l.farParticle)} m`);
    });
    it(`${id}: far skin stays put`, { todo: TODO[`${id}:far-skin`] }, () => {
      assert.ok(loc().farSkin <= LOCAL_TOL, `far skin moved ${f3(loc().farSkin)} m`);
    });
    it(`${id}: the opposite half stays put`, { todo: TODO[`${id}:opposite-half`] }, () => {
      const l = loc();
      assert.ok(l.oppositeParticle <= LOCAL_TOL && l.oppositeSkin <= LOCAL_TOL, `particle ${f3(l.oppositeParticle)} skin ${f3(l.oppositeSkin)}`);
    });
    it(`${id}: cabin intrusion stays under ${CABIN_TOL} m (struck door excepted)`, { todo: TODO[`${id}:cabin`] }, () => {
      const r = shoot(id);
      const doors = id === "left" ? [r.doorR] : id === "right" ? [r.doorL] : [r.doorL, r.doorR];
      for (const d of doors) assert.ok(d <= CABIN_TOL, `door ${f3(d)} m`);
      assert.ok(r.roof <= CABIN_TOL, `roof ${f3(r.roof)} m`);
    });
  }
});

describe("piston rig: arming the crash with a 3 km/h tap (0.2 kJ) changes nothing", () => {
  for (const id of PISTON_IDS) {
    it(`${id}: tap moves no body particle`, { todo: TODO[`${id}:tap-particles`] }, () => {
      const r = shoot(id, TAP);
      assert.ok(r.farParticle <= LOCAL_TOL, `${r.farParticleName} moved ${f3(r.farParticle)} m`);
      for (const s of r.struck) assert.ok(Math.abs(s.inward) <= LOCAL_TOL, `${s.name} ${f3(s.inward)} m`);
    });
    it(`${id}: tap moves no skin`, { todo: TODO[`${id}:tap-skin`] }, () => {
      const r = shoot(id, TAP);
      assert.ok(r.farSkin <= LOCAL_TOL, `far skin moved ${f3(r.farSkin)} m (panels ${f3(r.farBodySkin)} m)`);
      assert.ok(Math.abs(r.skinInward) <= LOCAL_TOL, `struck paint moved ${f3(r.skinInward)} m`);
    });
  }
});

const SPEEDS = [20, 30, 40, 50, 60, 70, 80];

describe("piston rig: severity", () => {
  for (const id of PISTON_IDS) {
    it(`${id}: crush never shrinks as the energy grows (${SPEEDS.join("/")} km/h)`, { todo: TODO[`${id}:monotonic`] }, () => {
      let prev = -Infinity;
      const row = SPEEDS.map((kph) => crushOf(shoot(id, { ...STANDARD, speedKph: kph })));
      for (const c of row) {
        assert.ok(c >= prev - 0.005, `crush by speed ${row.map(f3).join(" ")}`);
        prev = c;
      }
    });
  }

  for (const id of ["front", "left", "frontLeft"] as const) {
    it(`${id}: a honeycomb face (hardness 0.5) crushes the car less than steel at the same energy`, () => {
      const steel = crushOf(shoot(id));
      const soft = crushOf(shoot(id, { ...STANDARD, hardness: 0.5 }));
      assert.ok(soft < steel - 0.02, `soft ${f3(soft)} vs steel ${f3(steel)}`);
    });
  }

  /** Lowest speed (2 km/h resolution, 1500 kg rigid) that kills the drivetrain, or null up to 150 km/h. */
  function killSpeed(id: PistonId): number | null {
    for (let kph = 30; kph <= 150; kph += 10) {
      if (shoot(id, { ...STANDARD, speedKph: kph }).drivetrainAlive) continue;
      for (let k = kph - 8; k < kph; k += 2) if (!shoot(id, { ...STANDARD, speedKph: k }).drivetrainAlive) return k;
      return kph;
    }
    return null;
  }

  it("good: a hard enough front-middle shot kills the drivetrain", () => {
    const k = killSpeed("front");
    assert.ok(k != null, "front-middle never killed it up to 150 km/h");
  });

  it("good: the front-middle kill shot sits at the barrier path's kill EBS (wall56 alive, wall64 dead, RIG_ANALYSIS §6)", { todo: TODO["front:kill-ebs"] }, () => {
    const k = killSpeed("front")!;
    const ebsKph = shoot("front", { ...STANDARD, speedKph: k }).ebs * 3.6;
    assert.ok(ebsKph > 56 && ebsKph <= 64, `kills at ${k} km/h = EBS ${ebsKph.toFixed(1)} km/h`);
  });

  for (const id of ["rear", "left", "right", "rearLeft", "rearRight"] as const) {
    it(`${id}: the front-middle kill shot does not kill the drivetrain from here`, () => {
      const k = killSpeed("front")!;
      assert.equal(shoot(id, { ...STANDARD, speedKph: k }).drivetrainAlive, true, `dead at ${k} km/h`);
    });
  }

  for (const id of ["frontLeft", "frontRight"] as const) {
    it(`${id}: a corner needs at least the front-middle's kill shot to kill the drivetrain`, { todo: TODO[`${id}:corner-kill`] }, () => {
      const front = killSpeed("front")!;
      const corner = killSpeed(id);
      assert.ok(corner == null || corner >= front, `corner kills at ${corner} km/h, front-middle at ${front} km/h`);
    });
  }
});

describe("piston rig: lattice mode, standard shot", () => {
  for (const id of PISTON_IDS) {
    it(`${id}: struck particles go in (lattice)`, () => {
      const r = shoot(id, STANDARD, "lattice");
      for (const s of r.struck.slice(0, isCorner(id) ? 1 : 2)) assert.ok(s.inward >= 0.11, `${s.name} ${f3(s.inward)} m`);
    });
    it(`${id}: tap moves no skin (lattice)`, { todo: TODO[`${id}:lattice-tap-skin`] }, () => {
      const r = shoot(id, TAP, "lattice");
      assert.ok(r.farSkin <= LOCAL_TOL, `far skin moved ${f3(r.farSkin)} m (panels ${f3(r.farBodySkin)} m)`);
    });
  }
});

describe("piston rig: shot API", () => {
  it("close-but-wrong: PISTON_STRUCK names real particles for every piston", () => {
    const names = new Set(shoot("front").names);
    for (const id of PISTON_IDS) for (const n of PISTON_STRUCK[id]) assert.ok(names.has(n), `${id}: ${n}`);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { DeformableCar } from "./car.ts";
import type { DetachPart } from "./car-core.ts";
import { makeChassisGeometry } from "./car-mesh.ts";
import { CAR_STYLE_IDS, CAR_STYLES, type CarStyleId } from "./car-variants.ts";
import { makeShell, PANEL_NAMES, panelRegions, poseShell } from "./car-panels.ts";
import { DENT_MAX, newDentState, recordDent } from "./loose-dent.ts";
import { runWall, type CrashResult } from "../contact/crash-scenarios.test-util.ts";
import { assertSameNumbers, DT, paint } from "./test-support.ts";
import { LIES_FLAT, lowest, RESTS, thinAxisUp } from "./loose-step.test-util.ts";

/** The car with its parts and its hood readable, and a part tearable at a chosen impulse. */
class Probe extends DeformableCar {
  get allParts(): DetachPart[] {
    return this.parts;
  }
  get hoodMesh(): THREE.Mesh {
    return this.hood;
  }
  tear(name: string, impulse: number): void {
    this.detachPart(this.part(name), impulse);
  }
  part(name: string): DetachPart {
    return this.parts.find((p) => p.name === name)!;
  }
}
function probe(style: CarStyleId = "sedan"): Probe {
  const car = new Probe(paint(), new THREE.Scene(), null, style);
  car.deform.setMode("shape");
  return car;
}
const positions = (m: THREE.Object3D) => ((m as THREE.Mesh).geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
const worst = (r: CrashResult, kind: "quarter" | "arch") => Math.max(...PANEL_NAMES.filter((n) => n.startsWith(kind)).map((n) => r.hinge[n]!));
const torn = (r: CrashResult, kind: "quarter" | "arch") => r.detached.filter((n) => n.startsWith(kind));

describe("given every car body style, whose panels are cut from each body's own skin", () => {
  const bodies = CAR_STYLE_IDS.map((id) => ({ id, body: makeChassisGeometry(CAR_STYLES[id]) }));

  it("when each body's panels are cut, then every body has all six panels and no triangle belongs to two of them", () => {
    for (const { id, body } of bodies) {
      const cuts = panelRegions(CAR_STYLES[id], body);
      assert.equal(cuts.map((r) => r.name).join(), PANEL_NAMES.join());
      const seen = new Set<string>();
      for (const r of cuts) {
        assert.ok(r.verts.length > 20 && r.tris.count >= 30 * 3, `${id} ${r.name} has ${r.tris.count / 3} triangles`);
        for (let t = 0; t < r.tris.count; t += 3) {
          const key = [0, 1, 2].map((k) => r.tris.getX(t + k)).join(",");
          assert.ok(!seen.has(key), `${id}: triangle ${key} is in two panels (${r.name})`);
          seen.add(key);
        }
      }
    }
  });

  it("when the sedan, coupe and pickup quarter panels are cut, then each starts at its body's own rear door seam or behind its door, not at one shared place", () => {
    const front = (id: string) => {
      const { body } = bodies.find((b) => b.id === id)!;
      const r = panelRegions(CAR_STYLES[id as keyof typeof CAR_STYLES], body).find((q) => q.name === "quarterR")!;
      const pos = body.getAttribute("position") as THREE.BufferAttribute;
      return Math.max(...[...r.verts].map((v) => pos.getZ(v)));
    };
    assert.ok(front("sedan") < -0.5, `sedan quarter reaches z=${front("sedan")}, past its rear door`);
    assert.ok(front("coupe") > -0.15 && front("pickup") > -0.15, `two-door quarters start at z=${front("coupe")} / ${front("pickup")}, behind the door`);
  });

  it("when the sedan's quarter panel is shelled flat and then bent, then the flat shell lies on the skin (4 mm proud, its sheet 2 cm behind) and the bent panel peels at its leading edge and holds at the tail", () => {
    const { body } = bodies[0]!;
    const r = panelRegions(CAR_STYLES.sedan, body).find((q) => q.name === "quarterR")!;
    const shell = makeShell(r, body);
    const pos = body.getAttribute("position") as THREE.BufferAttribute;
    const out = shell.getAttribute("position") as THREE.BufferAttribute;
    const n = r.verts.length;
    const at = (k: number, back: number) => new THREE.Vector3(out.getX(k + back * n), out.getY(k + back * n), out.getZ(k + back * n)).add(r.origin);
    for (let k = 0; k < n; k++) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, r.verts[k]!);
      assert.ok(at(k, 0).distanceTo(v) < 0.0045, `front vertex ${k} stands ${at(k, 0).distanceTo(v)} m off the skin`);
      assert.ok(Math.abs(at(k, 1).distanceTo(v) - 0.02) < 1e-4, `back vertex ${k} is ${at(k, 1).distanceTo(v)} m behind`);
    }
    poseShell(r, shell, body, 1, 0);
    let free = 0;
    let held = 0;
    for (let k = 0; k < n; k++) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, r.verts[k]!);
      const d = at(k, 0).distanceTo(v);
      if (r.w[k]! > 0.9) free = Math.max(free, d);
      if (r.w[k]! < 0.05) held = Math.max(held, d);
    }
    assert.ok(free > 0.2, `the free end peeled ${free} m`);
    assert.ok(held < 0.02, `the hinge end moved ${held} m`);
  });

  it("when a police car nobody has crashed is checked, then it carries no panel mesh: attached panels are body, with no draw of their own", () => {
    const car = probe("police");
    for (const p of car.allParts.filter((q) => q.region)) assert.ok(!p.open && p.object.parent === null, `${p.name} is in the scene`);
    assert.ok(!car.body.geometry.getAttribute("primer").array.some((v) => v !== 0), "the body is primer before any panel hinged");
  });
});

describe("given the standard crashes into a wall, body panels hinge, then tear", () => {
  it("when a car hits a rear wall 30 % offset at 56 km/h and then at 80, then a quarter panel bends at 56 and tears at 80", () => {
    const soft = runWall(56, 0.3, "rear");
    assert.ok(worst(soft, "quarter") > 0.2 && worst(soft, "quarter") < 0.8, `56 km/h hinge ${worst(soft, "quarter")}`);
    assert.deepEqual(torn(soft, "quarter"), []);
    const hard = runWall(80, 0.3, "rear");
    assert.equal(torn(hard, "quarter").length, 1, `80 km/h tore ${torn(hard, "quarter")}`);
  });

  it("when a car hits a front wall 30 % offset at 40 km/h and then at 56, then an arch flare flaps at 40 and tears at 56", () => {
    const soft = runWall(40, 0.3, "front");
    assert.ok(worst(soft, "arch") > 0.5, `40 km/h arch hinge ${worst(soft, "arch")}`);
    assert.deepEqual(torn(soft, "arch"), []);
    assert.equal(torn(runWall(56, 0.3, "front"), "arch").length, 1);
  });

  it("when a car hits a wall off-centre with its nose at 24 km/h, then the front bumper hangs from its far corner, still on", () => {
    const car = probe();
    runWall(24, 0.3, "front", { car });
    const bumper = car.part("bumperF");
    assert.ok(bumper.hingeT > 0.3 && !bumper.detached, `bumper hinge ${bumper.hingeT}`);
    assert.ok(Math.abs(bumper.object.rotation.z) > 0.05, `bumper rolled ${bumper.object.rotation.z} rad`);
  });

  it("when a car hits a wall at 24 km/h, then every panel stays flat and no shell is in the scene", () => {
    const car = probe();
    const r = runWall(24, 1, "front", { car });
    for (const n of PANEL_NAMES) assert.equal(r.hinge[n], 0, `${n} hinged at 24 km/h`);
    assert.ok(car.allParts.every((p) => !p.region || !p.open));
  });

  it("when a police car hits a wall at 56 km/h, then its light bar tilts on one mount and does not shear off (it shears off at 64)", () => {
    const car = probe("police");
    const r = runWall(56, 1, "front", { car });
    assert.ok(!r.detached.includes("lightBar"));
    assert.ok(r.hinge.lightBar! > 0.3 && r.hinge.lightBar! < 0.95, `bar hinge ${r.hinge.lightBar}`);
    assert.ok(Math.abs(car.part("lightBar").object.rotation.z) > 0.1, `bar rolled ${car.part("lightBar").object.rotation.z} rad`);
  });
});

describe("given a car whose quarter panels and arch flares are torn off", () => {
  it("when the car steps on, then a torn quarter panel and arch lie flat on the road (lowest point within a centimetre, thin axis up, as a torn hood does), a car shows at most two torn shells, and a reset brings every shell back and the body to paint", () => {
    const car = probe();
    for (const n of ["quarterL", "quarterR", "archFL", "archFR"]) car.tear(n, 20);
    for (let i = 0; i < 240; i++) car.step(DT);
    for (const n of ["archFL", "archFR"]) {
      const part = car.part(n);
      const up = thinAxisUp(part);
      const low = lowest(part);
      assert.ok(up > LIES_FLAT && low >= -1e-9 && low <= RESTS, `${n} thin axis ${up.toFixed(3)} up, lowest point ${low.toFixed(4)} m over the road`);
    }
    assert.equal(car.allParts.filter((p) => p.region && p.detached && p.object.visible).length, 2, "drawn torn shells");
    car.resetVisual();
    assert.ok(car.allParts.every((p) => !p.region || p.object.visible), "a reset brings every shell back");
    assert.ok(!car.body.geometry.getAttribute("primer").array.some((v) => v !== 0), "and the body is paint again");
  });
});

describe("given a parked car that tears its hood and right quarter panel off and drops them on the road (dents on torn parts)", () => {
  /** A parked car tears its hood and right quarter panel off, then drops them on the road: 240 fixed steps. */
  function dropped(): Probe {
    const car = probe();
    car.tear("hood", 20);
    car.tear("quarterR", 20);
    for (let i = 0; i < 240; i++) car.step(DT);
    return car;
  }
  const fresh = positions(probe().hoodMesh);

  it("when the parts land, then they dent where they land, by centimetres, and a second run dents them to the same vertex", () => {
    const a = dropped();
    const hood = a.part("hood");
    assert.ok(hood.dent.count > 0 && a.part("quarterR").dent.count > 0, "no bounce dented them");
    let moved = 0;
    for (const [i, v] of positions(hood.object).entries()) moved = Math.max(moved, Math.abs(v - fresh[i]!));
    assert.ok(moved > 0.01 && moved <= 0.09, `hood dented by ${moved} m`);
    const b = dropped();
    assertSameNumbers(positions(b.part("hood").object), positions(hood.object), "hood vertices");
    assertSameNumbers(positions(b.part("quarterR").object), positions(a.part("quarterR").object), "quarter panel vertices");
  });

  it("when the car is reset, then the skin is put back", () => {
    const car = dropped();
    car.resetVisual();
    assertSameNumbers(positions(car.part("hood").object), fresh, "reset hood");
    assert.equal(car.part("hood").dent.count, 0);
  });

  it("when a soft touch lands and then many hard ones, then the soft touch does not dent and a part takes no more than its share of dents", () => {
    const d = newDentState();
    const o = new THREE.Object3D();
    recordDent(d, o, new THREE.Vector3(0, 1, 0));
    assert.equal(d.count, 0, "a 1 m/s touch dented");
    for (let i = 0; i < DENT_MAX + 5; i++) recordDent(d, o, new THREE.Vector3(0, 6, 0));
    assert.equal(d.count, DENT_MAX);
  });
});

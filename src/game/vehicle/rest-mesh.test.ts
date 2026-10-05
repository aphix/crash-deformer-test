import * as THREE from "three";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeChassisGeometry, makeHoodGeometry, makeTrunkGeometry, makeDoorGeometry, restSideProfile, CAR_HALF } from "./car-mesh.ts";
import { makeSideGlass, makeRearSideGlass, makeWindshield, makeRearGlass } from "./car-glass.ts";
import { makeWheelGeometry } from "./car-materials.ts";
import { TYRE_R } from "../deform/deform-state.ts";

function bbox(geo: THREE.BufferGeometry) {
  geo.computeBoundingBox();
  const b = geo.boundingBox!;
  return {
    sx: b.max.x - b.min.x,
    sy: b.max.y - b.min.y,
    sz: b.max.z - b.min.z,
    min: b.min,
    max: b.max,
  };
}

describe("given the sedan's rest-pose side profile (the body outline read at points along the car's length)", () => {
  it("when read over the boot 1.7 m behind the middle, then the body side stays under 0.82 m high and is not flagged as cabin, so the boot is not a greenhouse", () => {
    const p = restSideProfile(-1.7);
    assert.ok(p.ySideTop < 0.82, `trunk body ${p.ySideTop} looks like a cabin`);
    assert.ok(p.cabin < 0.15, `trunk cabin flag ${p.cabin}`);
  });

  it("when read at the rear quarter 0.4 m behind the middle, then the body side is belt height (0.7 to 0.92 m) with the greenhouse more than 0.3 m above it, not a wall up to the roof", () => {
    const p = restSideProfile(-0.4);
    assert.ok(p.ySideTop > 0.7 && p.ySideTop < 0.92, `quarter ${p.ySideTop}`);
    assert.ok(p.yRoof - p.ySideTop > 0.3, "greenhouse must sit above the quarter, not be filled with body");
  });

  it("when read at the door 0.28 m ahead of the middle, then there is a door cut-out and the body side drops to a sill under 0.3 m, not the whole cabin side", () => {
    const p = restSideProfile(0.28);
    assert.ok(p.doorHole > 0.5, `expected a door hole at z=0.28, got ${p.doorHole}`);
    assert.ok(p.ySideTop < 0.3, `door sill ${p.ySideTop} is still a wall`);
  });

  it("when read just behind (0.2 m behind the middle) and just ahead (0.7 m ahead) of the door, then there is no door cut-out at either, so the cut leaves the rear quarter and the A-pillar whole", () => {
    assert.equal(restSideProfile(-0.2).doorHole, 0);
    assert.equal(restSideProfile(0.7).doorHole, 0);
  });

  it("when read over the front fender 1.5 m ahead of the middle, then the body side is hood height (0.48 to 0.78 m) and not flagged as cabin", () => {
    const p = restSideProfile(1.5);
    assert.ok(p.ySideTop > 0.48 && p.ySideTop < 0.78, `fender ${p.ySideTop}`);
    assert.ok(p.cabin < 0.05);
  });

  it("when read at four points from 1.1 m behind to 0.5 m ahead of the middle, then the body side top stays under 0.95 m everywhere, never lofted up to the roof as a hearse's would be", () => {
    for (const z of [-1.1, -0.5, 0.2, 0.5]) {
      const p = restSideProfile(z);
      assert.ok(
        p.ySideTop < 0.95,
        `z=${z} body top ${p.ySideTop} reaches the roof — van/hearse blob`,
      );
    }
  });

  it("when read in the greenhouse 0.2 m behind the middle, then the roof is over 1.15 m, the belt under 0.9 m and the two more than 0.4 m apart", () => {
    const p = restSideProfile(-0.2);
    assert.ok(p.yRoof > 1.15, `roof ${p.yRoof}`);
    assert.ok(p.yBelt < 0.9, `belt ${p.yBelt}`);
    assert.ok(p.yRoof - p.yBelt > 0.4);
  });
});

describe("given the sedan's rest-pose body panels (chassis shell, hood, trunk and door)", () => {
  it("when the chassis shell is measured, then it is a compact sedan: 4.0 to 4.6 m long, 1.5 to 2.05 m wide, 1.05 to 1.45 m tall and symmetric left to right within 8 cm", () => {
    const geo = makeChassisGeometry();
    const b = bbox(geo);
    assert.ok(b.sz > 4.0 && b.sz < 4.6, `length ${b.sz}`);
    assert.ok(b.sx > 1.5 && b.sx < 2.05, `width ${b.sx}`);
    assert.ok(b.sy > 1.05 && b.sy < 1.45, `height ${b.sy}`);
    assert.ok(Math.abs(b.min.x + b.max.x) < 0.08, "asymmetric in X");
    geo.dispose();
  });

  it("when the car's collision half-size is read, then it matches the visual shell: 2.0 to 2.4 m half-length and 0.8 to 1.0 m half-width", () => {
    assert.ok(CAR_HALF.z > 2.0 && CAR_HALF.z < 2.4);
    assert.ok(CAR_HALF.x > 0.8 && CAR_HALF.x < 1.0);
  });

  it("when the hood and trunk panels are measured, then each is a shallow shell under 0.5 m tall, not a cabin", () => {
    const hood = makeHoodGeometry();
    const trunk = makeTrunkGeometry();
    const h = bbox(hood);
    const t = bbox(trunk);
    assert.ok(h.sy < 0.5, `hood height ${h.sy}`);
    assert.ok(t.sy < 0.5, `trunk height ${t.sy}`);
    hood.dispose();
    trunk.dispose();
  });

  it("when the door panel is measured, then it is 0.45 to 0.75 m long and 0.5 to 0.8 m tall, a door-sized panel and not a 1.2 m cabin slab", () => {
    const door = makeDoorGeometry(-1);
    const b = bbox(door);
    assert.ok(b.sz > 0.45 && b.sz < 0.75, `door length ${b.sz}`);
    assert.ok(b.sy > 0.5 && b.sy < 0.8, `door height ${b.sy}`);
    door.dispose();
  });

  it("when the left and right door panels are measured, then their lengths and heights agree within 2 cm, so the doors mirror", () => {
    const l = makeDoorGeometry(-1);
    const r = makeDoorGeometry(1);
    const bl = bbox(l);
    const br = bbox(r);
    assert.ok(Math.abs(bl.sz - br.sz) < 0.02);
    assert.ok(Math.abs(bl.sy - br.sy) < 0.02);
    l.dispose();
    r.dispose();
  });
});

function assembleRestCar(): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(makeChassisGeometry()));
  const hood = new THREE.Mesh(makeHoodGeometry());
  hood.position.set(0, 0.7, 0.74);
  g.add(hood);
  const trunk = new THREE.Mesh(makeTrunkGeometry());
  trunk.position.set(0, 0.74, -0.72);
  g.add(trunk);
  for (const sign of [-1, 1] as const) {
    const door = new THREE.Group();
    door.position.set(sign * 0.86, 0.54, 0.55);
    const skin = new THREE.Mesh(makeDoorGeometry(sign));
    skin.position.set(0, 0, -0.28);
    door.add(skin);
    const glass = new THREE.Mesh(makeSideGlass(sign));
    glass.position.set(-sign * 0.02, 0.52, -0.28);
    door.add(glass);
    g.add(door);
  }
  g.add(new THREE.Mesh(makeRearSideGlass(-1)));
  g.add(new THREE.Mesh(makeRearSideGlass(1)));
  g.add(new THREE.Mesh(makeWindshield()));
  g.add(new THREE.Mesh(makeRearGlass()));
  g.updateMatrixWorld(true);
  return g;
}

function hitX(g: THREE.Group, y: number, z: number): number | null {
  const ray = new THREE.Raycaster(new THREE.Vector3(3, y, z), new THREE.Vector3(-1, 0, 0));
  const hits = ray.intersectObject(g, true);
  return hits.length ? hits[0]!.point.x : null;
}

const sideHitCases = [
  { it: "when a ray is fired at the door cut-out at belt height (0.5 m up, 0.28 m ahead of the middle), then it hits the door skin beyond 0.72 m out, so the cut is not an open hole", y: 0.5, z: 0.28, minX: 0.72, failure: "door cut is an open hole at x={x}" },
  { it: "when a ray is fired at the front window (1.05 m up, 0.28 m ahead of the middle), then it hits door glass on the outer skin beyond 0.7 m out, so the window is not a hole", y: 1.05, z: 0.28, minX: 0.7, failure: "front window is a hole at x={x}" },
  { it: "when a ray is fired at the rear quarter window (1.05 m up, 0.4 m behind the middle), then it hits glass on the skin beyond 0.7 m out, not 20 cm inside it", y: 1.05, z: -0.4, minX: 0.7, failure: "rear window hole (old glass at x=0.6) got x={x}" },
  { it: "when a ray is fired at the rear quarter below the belt (0.5 m up, 0.4 m behind the middle), then it hits body metal beyond 0.72 m out", y: 0.5, z: -0.4, minX: 0.72, failure: "quarter missing at x={x}" },
  { it: "when a ray is fired at the trunk side (0.5 m up, 1.6 m behind the middle), then it hits solid body beyond 0.65 m out", y: 0.5, z: -1.6, minX: 0.65, failure: "trunk hole at x={x}" },
  { it: "when a ray is fired at the front fender (0.5 m up, 1.5 m ahead of the middle), then it hits solid body beyond 0.55 m out", y: 0.5, z: 1.5, minX: 0.55, failure: "fender hole at x={x}" },
  { it: "when a ray is fired at the rear quarter window (1.05 m up, 0.4 m behind the middle), then the glass it hits is outside 0.75 m, not an interior liner that would look like a rollcage", y: 1.05, z: -0.4, minX: 0.75, failure: "glass inset at x={x} — looks like a rollcage" },
] as const;

describe("given the assembled rest-pose sedan (chassis, hood, trunk, doors and glass) with rays fired at it from the side", () => {
  const g = assembleRestCar();

  for (const testCase of sideHitCases) {
    it(testCase.it, () => {
      const x = hitX(g, testCase.y, testCase.z);
      assert.ok(x !== null && x > testCase.minX, testCase.failure.replace("{x}", String(x)));
    });
  }

  it("when rays are fired along the greenhouse from belt to roof (1.02 m up, at four points from 0.55 m behind to 0.35 m ahead of the middle), then every ray hits the body beyond 0.68 m out, so there is no cabin-length void", () => {
    for (const z of [-0.55, -0.25, 0.15, 0.35]) {
      const x = hitX(g, 1.02, z);
      assert.ok(x !== null && x > 0.68, `greenhouse hole at z=${z} x=${x}`);
    }
  });
});

describe("given the sedan's wheel mesh (tyre, rim and hub)", () => {
  const geo = makeWheelGeometry();
  const pos = geo.getAttribute("position");
  const nrm = geo.getAttribute("normal");
  const uv1 = geo.getAttribute("uv1");
  const radius = (i: number) => Math.hypot(pos.getY(i), pos.getZ(i));

  it("when the largest radius is measured, then the tread crown equals the rig's tyre radius within 1e-6 m, so the wheel neither floats nor sinks", () => {
    let r = 0;
    for (let i = 0; i < pos.count; i++) r = Math.max(r, radius(i));
    assert.ok(Math.abs(r - TYRE_R) < 1e-6, `crown ${r} vs TYRE_R ${TYRE_R}`);
  });

  it("when the wheel's extent along the axle is measured, then it is mirror-symmetric across the axle plane within 1e-6 m and under 0.24 m wide, so one mesh serves the left and right wheels", () => {
    const b = bbox(geo);
    assert.ok(Math.abs(b.min.x + b.max.x) < 1e-6 && b.sx < 0.24, `x ${b.min.x}..${b.max.x}`);
  });

  it("when the normals of the tread vertices are read, then each points outward (more than 0.8 of the way), so the tyre does not render inside out", () => {
    for (let i = 0; i < pos.count; i++) {
      if (radius(i) < TYRE_R - 0.002) continue;
      const out = (nrm.getY(i) * pos.getY(i) + nrm.getZ(i) * pos.getZ(i)) / radius(i);
      assert.ok(out > 0.8, `tread vertex ${i} normal points ${out.toFixed(2)} outward`);
    }
  });

  it("when the tread-pattern coordinate of each vertex within 0.3 m of the axle is read, then it is a flat row (0 or 1), so only the tread samples the tread pattern", () => {
    for (let i = 0; i < pos.count; i++) {
      const v = uv1.getY(i);
      if (radius(i) < 0.3) assert.ok(v === 0 || v === 1, `vertex ${i} at r=${radius(i).toFixed(3)} samples tread row ${v}`);
    }
  });
});

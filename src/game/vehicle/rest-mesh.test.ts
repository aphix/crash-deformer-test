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

describe("rest pose is a sedan, not a van blob", () => {
  it("good: trunk stays at boot height, never greenhouse", () => {
    const p = restSideProfile(-1.7);
    assert.ok(p.ySideTop < 0.82, `trunk body ${p.ySideTop} looks like a cabin`);
    assert.ok(p.cabin < 0.15, `trunk cabin flag ${p.cabin}`);
  });

  it("good: rear quarter is belt height, not a C-sail wall to the roof", () => {
    const p = restSideProfile(-0.4);
    assert.ok(p.ySideTop > 0.7 && p.ySideTop < 0.92, `quarter ${p.ySideTop}`);
    assert.ok(p.yRoof - p.ySideTop > 0.3, "greenhouse must sit above the quarter, not be filled with body");
  });

  it("good: door cut is a sill, not the whole cabin side", () => {
    const p = restSideProfile(0.28);
    assert.ok(p.doorHole > 0.5, `expected a door hole at z=0.28, got ${p.doorHole}`);
    assert.ok(p.ySideTop < 0.3, `door sill ${p.ySideTop} is still a wall`);
  });

  it("good: door cut does not eat the rear quarter or the A-pillar", () => {
    assert.equal(restSideProfile(-0.2).doorHole, 0);
    assert.equal(restSideProfile(0.7).doorHole, 0);
  });

  it("good: front fender is hood height", () => {
    const p = restSideProfile(1.5);
    assert.ok(p.ySideTop > 0.48 && p.ySideTop < 0.78, `fender ${p.ySideTop}`);
    assert.ok(p.cabin < 0.05);
  });

  it("bad: lofting cabin metal to yRoof makes a hearse (old sectionPoints)", () => {
    for (const z of [-1.1, -0.5, 0.2, 0.5]) {
      const p = restSideProfile(z);
      assert.ok(
        p.ySideTop < 0.95,
        `z=${z} body top ${p.ySideTop} reaches the roof — van/hearse blob`,
      );
    }
  });

  it("close-but-wrong: belt and roof must stay distinct in the greenhouse", () => {
    const p = restSideProfile(-0.2);
    assert.ok(p.yRoof > 1.15, `roof ${p.yRoof}`);
    assert.ok(p.yBelt < 0.9, `belt ${p.yBelt}`);
    assert.ok(p.yRoof - p.yBelt > 0.4);
  });
});

describe("rest chassis / panels", () => {
  it("good: chassis bbox is a compact sedan", () => {
    const geo = makeChassisGeometry();
    const b = bbox(geo);
    assert.ok(b.sz > 4.0 && b.sz < 4.6, `length ${b.sz}`);
    assert.ok(b.sx > 1.5 && b.sx < 2.05, `width ${b.sx}`);
    assert.ok(b.sy > 1.05 && b.sy < 1.45, `height ${b.sy}`);
    assert.ok(Math.abs(b.min.x + b.max.x) < 0.08, "asymmetric in X");
    geo.dispose();
  });

  it("good: CAR_HALF matches the visual shell", () => {
    assert.ok(CAR_HALF.z > 2.0 && CAR_HALF.z < 2.4);
    assert.ok(CAR_HALF.x > 0.8 && CAR_HALF.x < 1.0);
  });

  it("good: hood and trunk are shallow shells, not cabins", () => {
    const hood = makeHoodGeometry();
    const trunk = makeTrunkGeometry();
    const h = bbox(hood);
    const t = bbox(trunk);
    assert.ok(h.sy < 0.5, `hood height ${h.sy}`);
    assert.ok(t.sy < 0.5, `trunk height ${t.sy}`);
    hood.dispose();
    trunk.dispose();
  });

  it("good: door is a door-sized panel, not a 1.2m cabin slab", () => {
    const door = makeDoorGeometry(-1);
    const b = bbox(door);
    assert.ok(b.sz > 0.45 && b.sz < 0.75, `door length ${b.sz}`);
    assert.ok(b.sy > 0.5 && b.sy < 0.8, `door height ${b.sy}`);
    door.dispose();
  });

  it("edge: left and right doors mirror", () => {
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

describe("rest car is closed from the side (no rollcage hole)", () => {
  const g = assembleRestCar();

  it("good: door skin fills the door cut at belt height", () => {
    const x = hitX(g, 0.5, 0.28);
    assert.ok(x !== null && x > 0.72, `door cut is an open hole at x=${x}`);
  });

  it("good: door glass fills the front window, on the outer skin", () => {
    const x = hitX(g, 1.05, 0.28);
    assert.ok(x !== null && x > 0.7, `front window is a hole at x=${x}`);
  });

  it("good: rear quarter glass sits on the skin, not 20cm inside", () => {
    const x = hitX(g, 1.05, -0.4);
    assert.ok(x !== null && x > 0.7, `rear window hole (old glass at x=0.6) got x=${x}`);
  });

  it("good: rear quarter metal is present below the belt", () => {
    const x = hitX(g, 0.5, -0.4);
    assert.ok(x !== null && x > 0.72, `quarter missing at x=${x}`);
  });

  it("good: trunk side is solid", () => {
    const x = hitX(g, 0.5, -1.6);
    assert.ok(x !== null && x > 0.65, `trunk hole at x=${x}`);
  });

  it("good: front fender is solid", () => {
    const x = hitX(g, 0.5, 1.5);
    assert.ok(x !== null && x > 0.55, `fender hole at x=${x}`);
  });

  it("bad: a cabin-length void from belt to roof (the screenshot hole)", () => {
    for (const z of [-0.55, -0.25, 0.15, 0.35]) {
      const x = hitX(g, 1.02, z);
      assert.ok(x !== null && x > 0.68, `greenhouse hole at z=${z} x=${x}`);
    }
  });

  it("close-but-wrong: glass must be outside |x|=0.75, not an interior liner", () => {
    const x = hitX(g, 1.05, -0.4);
    assert.ok(x !== null && x > 0.75, `glass inset at x=${x} — looks like a rollcage`);
  });
});

describe("wheel (tyre, rim, hub)", () => {
  const geo = makeWheelGeometry();
  const pos = geo.getAttribute("position");
  const nrm = geo.getAttribute("normal");
  const uv1 = geo.getAttribute("uv1");
  const radius = (i: number) => Math.hypot(pos.getY(i), pos.getZ(i));

  it("good: the tread crown is the rig's tyre radius, so the wheel neither floats nor sinks", () => {
    let r = 0;
    for (let i = 0; i < pos.count; i++) r = Math.max(r, radius(i));
    assert.ok(Math.abs(r - TYRE_R) < 1e-6, `crown ${r} vs TYRE_R ${TYRE_R}`);
  });

  it("good: mirror-symmetric across the axle plane, so one instance serves the left and right wheels", () => {
    const b = bbox(geo);
    assert.ok(Math.abs(b.min.x + b.max.x) < 1e-6 && b.sx < 0.24, `x ${b.min.x}..${b.max.x}`);
  });

  it("bad: tread faces pointing into the wheel (inverted lathe) render the tyre inside out", () => {
    for (let i = 0; i < pos.count; i++) {
      if (radius(i) < TYRE_R - 0.002) continue;
      const out = (nrm.getY(i) * pos.getY(i) + nrm.getZ(i) * pos.getZ(i)) / radius(i);
      assert.ok(out > 0.8, `tread vertex ${i} normal points ${out.toFixed(2)} outward`);
    }
  });

  it("edge: only the tread samples the tread pattern; sidewalls, rim and hub read its flat rows", () => {
    for (let i = 0; i < pos.count; i++) {
      const v = uv1.getY(i);
      if (radius(i) < 0.3) assert.ok(v === 0 || v === 1, `vertex ${i} at r=${radius(i).toFixed(3)} samples tread row ${v}`);
    }
  });
});

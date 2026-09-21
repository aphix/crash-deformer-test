import * as THREE from "three";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import {
  makeChassisGeometry,
  makeHoodGeometry,
  makeTrunkGeometry,
  makeDoorGeometry,
  makeSideGlass,
  makeRearSideGlass,
  makeWindshield,
  makeRearGlass,
  restSideProfile,
  CAR_HALF,
} from "./car-mesh.ts";

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

function writeSilhouette(): void {
  const zs: number[] = [];
  for (let i = 0; i <= 80; i++) zs.push(-2.14 + (4.28 * i) / 80);
  const sx = 90;
  const sy = 70;
  const xOf = (z: number) => 40 + (z + 2.14) * sx;
  const yOf = (y: number) => 160 - y * sy;
  const belt: string[] = [];
  const roof: string[] = [];
  const sill: string[] = [];
  for (const z of zs) {
    const p = restSideProfile(z);
    belt.push(`${xOf(z).toFixed(1)},${yOf(p.yBelt).toFixed(1)}`);
    roof.push(`${xOf(z).toFixed(1)},${yOf(p.yRoof).toFixed(1)}`);
    sill.push(`${xOf(z).toFixed(1)},${yOf(p.ySideTop).toFixed(1)}`);
  }
  const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 180" width="920" height="360">
  <rect width="460" height="180" fill="#1b1e24"/>
  <polyline fill="none" stroke="#5ad" stroke-width="1.4" points="${roof.join(" ")}"/>
  <polyline fill="none" stroke="#ddd" stroke-width="2.2" points="${sill.join(" ")}"/>
  <polyline fill="none" stroke="#888" stroke-width="1" points="${belt.join(" ")}"/>
  <text x="12" y="18" fill="#aaa" font-size="11">rest side profile — white=body top, gray=belt, cyan=roof</text>
</svg>`;
  fs.mkdirSync("/workspace/artifacts", { recursive: true });
  fs.writeFileSync("/workspace/artifacts/rest-silhouette.svg", svg);
}

describe("rest pose is a sedan, not a van blob", () => {
  it("writes a side silhouette for visual check", () => {
    writeSilhouette();
    assert.ok(fs.existsSync("/workspace/artifacts/rest-silhouette.svg"));
  });

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

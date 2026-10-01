import * as THREE from "three";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DeformableCar, WHEEL_POS } from "./car.ts";
import { CAR_STYLES, CAR_STYLE_IDS, type BodyStyle, type CarStyleId } from "./car-variants.ts";
import { makeChassisGeometry, makeRearGlass, makeTrunkGeometry, makeWindshield } from "./car-mesh.ts";
import { fleetStyle } from "./fleet.ts";
import { StreamedDeformation } from "./streamed-deform.ts";

const PAINT = { body: 0xc5c8ce, accent: 0x9aa0a8, name: "Titanium" };
const scene = new THREE.Scene();
const cars: Record<CarStyleId, DeformableCar> = {
  sedan: new DeformableCar(PAINT, scene, null, "sedan"),
  hatchback: new DeformableCar(PAINT, scene, null, "hatchback"),
  wagon: new DeformableCar(PAINT, scene, null, "wagon"),
  coupe: new DeformableCar(PAINT, scene, null, "coupe"),
  pickup: new DeformableCar(PAINT, scene, null, "pickup"),
};

/** Highest visible surface at (x=0, z): roof, glass, deck or bed floor — never the debug rig. */
function topAt(id: CarStyleId, z: number): number {
  const c = cars[id];
  c.group.updateMatrixWorld(true);
  const meshes: THREE.Object3D[] = [];
  c.group.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.name === "deform-rig") return;
    meshes.push(o);
  });
  const hit = new THREE.Raycaster(new THREE.Vector3(0, 3, z), new THREE.Vector3(0, -1, 0)).intersectObjects(meshes, false)[0];
  assert.ok(hit, `${id}: nothing under z=${z}`);
  return hit.point.y;
}

function chassisBox(style: BodyStyle): THREE.Box3 {
  const geo = makeChassisGeometry(style);
  geo.computeBoundingBox();
  const b = geo.boundingBox!.clone();
  geo.dispose();
  return b;
}

/** Max |skinned − rest| of a panel skinned against an undeformed rig: >0 only where the cage clamps it. */
function panelClamp(deform: StreamedDeformation, geo: THREE.BufferGeometry, part: Parameters<StreamedDeformation["skinPanel"]>[2], origin: THREE.Vector3): number {
  const attr = geo.getAttribute("position") as THREE.BufferAttribute;
  const rest = new Float32Array(attr.array as Float32Array);
  deform.skinPanel(geo, rest, part, origin);
  let drift = 0;
  for (let i = 0; i < rest.length; i++) drift = Math.max(drift, Math.abs(attr.array[i]! - rest[i]!));
  return drift;
}

/** Roof-level body vertices are cage-skinned. An at-rest skin pass moves them only by the
 *  cage solve's own breathing (≈5 cm on the base sedan), never off the body. */
function roofSkinDrift(style: BodyStyle, rig = style.rig): number {
  const geo = makeChassisGeometry(style);
  const d = new StreamedDeformation(geo, rig);
  const attr = geo.getAttribute("position") as THREE.BufferAttribute;
  const rest = new Float32Array(attr.array as Float32Array);
  d.applyImpact(new THREE.Vector3(0, 0.4, 2), new THREE.Vector3(0, 0, -1), 4);
  d.update(1 / 60, geo);
  let drift = 0;
  for (let i = 0; i < attr.count; i++) {
    if (rest[i * 3 + 1]! < 1.0) continue;
    drift = Math.max(drift, Math.hypot(attr.getX(i) - rest[i * 3]!, attr.getY(i) - rest[i * 3 + 1]!, attr.getZ(i) - rest[i * 3 + 2]!));
  }
  geo.dispose();
  return drift;
}

describe("body styles share one platform", () => {
  const sedan = chassisBox(CAR_STYLES.sedan);

  for (const id of CAR_STYLE_IDS) {
    it(`good: ${id} keeps the sedan's wheels, width and length (±0.12 m)`, () => {
      cars[id].wheels.forEach((w, i) => assert.deepEqual(w.position.toArray(), WHEEL_POS[i]));
      const b = chassisBox(CAR_STYLES[id]);
      const len = b.max.z - b.min.z;
      assert.ok(Math.abs(len - (sedan.max.z - sedan.min.z)) <= 0.12, `${id} length ${len}`);
      assert.ok(Math.abs(b.max.x - sedan.max.x) < 0.03 && Math.abs(b.min.x - sedan.min.x) < 0.03, `${id} width ${b.min.x}..${b.max.x}`);
    });

    it(`good: ${id} keeps the sedan's collision hulls and mass rig`, () => {
      assert.deepEqual(cars[id].deform.liveHulls(), cars.sedan.deform.liveHulls());
      const rig = (c: DeformableCar) => c.deform.masses.map((m) => [m.name, m.mass, ...m.rest.toArray()]);
      assert.deepEqual(rig(cars[id]), rig(cars.sedan));
    });
  }

  it("good: a 10-car field shows every style, slot 0 stays the sedan", () => {
    const field = Array.from({ length: 10 }, (_, i) => fleetStyle(i));
    assert.equal(field[0], "sedan");
    assert.deepEqual([...new Set(field)].sort(), [...CAR_STYLE_IDS].sort());
  });
});

describe("each style reads as its own silhouette", () => {
  it("good: sedan is three-box — roof over the cabin, trunk deck behind the glass", () => {
    assert.ok(topAt("sedan", -0.2) > 1.25);
    assert.ok(topAt("sedan", -1.5) < 0.9, `sedan trunk ${topAt("sedan", -1.5)}`);
  });

  it("good: wagon roof runs past the sedan's toward the tail", () => {
    for (const z of [-1.2, -1.5]) assert.ok(topAt("wagon", z) > 1.2, `wagon roof at z=${z} is ${topAt("wagon", z)}`);
  });

  it("good: hatchback roof outruns the sedan's but its tail drops below the wagon's", () => {
    assert.ok(topAt("hatchback", -1.2) > 1.2, `hatch roof ${topAt("hatchback", -1.2)}`);
    assert.ok(topAt("sedan", -1.2) < 1.05, `sedan glass at z=-1.2 is ${topAt("sedan", -1.2)}`);
    assert.ok(topAt("hatchback", -1.75) < topAt("wagon", -1.75) - 0.2, "hatch tail is as tall as the wagon's");
  });

  it("good: coupe roof sits lower than the sedan's", () => {
    assert.ok(topAt("coupe", -0.2) < topAt("sedan", -0.2) - 0.06, `coupe ${topAt("coupe", -0.2)} sedan ${topAt("sedan", -0.2)}`);
  });

  it("good: pickup has a cab roof and an open bed below every other style's deck", () => {
    assert.ok(topAt("pickup", -0.2) > 1.25);
    for (const z of [-1.1, -1.7]) {
      assert.ok(topAt("pickup", z) < 0.6, `pickup bed floor at z=${z} is ${topAt("pickup", z)}`);
      for (const id of CAR_STYLE_IDS) if (id !== "pickup") assert.ok(topAt(id, z) > 0.78, `${id} deck at z=${z}`);
    }
  });
});

describe("rig cages wrap every style", () => {
  for (const id of CAR_STYLE_IDS) {
    const style = CAR_STYLES[id];

    it(`good: ${id} boot and glass sit inside their cages (no clamp at rest)`, () => {
      const d = new StreamedDeformation(makeChassisGeometry(style), style.rig);
      const [oy, oz] = style.boot.origin;
      assert.ok(panelClamp(d, makeTrunkGeometry(style), "boot", new THREE.Vector3(0, oy, oz)) < 1e-4, `${id} boot`);
      assert.ok(panelClamp(d, makeWindshield(style), "glassFront", new THREE.Vector3()) < 1e-4, `${id} windshield`);
      assert.ok(panelClamp(d, makeRearGlass(style), "glassRear", new THREE.Vector3()) < 1e-4, `${id} rear glass`);
    });

    it(`good: ${id} roof and pillars stay put through an at-rest skin pass`, () => {
      const drift = roofSkinDrift(style);
      assert.ok(drift < 0.1, `${id} roof-level skin drift ${drift.toFixed(3)} m`);
    });

    it(`edge: ${id} rear hit crushes the tail without exploding the skin`, () => {
      const c = new DeformableCar(PAINT, new THREE.Scene(), null, id);
      const d = c.deform;
      const geo = c.body.geometry;
      c.group.updateMatrixWorld();
      const vel = new THREE.Vector3(0, 0, -14);
      d.beginCrush(new THREE.Vector3(0, 0.36, -2.06), new THREE.Vector3(0, 0, 1), 14, c.group, vel, new THREE.Vector3());
      const rl = d.masses.find((m) => m.name === "bumperRL")!;
      const z0 = rl.local.z;
      for (let i = 0; i < 24; i++) {
        d.notifyContact();
        d.feedOverlap(rl.world, new THREE.Vector3(0, 0, 1), 0.1, 14, 1 / 60);
        d.stepStructure(1 / 60);
        d.followGroup(c.group, vel, new THREE.Vector3(), 1 / 60);
        d.update(1 / 60, geo);
      }
      assert.ok(rl.local.z - z0 > 0.05, `${id} tail did not crush ${z0} → ${rl.local.z}`);
      const a = geo.getAttribute("position").array as Float32Array;
      let r = 0;
      for (let i = 0; i < a.length; i += 3) {
        assert.ok(Number.isFinite(a[i]! + a[i + 1]! + a[i + 2]!), `${id} NaN vertex`);
        r = Math.max(r, Math.hypot(a[i]!, a[i + 1]!, a[i + 2]!));
      }
      assert.ok(r < 4.2, `${id} skin exploded, vertex radius ${r}`);
    });
  }

  it("bad: without rig overrides the hatch and wagon roofs are skinned off the body", () => {
    for (const id of ["hatchback", "wagon"] as const) {
      const drift = roofSkinDrift(CAR_STYLES[id], {});
      assert.ok(drift > 0.5, `${id} roof drift without overrides only ${drift.toFixed(3)} m`);
    }
  });
});

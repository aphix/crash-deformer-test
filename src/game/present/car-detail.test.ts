import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as THREE from "three";
import type { CarStyleId } from "../vehicle/car-variants.ts";
import { DeformableCar } from "../vehicle/car.ts";
import { paint } from "../vehicle/test-support.ts";
import { CarDetail, DETAIL_LEVELS, PHONE_LEVEL } from "./car-detail.ts";

/** A 50 degree lens at the origin looking down +z; cars stand on the axis at the given distance. */
function stage(fov = 50): { camera: THREE.PerspectiveCamera; detail: CarDetail; car(at: number, style?: CarStyleId): DeformableCar } {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(fov, 2, 0.1, 900);
  camera.lookAt(0, 0, 1);
  camera.updateMatrixWorld(true);
  return {
    camera,
    detail: new CarDetail(),
    car: (at, style = "sedan") => {
      const car = new DeformableCar(paint(), scene, null, style);
      car.spawn(0, at, 0);
      car.group.updateMatrixWorld(true);
      return car;
    },
  };
}

/** The meshes the camera would draw of the car's own group: on the camera's layers, no hidden ancestor (the rig overlay is hidden). */
function drawn(car: DeformableCar, camera: THREE.Camera): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  car.group.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh || !o.layers.test(camera.layers)) return;
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return;
    out.push(o as THREE.Mesh);
  });
  return out;
}

const casters = (meshes: readonly THREE.Mesh[]): number => meshes.filter((m) => m.castShadow).length;

describe("given a car and the farthest rung (small parts beyond 35 m, only the body beyond 75 m) on a 50 degree lens", () => {
  const cases: { at: number; what: "everything" | "its casters and fewer others" | "the body alone" }[] = [
    { at: 20, what: "everything" },
    { at: 34, what: "everything" },
    { at: 40, what: "its casters and fewer others" },
    { at: 70, what: "its casters and fewer others" },
    { at: 80, what: "the body alone" },
    { at: 250, what: "the body alone" },
  ];
  for (const c of cases) {
    test(`when it stands ${c.at} m away, then the camera draws ${c.what}`, () => {
      const { camera, detail, car } = stage();
      const full = drawn(car(1), camera);
      const probe = car(c.at);
      detail.update([probe], camera, null, null);
      const meshes = drawn(probe, camera);
      if (c.what === "everything") assert.equal(meshes.length, full.length);
      else if (c.what === "its casters and fewer others") {
        assert.equal(casters(meshes), casters(full));
        assert.ok(meshes.length < full.length, `${meshes.length} of ${full.length} meshes`);
      } else {
        assert.equal(meshes.length, 1);
        assert.equal(meshes[0], probe.body);
      }
    });
  }
});

describe("given a car 100 m away", () => {
  test("when it is the camera's car, or the replay's focus, then it keeps full detail while another car there does not", () => {
    const { camera, detail, car } = stage();
    const a = car(100);
    const b = car(100);
    const other = car(100);
    const full = drawn(car(1), camera).length;
    detail.update([a, b, other], camera, a, b);
    assert.equal(drawn(a, camera).length, full);
    assert.equal(drawn(b, camera).length, full);
    assert.equal(drawn(other, camera).length, 1);
  });

  test("when the lens narrows to 25 degrees (a zoom), then the car counts as 55 m away: the near cut and not the far one", () => {
    const { camera, detail, car } = stage(25);
    const probe = car(120);
    const full = drawn(car(1), camera);
    detail.update([probe], camera, null, null);
    const meshes = drawn(probe, camera);
    assert.equal(casters(meshes), casters(full), "every caster still drawn");
    assert.ok(meshes.length < full.length, "small parts out");
  });

  test("when it is a wreck (a hood torn off, a door folding), then the far cut takes it too: the body alone, while the torn hood flies in view", () => {
    const { camera, detail, car } = stage();
    const probe = car(100);
    const hood = probe["parts"].find((p) => p.name === "hood")!;
    probe["detachPart"](hood, 10);
    probe["parts"].find((p) => p.name === "doorL")!.folding = true;
    detail.update([probe], camera, null, null);
    const meshes = drawn(probe, camera);
    assert.equal(meshes.length, 1);
    assert.equal(meshes[0], probe.body);
    let loose = 0;
    hood.object.traverse((o) => void ((o as THREE.Mesh).isMesh && o.layers.test(camera.layers) && loose++));
    assert.ok(loose >= 1, "the loose hood is not the car's mesh: it keeps drawing");
  });

  test("when a hood tears off a car already in the far cut, then its meshes are drawn on that same frame, flying in view", () => {
    const { camera, detail, car } = stage();
    const probe = car(100);
    detail.update([probe], camera, null, null);
    const hood = probe["parts"].find((p) => p.name === "hood")!;
    const visible = (): number => {
      let n = 0;
      hood.object.traverse((o) => void ((o as THREE.Mesh).isMesh && o.layers.test(camera.layers) && n++));
      return n;
    };
    assert.equal(visible(), 0, "a whole hood is not drawn at 100 m");
    probe["detachPart"](hood, 10);
    assert.ok(visible() >= 1, "the torn hood is the world's: drawn at once, before the next update");
    detail.update([probe], camera, null, null);
    assert.ok(visible() >= 1, "and the next update leaves it be");
    assert.equal(drawn(probe, camera).length, 1, "the car itself stays the body alone");
  });

  test("when it is a police car, then the light bar stays drawn with the body", () => {
    const { camera, detail, car } = stage();
    const probe = car(100, "police");
    detail.update([probe], camera, null, null);
    const names = drawn(probe, camera).map((m) => m.name);
    assert.equal(names.length, 2);
    assert.ok(names.includes("lightBar"));
  });
});

describe("given a car that crosses the far distance", () => {
  test("when it approaches from 80 m, then it is whole again at 69 m (92 % of 75), not before; and it goes far again only past 75 m", () => {
    const { camera, detail, car } = stage();
    const probe = car(80);
    const isFar = (): boolean => drawn(probe, camera).length === 1;
    const stepTo = (at: number): boolean => {
      probe.group.position.z = at;
      probe.group.updateMatrixWorld(true);
      detail.update([probe], camera, null, null);
      return isFar();
    };
    assert.equal(stepTo(80), true);
    assert.equal(stepTo(72), true, "inside 75 m but not yet inside 69 m");
    assert.equal(stepTo(68), false, "inside 69 m: the small parts are still out (mid cut) but the body is not alone");
    assert.equal(stepTo(74), false, "75 m not yet crossed again");
    assert.equal(stepTo(76), true);
  });

  test("when it has been far and comes back to 10 m, then every mesh it had is drawn again", () => {
    const { camera, detail, car } = stage();
    const probe = car(1);
    const full = drawn(probe, camera).length;
    probe.group.position.z = 150;
    detail.update([probe], camera, null, null);
    assert.equal(drawn(probe, camera).length, 1);
    probe.group.position.z = 10;
    detail.update([probe], camera, null, null);
    assert.equal(drawn(probe, camera).length, full);
  });

  test("when it comes from the far cut to between the two, then the small parts stay out and the rest returns: 40 m draws the same meshes whether it arrived from 150 m or from 20 m", () => {
    const { camera, detail, car } = stage();
    const fromFar = car(150);
    const fromNear = car(20);
    detail.update([fromFar, fromNear], camera, null, null);
    for (const probe of [fromFar, fromNear]) probe.group.position.z = 40;
    fromFar.group.updateMatrixWorld(true);
    fromNear.group.updateMatrixWorld(true);
    detail.update([fromFar, fromNear], camera, null, null);
    const arrived = drawn(fromFar, camera).length;
    assert.equal(arrived, drawn(fromNear, camera).length);
    assert.ok(arrived > 1, "more than the body");
  });
});

describe("given the detail ladder", () => {
  test("when the rungs are read, then each is nearer than the one before and its small-parts distance is inside its far distance", () => {
    for (let i = 0; i < DETAIL_LEVELS.length; i++) {
      const l = DETAIL_LEVELS[i]!;
      assert.ok(l.mid < l.far, `rung ${i}`);
      if (i > 0) {
        assert.ok(l.mid < DETAIL_LEVELS[i - 1]!.mid, `rung ${i} small parts nearer`);
        assert.ok(l.far < DETAIL_LEVELS[i - 1]!.far, `rung ${i} far nearer`);
      }
    }
    assert.ok(PHONE_LEVEL >= 0 && PHONE_LEVEL < DETAIL_LEVELS.length);
    assert.equal(DETAIL_LEVELS[0]!.far, 75);
  });

  test("when the phone's rung is in force, then a car 55 m away draws the body alone and one 45 m away does not; and with no cuts at all, a car 500 m away is whole", () => {
    const { camera, car } = stage();
    const detail = new CarDetail(PHONE_LEVEL);
    assert.equal(detail.level, PHONE_LEVEL);
    const far = car(55);
    const mid = car(45);
    detail.update([far, mid], camera, null, null);
    assert.equal(drawn(far, camera).length, 1);
    assert.ok(drawn(mid, camera).length > 1);
    detail.setDistances(Infinity, Infinity);
    assert.equal(detail.level, -1);
    detail.update([far, mid], camera, null, null);
    const full = drawn(car(1), camera).length;
    assert.equal(drawn(far, camera).length, full);
    assert.equal(drawn(mid, camera).length, full);
    detail.setLevel(99);
    assert.equal(detail.level, DETAIL_LEVELS.length - 1);
  });
});

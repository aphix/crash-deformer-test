import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as THREE from "three";
import { CarDetail, DETAIL_LEVELS } from "../present/car-detail.ts";
import { DeformableCar } from "./car.ts";
import { assertSameNumbers, paint } from "./test-support.ts";
import { WheelBatch } from "./wheel-batch.ts";

/** The instance matrix is float32: a wheel's position of a few hundred metres is stored within 1e-4 m. */
const FLOAT32_SLACK = 1e-4;
const FAR_BEYOND = DETAIL_LEVELS[0]!.far;

/** A 50 degree lens at the origin looking down +z; cars stand on the axis at the given distance. */
function stage() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 2, 0.1, 900);
  camera.lookAt(0, 0, 1);
  camera.updateMatrixWorld(true);
  const detail = new CarDetail();
  const batch = new WheelBatch(16);
  const car = (at: number) => {
    const made = new DeformableCar(paint(), scene, null, "sedan");
    made.spawn(0, at, 0);
    made.group.updateMatrixWorld(true);
    return made;
  };
  const draw = (cars: DeformableCar[]) => {
    detail.update(cars, camera, null, null);
    for (const c of cars) c.group.updateMatrixWorld(true);
    batch.sync(cars, (c) => detail.isFar(c));
  };
  return { batch, car, draw };
}

const triangles = (mesh: THREE.Mesh): number => mesh.geometry.index!.count / 3;

describe("given the wheel batch and cars at two distances from the camera", () => {
  test("when a car is inside the farthest rung's distance and another beyond it, then the near car's four wheels take the full wheel and the far car's four the far wheel", () => {
    const { batch, car, draw } = stage();
    const cars = [car(10), car(FAR_BEYOND + 20)];
    draw(cars);
    const [full, far] = batch.meshes as [THREE.InstancedMesh, THREE.InstancedMesh];
    assert.equal(full.count, 4);
    assert.equal(far.count, 4);
    const matrix = new THREE.Matrix4();
    far.getMatrixAt(0, matrix);
    assertSameNumbers(matrix.elements, cars[1]!.wheels[0]!.matrixWorld.elements, "the far wheel stands where the car's wheel group does", FLOAT32_SLACK);
  });

  test("when the far car comes back inside the distance, then all eight wheels are full wheels", () => {
    const { batch, car, draw } = stage();
    const cars = [car(10), car(FAR_BEYOND + 20)];
    draw(cars);
    cars[1]!.group.position.z = 12;
    draw(cars);
    assert.equal(batch.meshes[0]!.count, 8);
    assert.equal(batch.meshes[1]!.count, 0);
  });

  test("when the two wheel shapes are compared, then the far wheel has at most a fifth of the full wheel's triangles and the same attributes", () => {
    const { batch } = stage();
    const [full, far] = batch.meshes as [THREE.InstancedMesh, THREE.InstancedMesh];
    assert.ok(triangles(far) * 5 <= triangles(full), `${triangles(far)} of ${triangles(full)}`);
    assert.deepEqual(Object.keys(far.geometry.attributes).sort(), Object.keys(full.geometry.attributes).sort());
  });
});

describe("given the wheel batch attached to a renderer's shadow pass", () => {
  const attached = () => {
    const made = stage();
    const seen: boolean[] = [];
    const shadow = made.batch.meshes[2]!;
    const renderer: Parameters<WheelBatch["attach"]>[0] = { shadowMap: { render: () => void seen.push(shadow.visible) } };
    made.batch.attach(renderer);
    return { ...made, renderer, seen, shadow };
  };

  test("when the shadow pass runs, then the prisms are shown during it and hidden before and after, and the two wheel draws cast nothing", () => {
    const { batch, renderer, seen, shadow } = attached();
    assert.equal(shadow.visible, false, "hidden while the main pass builds its list");
    renderer.shadowMap.render([], new THREE.Scene(), new THREE.PerspectiveCamera());
    assert.deepEqual(seen, [true], "visible inside the pass");
    assert.equal(shadow.visible, false, "hidden again once the pass is done");
    assert.equal(shadow.castShadow, true);
    assert.deepEqual(
      batch.meshes.slice(0, 2).map((m) => m.castShadow),
      [false, false],
    );
  });

  test("when a near car and a far car are drawn, then one prism stands at each of the eight wheels and each prism is at most a tenth of a full wheel's triangles", () => {
    const { batch, car, draw, shadow } = attached();
    draw([car(10), car(FAR_BEYOND + 20)]);
    assert.equal(shadow.count, 8);
    assert.ok(triangles(shadow) * 10 <= triangles(batch.meshes[0] as THREE.InstancedMesh), `${triangles(shadow)} of ${triangles(batch.meshes[0] as THREE.InstancedMesh)}`);
  });

  test("when the batch is disposed, then the renderer's own shadow pass is back", () => {
    const { batch, renderer, seen } = attached();
    batch.dispose();
    renderer.shadowMap.render([], new THREE.Scene(), new THREE.PerspectiveCamera());
    assert.deepEqual(seen, [false]);
  });
});

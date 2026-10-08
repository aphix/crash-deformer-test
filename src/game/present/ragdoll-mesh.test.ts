import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { assertSameNumbers } from "../vehicle/test-support.ts";
import { driverLook, JEANS, type DriverLook } from "./driver-look.ts";
import { DummyMesh } from "./ragdoll-mesh.ts";
import { PARTS } from "./ragdoll-body.ts";

const MAN: DriverLook = { woman: false, shirt: 0xc0392b, pants: JEANS, hair: 0x18120f, hat: null, mustache: false };
const WOMAN: DriverLook = { woman: true, shirt: 0x2a9d8f, pants: JEANS, hair: 0xd2b062, hat: null, mustache: false };
const NAVY = new THREE.Color(0x1b2a4a);

/** Slot 0's pieces as (colour, x-size) rows after posing the whole standing dummy; hidden pieces (zero scale) leave out. */
function drawn(look: DriverLook, cop: boolean): { color: THREE.Color; size: THREE.Vector3; at: THREE.Vector3 }[] {
  const mesh = new DummyMesh(1);
  mesh.dress(0, cop, look);
  const q = new THREE.Quaternion();
  for (const [k, p] of PARTS.entries()) mesh.pose(0, k, new THREE.Vector3(p.c[0], p.c[1], p.c[2]), q);
  const rows: { color: THREE.Color; size: THREE.Vector3; at: THREE.Vector3 }[] = [];
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const rot = new THREE.Quaternion();
  const size = new THREE.Vector3();
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m);
    if (m.determinant() === 0) continue;
    m.decompose(pos, rot, size);
    const color = new THREE.Color();
    mesh.getColorAt(i, color);
    rows.push({ color, size: size.clone(), at: pos.clone() });
  }
  return rows;
}
const has = (rows: { color: THREE.Color }[], hex: number) => rows.some((r) => r.color.getHex() === new THREE.Color(hex).getHex());

describe("given the crash-test dummies drawn for thrown drivers", () => {
  it("when a civilian man is dressed, then he wears his own shirt and hair colours and nothing of the default charcoal shirt", () => {
    const rows = drawn(MAN, false);
    assert.ok(has(rows, MAN.shirt) && has(rows, MAN.hair));
    assert.ok(!has(rows, 0x2b2d32), "the old charcoal tee is gone");
  });

  it("when a cop is dressed, then he keeps the navy uniform whatever the random look; only his hair colour varies, and no civilian shirt appears", () => {
    const rows = drawn(MAN, true);
    assert.ok(rows.some((r) => r.color.getHex() === NAVY.getHex()), "navy shirt");
    assert.ok(!has(rows, MAN.shirt), "no civilian tee on a cop");
    assert.ok(has(rows, MAN.hair), "the hair under the cap is the driver's");
  });

  it("when a woman is dressed against a man, then she has narrower shoulders, long hair reaching further down her back, her own shirt and hair colours and a different set of pieces", () => {
    const man = drawn(MAN, false);
    const woman = drawn(WOMAN, false);
    assert.ok(has(woman, WOMAN.shirt) && has(woman, WOMAN.hair));
    const chest = (rows: typeof man, look: DriverLook) => Math.max(...rows.filter((r) => r.color.getHex() === new THREE.Color(look.shirt).getHex() && r.size.y > 0.35).map((r) => r.size.x));
    assert.ok(chest(woman, WOMAN) < chest(man, MAN) - 0.04, `chest ${chest(woman, WOMAN).toFixed(2)} m against ${chest(man, MAN).toFixed(2)} m`);
    // Hair pieces (her colour): how far down below the head her hair reaches.
    const lowest = (rows: typeof man, look: DriverLook) => Math.min(...rows.filter((r) => r.color.getHex() === new THREE.Color(look.hair).getHex()).map((r) => r.at.y));
    const manLow = lowest(man, MAN);
    const womanLow = lowest(woman, WOMAN);
    assert.ok(womanLow < manLow - 0.1, `her hair reaches ${womanLow.toFixed(2)} m, his ${manLow.toFixed(2)} m`);
    assert.notEqual(man.length, woman.length, "a different set of pieces");
  });

  it("when a driver picks trousers, a cap and a moustache, then his legs wear the trousers' colour, his crown the cap's, and his face gains one piece in his hair's colour", () => {
    const plain = drawn(MAN, false);
    const capped = drawn({ ...MAN, pants: 0x123456, hat: 0xee2211 }, false);
    const picked = drawn({ ...MAN, pants: 0x123456, hat: 0xee2211, mustache: true }, false);
    assert.ok(has(picked, 0x123456) && !has(plain, 0x123456), "the trousers' colour");
    assert.ok(has(picked, 0xee2211) && !has(plain, 0xee2211), "the cap's colour");
    const hairOnFace = (rows: typeof plain) => rows.filter((r) => r.color.getHex() === new THREE.Color(MAN.hair).getHex() && r.at.z > 0.08).length;
    assert.equal(hairOnFace(picked), hairOnFace(capped) + 1, "one moustache piece in front of his face");
  });

  it("when a field of 8 drivers is dressed, then at least 6 of them look different, and dressing the same drivers again leaves every slot's colours unchanged", () => {
    const mesh = new DummyMesh(8);
    const per = mesh.instanceColor!.array.length / 8;
    const cols = (s: number) => Array.from(mesh.instanceColor!.array.slice(s * per, (s + 1) * per)).join();
    for (let s = 0; s < 8; s++) mesh.dress(s, false, driverLook(5, s));
    const before = Float32Array.from(mesh.instanceColor!.array);
    assert.ok(new Set(Array.from({ length: 8 }, (_, s) => cols(s))).size >= 6, "8 drivers, at least 6 distinct dress");
    for (let s = 0; s < 8; s++) mesh.dress(s, false, driverLook(5, s));
    assertSameNumbers(mesh.instanceColor!.array, before, "the same drivers dressed again");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { driverLook, JEANS, type DriverLook } from "./driver-look.ts";
import { DummyMesh } from "./ragdoll-mesh.ts";
import { JOINTS, PARTS } from "./ragdoll-body.ts";
import { BODY_VERTICES, bodyIndex } from "./dummy-bodies.ts";
import { BONES_ATTRIBUTE, BUILD, FLAGS_AT, KINDS_ATTRIBUTE, restFits, ROLE, ROLES, skinPoint, WHISKERS } from "./dummy-skin.ts";

/**
 * The steepest each `JOINTS` row's blend weight may climb per metre, restated from the band widths of dummy-skin.ts (neck
 * 1.40..1.48 m slanted 1.2 per metre of |x|; shoulder 0.20 m along the arm by 0.08 m across it; elbow and knee +-0.05 m; hip
 * 0.92..0.76 m with the crotch lifted 0.06 m over 0.10 m of |x|). A smoothstep over a width climbs at most 1.5 / width, a
 * smoothstep of a coordinate that itself moves at most k per metre at most 1.5 k / width, and the product of two orthogonal ones at
 * most the hypotenuse of their slopes. A fit whose weights climb faster than its declared bands is what a hard seam is.
 */
const SMOOTHSTEP_SLOPE = 1.5;
const SLOPE_NECK = (SMOOTHSTEP_SLOPE / 0.08) * Math.hypot(1, 1.2);
const SLOPE_SHOULDER = Math.hypot(SMOOTHSTEP_SLOPE / 0.2, SMOOTHSTEP_SLOPE / 0.08);
const SLOPE_ELBOW_OR_KNEE = SMOOTHSTEP_SLOPE / 0.1;
const SLOPE_HIP = (SMOOTHSTEP_SLOPE / 0.16) * Math.hypot(1, (0.06 * SMOOTHSTEP_SLOPE) / 0.1);
const JOINT_SLOPE = [SLOPE_NECK, SLOPE_SHOULDER, SLOPE_ELBOW_OR_KNEE, SLOPE_SHOULDER, SLOPE_ELBOW_OR_KNEE, SLOPE_HIP, SLOPE_ELBOW_OR_KNEE, SLOPE_HIP, SLOPE_ELBOW_OR_KNEE] as const;

const MAN: DriverLook = { woman: false, shirt: 0xc0392b, pants: JEANS, hair: 0x18120f, hat: null, mustache: false };
const WOMAN: DriverLook = { woman: true, shirt: 0x2a9d8f, pants: JEANS, hair: 0xd2b062, hat: null, mustache: false };
const NAVY = new THREE.Color(0x1b2a4a);
const BUILDS = [
  { name: "man", look: MAN },
  { name: "woman", look: WOMAN },
  { name: "portly man", look: { ...MAN, portly: true } },
] as const;

/**
 * How well a fitted body sits on the rig (m): its crown within `HEIGHT_BOUND` of the head top; each limb's axis (the mean x and
 * z of its rigid vertices) within `PIVOT_BOUND` of its joint, and each blend's half-weight height within `PIVOT_BOUND_Y` of the
 * joint (the portly man's broad hip and elbow bands lie 0.03 m off, the slender ones within 0.015 m).
 */
const HEIGHT_BOUND = 0.01;
const PIVOT_BOUND = 0.02;
const PIVOT_BOUND_Y = 0.04;
/**
 * A fitted rest edge is at most `REST_RATIO` times its T-pose length and `REST_GROW` m longer: a bend about a pivot keeps
 * lengths, so only the weight bands across an edge may stretch it (a baked edge is up to 6.7 cm across a shoulder, and the
 * widest band's stretch is 4.5 cm); the old fit's sheets from shoulder to hip were 3 to 9 times and 0.1 m and more.
 */
const REST_RATIO = 3;
const REST_GROW = 0.05;
/**
 * A limb vertex (not a blend with the torso, whose bulk is the deltoid's and the buttock's, nor a foot, a wedge ahead of the
 * shin) stands within its rig part's box grown by this skin margin (m): the portly man's thigh and arm are the thickest, 0.04 m
 * out of the box; the hand's fingertips on the slender builds are 0.05 m under the forearm box's end.
 */
const LIMB_MARGIN = 0.05;

type PartPose = { p: THREE.Vector3; q: THREE.Quaternion };
/** The part's centre standing. */
const centre = (k: number) => new THREE.Vector3(...PARTS[k]!.c);
const turn = (axis: "x" | "y" | "z", degrees: number) =>
  new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0), (degrees * Math.PI) / 180);

/** The ten parts with part `k` swung by `turns[k]` about its joint to its parent, parents first: the joints stay closed, as Rapier's do. */
function posture(turns: Partial<Record<number, THREE.Quaternion>>): PartPose[] {
  const poses = PARTS.map((_, k) => ({ p: centre(k), q: new THREE.Quaternion() }));
  for (let k = 1; k < PARTS.length; k++) {
    const [parent, , jx, jy, jz] = JOINTS.find((j) => j[1] === k)!;
    const joint = new THREE.Vector3(jx, jy, jz);
    const above = poses[parent]!;
    const jointNow = joint.clone().sub(centre(parent)).applyQuaternion(above.q).add(above.p);
    poses[k]!.q.copy(above.q).multiply(turns[k] ?? new THREE.Quaternion());
    poses[k]!.p.copy(centre(k)).sub(joint).applyQuaternion(poses[k]!.q).add(jointNow);
  }
  return poses;
}

function show(mesh: DummyMesh, poses: readonly PartPose[]): void {
  for (const [k, pose] of poses.entries()) mesh.pose(0, k, pose.p, pose.q);
}

type Drawn = { role: number; hex: number; at: THREE.Vector3; bones: [number, number] };

/** Slot 0's drawn vertices after posing the whole standing dummy (the ones its build leaves out are not in the list). */
function drawn(look: DriverLook, cop: boolean): Drawn[] {
  const mesh = new DummyMesh(1);
  mesh.dress(0, cop, look);
  show(mesh, posture({}));
  const roles = mesh.geometry.getAttribute(KINDS_ATTRIBUTE);
  const bones = mesh.geometry.getAttribute(BONES_ATTRIBUTE);
  const rows: Drawn[] = [];
  for (let i = 0; i < roles.count; i++) {
    const at = new THREE.Vector3();
    if (!mesh.posed(0, i, at)) continue;
    const role = roles.getX(i);
    rows.push({ role, hex: mesh.colourOf(0, role, new THREE.Color()).getHex(), at, bones: [bones.getX(i), bones.getY(i)] });
  }
  return rows;
}
/** The rest position the slot's build draws. `posed` skins this, not the man attribute, for a woman or a portly man. */
function restShape(mesh: DummyMesh): THREE.BufferAttribute | THREE.InterleavedBufferAttribute {
  const flags = mesh["rows"][FLAGS_AT * 4]!;
  const name = (flags & BUILD.WOMAN) !== 0 ? "shapeWoman" : (flags & BUILD.PORTLY) !== 0 ? "shapePortly" : "position";
  return mesh.geometry.getAttribute(name);
}

/** The fitted body (`restFits`: its scaled T-pose among other things) the slot's build draws. */
function fitOf(mesh: DummyMesh) {
  const flags = mesh["rows"][FLAGS_AT * 4]!;
  const fits = restFits();
  return (flags & BUILD.WOMAN) !== 0 ? fits.woman : (flags & BUILD.PORTLY) !== 0 ? fits.portly : fits.man;
}

const hexOf = (hex: number) => new THREE.Color(hex).getHex();
const has = (rows: Drawn[], hex: number) => rows.some((r) => r.hex === hexOf(hex));
const ofRole = (rows: Drawn[], role: number) => rows.filter((r) => r.role === role);
/** The jacket's torso vertices between heights `low` and `high` (rigid on the torso: the sleeves' rings on the shoulder bands are not). */
const torsoShirt = (rows: Drawn[], low: number, high: number) => ofRole(rows, ROLE.SHIRT).filter((r) => r.bones[0] === 0 && r.bones[1] === 0 && r.at.y > low && r.at.y < high);

describe("given the crash-test dummies drawn for thrown drivers", () => {
  it("when a civilian man is dressed, then he wears his own shirt and hair colours and nothing of the default charcoal shirt", () => {
    const rows = drawn(MAN, false);
    assert.ok(has(rows, MAN.shirt) && has(rows, MAN.hair));
    assert.ok(!has(rows, 0x2b2d32), "the old charcoal tee is gone");
  });

  it("when a cop is dressed, then he keeps the navy uniform whatever the random look; only his hair colour varies, and no civilian shirt appears", () => {
    const rows = drawn(MAN, true);
    assert.ok(rows.some((r) => r.hex === NAVY.getHex()), "navy shirt");
    assert.ok(!has(rows, MAN.shirt), "no civilian tee on a cop");
    assert.ok(has(rows, MAN.hair), "the hair under the cap is the driver's");
  });

  it("when a woman is dressed against a man, then she has narrower shoulders, long hair reaching further down her back, her own shirt and hair colours and a different body", () => {
    const man = drawn(MAN, false);
    const woman = drawn(WOMAN, false);
    assert.ok(has(woman, WOMAN.shirt) && has(woman, WOMAN.hair));
    const chest = (rows: Drawn[]) => Math.max(...torsoShirt(rows, 1.15, 1.33).map((r) => Math.abs(r.at.x)));
    assert.ok(chest(woman) < chest(man) * 0.9, `chest half width ${chest(woman).toFixed(3)} m against ${chest(man).toFixed(3)} m`);
    const hairBottom = (rows: Drawn[]) => Math.min(...[...ofRole(rows, ROLE.HAIR), ...ofRole(rows, ROLE.LOCKS)].map((r) => r.at.y));
    assert.ok(hairBottom(woman) < hairBottom(man) - 0.1, `her hair reaches ${hairBottom(woman).toFixed(2)} m, his ${hairBottom(man).toFixed(2)} m`);
    assert.notEqual(man.length, woman.length, "a different body");
  });

  it("when a portly man in a suit is dressed against a plain man, then he is broader through the chest and belly, wears a red tie and a white collar, and has fuller hair over his crown", () => {
    const suit = { ...MAN, shirt: 0x1f3463, pants: 0x1f3463, hair: 0xe8bf6c };
    const plain = drawn(suit, false);
    const portly = drawn({ ...suit, portly: true }, false);
    const section = (rows: Drawn[]) => {
      const belly = torsoShirt(rows, 0.97, 1.3);
      const [x, z] = [belly.map((r) => r.at.x), belly.map((r) => r.at.z)];
      return (Math.max(...x) - Math.min(...x)) * (Math.max(...z) - Math.min(...z));
    };
    assert.ok(section(portly) > section(plain) * 1.3, `torso section ${section(portly).toFixed(3)} m² against ${section(plain).toFixed(3)} m²`);
    assert.ok(has(portly, 0xb3202a) && !has(plain, 0xb3202a), "a red tie");
    assert.ok(has(portly, 0xf4f4f1) && !has(plain, 0xf4f4f1), "a white collar");
    const hairWidth = (rows: Drawn[]) => Math.max(...ofRole(rows, ROLE.HAIR).map((r) => Math.abs(r.at.x)));
    assert.ok(hairWidth(portly) > hairWidth(plain) + 0.01, `${hairWidth(portly).toFixed(3)} m across the hair against ${hairWidth(plain).toFixed(3)} m`);
  });

  it("when a driver picks trousers, a cap and a moustache, then his legs wear the trousers' colour, his crown the cap's, and his face gains a moustache in his hair's colour", () => {
    const plain = drawn(MAN, false);
    const capped = drawn({ ...MAN, pants: 0x123456, hat: 0xee2211 }, false);
    const picked = drawn({ ...MAN, pants: 0x123456, hat: 0xee2211, mustache: true }, false);
    assert.ok(has(picked, 0x123456) && !has(plain, 0x123456), "the trousers' colour");
    assert.ok(has(picked, 0xee2211) && !has(plain, 0xee2211), "the cap's colour");
    const moustache = (rows: Drawn[]) => ofRole(rows, ROLE.MUSTACHE);
    assert.equal(moustache(capped).length, 0, "no moustache unless he wears one");
    assert.ok(moustache(picked).length > 0, "his moustache is drawn");
    assert.ok(moustache(picked).every((r) => r.at.z > 0.08 && r.at.y > 1.52 && r.at.y < 1.62), "on his upper lip, in front of his face");
    assert.equal(has(picked, MAN.hair), true);
  });

  it("when a field of 8 drivers is dressed, then at least 6 of them look different, and dressing the same drivers again leaves every slot's colours unchanged", () => {
    const mesh = new DummyMesh(8);
    const dress = (s: number) => {
      const colour = new THREE.Color();
      return Array.from({ length: ROLES }, (_, role) => mesh.colourOf(s, role, colour).getHex()).join();
    };
    for (let s = 0; s < 8; s++) mesh.dress(s, false, driverLook(5, s));
    const before = Array.from({ length: 8 }, (_, s) => dress(s));
    assert.ok(new Set(before).size >= 6, "8 drivers, at least 6 distinct dress");
    for (let s = 0; s < 8; s++) mesh.dress(s, false, driverLook(5, s));
    assert.equal(Array.from({ length: 8 }, (_, s) => dress(s)).join("|"), before.join("|"), "the same drivers dressed again");
  });

  it("when a dummy is posed and hidden, then the draw ends after the highest slot with a dummy out, and the one body is a single instance per slot", () => {
    const mesh = new DummyMesh(8);
    assert.equal(mesh.count, 0, "nothing out, nothing drawn");
    show(mesh, posture({}));
    assert.equal(mesh.count, 1, "slot 0 out");
    mesh.pose(5, 0, centre(0), new THREE.Quaternion());
    assert.equal(mesh.count, 6, "slot 5 out ends the draw after it");
    mesh.hide(5);
    assert.equal(mesh.count, 1, "slot 5 gone, the draw ends after slot 0 again");
    mesh.hide(0);
    assert.equal(mesh.count, 0);
  });

  it("when the body's triangles are counted, then the baked lores body is all there and the wear on top stays under 12k", () => {
    const mesh = new DummyMesh(1);
    const triangles = mesh.geometry.index!.count / 3;
    assert.ok(triangles >= 8040, `${triangles} triangles, the 8040-triangle body is missing`);
    assert.ok(triangles <= 12000, `${triangles} triangles`);
  });

  it("when each build stands, then its height and joints sit on the rig", () => {
    const top = PARTS[1]!.c[1] + PARTS[1]!.h[1];
    /** Each limb's joint (a `JOINTS` row), its part, and the heights (m) over which that part is rigid on its bone: the limb's axis there is the joint's x and z. */
    const limbs = [
      { name: "left shoulder", joint: 1, part: 2, from: 1.12, to: 1.26 },
      { name: "left elbow", joint: 2, part: 3, from: 0.85, to: 1.0 },
      { name: "right shoulder", joint: 3, part: 4, from: 1.12, to: 1.26 },
      { name: "right elbow", joint: 4, part: 5, from: 0.85, to: 1.0 },
      { name: "left hip", joint: 5, part: 6, from: 0.5, to: 0.74 },
      { name: "left knee", joint: 6, part: 7, from: 0.15, to: 0.36 },
      { name: "right hip", joint: 7, part: 8, from: 0.5, to: 0.74 },
      { name: "right knee", joint: 8, part: 9, from: 0.15, to: 0.36 },
    ];
    /** Where each blend between two bones is at half weight: the joint's own height (an elbow, a knee, a hip, a shoulder). The hip's is measured outboard of 0.1 m: the crotch's centre vertices are lifted 0.06 m into the torso's side on purpose. */
    const bands = [
      { name: "elbow", joint: 4, a: 4, b: 5, outboard: 0 },
      { name: "knee", joint: 8, a: 8, b: 9, outboard: 0 },
      { name: "hip", joint: 7, a: 0, b: 8, outboard: 0.1 },
      { name: "shoulder", joint: 3, a: 0, b: 4, outboard: 0 },
    ];
    for (const build of BUILDS) {
      const mesh = new DummyMesh(1);
      mesh.dress(0, false, build.look);
      const [rest, skin] = [restShape(mesh), mesh.geometry.getAttribute(BONES_ATTRIBUTE)];
      let height = 0;
      for (let i = 0; i < BODY_VERTICES; i++) height = Math.max(height, rest.getY(i));
      assert.ok(Math.abs(height - top) < HEIGHT_BOUND, `${build.name} is ${height.toFixed(3)} m, the rig top is ${top}`);
      for (const limb of limbs) {
        const [, , jx, , jz] = JOINTS[limb.joint]!;
        const sum = new THREE.Vector3();
        let n = 0;
        for (let i = 0; i < BODY_VERTICES; i++) {
          if (skin.getX(i) !== limb.part || skin.getY(i) !== limb.part || rest.getY(i) < limb.from || rest.getY(i) > limb.to) continue;
          sum.add(new THREE.Vector3(rest.getX(i), 0, rest.getZ(i)));
          n++;
        }
        assert.ok(n > 20, `${build.name} ${limb.name}: ${n} rigid vertices on part ${limb.part}`);
        assert.ok(Math.abs(sum.x / n - jx) < PIVOT_BOUND && Math.abs(sum.z / n - jz) < PIVOT_BOUND, `${build.name} ${limb.name}: the limb's axis is at x ${(sum.x / n).toFixed(3)}, z ${(sum.z / n).toFixed(3)}, the rig's joint at ${jx}, ${jz}`);
      }
      for (const band of bands) {
        const jy = JOINTS[band.joint]![3];
        let [n, sum] = [0, 0];
        for (let i = 0; i < BODY_VERTICES; i++) {
          if (skin.getX(i) !== band.a || skin.getY(i) !== band.b || Math.abs(skin.getZ(i) - 0.5) > 0.2 || Math.abs(rest.getX(i)) < band.outboard) continue;
          sum += rest.getY(i);
          n++;
        }
        assert.ok(n >= 6, `${build.name} ${band.name}: ${n} vertices within 0.2 of half weight`);
        assert.ok(Math.abs(sum / n - jy) < PIVOT_BOUND_Y, `${build.name} ${band.name}: the blend is at half weight at y ${(sum / n).toFixed(3)}, the rig's joint at ${jy}`);
      }
    }
  });

  for (const build of BUILDS) {
    it(`when the ${build.name} is fitted to the rig, then no rest edge is more than ${REST_RATIO}x its T-pose length or ${REST_GROW} m longer (no sheet hangs from a shoulder or a forearm)`, () => {
      const mesh = new DummyMesh(1);
      mesh.dress(0, false, build.look);
      const [rest, tpose, index] = [restShape(mesh), fitOf(mesh).tpose, bodyIndex()];
      let [sheet, grown, checked] = ["", 0, 0];
      for (let t = 0; t < index.length; t++) {
        const [i, j] = [index[t]!, index[t % 3 === 2 ? t - 2 : t + 1]!];
        const standing = Math.hypot(tpose[i * 3]! - tpose[j * 3]!, tpose[i * 3 + 1]! - tpose[j * 3 + 1]!, tpose[i * 3 + 2]! - tpose[j * 3 + 2]!);
        const fitted = Math.hypot(rest.getX(i) - rest.getX(j), rest.getY(i) - rest.getY(j), rest.getZ(i) - rest.getZ(j));
        checked++;
        if ((fitted > REST_RATIO * standing || fitted - standing > REST_GROW) && fitted - standing > grown) {
          grown = fitted - standing;
          sheet = `edge ${i}-${j} at (${rest.getX(i).toFixed(2)}, ${rest.getY(i).toFixed(2)}, ${rest.getZ(i).toFixed(2)}) is ${standing.toFixed(3)} m in the T-pose and ${fitted.toFixed(3)} m fitted`;
        }
      }
      assert.ok(checked === index.length, `${checked} edges checked`);
      assert.equal(sheet, "", `a sheet: ${sheet}`);
    });

    it(`when the ${build.name} stands, then every limb vertex is inside its rig part's box grown by a ${LIMB_MARGIN} m skin margin (the arms hang inside the arm boxes)`, () => {
      const mesh = new DummyMesh(1);
      mesh.dress(0, false, build.look);
      const [rest, skin, kinds] = [restShape(mesh), mesh.geometry.getAttribute(BONES_ATTRIBUTE), mesh.geometry.getAttribute(KINDS_ATTRIBUTE)];
      let [checked, worst, where] = [0, -Infinity, ""];
      for (let i = 0; i < BODY_VERTICES; i++) {
        const [a, b, w] = [skin.getX(i), skin.getY(i), skin.getZ(i)];
        if (a < 2 || b < 2 || kinds.getX(i) === ROLE.SHOE) continue;
        const part = w >= 0.5 ? b : a;
        const [c, h] = [PARTS[part]!.c, PARTS[part]!.h];
        const over = Math.max(Math.abs(rest.getX(i) - c[0]) - h[0], Math.abs(rest.getY(i) - c[1]) - h[1], Math.abs(rest.getZ(i) - c[2]) - h[2]);
        checked++;
        if (over > worst) [worst, where] = [over, `vertex ${i} at (${rest.getX(i).toFixed(3)}, ${rest.getY(i).toFixed(3)}, ${rest.getZ(i).toFixed(3)}) on part ${part}`];
      }
      assert.ok(checked > 1000, `${checked} limb vertices checked`);
      assert.ok(worst <= LIMB_MARGIN, `${where} is ${worst.toFixed(3)} m outside its part's box, the margin is ${LIMB_MARGIN} m`);
    });
  }
});

describe("given the dummy skinned to the ten rigid parts", () => {
  it("when every part is moved by one rigid transform, then every drawn vertex lands where that transform puts it standing", () => {
    const mesh = new DummyMesh(1);
    mesh.dress(0, false, { ...MAN, portly: true, mustache: true });
    const move = new THREE.Matrix4().compose(new THREE.Vector3(3, 0.5, -2), turn("y", 70).multiply(turn("x", -25)), new THREE.Vector3(1, 1, 1));
    const rest = posture({}).map((pose) => ({ p: pose.p.clone().applyMatrix4(move), q: new THREE.Quaternion().setFromRotationMatrix(move).multiply(pose.q) }));
    show(mesh, rest);
    const at = new THREE.Vector3();
    const standing = new THREE.Vector3();
    let moved = 0;
    const shape = restShape(mesh);
    for (let i = 0; i < shape.count; i++) {
      if (!mesh.posed(0, i, at)) continue;
      standing.fromBufferAttribute(shape, i).applyMatrix4(move);
      assert.ok(at.distanceTo(standing) < 1e-5, `vertex ${i} is ${at.distanceTo(standing)} m off`);
      moved++;
    }
    assert.ok(moved > mesh.geometry.getAttribute("position").count / 2, `${moved} vertices checked`);
  });
});

/** A joint of `JOINTS` (parent part, child part) and what the pose does to it: the child's swing about it. */
type Bend = { name: string; turns: Partial<Record<number, THREE.Quaternion>> };
const BENDS: readonly Bend[] = [
  { name: "elbows bent 90 degrees", turns: { 3: turn("x", -90), 5: turn("x", -90) } },
  { name: "knees bent 90 degrees", turns: { 7: turn("x", 90), 9: turn("x", 90) } },
  { name: "hips bent 90 degrees (seated)", turns: { 6: turn("x", -90), 8: turn("x", -90) } },
  { name: "head turned 60 degrees", turns: { 1: turn("y", 60) } },
  { name: "arms raised overhead (one forward, one out to the side)", turns: { 2: turn("x", 180), 4: turn("z", 180) } },
  {
    name: "all of them at once",
    turns: { 1: turn("y", 60), 2: turn("x", 180), 4: turn("z", 180), 3: turn("x", -90), 5: turn("x", -90), 6: turn("x", -90), 8: turn("x", -90), 7: turn("x", 90), 9: turn("x", 90) },
  },
];

/**
 * An edge's posed length over its standing length, with the bones it rides: the set of bones of nonzero weight over both ends
 * (one bone: rigid; two: a joint's band), `t`, its length in the T-pose the weights were weighed on (0 on the wear, which is
 * rigid) and `dw`, how far the child bone's weight differs across it. `snap` rounds every weight to its nearest bone.
 */
type Stretch = { bones: number[]; ratio: number; extra: number; reach: number; t: number; dw: number };

/** The weights are shared by the three builds, weighed on the man's T-pose (`dummyGeometry`): the climb of a weight is bounded against its edge there. */
function stretches(mesh: DummyMesh, snap: boolean): Stretch[] {
  const geo = mesh.geometry;
  const [pos, skin, index, tpose] = [restShape(mesh), geo.getAttribute(BONES_ATTRIBUTE), geo.index!, restFits().man.tpose];
  const rows = mesh["rows"];
  const ends = [new THREE.Vector3(), new THREE.Vector3()];
  const standing = [new THREE.Vector3(), new THREE.Vector3()];
  const used = (i: number) => (skin.getZ(i) < 1 ? [skin.getX(i)] : []).concat(skin.getZ(i) > 0 ? [skin.getY(i)] : []);
  const out: Stretch[] = [];
  const probe = new THREE.Vector3();
  for (let t = 0; t < index.count; t += 3) {
    for (let e = 0; e < 3; e++) {
      const ij = [index.getX(t + e), index.getX(t + ((e + 1) % 3))] as const;
      if (!mesh.posed(0, ij[0], probe) || !mesh.posed(0, ij[1], probe)) continue;
      for (const [n, i] of ij.entries()) {
        standing[n]!.fromBufferAttribute(pos, i);
        skinPoint(rows, 0, skin.getX(i), skin.getY(i), snap ? Math.round(skin.getZ(i)) : skin.getZ(i), standing[n]!, ends[n]!);
      }
      const length = standing[0]!.distanceTo(standing[1]!);
      if (length < 1e-6) continue;
      const bones = [...new Set([...used(ij[0]), ...used(ij[1])])].sort((a, b) => a - b);
      const joint = JOINTS.find((j) => bones.length === 2 && j[0] === bones[0] && j[1] === bones[1]);
      const reach = joint ? Math.max(...ij.map((i) => standing[0]!.fromBufferAttribute(pos, i).distanceTo(new THREE.Vector3(joint[2], joint[3], joint[4])))) : 0;
      const [i, j] = ij;
      const t0 = i < BODY_VERTICES && j < BODY_VERTICES ? Math.hypot(tpose[i * 3]! - tpose[j * 3]!, tpose[i * 3 + 1]! - tpose[j * 3 + 1]!, tpose[i * 3 + 2]! - tpose[j * 3 + 2]!) : 0;
      const onChild = (k: number) => {
        const w = snap ? Math.round(skin.getZ(k)) : skin.getZ(k);
        return (skin.getX(k) === bones[1] ? 1 - w : 0) + (skin.getY(k) === bones[1] ? w : 0);
      };
      out.push({ bones, ratio: ends[0]!.distanceTo(ends[1]!) / length, extra: ends[0]!.distanceTo(ends[1]!) - length, reach, t: t0, dw: Math.abs(onChild(i) - onChild(j)) });
    }
  }
  return out;
}

/** The angle (rad) bone `b` is turned from bone `a` in slot 0's pose rows. */
function swung(mesh: DummyMesh, a: number, b: number): number {
  const rows = mesh["rows"];
  const [qa, qb] = [new THREE.Quaternion().fromArray(rows, (2 * a + 1) * 4), new THREE.Quaternion().fromArray(rows, (2 * b + 1) * 4)];
  return 2 * Math.acos(Math.min(1, Math.abs(qa.dot(qb))));
}

/**
 * The most a joint's edge may grow. A vertex in the band rides bones A and B with weight w on B: its two rigid images differ by
 * 2 sin(θ/2) times its distance `reach` from the joint (θ, the bones' relative turn; the joint stays closed in every pose), and
 * an edge between vertices i and j is p_j - p_i = M_j (v_j - v_i) + (w_j - w_i)(image_B - image_A)(v_i) with |M_j| <= 1 (a blend
 * of rotations). w climbs at most `JOINT_SLOPE` per metre of the T-pose the vertices were weighed in (the band widths of
 * dummy-skin.ts), so |w_j - w_i| <= slope * t and |p_j - p_i| <= |v_j - v_i| + 2 sin(θ/2) * reach * slope * t. Both halves are
 * checked: the weights' slope (`steep`, the bound's premise: a weight steeper than its band width says is what a hard seam is)
 * and the growth (`worst`). Snapping every weight to its nearest bone makes w_j - w_i a whole 1 across the seam, which neither allows.
 */
const allowance = (theta: number, reach: number, slope: number, t: number) => 2 * Math.sin(theta / 2) * reach * slope * t + 1e-4;

/** The worst growth (m) of a joint's edge past `allowance` and the worst weight step past `slope * t`, and which edge. */
function overshoot(rows: Stretch[], mesh: DummyMesh): { worst: number; joint: string; steep: number; steepJoint: string } {
  let [worst, steep] = [0, 0];
  let [joint, steepJoint] = ["none", "none"];
  for (const row of rows) {
    const j = row.bones.length === 2 ? JOINTS.findIndex((p) => p[0] === row.bones[0] && p[1] === row.bones[1]) : -1;
    if (j < 0) continue;
    const over = row.extra - allowance(swung(mesh, row.bones[0]!, row.bones[1]!), row.reach, JOINT_SLOPE[j]!, row.t);
    if (over > worst) {
      worst = over;
      joint = `bones ${row.bones.join("-")} grew ${row.extra.toFixed(3)} m over a ${row.t.toFixed(3)} m edge, ${over.toFixed(3)} m more than the weights allow`;
    }
    const climb = row.dw - JOINT_SLOPE[j]! * row.t - 1e-4;
    if (climb > steep) {
      steep = climb;
      steepJoint = `bones ${row.bones.join("-")} weight steps ${row.dw.toFixed(3)} over a ${row.t.toFixed(3)} m edge, the band widths allow ${(JOINT_SLOPE[j]! * row.t).toFixed(3)}`;
    }
  }
  return { worst, joint, steep, steepJoint };
}

describe("given the dummy bent at its joints", () => {
  for (const build of BUILDS) {
    for (const bend of BENDS) {
      it(`when the ${build.name} has his ${bend.name}, then no edge in a joint band stretches past what a blended band allows, and the parts between joints stay rigid`, () => {
        const mesh = new DummyMesh(1);
        mesh.dress(0, false, build.look);
        show(mesh, posture(bend.turns));
        const rows = stretches(mesh, false);
        assert.ok(rows.filter((r) => r.bones.length === 2).length > 100, "the bands' edges were measured");
        const { worst, joint, steep, steepJoint } = overshoot(rows, mesh);
        assert.ok(steep <= 0, `a weight climbs faster than its band: ${steepJoint}`);
        assert.ok(worst <= 0, `a seam opened: ${joint}`);
        for (const row of rows) if (row.bones.length === 1) assert.ok(Math.abs(row.ratio - 1) < 1e-4, `a rigid edge stretched ${row.ratio}x`);
      });
    }
  }

  const bent = BENDS.slice(0, 3);
  for (const bend of bent) {
    it(`when the weights are snapped to the nearest bone with his ${bend.name}, then the same measure finds the seam open (the measure bites)`, () => {
      const mesh = new DummyMesh(1);
      mesh.dress(0, false, MAN);
      show(mesh, posture(bend.turns));
      const { worst, joint } = overshoot(stretches(mesh, true), mesh);
      assert.ok(worst > 0.02, `no seam opened without the blend: ${joint}`);
    });
  }

  it("when the body is at rest, then every joint band's edge is its standing length", () => {
    const mesh = new DummyMesh(1);
    show(mesh, posture({}));
    assert.ok(stretches(mesh, false).every((r) => Math.abs(r.ratio - 1) < 1e-4));
  });

  it("when a slot flags whiskers and builds, then each build draws only its own vertices", () => {
    const mesh = new DummyMesh(1);
    const probe = new THREE.Vector3();
    const count = (flags: number) => {
      mesh.dress(0, false, { ...MAN, woman: flags === BUILD.WOMAN, portly: flags === BUILD.PORTLY, mustache: (flags & WHISKERS) !== 0 });
      let n = 0;
      for (let i = 0; i < mesh.geometry.getAttribute("position").count; i++) if (mesh.posed(0, i, probe)) n++;
      return n;
    };
    assert.equal(new Set([count(BUILD.MAN), count(BUILD.WOMAN), count(BUILD.PORTLY)]).size, 3, "three different bodies");
    assert.ok(count(BUILD.MAN | WHISKERS) > count(BUILD.MAN), "a moustache adds vertices");
  });
});

describe("given a dummy ray-picked as the garage's driver is", () => {
  it("when a ray from the front meets his standing body, then it hits slot 0 on his chest, in the world", () => {
    const mesh = new DummyMesh(2);
    mesh.dress(0, false, MAN);
    const offset = new THREE.Vector3(4, 0, 6);
    for (const [k, pose] of posture({}).entries()) mesh.pose(0, k, pose.p.add(offset), pose.q);
    mesh.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(4, 1.2, 8), new THREE.Vector3(0, 0, -1));
    const hit = ray.intersectObject(mesh)[0]!;
    assert.equal(hit.instanceId, 0);
    assert.ok(hit.point.z > 6 && hit.point.z < 6.2, `hit at z = ${hit.point.z}`);
    const miss = new THREE.Raycaster(new THREE.Vector3(-4, 1.2, 8), new THREE.Vector3(0, 0, -1));
    assert.equal(miss.intersectObject(mesh).length, 0, "a ray past him misses");
  });
});

/** The head's triangles (the baked body's, rigid on the head bone: skull, scalp and face) of the standing slot 0 in its build's rest shape. */
function skinTriangles(mesh: DummyMesh): THREE.Triangle[] {
  const geo = mesh.geometry;
  const [pos, skin, index] = [restShape(mesh), geo.getAttribute(BONES_ATTRIBUTE), geo.index!];
  const onHead = (i: number) => i < BODY_VERTICES && skin.getX(i) === 1 && skin.getY(i) === 1 && pos.getY(i) >= 1.5;
  const out: THREE.Triangle[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const [a, b, c] = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
    if (onHead(a) && onHead(b) && onHead(c)) out.push(new THREE.Triangle(new THREE.Vector3().fromBufferAttribute(pos, a), new THREE.Vector3().fromBufferAttribute(pos, b), new THREE.Vector3().fromBufferAttribute(pos, c)));
  }
  return out;
}

/**
 * How far (m) head wear may stand from the skull (the baked head, scalp included). Hair and the cap's crown are shells 0.016 to
 * 0.025 m out of it (the portly man's fuller hair), their face half pulled to half its depth under the skin: 0.06 m with a centimetre to spare.
 * The peak stands 0.045 m out of a crown 0.02 m out of the skull: 0.12 m still covers the tip.
 */
const WEAR_BOUND = 0.06;
const PEAK_BOUND = 0.12;
/** A woman's long hair hangs below the jaw by design: the check covers the head wear from this height (m, the cheek) up. */
const HANGS_BELOW = 1.57;
/** The peak's rim is the crown's own ring: at least this many of its vertices lie on a crown vertex (within a millimetre). */
const PEAK_ATTACHED = 10;

const HEADS = [
  { name: "bare man", look: MAN, cop: false },
  { name: "woman with long hair", look: WOMAN, cop: false },
  { name: "portly man", look: { ...MAN, portly: true }, cop: false },
  { name: "man in a cap", look: { ...MAN, hat: 0x2255aa }, cop: false },
  { name: "cop in his cap", look: MAN, cop: true },
] as const;

describe("given the dummy's head", () => {
  for (const head of HEADS) {
    it(`when the ${head.name} is drawn, then every hair, cap and peak vertex stands within a bound of the skull's skin, and a drawn peak is fastened to its crown`, () => {
      const mesh = new DummyMesh(1);
      mesh.dress(0, head.cop, head.look);
      show(mesh, posture({}));
      const skin = skinTriangles(mesh);
      assert.ok(skin.length > 60, `${skin.length} skin triangles on the head`);
      const geo = mesh.geometry;
      const [kinds, bones] = [geo.getAttribute(KINDS_ATTRIBUTE), geo.getAttribute(BONES_ATTRIBUTE)];
      const at = new THREE.Vector3();
      const near = new THREE.Vector3();
      const peak: THREE.Vector3[] = [];
      const crown: THREE.Vector3[] = [];
      let checked = 0;
      for (let i = 0; i < kinds.count; i++) {
        const role = kinds.getX(i);
        if (![ROLE.HAIR, ROLE.LOCKS, ROLE.BRIM].includes(role as never) || !mesh.posed(0, i, at) || at.y < HANGS_BELOW) continue;
        assert.ok(bones.getX(i) === 1 && bones.getY(i) === 1, `vertex ${i} of the head wear rides the head bone alone`);
        let best = Infinity;
        for (const tri of skin) best = Math.min(best, tri.closestPointToPoint(at, near).distanceTo(at));
        const bound = role === ROLE.BRIM ? PEAK_BOUND : WEAR_BOUND;
        assert.ok(best <= bound, `vertex ${i} (role ${role}) floats ${best.toFixed(3)} m off the skull, bound ${bound} m`);
        if (role === ROLE.BRIM) peak.push(at.clone());
        if (role === ROLE.HAIR) crown.push(at.clone());
        checked++;
      }
      assert.ok(checked > 40, `${checked} head wear vertices checked`);
      if (head.cop || head.look.hat !== null) {
        const fastened = peak.filter((p) => crown.some((c) => c.distanceTo(p) < 1e-3)).length;
        assert.ok(fastened >= PEAK_ATTACHED, `${fastened} of ${peak.length} peak vertices lie on the crown, at least ${PEAK_ATTACHED} must`);
      } else assert.equal(peak.length, 0, "no peak without a cap");
    });
  }

  it("when a civilian and a cop are drawn, then the civilian's eyes are the atlas and the cop's lenses sit on the face", () => {
    const civilian = drawn(MAN, false);
    const cop = drawn(MAN, true);
    const lenses = (rows: Drawn[]) => ofRole(rows, ROLE.EYES).filter((r) => r.at.z > 0.05 && r.at.y > 1.55);
    assert.equal(lenses(civilian).length, 0, "no floating eye boxes on a civilian");
    assert.ok(lenses(cop).length > 8, `${lenses(cop).length} lens vertices on the cop`);
    const gap = Math.min(...lenses(cop).map((r) => Math.abs(r.at.x)));
    assert.ok(gap > 0.015, "the lenses are a pair, not one bar");
    assert.ok(Math.max(...lenses(cop).map((r) => r.at.z)) < 0.14, "the lenses sit on the face, not in front of it");
  });
});

/**
 * A shoulder or hip end cap floats when it sits this far (m) from the torso body. A sleeve is about 0.05 m across, so 0.06 m
 * is a cap standing clear of the body; a limb that grows out of the torso has no cap of its own.
 */
const CAP_FLOAT = 0.06;
/**
 * Along the posed span from the torso to the limb root, a hole wider than this (m) is a gap. A closed shoulder whose
 * outer ring sits 0.10 m inside the joint bows 0.072 m off that straight span at 180°; 0.08 m still reads as closed,
 * and a floating sleeve leaves the span empty.
 */
const SEAM_HOLE = 0.08;
/** Rest distance (m) from the joint that still counts as its band: far enough to reach the torso shell beside a sleeve at x = 0.24. */
const SEAM_REACH = 0.22;
/** A vertex this close (m) to the limb's axis is the limb's own end cap, not the torso body. */
const CAP_AXIS = 0.03;
/**
 * A torso-body vertex is at least this far (m) off the limb axis. The baked body has no end-cap tubes: the torso vertices on a
 * limb's axis (the crotch's) are the only ones the old cap test can find, and each must lie within `CAP_FLOAT` of the rest of the torso.
 */
const BODY_OFF_AXIS = CAP_AXIS;

/** Shoulders and hips, the joints a limb must grow out of. `joint` indexes `JOINTS` (parent, child, point). */
const SEAMS = [
  { name: "left shoulder", joint: 1, role: ROLE.SHIRT },
  { name: "right shoulder", joint: 3, role: ROLE.SHIRT },
  { name: "left hip", joint: 5, role: ROLE.LEGS },
  { name: "right hip", joint: 7, role: ROLE.LEGS },
] as const;

/** The poses a viewer sees the joint in: standing, the defect's arms overhead, arms out, legs spread, sitting. */
const SEAM_POSES: readonly { name: string; turns: Partial<Record<number, THREE.Quaternion>> }[] = [
  { name: "at rest", turns: {} },
  { name: "arms raised overhead", turns: { 2: turn("x", 180), 4: turn("z", 180) } },
  { name: "arms out to the side", turns: { 2: turn("z", -90), 4: turn("z", 90) } },
  { name: "legs spread", turns: { 6: turn("z", -50), 8: turn("z", 50) } },
  { name: "sitting", turns: { 6: turn("x", -90), 8: turn("x", -90) } },
];

/** Fully on the torso bone: weight 0 on any child counts, including a blend stored as parent, child, 0. */
function onTorso(skin: { getX: (i: number) => number; getY: (i: number) => number; getZ: (i: number) => number }, i: number): boolean {
  const w = skin.getZ(i);
  return (w >= 1 || skin.getX(i) === 0) && (w <= 0 || skin.getY(i) === 0);
}

/**
 * The seam at `joint` (a `JOINTS` row): how far (m) a torso-weighted end cap floats off the torso body, and the widest hole
 * (m) along the posed span from that body to the limb root. Both stay under their bounds when the limb grows out of the torso.
 */
function seamGap(mesh: DummyMesh, joint: number, role: number): { float: number; hole: number } {
  const [, limb, jx, jy, jz] = JOINTS[joint]!;
  const at = new THREE.Vector3(jx, jy, jz);
  const axis = new THREE.Vector3(jx, 0, jz);
  const geo = mesh.geometry;
  const [pos, skin, kinds] = [restShape(mesh), geo.getAttribute(BONES_ATTRIBUTE), geo.getAttribute(KINDS_ATTRIBUTE)];
  const offAxis = (p: THREE.Vector3) => Math.hypot(p.x - axis.x, p.z - axis.z);
  const body: THREE.Vector3[] = [];
  const caps: THREE.Vector3[] = [];
  const limbPts: THREE.Vector3[] = [];
  const fill: THREE.Vector3[] = [];
  const posed = new THREE.Vector3();
  const rest = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    if (kinds.getX(i) !== role || !mesh.posed(0, i, posed)) continue;
    fill.push(posed.clone());
    rest.fromBufferAttribute(pos, i);
    if (rest.distanceTo(at) > SEAM_REACH) continue;
    const w = skin.getZ(i);
    const bone = w >= 0.5 ? skin.getY(i) : skin.getX(i);
    if (onTorso(skin, i) && offAxis(rest) <= CAP_AXIS) caps.push(posed.clone());
    else if (onTorso(skin, i) && offAxis(rest) >= BODY_OFF_AXIS) body.push(posed.clone());
    else if (bone === limb) limbPts.push(posed.clone());
  }
  let float = caps.length === 0 ? 0 : body.length === 0 ? Infinity : 0;
  for (const cap of caps) {
    const near = body.reduce((best, p) => Math.min(best, cap.distanceTo(p)), Infinity);
    if (near > float) float = near;
  }
  if (body.length === 0 || limbPts.length === 0) return { float, hole: Infinity };
  const anchor = body.reduce((best, p) => (p.distanceTo(at) < best.distanceTo(at) ? p : best));
  const root = limbPts.reduce((best, p) => (p.distanceTo(anchor) < best.distanceTo(anchor) ? p : best));
  const span = anchor.distanceTo(root);
  let hole = 0;
  const step = new THREE.Vector3();
  for (let t = 0; t <= span; t += SEAM_HOLE / 2) {
    step.copy(root).sub(anchor).multiplyScalar(span < 1e-6 ? 0 : t / span).add(anchor);
    const near = fill.reduce((best, p) => Math.min(best, step.distanceTo(p)), Infinity);
    if (near > hole) hole = near;
  }
  return { float, hole };
}

describe("given the dummy's shoulders and hips", () => {
  for (const build of BUILDS) {
    for (const pose of SEAM_POSES) {
      it(`when the ${build.name} is ${pose.name}, then the shoulders and hips stay closed`, () => {
        const mesh = new DummyMesh(1);
        mesh.dress(0, false, build.look);
        show(mesh, posture(pose.turns));
        for (const seam of SEAMS) {
          const { float, hole } = seamGap(mesh, seam.joint, seam.role);
          assert.ok(float <= CAP_FLOAT, `${seam.name} end cap floats ${float.toFixed(3)} m off the torso (bound ${CAP_FLOAT} m)`);
          assert.ok(hole <= SEAM_HOLE, `${seam.name} opens a ${hole.toFixed(3)} m hole (bound ${SEAM_HOLE} m)`);
        }
      });
    }
  }
});

/**
 * A bridge face shows its back when its normal's component away from the limb axis is below this. The old flap read -0.93;
 * a mitred corner where the tube turns down the sleeve sits near -0.25 and still reads as the outside, so -0.3 is the back face.
 */
const OUTWARD = -0.3;

/** Worst inward face at `joint`: how far (dot) a bridge triangle's normal points toward the limb axis instead of away. */
function inwardFace(mesh: DummyMesh, joint: number, role: number): number {
  const [, limb, jx, jy, jz] = JOINTS[joint]!;
  const axis = new THREE.Vector3(jx, 0, jz);
  const geo = mesh.geometry;
  const [pos, skin, kinds, index] = [restShape(mesh), geo.getAttribute(BONES_ATTRIBUTE), geo.getAttribute(KINDS_ATTRIBUTE), geo.index!];
  const at = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const rest = new THREE.Vector3();
  let worst = 0;
  const tri = (i: number) => {
    if (!mesh.posed(0, i, at[0])) return false;
    rest.fromBufferAttribute(pos, i);
    const w = skin.getZ(i);
    return kinds.getX(i) === role && rest.distanceTo(new THREE.Vector3(jx, jy, jz)) < 0.2 && skin.getY(i) === limb && w > 0.15 && w < 0.85;
  };
  for (let t = 0; t < index.count; t += 3) {
    const ij = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
    if (!ij.some((i) => tri(i))) continue;
    for (const [n, i] of ij.entries()) mesh.posed(0, i, at[n]);
    const normal = at[1].clone().sub(at[0]).cross(at[2].clone().sub(at[0]));
    if (normal.lengthSq() < 1e-10) continue;
    normal.normalize();
    const mid = at[0].clone().add(at[1]).add(at[2]).multiplyScalar(1 / 3);
    if (Math.abs(mid.x) < Math.abs(jx) + 0.05) continue;
    const radial = mid.clone().sub(axis);
    radial.y = 0;
    if (radial.lengthSq() < 1e-6) continue;
    worst = Math.min(worst, normal.dot(radial.normalize()));
  }
  return worst;
}

describe("given the shoulder and hip bridges", () => {
  for (const build of BUILDS) {
    it(`when the ${build.name} stands and bends, then every bridge face points outward, not a cap or a flap`, () => {
      const mesh = new DummyMesh(1);
      mesh.dress(0, false, build.look);
      for (const pose of SEAM_POSES) {
        if (pose.name !== "at rest") continue;
        show(mesh, posture(pose.turns));
        for (const seam of SEAMS) {
          const dot = inwardFace(mesh, seam.joint, seam.role);
          assert.ok(dot >= OUTWARD, `${seam.name} ${pose.name}: a face points inward ${dot.toFixed(2)} (bound ${OUTWARD})`);
          const { hole } = seamGap(mesh, seam.joint, seam.role);
          assert.ok(hole <= SEAM_HOLE, `${seam.name} ${pose.name}: a ${hole.toFixed(3)} m flap (bound ${SEAM_HOLE} m)`);
        }
      }
    });
  }
});

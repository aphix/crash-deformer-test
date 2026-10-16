import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { driverLook, JEANS, type DriverLook } from "./driver-look.ts";
import { DummyMesh } from "./ragdoll-mesh.ts";
import { JOINTS, PARTS } from "./ragdoll-body.ts";
import { BONES_ATTRIBUTE, BUILD, FLAGS_AT, isDrawn, KINDS_ATTRIBUTE, ROLE, ROLES, skinPoint, WHISKERS } from "./dummy-skin.ts";

const MAN: DriverLook = { woman: false, shirt: 0xc0392b, pants: JEANS, hair: 0x18120f, hat: null, mustache: false };
const WOMAN: DriverLook = { woman: true, shirt: 0x2a9d8f, pants: JEANS, hair: 0xd2b062, hat: null, mustache: false };
const NAVY = new THREE.Color(0x1b2a4a);
const BUILDS = [
  { name: "man", look: MAN },
  { name: "woman", look: WOMAN },
  { name: "portly man", look: { ...MAN, portly: true } },
] as const;

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

  it("when the body's triangles are counted, then one slot submits at most twice the 56 octagonal blocks (28 triangles each) it replaced", () => {
    const mesh = new DummyMesh(1);
    assert.ok(mesh.geometry.index!.count / 3 <= 2 * 56 * 28, `${mesh.geometry.index!.count / 3} triangles`);
  });
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
    for (let i = 0; i < mesh.geometry.getAttribute("position").count; i++) {
      if (!mesh.posed(0, i, at)) continue;
      standing.fromBufferAttribute(mesh.geometry.getAttribute("position"), i).applyMatrix4(move);
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
 * (one bone: rigid; two: a joint's band). `snap` rounds every weight to its nearest bone.
 */
type Stretch = { bones: number[]; ratio: number; reach: number };

function stretches(mesh: DummyMesh, snap: boolean): Stretch[] {
  const geo = mesh.geometry;
  const [pos, skin, index] = [geo.getAttribute("position"), geo.getAttribute(BONES_ATTRIBUTE), geo.index!];
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
      out.push({ bones, ratio: ends[0]!.distanceTo(ends[1]!) / length, reach });
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
 * The most a joint's edge may stretch. A vertex in the band rides bones A and B with weight w on B, w climbing linearly across
 * the band (half width `BAND`, so by at most 1/2 between two rings one `BAND` apart): its two rigid images differ by
 * 2 sin(θ/2) times its distance `reach` from the joint (θ, the bones' relative turn), and an edge between vertices i and j
 * is p_j - p_i = M_j (v_j - v_i) + (w_j - w_i)(image_B - image_A)(v_i) with |M_j| <= 1 (a blend of rotations), so
 * |p_j - p_i| <= |e| (1 + sin(θ/2) * reach / BAND) for |e| >= BAND, the least an edge across a band is long. Snapping every
 * weight to its nearest bone makes w_j - w_i a whole 1 across the seam, double that.
 */
const BAND = 0.04;
const bound = (theta: number, reach: number) => 1 + (Math.sin(theta / 2) * reach) / BAND + 1e-4;

function overshoot(rows: Stretch[], mesh: DummyMesh): { worst: number; joint: string } {
  let worst = 0;
  let joint = "none";
  for (const row of rows) {
    if (row.bones.length !== 2) continue;
    const over = row.ratio - bound(swung(mesh, row.bones[0]!, row.bones[1]!), row.reach);
    if (over > worst) {
      worst = over;
      joint = `bones ${row.bones.join("-")} stretched ${row.ratio.toFixed(2)}x (bound ${bound(swung(mesh, row.bones[0]!, row.bones[1]!), row.reach).toFixed(2)}x)`;
    }
  }
  return { worst, joint };
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
        const { worst, joint } = overshoot(rows, mesh);
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
      assert.ok(worst > 0.05, `no seam opened without the blend: ${joint}`);
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

/** The head's skin triangles (rigid on the head bone, the skull and its face features) of the standing slot 0. */
function skinTriangles(mesh: DummyMesh): THREE.Triangle[] {
  const geo = mesh.geometry;
  const [pos, skin, kinds, index] = [geo.getAttribute("position"), geo.getAttribute(BONES_ATTRIBUTE), geo.getAttribute(KINDS_ATTRIBUTE), geo.index!];
  const onHead = (i: number) => kinds.getX(i) === ROLE.SKIN && skin.getX(i) === 1 && skin.getY(i) === 1 && pos.getY(i) >= 1.5 && isDrawn(kinds.getY(i), mesh["rows"][FLAGS_AT * 4]!);
  const out: THREE.Triangle[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const [a, b, c] = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
    if (onHead(a) && onHead(b) && onHead(c)) out.push(new THREE.Triangle(new THREE.Vector3().fromBufferAttribute(pos, a), new THREE.Vector3().fromBufferAttribute(pos, b), new THREE.Vector3().fromBufferAttribute(pos, c)));
  }
  return out;
}

/**
 * How far (m) head wear may stand from the skull's skin. Hair and the cap's crown are shells `HAIR_OUT` to 0.03 m out of the skull
 * (portly hair), their face half pulled up to half its width under the skin (0.5 of a 0.1 m radius: 0.05 m), so 0.03 and 0.05 give 0.06 with
 * a centimetre to spare. The peak stands 0.085 m out of a crown 0.02 m out of the skull, and its tip is the most distant point: 0.12 m.
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

  it("when a civilian and a cop are drawn, then the civilian has two small eyes with a gap between them, and the cop has a pair of dark lenses over them seated on the face", () => {
    const civilian = drawn(MAN, false);
    const cop = drawn(MAN, true);
    const eyes = (rows: Drawn[]) => ofRole(rows, ROLE.EYES).filter((r) => r.at.z > 0.05 && r.at.y > 1.55);
    const gap = Math.min(...eyes(civilian).map((r) => Math.abs(r.at.x)));
    assert.ok(gap > 0.015, `the eyes are ${(gap * 2).toFixed(3)} m apart at their nearest, not one bar`);
    assert.ok(Math.max(...eyes(civilian).map((r) => Math.abs(r.at.x))) < 0.06, "small eyes");
    assert.ok(eyes(cop).length > eyes(civilian).length * 2, `${eyes(cop).length} dark vertices on the cop's face against ${eyes(civilian).length}`);
    assert.ok(Math.max(...eyes(cop).map((r) => r.at.z)) > Math.max(...eyes(civilian).map((r) => r.at.z)), "the lenses stand out of the face");
  });
});

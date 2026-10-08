import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { Corkscrew, CORKSCREW } from "../scenes/corkscrew.ts";
import { FleetRamps, RAMP } from "../scenes/fleet-ramps.ts";
import { PREFABS, type PrefabId } from "../world/catalog.ts";
import { setGround, type Ground } from "../world/ground.ts";
import { placeProps } from "../world/placements.ts";
import { Track } from "../world/track.ts";
import { parseTrack } from "../world/track-schema.ts";
import { square } from "../world/track.test-util.ts";
import { TRACKS } from "../world/tracks/index.ts";
import { TUNNEL_GAP, TUNNEL_SIDE } from "./track-mesh.ts";
import { levelAt, surfY } from "../world/track-sections.ts";
import { RagdollSystem } from "./engine-ragdoll.ts";

const FRAME = 1 / 60;
/** Most a part's centre may sit inside a solid (m): one 1/120 s step at 15 m/s is 0.125 m, and Rapier resolves it the next step. */
const SOAK = 0.15;
const UP = new THREE.Vector3(0, 1, 0);

type V3 = { x: number; y: number; z: number };
type Dolls = { live: boolean; bodies: { translation(): V3 }[] }[];
type Colliders = { len(): number };

const stunt = () => new Track(parseTrack(TRACKS.find((j) => parseTrack(j).id === "stunt")!));

/** A ragdoll system on `ground` (the active one) with `track` as its course, and no cars. */
async function system(ground: Ground | null, track: Track | null): Promise<RagdollSystem> {
  const sys = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
  await sys.preload();
  setGround(ground);
  if (track) sys.setCourse(track, placeProps(track), null);
  sys.update(FRAME, [], true, false, 0, null);
  return sys;
}

const dollsOf = (sys: RagdollSystem): Dolls => sys["dolls"];
const colliders = (sys: RagdollSystem): number => (sys["world"]!.colliders as Colliders).len();

/** Throw a dummy from `p` at `v` (torso `head` turned toward `lie`, or standing when null). */
function throwFrom(sys: RagdollSystem, p: THREE.Vector3, v: THREE.Vector3, lie: THREE.Vector3 | null): void {
  const q = new THREE.Quaternion();
  if (lie) q.setFromUnitVectors(UP, lie);
  sys["spawn"]({ car: 0, p, q, v, w: new THREE.Vector3(), age: 0, cop: false, rides: true });
}

/** Step `secs` of frames and call `each` with every part's centre after each. */
function run(sys: RagdollSystem, secs: number, each: (part: V3, f: number) => void): void {
  const d = dollsOf(sys)[0]!;
  for (let f = 0; f < Math.round(secs / FRAME); f++) {
    sys.update(FRAME, [], true, false, 0, null);
    for (const b of d.bodies) each(b.translation(), f);
  }
}

/** One piece of a prop (`PREFABS[..].collider`) in its prop's frame, an upright box or cylinder from y0 to y1. */
type Piece = { x: number; z: number; hx: number; hz: number; y0: number; y1: number; circle: boolean };

/** A prop placed on the square course: where it stands, its pieces, and `face`: the local x of the first of them a shot along local +x meets, at its height. */
type Prop = { x: number; z: number; yaw: number; pieces: Piece[]; face: number };

/** Where a shot is aimed (m up) where the prop's own 60 % of its height up to 1 m would miss it: a billboard's panel, over the opening between its posts. */
const AIM: Partial<Record<PrefabId, number>> = { billboard: 3 };

/** Signed distance (m) from a point to the nearest piece of a prop (negative inside one): prop frame local x = (cos, −sin), z = (sin, cos). */
function depth(s: Prop, p: V3): number {
  const ex = p.x - s.x;
  const ez = p.z - s.z;
  const lx = ex * Math.cos(s.yaw) - ez * Math.sin(s.yaw);
  const lz = ex * Math.sin(s.yaw) + ez * Math.cos(s.yaw);
  let d = Infinity;
  for (const q of s.pieces) {
    const dy = Math.max(q.y0 - p.y, p.y - q.y1);
    const side = q.circle ? Math.hypot(lx - q.x, lz - q.z) - q.hx : Math.max(Math.abs(lx - q.x) - q.hx, Math.abs(lz - q.z) - q.hz);
    d = Math.min(d, Math.max(side, dy));
  }
  return d;
}

/**
 * One `prefab` placed on the square course, a dummy fired head first along its local +x at 15 m/s from 6 m short of its
 * first face, at 60 % of its height up to 1 m (`AIM`). With `solids` false the course's solids are dropped (the control).
 */
async function fireAt(prefab: PrefabId, solids: boolean): Promise<{ solid: Prop; deepest: number; reach: number; along: number }> {
  const spec = PREFABS[prefab];
  const y = AIM[prefab] ?? Math.min(1, 0.6 * spec.size[1]);
  const pieces = spec.collider.map((c): Piece => {
    const circle = c.kind === "circle";
    return { x: c.x ?? 0, z: c.z ?? 0, hx: circle ? c.r : c.hx, hz: circle ? c.r : c.hz, y0: c.y0 ?? 0, y1: c.y1 ?? spec.size[1], circle };
  });
  // The first face of the pieces the shot's line (lateral 0, height y) runs into.
  let face = Infinity;
  for (const q of pieces) {
    if (y < q.y0 || y > q.y1 || Math.abs(q.z) >= q.hz) continue;
    face = Math.min(face, q.x - (q.circle ? Math.sqrt(q.hx * q.hx - q.z * q.z) : q.hx));
  }
  assert.ok(Number.isFinite(face), `${prefab}: nothing at ${y} m on the shot's line`);
  const solid: Prop = { x: -45, z: 30, yaw: 0.4, pieces, face };
  const track = new Track(parseTrack(square({ props: [{ prefab, x: solid.x, z: solid.z, yaw: solid.yaw, scale: 1 }] })));
  const sys = await system(track.ground(), track);
  if (!solids) sys["solids"] = [];
  const dir = new THREE.Vector3(Math.cos(solid.yaw), 0, -Math.sin(solid.yaw));
  const flight = 6 / 15;
  const start = new THREE.Vector3(solid.x, y + 0.5 * 9.6 * flight * flight, solid.z).addScaledVector(dir, face - 6);
  throwFrom(sys, start, dir.clone().multiplyScalar(15), dir);
  let deepest = Infinity;
  let reach = -Infinity;
  run(sys, 3, (p) => {
    deepest = Math.min(deepest, depth(solid, p));
    reach = Math.max(reach, (p.x - solid.x) * dir.x + (p.z - solid.z) * dir.z);
  });
  const t = dollsOf(sys)[0]!.bodies[0]!.translation();
  const along = (t.x - solid.x) * dir.x + (t.z - solid.z) * dir.z;
  sys.dispose();
  return { solid, deepest, reach, along };
}

describe("given a thrown dummy (the ejected driver's ragdoll) and the solid props a car also meets", () => {
  const kinds: PrefabId[] = ["building", "grandstand", "billboard", "lamp", "tree", "rock", "barrier-block", "hay-bale", "tyre-stack", "crate", "cone"];
  for (const prefab of kinds) {
    it(`when a dummy is fired at a ${prefab} at 15 m/s, then it stops on the prop's face: no part inside it and none behind it`, async () => {
      const { solid, deepest, reach, along } = await fireAt(prefab, true);
      assert.ok(reach > solid.face - 0.6, `the shot reached the face (${reach.toFixed(2)} vs ${solid.face.toFixed(2)})`);
      assert.ok(deepest > -SOAK, `a part sank ${(-deepest).toFixed(2)} m into the ${prefab}`);
      assert.ok(along < solid.face, `torso ended behind the face: ${along.toFixed(2)}`);
    });
  }

  it("when the course's solids are left out and the same shots are fired at props over 1.2 m tall, then the torso ends inside or behind the props", async () => {
    for (const prefab of kinds.filter((k) => PREFABS[k].size[1] > 1.2)) {
      const { solid, along } = await fireAt(prefab, false);
      assert.ok(along > solid.face, `${prefab}: with no solid the torso ended ${along.toFixed(2)} along, face at ${solid.face.toFixed(2)}`);
    }
  });

  it("when a dummy is fired at a billboard between its posts, under the panel, then he flies through the opening and ends beyond it", async () => {
    const track = new Track(parseTrack(square({ props: [{ prefab: "billboard", x: -45, z: 30, yaw: 0, scale: 1 }] })));
    const sys = await system(track.ground(), track);
    throwFrom(sys, new THREE.Vector3(-51, 1.2, 30), new THREE.Vector3(15, 0, 0), new THREE.Vector3(1, 0, 0));
    run(sys, 3, () => {});
    const x = dollsOf(sys)[0]!.bodies[0]!.translation().x;
    sys.dispose();
    assert.ok(x > -44, `through the opening: ${x.toFixed(2)}`);
  });

  it("when a crate has been knocked off its spot versus left standing and a dummy is fired at the spot, then the standing crate stops him and the knocked one, flown off sideways, lets him by", async () => {
    const track = new Track(parseTrack(square({ props: [{ prefab: "crate", x: -45, z: 30, yaw: 0, scale: 1 }] })));
    const ends: number[] = [];
    for (const knocked of [false, true]) {
      const sys = await system(track.ground(), track);
      if (knocked) {
        sys.knockProp(0, -1, 0, 4, 12);
        run(sys, 2, () => {});
      }
      throwFrom(sys, new THREE.Vector3(-51, 1.2, 30), new THREE.Vector3(15, 0, 0), new THREE.Vector3(1, 0, 0));
      run(sys, 3, () => {});
      ends.push(dollsOf(sys)[0]!.bodies[0]!.translation().x);
      sys.dispose();
    }
    assert.ok(ends[0]! < -45.5, `standing crate stops him: ${ends[0]!.toFixed(2)}`);
    assert.ok(ends[1]! > -44, `knocked crate lets him by: ${ends[1]!.toFixed(2)}`);
  });
});

describe("given a thrown dummy and the stunt course's tunnel shell and bridge deck", () => {
  const track = stunt();
  const p = track.path;
  const ground = track.ground();

  it("when he is thrown at the tunnel's side walls and straight up, then the side wall and the roof hold him", async () => {
    const k = 1012;
    const left = new THREE.Vector3(p.tz[k]!, 0, -p.tx[k]!);
    const wall = p.half[k]! + p.runL[k]! + TUNNEL_GAP;
    const road = surfY(ground, p, k, 0);
    for (const dir of [left, left.clone().negate()]) {
      const sys = await system(ground, track);
      // From 5 m beside the centre line toward the wall, 2.5 m up, 15 m/s: the wall is 2–3 m on.
      const from = new THREE.Vector3(p.x[k]!, road + 2.5, p.z[k]!).addScaledVector(dir, 5);
      throwFrom(sys, from, dir.clone().multiplyScalar(15), dir);
      let far = 0;
      run(sys, 3, (q) => (far = Math.max(far, (q.x - p.x[k]!) * dir.x + (q.z - p.z[k]!) * dir.z)));
      sys.dispose();
      assert.ok(far < wall + 0.1, `a part reached ${far.toFixed(2)} m from the centre line; the wall's face is ${wall.toFixed(2)}`);
    }
    // Straight up at 15 m/s (11.7 m of rise): the arch's apex is the most height there is.
    const sys = await system(ground, track);
    throwFrom(sys, new THREE.Vector3(p.x[k]!, road + 1.5, p.z[k]!), new THREE.Vector3(0, 15, 0), UP);
    let top = 0;
    run(sys, 3, (q) => (top = Math.max(top, q.y)));
    sys.dispose();
    assert.ok(top < road + TUNNEL_SIDE + 3 + 0.25, `a part rose to ${(top - road).toFixed(2)} m over the road; the arch's apex is ${(TUNNEL_SIDE + 3).toFixed(1)}`);
  });

  it("when he is thrown up under the bridge and dropped on top of it, then the deck's underside holds him and he ends on the road under it, and on top he lies on the deck", async () => {
    const roadY = ground.heightAt(0, 0, 1);
    const deckY = ground.heightAt(0, 0, 12);
    assert.ok(deckY - roadY > 8, "the crossing is a real bridge");
    const under = await system(ground, track);
    throwFrom(under, new THREE.Vector3(0, roadY + 1.5, 0), new THREE.Vector3(0, 15, 0), UP);
    let top = 0;
    run(under, 4, (q) => (top = Math.max(top, q.y)));
    const end = dollsOf(under)[0]!.bodies[0]!.translation().y;
    under.dispose();
    assert.ok(top > deckY - 1 - 0.6, `he reached the underside: rose to ${top.toFixed(2)}`);
    assert.ok(top < deckY - 1 + 0.1, `a part rose to ${top.toFixed(2)}, the underside is ${(deckY - 1).toFixed(2)}`);
    assert.ok(end < roadY + 1, `he came down on the road under it: torso y ${end.toFixed(2)}`);
    const over = await system(ground, track);
    throwFrom(over, new THREE.Vector3(0, deckY + 3, 0), new THREE.Vector3(), null);
    let low = Infinity;
    run(over, 3, (q) => (low = Math.min(low, q.y)));
    const rest = dollsOf(over)[0]!.bodies[0]!.translation().y;
    over.dispose();
    assert.ok(low > deckY - 0.1, `a part went ${(deckY - low).toFixed(2)} m under the deck's top`);
    assert.ok(rest > deckY && rest < deckY + 0.8, `torso rests on the deck: ${(rest - deckY).toFixed(2)} m over it`);
    // levelAt is the sim's own deck height, so the colliders are where the cars drive.
    assert.ok(Math.abs(levelAt(p, 637, 0) - deckY) < 0.05);
  });

  it("when he is fired at the wall of the road under the bridge, then the wall stands on the road, not on the deck above", async () => {
    let k = 0;
    for (let i = 0; i < p.count; i++) if (p.y[i]! < 1 && Math.hypot(p.x[i]!, p.z[i]!) < Math.hypot(p.x[k]!, p.z[k]!)) k = i;
    assert.ok(Math.hypot(p.x[k]!, p.z[k]!) < 3 && !p.deck[k], "the road crosses under the bridge near the origin");
    const left = new THREE.Vector3(p.tz[k]!, 0, -p.tx[k]!);
    const wall = p.half[k]! + p.runL[k]!;
    const sys = await system(ground, track);
    throwFrom(sys, new THREE.Vector3(p.x[k]!, p.y[k]! + 1, p.z[k]!).addScaledVector(left, 5), left.clone().multiplyScalar(15), left);
    let far = 0;
    run(sys, 3, (q) => (far = Math.max(far, (q.x - p.x[k]!) * left.x + (q.z - p.z[k]!) * left.z)));
    sys.dispose();
    assert.ok(far > wall - 0.6 && far < wall + 0.15, `a part reached ${far.toFixed(2)} m out; the wall's face is ${wall.toFixed(2)}`);
  });
});

describe("given a thrown dummy and the fleet ramps", () => {
  it("when he is dropped on a ramp and fired at its side face, then he rests on its surface and stays outside the side face", async () => {
    const ramps = new FleetRamps(new THREE.Scene());
    const yaw = 0.6;
    ramps.place(yaw, null);
    const ax = Math.sin(yaw);
    const az = Math.cos(yaw);
    const at = (u: number, v: number) => new THREE.Vector3(u * ax + v * az, 0, u * az - v * ax);
    const drop = await system(ramps, null);
    const mid = at(RAMP.start + 2.3, 0);
    throwFrom(drop, new THREE.Vector3(mid.x, ramps.heightAt(mid.x, mid.z) + 2.5, mid.z), new THREE.Vector3(), null);
    let under = 0;
    run(drop, 4, (q) => (under = Math.max(under, ramps.heightAt(q.x, q.z) - q.y)));
    const t = dollsOf(drop)[0]!.bodies[0]!.translation();
    const gap = t.y - ramps.heightAt(t.x, t.z);
    drop.dispose();
    assert.ok(under < 0.05, `a part sank ${under.toFixed(2)} m into the ramp`);
    assert.ok(gap > 0.05 && gap < 0.5, `torso rests ${gap.toFixed(2)} m over the face`);
    // Across the wedge's side face (1.07 m tall 0.5 m up the run), from 5 m out, at mid-height; only parts alongside the wedge count.
    const side = await system(ramps, null);
    const face = at(RAMP.start + 0.5, -RAMP.halfW - 5);
    const dir = at(0, 1);
    throwFrom(side, new THREE.Vector3(face.x, 0.5 + 0.5 * 9.6 * (5 / 15) ** 2, face.z), dir.clone().multiplyScalar(15), dir);
    let reach = -Infinity;
    run(side, 3, (q) => {
      const u = q.x * ax + q.z * az;
      if (u > RAMP.start + 0.1 && u < RAMP.start + RAMP.len - 0.1) reach = Math.max(reach, q.x * az - q.z * ax);
    });
    side.dispose();
    assert.ok(reach < -RAMP.halfW + SOAK, `a part crossed the face: v ${reach.toFixed(2)} vs ${(-RAMP.halfW).toFixed(2)}`);
  });
});

describe("given a thrown dummy and the corkscrew's channel and the sandbox's lamp posts", () => {
  it("when he is dropped in the channel and fired across it, then he lies on its floor and the wall holds him in", async () => {
    const cork = new Corkscrew(new THREE.Scene());
    const z = CORKSCREW.mouthZ + 2;
    const floor = cork.heightAt(0, z, 3);
    const drop = await system(cork, null);
    throwFrom(drop, new THREE.Vector3(0, floor + 2, z), new THREE.Vector3(), null);
    let low = Infinity;
    run(drop, 3, (q) => (low = Math.min(low, q.y - cork.heightAt(q.x, q.z, q.y + 1))));
    drop.dispose();
    assert.ok(low > -0.1, `a part sank ${(-low).toFixed(2)} m into the floor`);
    const side = await system(cork, null);
    throwFrom(side, new THREE.Vector3(0, floor + 0.7, z), new THREE.Vector3(12, 0, 0), new THREE.Vector3(1, 0, 0));
    let far = 0;
    run(side, 2, (q) => (far = Math.max(far, Math.abs(q.x))));
    side.dispose();
    assert.ok(far < CORKSCREW.halfW + 0.2, `a part got ${far.toFixed(2)} m from the centre; the walls stand ${CORKSCREW.halfW} m out`);
  });

  it("when a dummy is fired at a lamp post that is standing, broken or hidden, then the standing post stops him and a broken or hidden one does not", async () => {
    const ends: number[] = [];
    for (const state of ["standing", "broken", "hidden"]) {
      const sys = await system(null, null);
      sys.poles = [{ group: { position: { x: 16, z: 0 }, visible: state !== "hidden" }, intact: state !== "broken", radius: 0.12 }];
      throwFrom(sys, new THREE.Vector3(10, 1.4, 0), new THREE.Vector3(15, 0, 0), new THREE.Vector3(1, 0, 0));
      run(sys, 3, () => {});
      ends.push(dollsOf(sys)[0]!.bodies[0]!.translation().x);
      sys.dispose();
    }
    assert.ok(ends[0]! < 16, `standing pole stops him: ${ends[0]!.toFixed(2)}`);
    assert.ok(ends[1]! > 18 && ends[2]! > 18, `a broken or hidden pole does not: ${ends[1]!.toFixed(2)}, ${ends[2]!.toFixed(2)}`);
  });
});

describe("given the ragdoll world after throws on a course, the corkscrew and the ramps", () => {
  it("when it is reset after each, then it leaves exactly the collider count it had before the throws, and a course swap drops the old solids", async () => {
    const track = stunt();
    const sys = await system(track.ground(), track);
    const peaks: number[] = [];
    // A course throw builds its patch (heightfield, walls, solids) and a second dummy another; a despawn removes its own.
    for (const [ground, at] of [[track.ground(), [-150, -80]], [new Corkscrew(new THREE.Scene()), [0, -30]], [new FleetRamps(new THREE.Scene()), [0, 0]]] as const) {
      setGround(ground);
      // The course's standing props are bodies while its ground is the active one, and go with it.
      sys.update(FRAME, [], true, false, 0, null);
      const base = colliders(sys);
      for (let n = 0; n < 2; n++) throwFrom(sys, new THREE.Vector3(at[0], 2 + n, at[1]), new THREE.Vector3(8, 0, 0), null);
      sys.update(FRAME, [], true, false, 0, null);
      peaks.push(colliders(sys) - base);
      sys.reset();
      assert.equal(colliders(sys), base, `after a reset on ${ground.constructor.name}`);
    }
    assert.ok(peaks.every((n) => n > 0), `the throws built colliders: ${peaks.join(", ")} more`);
    // The course swap: a new course drops the old solids' recipes with it.
    sys.setCourse(track, placeProps(track), null);
    assert.equal(sys["solids"], null);
    sys.dispose();
  });
});

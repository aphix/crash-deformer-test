import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { PREFABS } from "./catalog.ts";
import { placeProps, propColliders, type Placed } from "./placements.ts";
import { Track, blankProjection, projectPath, type TrackPath } from "./track.ts";
import oval from "./tracks/oval.json" with { type: "json" };

/** Distance (m) from (x, z) beyond the wall line of a corridor (< 0 = on road or runoff). */
function gap(path: TrackPath, x: number, z: number): number {
  const p = projectPath(path, x, z, -1, blankProjection());
  return Math.sqrt(p.dist2) - path.half[p.k]! - (p.lateral > 0 ? path.runL[p.k]! : path.runR[p.k]!);
}

/** Generated (along + scatter) solid props that reach onto any corridor's road or runoff. */
function onCorridor(track: Track, placed: Placed[]): string[] {
  const cols = propColliders(placed);
  const bad: string[] = [];
  for (const c of cols) {
    if (c.index < track.json.props.length || c.body !== "solid") continue;
    for (const path of [track.path, ...track.shortcuts.map((s) => s.path)]) {
      const g = gap(path, c.x, c.z);
      if (g < c.r) bad.push(`${c.prefab} #${c.index} at (${c.x.toFixed(1)}, ${c.z.toFixed(1)}) gap ${g.toFixed(2)} < r ${c.r.toFixed(2)}`);
    }
  }
  return bad;
}

describe("placements", () => {
  it("the same track places the same props and colliders every time", () => {
    const a = placeProps(new Track(oval));
    const b = placeProps(new Track(structuredClone(oval)));
    assert.ok(a.length > oval.props.length);
    assert.deepEqual(a, b);
    assert.deepEqual(propColliders(a), propColliders(b));
  });

  it("oval: along and scatter props keep off every corridor, scatter stays in its band and clear of the start line", () => {
    const t = new Track(oval);
    const placed = placeProps(t);
    assert.deepEqual(onCorridor(t, placed), []);
    const trees = placed.filter((p) => p.prefab === "tree");
    assert.equal(trees.length, 70);
    const g0 = t.gates[0]!;
    const mx = (g0.ax + g0.bx) / 2;
    const mz = (g0.az + g0.bz) / 2;
    for (const p of trees) {
      const near = Math.min(...[t.path, ...t.shortcuts.map((s) => s.path)].map((c) => gap(c, p.x, p.z)));
      assert.ok(near >= 14 && near <= 70, `tree at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) is ${near.toFixed(1)} m from the nearest wall line`);
      assert.ok(Math.hypot(p.x - mx, p.z - mz) >= 25, "tree within 25 m of the start line");
      assert.equal(p.y, t.ground().heightAt(p.x, p.z));
    }
    assert.equal(placed.filter((p) => p.prefab === "lamp").length, Math.round(t.length / 45));
  });

  it("along copies that would land on a shortcut's road are skipped", () => {
    const t = new Track({ ...oval, along: [{ prefab: "lamp", every: 6, side: "left", offset: 1 }], scatter: [] });
    const placed = placeProps(t);
    const lamps = placed.filter((p) => p.prefab === "lamp");
    assert.ok(lamps.length > 0 && lamps.length < Math.round(t.length / 6), `${lamps.length} lamps`);
    assert.deepEqual(onCorridor(t, placed), []);
  });

  it("along props face the road: front (+X) points at the centreline on both sides", () => {
    const t = new Track({ ...oval, along: [{ prefab: "billboard", every: 30, side: "both", offset: 4 }], scatter: [] });
    const boards = placeProps(t).filter((p) => p.prefab === "billboard").slice(2);
    assert.ok(boards.length > 10);
    for (const b of boards) {
      const p = projectPath(t.path, b.x, b.z, -1, blankProjection());
      const fx = Math.cos(b.yaw);
      const fz = -Math.sin(b.yaw);
      const toRoad = ((p.cx - b.x) * fx + (p.cz - b.z) * fz) / Math.hypot(p.cx - b.x, p.cz - b.z);
      assert.ok(toRoad > 0.99, `billboard at (${b.x.toFixed(1)}, ${b.z.toFixed(1)}) faces ${toRoad.toFixed(2)} away`);
    }
  });

  it("colliders scale with the prop", () => {
    const t = new Track({
      ...oval,
      props: [
        { prefab: "crate", x: 0, z: 0 },
        { prefab: "crate", x: 0, z: 10, scale: 2 },
        { prefab: "cone", x: 0, z: 20, size: [0.8, 1.4, 0.8] },
        { prefab: "gantry", x: 0, z: 30 },
      ],
      along: [],
      scatter: [],
    });
    const cols = propColliders(placeProps(t));
    assert.deepEqual(
      cols.map((c) => c.index),
      [0, 1, 2],
    );
    const [crate, big, cone] = cols;
    assert.equal(big!.hx, crate!.hx * 2);
    assert.equal(big!.hz, crate!.hz * 2);
    assert.equal(big!.mass, crate!.mass * 8);
    assert.equal(cone!.kind, "circle");
    assert.equal(cone!.r, 0.56);
    assert.equal(cone!.mass, PREFABS.cone.mass * 8);
  });

  it("a box collider of a yawed prop covers its rotated footprint, and no more", () => {
    const t = new Track({
      ...oval,
      props: [{ prefab: "billboard", x: 3, z: -7, yaw: 0.6, size: [0.5, 5, 9] }],
      along: [],
      scatter: [],
    });
    const placed = placeProps(t);
    const [c] = propColliders(placed);
    const p = placed[0]!;
    // The footprint as the art renders it: prefab-local corners through the instance transform.
    const o = new THREE.Object3D();
    o.position.set(p.x, 0, p.z);
    o.rotation.y = p.yaw;
    o.scale.set(p.sx, p.sy, p.sz);
    o.updateMatrixWorld();
    const [w, , d] = PREFABS.billboard.size;
    const inside = (v: THREE.Vector3) => {
      const dx = v.x - c!.x;
      const dz = v.z - c!.z;
      const lx = dx * Math.cos(c!.yaw) - dz * Math.sin(c!.yaw);
      const lz = dx * Math.sin(c!.yaw) + dz * Math.cos(c!.yaw);
      return Math.abs(lx) <= c!.hx + 1e-9 && Math.abs(lz) <= c!.hz + 1e-9;
    };
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      const corner = new THREE.Vector3((sx * w) / 2, 0, (sz * d) / 2).applyMatrix4(o.matrixWorld);
      assert.ok(inside(corner), `corner ${sx},${sz} outside the collider`);
      const beyondX = new THREE.Vector3((sx * w * 1.1) / 2, 0, 0).applyMatrix4(o.matrixWorld);
      const beyondZ = new THREE.Vector3(0, 0, (sz * d * 1.1) / 2).applyMatrix4(o.matrixWorld);
      assert.ok(!inside(beyondX) && !inside(beyondZ), "collider larger than the footprint");
    }
  });
});

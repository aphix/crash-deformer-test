import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Track, blankProjection, crossGate, type WallHit } from "./track.ts";
import { parseTrack, type TrackFile } from "./track-schema.ts";
import { TRACKS } from "./tracks/index.ts";

const square = (extra: Partial<TrackFile> = {}): TrackFile => ({
  id: "square",
  name: "Square",
  road: { width: 10, runoff: [2, 2] },
  nodes: [
    { x: 0, z: 0 },
    { x: 0, z: 60 },
    { x: 0, z: 120 },
    { x: 60, z: 140 },
    { x: 120, z: 120 },
    { x: 120, z: 60 },
    { x: 120, z: 0 },
    { x: 60, z: -20 },
  ],
  checkpoints: [{ node: 0 }, { node: 2 }, { node: 4 }, { node: 6 }],
  ...extra,
});

describe("track", () => {
  for (const json of TRACKS) {
    const t = new Track(json);
    it(`${t.id}: gates run forward round the loop and the grid sits behind the line on the road`, () => {
      for (let i = 1; i < t.gates.length; i++) assert.ok(t.gates[i]!.s > t.gates[i - 1]!.s, `gate ${i} not after gate ${i - 1}`);
      const p = blankProjection();
      const slots = Array.from({ length: 16 }, (_, i) => t.gridSlot(i));
      slots.forEach((g, i) => {
        t.project(g.x, g.z, -1, p);
        assert.ok(Math.abs(p.lateral) < t.path.half[p.k]! - 1, `slot ${i} off the road (lateral ${p.lateral.toFixed(1)})`);
        assert.ok(p.s > t.length - 6 - 8 * 9, `slot ${i} too far back (s ${p.s.toFixed(0)})`);
        const tx = t.path.tx[p.k]!;
        const tz = t.path.tz[p.k]!;
        assert.ok(Math.sin(g.yaw) * tx + Math.cos(g.yaw) * tz > 0.99, `slot ${i} not facing the race direction`);
        for (let j = 0; j < i; j++) assert.ok(Math.hypot(g.x - slots[j]!.x, g.z - slots[j]!.z) > 4.5, `slots ${j} and ${i} overlap`);
      });
    });
  }

  it("a gate only counts crossings in the race direction", () => {
    const t = new Track(square());
    const g = t.gates[0]!;
    assert.ok(crossGate(g, 0, -1, 0, 1) > 0.4);
    assert.equal(crossGate(g, 0, 1, 0, -1), -1);
    assert.equal(crossGate(g, 30, -1, 30, 1), -1, "outside the gate's span");
  });

  it("rejects malformed layouts with the offending path", () => {
    assert.throws(() => parseTrack(square({ checkpoints: [{ node: 1 }, { node: 2 }, { node: 4 }] })), /checkpoints\.0: checkpoint 0 must be node 0/);
    assert.throws(() => parseTrack(square({ checkpoints: [{ node: 0 }, { node: 4 }, { node: 2 }] })), /checkpoints\.2: checkpoints must run in driving order/);
    assert.throws(
      () => parseTrack(square({ shortcuts: [{ id: "a", from: 1, to: 2, path: [{ x: 1, z: 1 }, { x: 2, z: 2 }] }] })),
      /shortcuts\.0: a shortcut must skip at least one checkpoint/,
    );
    assert.throws(() => new Track(square({ road: { width: 30, runoff: [20, 20] } })), /inside its own corridor/);
  });

  it("walls push a car back inside; an opened edge lets it through", () => {
    const walled = new Track(square());
    const p = blankProjection();
    const out: WallHit = { x: 0, z: 0, nx: 0, nz: 0, k: 0 };
    // Right of the centreline at sample 30 (left = (tz, −tx)).
    const k = 30;
    const at = (t: Track, lat: number): [number, number] => [t.path.x[k]! + t.path.tz[k]! * lat, t.path.z[k]! - t.path.tx[k]! * lat];
    const [x, z] = at(walled, -6.5);
    walled.project(x, z, -1, p);
    assert.ok(walled.wallClip(x, z, 1, p, out), "beyond the right wall line");
    walled.project(out.x, out.z, p.k, p);
    assert.ok(Math.abs(p.lateral + 6) < 0.05, `put back at lateral ${p.lateral.toFixed(2)}`);
    assert.ok(out.nx * walled.path.tz[k]! - out.nz * walled.path.tx[k]! > 0.99, "normal points back to the road (left)");
    for (const lat of [-3, -20]) {
      const [qx, qz] = at(walled, lat);
      walled.project(qx, qz, -1, p);
      assert.equal(walled.wallClip(qx, qz, 1, p, out), false, `lateral ${lat}: on the road / beyond the wall band`);
    }
    const open = new Track(square({ road: { width: 10, runoff: [2, 2], wall: [true, false] } }));
    walled.project(x, z, -1, p);
    assert.equal(open.wallClip(x, z, 1, p, out), false);
  });

  it("ground: a flat course is the y = 0 plane; banking raises the right edge; grip follows the surface", () => {
    const flat = new Track(square()).ground();
    for (const [x, z] of [[0, 30], [5, 50], [60, 60], [-30, -30], [500, 500]] as const) assert.equal(flat.heightAt(x, z), 0);
    const n = flat.normalAt(0, 30, { x: 0, y: 0, z: 0 });
    assert.ok(n.y === 1 && n.x === 0 && n.z === 0, `normal ${JSON.stringify(n)}`);
    assert.equal(flat.frictionAt(0, 30), 1, "asphalt");
    assert.equal(flat.frictionAt(60, 60), 0.5, "grass infield");
    const banked = square({ nodes: square().nodes!.map((nd) => ({ ...nd, bank: 8 })) });
    const g = new Track(banked).ground();
    // Driving +Z at x = 0: right is −X.
    assert.ok(g.heightAt(-4, 60) > 0.4 && g.heightAt(4, 60) < -0.4, `right ${g.heightAt(-4, 60)} left ${g.heightAt(4, 60)}`);
    const oval = new Track(TRACKS[0]).ground();
    assert.equal(oval.frictionAt(0, -115), 0.72, "the oval's dirt service road");
  });
});

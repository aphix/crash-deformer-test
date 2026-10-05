import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Track, blankProjection, crossGate, type Projection } from "./track.ts";
import { parseTrack } from "./track-schema.ts";
import { square } from "./track.test-util.ts";
import { TRACKS } from "./tracks/index.ts";

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

    /** Each sample of every shortcut path with its projection on the main loop; the hint follows the path (two levels can share an (x, z)). */
    const walkShortcuts = (each: (id: string, i: number, last: boolean, pr: Projection) => void): void => {
      const pr = blankProjection();
      for (const sc of t.shortcuts) {
        let hint = -1;
        for (let i = 0; i < sc.path.count; i++) {
          t.project(sc.path.x[i]!, sc.path.z[i]!, hint, pr);
          hint = pr.k;
          each(sc.id, i, i === sc.path.count - 1, pr);
        }
      }
    };
    it(`${t.id}: a shortcut crosses the main wall line only where that wall is open on its side (a closed mouth wrecks every car that takes the cut)`, () => {
      const closed: string[] = [];
      let prev = { lat: 0, inside: false };
      walkShortcuts((id, i, _last, pr) => {
        const inside = Math.abs(pr.lateral) < t.path.half[pr.k]! + (pr.lateral > 0 ? t.path.runL[pr.k]! : t.path.runR[pr.k]!);
        if (i > 0 && Math.sign(prev.lat) === Math.sign(pr.lateral) && prev.inside !== inside && (pr.lateral > 0 ? t.path.wallL[pr.k] : t.path.wallR[pr.k])) {
          closed.push(`${id} sample ${i}: closed ${pr.lateral > 0 ? "left" : "right"} wall at main s ${pr.s.toFixed(0)}`);
        }
        prev = { lat: pr.lateral, inside };
      });
      assert.deepEqual(closed, []);
    });
    // `progress` runs between the shortcut's gates (RACE_DESIGN: Checkpoints), so a mouth far past its `from` gate drops every car that takes it back that far in the order, and 8 s of such a drop at the start reads as a stall (a respawn request on a car doing 40 m/s).
    const GATE_SLACK = 100;
    it(`${t.id}: every shortcut's mouth is within ${GATE_SLACK} m past its from gate and its exit within ${GATE_SLACK} m before its to gate`, () => {
      const far: string[] = [];
      let mouth = 0;
      walkShortcuts((id, i, last, pr) => {
        if (i === 0) mouth = pr.s;
        if (!last) return;
        const sc = t.shortcuts.find((c) => c.id === id)!;
        const into = (((mouth - t.gates[sc.from]!.s) % t.length) + t.length) % t.length;
        const out = ((((sc.to === 0 ? t.length : t.gates[sc.to]!.s) - pr.s) % t.length) + t.length) % t.length;
        if (into > GATE_SLACK) far.push(`${id}: mouth ${into.toFixed(0)} m past gate ${sc.from}`);
        if (out > GATE_SLACK) far.push(`${id}: exit ${out.toFixed(0)} m before gate ${sc.to}`);
      });
      assert.deepEqual(far, []);
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

  it("a bridge deck and the road under it: each car sees its own level", () => {
    const stunt = new Track(TRACKS.find((j) => parseTrack(j).id === "stunt"));
    const g = stunt.ground();
    // The figure-of-eight crosses itself at the origin: the start straight under, the deck 9 m over.
    assert.ok(Math.abs(g.heightAt(0, 0, 0.3)) < 0.05, `under the bridge ${g.heightAt(0, 0, 0.3)}`);
    assert.ok(Math.abs(g.heightAt(0, 0, 9.2) - 9) < 0.15, `on the deck ${g.heightAt(0, 0, 9.2)}`);
    assert.ok(Math.abs(g.heightAt(0, 0) - 9) < 0.15, "no layer hint: the top surface");
    assert.equal(g.surfaceAt(0, 0, 9.2), "asphalt");
    // Off the deck's side the ground below shows again, whatever the hint.
    assert.ok(g.heightAt(14, 14, 9.2) < 1, "beside the deck you fall to the ground");
  });

  it("rejects a crossover without a deck, too little headroom, or a checkpoint over the other level", () => {
    const stunt = parseTrack(TRACKS.find((j) => parseTrack(j).id === "stunt"));
    const noDeck = { ...stunt, nodes: stunt.nodes.map((nd) => ({ ...nd, deck: false })) };
    assert.throws(() => new Track(noDeck), /crosses itself .* without a deck/);
    const low = { ...stunt, nodes: stunt.nodes.map((nd) => (nd.y === 9 ? { ...nd, y: 3 } : nd)) };
    assert.throws(() => new Track(low), /a car needs 4.5 m/);
    const gateOver = { ...stunt, checkpoints: [...stunt.checkpoints.slice(0, 1), { node: 1, t: 0 }, ...stunt.checkpoints.slice(1)] };
    assert.throws(() => new Track(gateOver), /sits over another part of the loop/);
  });
});

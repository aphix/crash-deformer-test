import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Track } from "./track.ts";
import { square } from "./track.test-util.ts";
import { HAVANA } from "./tracks/havana.ts";
import { TRACKS } from "./tracks/index.ts";

describe("havana (the Survival course)", () => {
  const track = new Track(HAVANA);

  it("loads through the Track loader as a closed ring with checkpoints, and is not a race course", () => {
    assert.equal(track.id, "havana");
    assert.ok(track.gates.length >= 3, `${track.gates.length} checkpoints`);
    assert.ok(!TRACKS.some((j) => new Track(j).id === "havana"), "the race menu must not list the survival course");
  });

  it("survival anchors: the start faces the hill at the far end of the approach, the cops queue tight behind it", () => {
    const s = track.survival;
    assert.ok(s, "havana carries survival anchors");
    // Heading: forward = (sin yaw, cos yaw); the hill centre is the origin.
    const toHill = Math.atan2(-s.start.x, -s.start.z);
    assert.ok(Math.abs(Math.sin(s.start.yaw - toHill)) < 0.02, `start yaw ${s.start.yaw} does not face the hill (${toHill})`);
    assert.ok(s.formation.length >= 4 && s.formation.length <= 6, `${s.formation.length} formation slots`);
    const fx = Math.sin(s.start.yaw);
    const fz = Math.cos(s.start.yaw);
    for (const [i, c] of s.formation.entries()) {
      const behind = -((c.x - s.start.x) * fx + (c.z - s.start.z) * fz);
      assert.ok(behind > 4 && behind < 40, `slot ${i} is ${behind.toFixed(1)} m behind the start`);
      for (let j = 0; j < i; j++) assert.ok(Math.hypot(c.x - s.formation[j]!.x, c.z - s.formation[j]!.z) > 4.5, `slots ${j} and ${i} overlap`);
    }
  });

  it("a course without survival anchors has none", () => {
    assert.equal(new Track(square()).survival, null);
  });
});

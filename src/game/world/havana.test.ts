import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PREFABS } from "./catalog.ts";
import { placeProps, propColliders } from "./placements.ts";
import { Track } from "./track.ts";
import { square } from "./track.test-util.ts";
import { HAVANA } from "./tracks/havana.ts";
import { OFF_MENU, TRACKS } from "./tracks/index.ts";

describe("given the Survival course Havana", () => {
  const track = new Track(HAVANA);

  it("when it is loaded through the Track loader, then it is a closed ring with checkpoints and is not a race course (the race menu does not list it and the race loader resolves it by id)", () => {
    assert.equal(track.id, "havana");
    assert.ok(track.gates.length >= 3, `${track.gates.length} checkpoints`);
    assert.ok(!TRACKS.some((j) => new Track(j).id === "havana"), "the race menu must not list the survival course");
    assert.ok(OFF_MENU.includes(HAVANA), "the race loader resolves it by id");
  });

  it("when its Survival anchors are read, then the start faces the hill at the far end of the approach and the cops queue tight behind it", () => {
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

  describe("given the square course, which has no Survival anchors", () => {
    it("when it is loaded, then its Survival anchors are null", () => {
      assert.equal(new Track(square()).survival, null);
    });
  });

  describe("given Havana's layout, as the friend's spec and the owner's pictures ask for it", () => {
    const plateau = track.json.environment.plateaus[0]!;
    const ground = track.ground();
    const placed = placeProps(track);
    const colliders = propColliders(placed);
    const route = (id: string) => track.routes.find((r) => r.id === id)!;
    /** Solid props (not palms) as circles: centre, radius, height. */
    const solids = colliders.filter((c) => c.prefab !== "palm").map((c) => ({ x: c.x, z: c.z, r: c.kind === "circle" ? c.r : Math.hypot(c.hx, c.hz), h: PREFABS[c.prefab].size[1] * placed[c.index]!.sy, prefab: c.prefab }));

    it("when the plateau and its face are measured, then it rises 4-6 m over 15-22 m with a 20-25 m launch face, a plaza about 25 x 35 m and a ring road 10-12 m wide, the plaza paved, the face grass and the island round it lawn", () => {
      assert.ok(plateau.height >= 4 && plateau.height <= 6, `rise ${plateau.height} m`);
      assert.ok(plateau.run[3] >= 15 && plateau.run[3] <= 22, `the near face runs ${plateau.run[3]} m`);
      assert.ok(2 * plateau.halfX >= 20 && 2 * plateau.halfX <= 25, `the face is ${2 * plateau.halfX} m wide`);
      assert.ok(2 * plateau.halfZ >= 30 && 2 * plateau.halfZ <= 40, `the plaza is ${2 * plateau.halfX} x ${2 * plateau.halfZ} m`);
      assert.ok(plateau.run[3] > 0 && 2 * track.path.half[0]! >= 10 && 2 * track.path.half[0]! <= 12, `the foot road is ${2 * track.path.half[0]!} m wide`);
      assert.equal(ground.heightAt(0, 0), plateau.height);
      assert.equal(ground.surfaceAt(0, 0), "concrete", "the plaza is paved");
      assert.equal(ground.surfaceAt(0, 28), "grass", "the face is grass");
      assert.equal(ground.surfaceAt(-30, -20), "grass", "the island round it is lawn");
    });

    it("when the approach is measured, then it is a 18-24 m boulevard at least 200 m long aimed at the hill, with palms on its edges, a clear centre corridor and the monument in view from the start", () => {
      const b = route("boulevard");
      assert.ok(2 * b.path.half[0]! >= 18 && 2 * b.path.half[0]! <= 24, `${2 * b.path.half[0]!} m wide`);
      assert.ok(b.path.length >= 200, `${b.path.length.toFixed(0)} m long`);
      assert.ok(Math.abs(b.path.tx[0]!) < 1e-6 && b.path.tz[0]! < 0, "it runs straight at the hill");
      const palms = placed.filter((p) => p.prefab === "palm" && p.z > 60 && Math.abs(p.x) < 25);
      assert.ok(palms.length >= 20 && palms.every((p) => Math.abs(p.x) > 10), `${palms.length} palms, none in the centre corridor`);
      assert.ok(solids.every((s) => s.z < 60 || s.z > 470 || Math.abs(s.x) - s.r >= 10), "no solid in the corridor");
      // The sight line from the driver's eye at the start to the monument's top: no block taller than the line stands in it.
      const start = track.survival!.start;
      const mon = solids.find((s) => s.prefab === "monument")!;
      for (const s of solids.filter((q) => q !== mon)) {
        const d = ((s.x - start.x) * (mon.x - start.x) + (s.z - start.z) * (mon.z - start.z)) / Math.hypot(mon.x - start.x, mon.z - start.z) ** 2;
        if (d < 0 || d > 1) continue;
        const off = Math.hypot(start.x + (mon.x - start.x) * d - s.x, start.z + (mon.z - start.z) * d - s.z);
        assert.ok(off > s.r || 1.5 + (PREFABS.monument.size[1] - 1.5) * d > s.h, `a ${s.prefab} at (${s.x.toFixed(0)}, ${s.z.toFixed(0)}) blocks the monument`);
      }
    });

    it("when the monument is measured, then it is a solid star-plan tower near the plaza's centre, with a clear driving strip on its left", () => {
      const m = colliders.find((c) => c.prefab === "monument")!;
      assert.ok(m.kind === "circle" && m.r >= 5, "a solid circle of the tower's footprint");
      assert.ok(Math.hypot(m.x - plateau.x, m.z - plateau.z) < 8, "near the centre");
      assert.equal(placed[m.index]!.y, plateau.height, "standing on the plaza");
      assert.ok(PREFABS.monument.size[1] >= 40, "tall");
      assert.ok(m.x - (m as { r: number }).r - (plateau.x - plateau.halfX) >= 8, "at least 8 m of plaza clear on its left");
    });

    it("when the escape alley is measured, then it is narrow and along the plaza's left edge, with stucco walls (solid) and a dumpster (a collider) at a corner", () => {
      const a = route("alley");
      assert.ok(2 * a.path.half[0]! <= 6.5, `${2 * a.path.half[0]!} m wide`);
      assert.ok(a.path.x[0]! < plateau.x - plateau.halfX && a.path.x[0]! > plateau.x - plateau.halfX - 30, "left of the plaza's edge");
      const walls = placed.filter((p) => p.prefab === "wall" && Math.abs(p.x - a.path.x[0]!) < 4.5 && Math.abs(p.yaw - Math.round(p.yaw / Math.PI) * Math.PI) < 0.01);
      assert.ok(walls.length >= 4, `${walls.length} wall panels along it`);
      const stub = placed.find((p) => p.prefab === "wall" && Math.abs(Math.abs(p.yaw) - Math.PI / 2) < 0.01)!;
      const bin = placed.find((p) => p.prefab === "dumpster")!;
      assert.ok(stub && bin && Math.hypot(bin.x - stub.x, bin.z - stub.z) < 4, "the dumpster stands by the stub wall's corner");
      for (const id of ["wall", "dumpster"] as const) assert.ok(PREFABS[id].body === "solid" && PREFABS[id].collider, `${id} is solid`);
    });

    it("when the landing beyond the crest is checked, then the area is open with room for several cops (no solid within 60 m of the line, 70-215 m past the plaza), the paseo asphalt and the lawn beside it grass", () => {
      const inRoom = solids.filter((s) => Math.abs(s.x) < 60 && s.z < -66 && s.z > -215);
      assert.deepEqual(inRoom.map((s) => `${s.prefab} (${s.x.toFixed(0)}, ${s.z.toFixed(0)})`), []);
      assert.equal(ground.surfaceAt(0, -120), "asphalt", "the paseo");
      assert.equal(ground.surfaceAt(40, -120), "grass", "the lawn beside it");
    });

    it("when the start and the five cop slots are checked, then they stand on the boulevard's asphalt, clear of every prop", () => {
      const s = track.survival!;
      for (const [i, a] of [s.start, ...s.formation].entries()) {
        assert.equal(ground.surfaceAt(a.x, a.z), "asphalt", `anchor ${i}`);
        assert.ok(colliders.every((c) => Math.hypot(c.x - a.x, c.z - a.z) > (c.kind === "circle" ? c.r : Math.hypot(c.hx, c.hz)) + 3), `anchor ${i} is by a prop`);
      }
    });
  });
});

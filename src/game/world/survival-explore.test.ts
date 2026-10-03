import { describe, it } from "node:test";
import { HAVANA } from "./tracks/havana.ts";
import { hold, leaveSurvival, play, survivalWorld } from "./survival-run.test-util.ts";
import type { World } from "./race-world.test-util.ts";

const wall = { prefab: "building", x: 0, z: 392, yaw: 0, scale: 1, size: [30, 14, 14] };
const course = { ...(HAVANA as object), props: [wall] };

describe("explore", () => {
  it("cops round a building to a held player", (t) => {
    const w = survivalWorld(course);
    try {
      let moved = false;
      const log: string[] = [];
      const player = (ww: World, tt: number): void => {
        if (!moved && ww.race.phase === "racing") {
          moved = true;
          ww.cars[0]!.spawnFacing(0, 340, Math.PI, 0);
        }
        if (Math.abs(tt - Math.round(tt)) < 1 / 120) {
          const q = ww.cars[0]!;
          log.push(`${tt.toFixed(0)}s ${q.group.position.x.toFixed(0)},${q.group.position.z.toFixed(0)},${q.group.position.y.toFixed(1)} v${q.velocity.length().toFixed(1)} out ${q.driverOut} up ${q.group.matrixWorld.elements[5]!.toFixed(2)}`);
        }
        hold(ww);
      };
      const r = play(w, { seconds: 40, player, cam: false });
      t.diagnostic(log.join("\n"));
      const p = w.cars[0]!.group.position;
      t.diagnostic(`player ${p.x.toFixed(0)},${p.z.toFixed(0)} ends ${JSON.stringify(r.ends)}`);
      t.diagnostic(`gaps ${r.gaps.map((g) => g.nearest.toFixed(0)).join(" ")}`);
      t.diagnostic(`stuck ${JSON.stringify(r.stuck)}`);
      for (let i = 1; i <= 6; i++) {
        const c = w.cars[i]!.group.position;
        t.diagnostic(`cop ${i} at ${c.x.toFixed(0)},${c.z.toFixed(0)} d=${Math.hypot(c.x - p.x, c.z - p.z).toFixed(0)}`);
      }
    } finally {
      leaveSurvival(w);
    }
  });
});

import { describe, it } from "node:test";
import { Track } from "./track.ts";
import { HAVANA } from "./tracks/havana.ts";
import { leaveSurvival, play, steerAt, survivalWorld } from "./survival-run.test-util.ts";
import type { World } from "./race-world.test-util.ts";
import { placeProps, propColliders } from "./placements.ts";

const track = new Track(HAVANA);

function ring(): [number, number][] {
  const p = track.path;
  const pts: [number, number][] = [];
  for (let k = 0; k < p.count; k += 18) pts.push([p.x[k]!, p.z[k]!]);
  return pts;
}
const SHUTTLE: [number, number][] = [[-4, -200], [0, 120]];

function tour(pts: readonly (readonly [number, number])[], cap: number | null): (w: World) => void {
  let i = 0;
  return (w) => {
    const car = w.cars[0]!.group.position;
    if (Math.hypot(pts[i]![0] - car.x, pts[i]![1] - car.z) < 14) i = (i + 1) % pts.length;
    steerAt(w, pts[i]![0], pts[i]![1], cap);
  };
}

describe("explore", () => {
  for (const [name, pts, cap] of [["ring 22", ring(), 22], ["shuttle", SHUTTLE, null], ["ring 12", ring(), 12]] as const) {
    it(name, (t) => {
      const w = survivalWorld();
      try {
        const cols = propColliders(placeProps(track));
        const r = play(w, { seconds: Number(process.env.SECS ?? 100), player: tour(pts, cap), retry: true });
        for (const st of r.stuck) t.diagnostic(`stuck cop ${st.id} at ${st.x.toFixed(1)},${st.z.toFixed(1)} t${st.t.toFixed(0)} ${st.seconds.toFixed(1)}s near: ` + cols.filter((c) => Math.hypot(c.x - st.x, c.z - st.z) < 14).map((c) => `${c.prefab}(${c.x.toFixed(0)},${c.z.toFixed(0)} h${c.hx.toFixed(0)}x${c.hz.toFixed(0)} y${c.yaw.toFixed(2)})`).join(" "));
        t.diagnostic(`${name}: ends ${r.ends.map((e) => `${e.cause}@${e.t.toFixed(0)}`).join(" ")} spawns ${r.spawns.length} stuck ${r.stuck.length}`);
      } finally {
        leaveSurvival(w);
      }
    });
  }
});

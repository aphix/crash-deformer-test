import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "./ground.ts";
import { makeWorld, playerRace, type PlayerLine, type World } from "./race-world.test-util.ts";
import { Track } from "./track.ts";
import oval from "./tracks/oval.json" with { type: "json" };

/**
 * The owner's "counted DNF, had to do an extra lap": the PLAYER slot, driven through the real seat,
 * must be scored on the same lap count as the AI however it drives the oval. The service road runs
 * through the open infield; before the fix a car beside the dirt or straight across the infield
 * crossed the shortcut's mouth gate, missed the next one and lost the whole lap without a word.
 */
const LAPS = 3;
const track = new Track(oval);
const sc = track.shortcuts[0]!;
const fromS = track.gates[sc.from]!.s + 30;
const road = Array.from({ length: sc.path.count }, (_, k) => [sc.path.x[k]!, sc.path.z[k]!] as const);

const LINES: Record<string, PlayerLine> = {
  "the high line": { lat: -7.5 },
  "the apron": { lat: 10.5 },
  "a respawn mid-race": { lat: 0, respawnAt: 45 },
  "the grass beside the service road": { lat: 0, detour: { fromS, pts: road.map(([x, z]) => [x * 0.85, z + 5] as const) } },
  "straight across the infield": { lat: 0, detour: { fromS, pts: [[44, -55], [0, -62], [-44, -55]] } },
};

describe("the player's car is scored like the AI's", () => {
  let w: World;
  before(() => {
    w = makeWorld();
    w.race.enter();
  });
  after(() => {
    w.race.exit();
    setGround(null);
  });
  for (const [name, line] of Object.entries(LINES)) {
    it(`oval, ${LAPS} laps, the player on ${name}: home on full distance, HUD lap and place = the rules'`, (t) => {
      const o = playerRace(w, track, line, LAPS, 3, 220);
      t.diagnostic(`${name}: you ${o.you.status} P${o.you.place} ${o.you.time?.toFixed(1) ?? "-"} s, ${o.you.laps} laps; AI ${o.ai.map((a) => `${a.status}/${a.laps}`).join(" ")}`);
      assert.equal(o.you.status, "finished", `you ${o.you.status} on ${o.you.laps} laps`);
      assert.equal(o.you.laps, LAPS);
      assert.ok(o.ai.every((a) => a.laps === LAPS), "the AI on the same distance");
      assert.ok(o.samples > 100);
      assert.equal(o.hudLapMismatch, 0, "HUD lap = rules lap");
      assert.equal(o.hudPlaceMismatch, 0, "HUD place = rules place");
    });
  }
});

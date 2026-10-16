import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CHEVRON_GAP, CHEVRON_RUN, CHEVRON_SLOTS, CHEVRON_TURN, PREFAB } from "./constants.ts";
import { junctionsOf } from "./junctions.ts";
import { placeProps, type Placed } from "./placements.ts";
import { Track, blankPoint, blankProjection, projectPath } from "./track.ts";
import { TRACKS } from "./tracks/index.ts";

type Vec = { x: number; z: number };

/** One end of a shortcut that turns more than `CHEVRON_TURN`: the way the drivers it is for come in, the way they turn, and the boards of its run. */
type Run = { shortcut: string; end: "mouth" | "rejoin"; endS: number; approach: Vec; target: Vec; boards: Placed[] };

const unit = (x: number, z: number): Vec => ({ x: x / Math.hypot(x, z), z: z / Math.hypot(x, z) });
const dot = (a: Vec, b: Vec): number => a.x * b.x + a.z * b.z;
/** > 0 when `to` points to the left of `from` (+X at yaw 0 is the left of +Z). */
const leftOf = (from: Vec, to: Vec): number => to.x * from.z - to.z * from.x;
const turnBetween = (from: Vec, to: Vec): number => Math.atan2(Math.abs(leftOf(from, to)), dot(from, to));

/**
 * Every shortcut end of `track` that turns more than `CHEVRON_TURN`, with its run: the course's chevron boards in the order
 * `placeProps` lays them (per shortcut, its mouth's run then its rejoin's, `CHEVRON_RUN` boards each). The way in and the way
 * to turn come from the paths' own tangents, not from the placement. `boards` is every chevron of the course.
 */
function runsOf(track: Track): { runs: Run[]; boards: Placed[] } {
  const boards = placeProps(track).filter((p) => p.prefab === PREFAB.chevron);
  const point = blankPoint();
  const loopHeading = (s: number): Vec => {
    const at = track.pointAt(s, point);
    return { x: at.tx, z: at.tz };
  };
  const runs: Run[] = [];
  for (const [i, junction] of junctionsOf(track).entries()) {
    const shortcut = track.shortcuts[i]!;
    const path = shortcut.path;
    const last = path.count - 1;
    const ends = [
      { end: "mouth", endS: junction.mouthS, approach: loopHeading(junction.mouthS), target: unit(path.x[1]! - path.x[0]!, path.z[1]! - path.z[0]!) },
      { end: "rejoin", endS: junction.exitS, approach: unit(path.x[last]! - path.x[last - 1]!, path.z[last]! - path.z[last - 1]!), target: loopHeading(junction.exitS) },
    ] as const;
    for (const end of ends) {
      if (turnBetween(end.approach, end.target) <= CHEVRON_TURN) continue;
      runs.push({ shortcut: shortcut.id, ...end, boards: boards.slice(runs.length * CHEVRON_RUN, (runs.length + 1) * CHEVRON_RUN) });
    }
  }
  return { runs, boards };
}

/** Courses by the number of shortcut ends turning more than `CHEVRON_TURN` (30°): oval's service road leaves and rejoins at 26°, rally's ridge track rejoins at 29°. */
const runCounts = [
  { it: "when the oval's one shortcut is measured, then both its ends are under 30° and it gets no run", track: "oval", expectedRuns: 0 },
  { it: "when rally's two shortcuts are measured, then three of their four ends turn more than 30°", track: "rally", expectedRuns: 3 },
  { it: "when the city's one shortcut is measured, then both its ends get a run", track: "city", expectedRuns: 2 },
  { it: "when stunt's one shortcut is measured, then both its ends get a run", track: "stunt", expectedRuns: 2 },
  { it: "when four-count's two shortcuts are measured, then all four ends get a run", track: "four-count", expectedRuns: 4 },
  { it: "when dam-spine's one shortcut is measured, then both its ends get a run", track: "dam-spine", expectedRuns: 2 },
  { it: "when razor-shelf's one shortcut is measured, then both its ends get a run", track: "razor-shelf", expectedRuns: 2 },
  { it: "when breaker-yard's two shortcuts are measured, then all four ends get a run", track: "breaker-yard", expectedRuns: 4 },
] as const;

const withShortcuts = TRACKS.map((json) => new Track(json)).filter((track) => track.shortcuts.length > 0);

describe("given the courses that have shortcuts", () => {
  it("when they are listed against the run-count table, then none is missing from it and none is extra", () => {
    assert.equal(
      withShortcuts.map((track) => track.id).join(","),
      runCounts.map((testCase) => testCase.track).join(","),
      "courses with shortcuts, in course order",
    );
  });

  for (const testCase of runCounts) {
    it(testCase.it, () => {
      const track = withShortcuts.find((t) => t.id === testCase.track)!;
      const { runs, boards } = runsOf(track);
      assert.equal(runs.length, testCase.expectedRuns, "shortcut ends turning more than 30°");
      assert.equal(boards.length, testCase.expectedRuns * CHEVRON_RUN, "chevron boards on the course");
    });
  }
});

/** Signed arc length (m) from `from` to `to` along the closed main loop, in [−length/2, length/2). */
function loopDistance(track: Track, from: number, to: number): number {
  return ((((to - from) % track.length) + 1.5 * track.length) % track.length) - track.length / 2;
}

for (const track of withShortcuts) {
  const { runs } = runsOf(track);
  describe(`given the ${track.id} course's shortcut junctions that turn more than 30°`, () => {
    it("when each board is measured against the drivers it is for, then a face of it stands within 45° of square to their approach", () => {
      for (const run of runs) {
        for (const [b, board] of run.boards.entries()) {
          const faceNormal = { x: Math.cos(board.yaw), z: -Math.sin(board.yaw) };
          const square = Math.abs(dot(faceNormal, run.approach));
          assert.ok(square >= Math.cos(Math.PI / 4), `${run.shortcut} ${run.end} board ${b} turns ${(Math.acos(square) * 180) / Math.PI} degrees off square to its drivers`);
        }
      }
    });

    it("when each board's arrow is read, then it points into the shortcut at a mouth and along the race direction at a rejoin", () => {
      for (const run of runs) {
        for (const [b, board] of run.boards.entries()) {
          const arrow = { x: -Math.sin(board.yaw), z: -Math.cos(board.yaw) };
          assert.ok(dot(arrow, run.target) > 0, `${run.shortcut} ${run.end} board ${b}: arrow points ${dot(arrow, run.target).toFixed(2)} along the way to turn`);
          assert.equal(Math.sign(leftOf(run.approach, arrow)), Math.sign(leftOf(run.approach, run.target)), `${run.shortcut} ${run.end} board ${b}: arrow on the side of the turn`);
        }
      }
    });

    it("when the face a driver sees is read, then it shows '>' for a turn to the right and '<' for a turn to the left", () => {
      for (const run of runs) {
        for (const [b, board] of run.boards.entries()) {
          const frontToDriver = -(Math.cos(board.yaw) * run.approach.x - Math.sin(board.yaw) * run.approach.z) > 0;
          assert.equal(frontToDriver, leftOf(run.approach, run.target) < 0, `${run.shortcut} ${run.end} board ${b}: the '>' face toward drivers who turn right`);
        }
      }
    });

    it("when each board's side of the loop is read, then it stands on the outside of the turn", () => {
      const proj = blankProjection();
      const point = blankPoint();
      for (const run of runs) {
        for (const [b, board] of run.boards.entries()) {
          projectPath(track.path, board.x, board.z, -1, proj);
          const at = track.pointAt(proj.s, point);
          const offset = { x: board.x - proj.cx, z: board.z - proj.cz };
          const side = leftOf({ x: at.tx, z: at.tz }, offset);
          assert.equal(Math.sign(side), -Math.sign(leftOf(run.approach, run.target)), `${run.shortcut} ${run.end} board ${b}: opposite the side the drivers turn to`);
        }
      }
    });

    it(`when each board's place along the loop is read, then a mouth's run leads up to it and a rejoin's leads on from it, within ${CHEVRON_SLOTS} slots of ${CHEVRON_GAP} m`, () => {
      const proj = blankProjection();
      const reach = CHEVRON_SLOTS * CHEVRON_GAP;
      for (const run of runs) {
        for (const [b, board] of run.boards.entries()) {
          projectPath(track.path, board.x, board.z, -1, proj);
          const along = loopDistance(track, run.endS, proj.s) * (run.end === "mouth" ? -1 : 1);
          assert.ok(along >= -CHEVRON_GAP && along <= reach + CHEVRON_GAP, `${run.shortcut} ${run.end} board ${b} stands ${along.toFixed(1)} m ahead of the junction along the run's way`);
        }
      }
    });
  });
}

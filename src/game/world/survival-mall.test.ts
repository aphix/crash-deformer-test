import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HUNT } from "../ai/hunter.ts";
import { FRAME, frame, makeWorld, type World } from "./race-world.test-util.ts";
import { TRACK_ID } from "./constants.ts";
import { placeProps, propColliders } from "./placements.ts";
import { hold, leaveSurvival, play, steerAt } from "./survival-run.test-util.ts";
import { Track } from "./track.ts";
import { TRACKS } from "./tracks/index.ts";

/**
 * Survival on the National Mall (docs/SURVIVAL.md): the course the owner asked for, picked from the Survival course list, started on
 * the race's start line and facing the Washington Monument down the middle of the Mall, closed all round, with the White House
 * guards still on duty.
 */

const mall = TRACKS.find((j) => new Track(j).id === TRACK_ID.nationalMall)!;
const track = new Track(mall);
const spec = track.survival!;
const monument = placeProps(track).find((p) => p.prefab === "obelisk")!;

/** A world whose Survival run is on the Mall, picked as Survival's own menu picks it (the course card, then Start survival). */
function mallWorld(seed = 1): World {
  const w = makeWorld();
  w.race.reseed(seed);
  w.race.enter(true, false, true);
  w.race.command({ type: "survivalCourse", id: TRACK_ID.nationalMall });
  w.race.command({ type: "start" });
  return w;
}

function toGreen(w: World, state: { acc: number }): void {
  for (let n = 0; n * FRAME < 8 && w.race.phase !== "racing"; n++) frame(w, state);
  assert.equal(w.race.phase, "racing");
}

describe("given the Survival course list", () => {
  it("when Survival's menu reads it, then it offers Havana and Washington DC with no run behind it, Havana picked until the player picks the Mall, and a course Survival is not played on is refused", () => {
    const w = makeWorld();
    try {
      w.race.enter(true, false, true);
      const first = w.race.hud();
      assert.equal(first.menu, "survival");
      assert.equal(first.phase, null, "no run until Start");
      assert.equal(first.survivalCourses.map((c) => c.id).join(), `havana,${TRACK_ID.nationalMall}`);
      assert.equal(first.survivalCourses[1]!.name, "Washington DC");
      assert.equal(first.survivalCourse, "havana");
      w.race.command({ type: "survivalCourse", id: TRACK_ID.nationalMall });
      assert.equal(w.race.hud().survivalCourse, TRACK_ID.nationalMall);
      assert.equal(w.race.courseId, TRACK_ID.nationalMall, "the course behind the menu follows the pick");
      w.race.command({ type: "survivalCourse", id: "oval" });
      assert.equal(w.race.hud().survivalCourse, TRACK_ID.nationalMall, "the oval has no Survival anchors");
      assert.equal(w.race.hud().menu, "survival", "picking starts nothing");
      assert.equal(w.race.hud().phase, null);
    } finally {
      leaveSurvival(w);
    }
  });
});

describe("given a Survival run on the National Mall", () => {
  it("when the run starts, then the player is on the race's start line facing the Washington Monument down the Mall and the cops are queued behind it, on the other side of 3rd Street from the monument", () => {
    const w = mallWorld();
    try {
      assert.equal(w.race.courseId, TRACK_ID.nationalMall);
      assert.equal(w.race.survival, true);
      const car = w.cars[0]!;
      const at = car.group.position;
      const pole = track.gridSlot(0);
      assert.ok(Math.hypot(at.x - pole.x, at.z - pole.z) < 5, `the player is ${Math.hypot(at.x - pole.x, at.z - pole.z).toFixed(1)} m from the race's pole slot`);
      const toMonument = Math.atan2(monument.x - at.x, monument.z - at.z);
      const facing = Math.atan2(car.fwdFlat.x, car.fwdFlat.z);
      const off = Math.abs(Math.atan2(Math.sin(facing - toMonument), Math.cos(facing - toMonument)));
      assert.ok(off < (3 * Math.PI) / 180, `the car faces ${((off * 180) / Math.PI).toFixed(1)}° off the monument`);
      for (const [k, f] of spec.formation.entries()) {
        const cop = w.cars[1 + k]!.group.position;
        const behind = -((cop.x - at.x) * car.fwdFlat.x + (cop.z - at.z) * car.fwdFlat.z);
        assert.ok(behind > 10, `cop ${k} is ${behind.toFixed(1)} m behind the player`);
        assert.ok(Math.hypot(cop.x - f.x, cop.z - f.z) < 0.01, `cop ${k} is on its slot`);
      }
    } finally {
      leaveSurvival(w);
    }
  });

  it("when the pack is played against for 150 s, then cops keep dropping in and none appears in the chase camera's view", (t) => {
    const w = mallWorld();
    try {
      const r = play(w, { seconds: 150, player: (ww) => steerAt(ww, monument.x, monument.z, null), retry: true });
      const seen = r.spawns.filter((s) => s.visible);
      t.diagnostic(`${r.spawns.length} drop-ins over ${r.ends.length + 1} runs, nearest ${Math.min(...r.spawns.map((s) => s.dist)).toFixed(0)} m, ${seen.length} visible`);
      assert.ok(r.spawns.length >= 8, `only ${r.spawns.length} drop-ins: the invariant would be vacuous`);
      assert.deepEqual(seen, [], `cops appeared in view: ${JSON.stringify(seen.slice(0, 3))}`);
      assert.ok(r.spawns.every((s) => s.dist >= HUNT.dropMin - 1e-6), "a drop-in closer than the minimum");
    } finally {
      leaveSurvival(w);
    }
  });

  it("when the player's car stops on the White House's North Lawn, then the guards are on duty as in the race: its engine dies and the run ends wrecked", () => {
    const w = mallWorld();
    try {
      const state = { acc: 0 };
      toGreen(w, state);
      w.cars[0]!.spawnFacing(-1000, -1090, 0, 0);
      for (let n = 0; n * FRAME < 20 && w.race.hud().phase !== "finished"; n++) {
        hold(w);
        frame(w, state);
      }
      assert.equal(w.race.hud().survival?.result?.cause, "wrecked", "the guards' fire is what ends the run");
    } finally {
      leaveSurvival(w);
    }
  });
});

describe("given the National Mall as a Survival course, a city closed by a rim of blocks round it", () => {
  /** The rim: the blocks outside the street grid, one row on each side (the course file's `building` props standing along its edge). */
  const rim = track.json.props.filter((p) => p.prefab === "building" && p.size?.[1] === 20 && (p.size[0] === 12 || p.size[2] === 12));

  it("when a car-sized disc spreads from the player's start through the course's solids, then it cannot reach the edge of the world", (t) => {
    const placed = placeProps(track);
    const solids = propColliders(placed).filter((c) => c.body === "solid" && c.base - placed[c.index]!.y < 1.38);
    const half = 1.1;
    const BUCKET = 64;
    const buckets = new Map<number, typeof solids>();
    const key = (bx: number, bz: number): number => bx * 4096 + bz;
    for (const c of solids) {
      const r = c.r + half;
      for (let bx = Math.floor((c.x - r) / BUCKET); bx <= Math.floor((c.x + r) / BUCKET); bx++) {
        for (let bz = Math.floor((c.z - r) / BUCKET); bz <= Math.floor((c.z + r) / BUCKET); bz++) {
          const at = buckets.get(key(bx, bz));
          if (at) at.push(c);
          else buckets.set(key(bx, bz), [c]);
        }
      }
    }
    const blocked = (x: number, z: number): boolean => {
      for (const c of buckets.get(key(Math.floor(x / BUCKET), Math.floor(z / BUCKET))) ?? []) {
        const ex = x - c.x;
        const ez = z - c.z;
        if (ex * ex + ez * ez > (c.r + half) ** 2) continue;
        if (c.kind === "circle") return true;
        const cos = Math.cos(c.yaw);
        const sin = Math.sin(c.yaw);
        if (Math.abs(ex * cos - ez * sin) < c.hx + half && Math.abs(ex * sin + ez * cos) < c.hz + half) return true;
      }
      return false;
    };
    const CELL = 2;
    const b = track.bounds;
    const x0 = Math.floor(b.minX - 150);
    const z0 = Math.floor(b.minZ - 150);
    const nx = Math.ceil((b.maxX + 150 - x0) / CELL);
    const nz = Math.ceil((b.maxZ + 150 - z0) / CELL);
    const seen = new Uint8Array(nx * nz);
    const start = spec.start;
    const first = Math.round((start.z - z0) / CELL) * nx + Math.round((start.x - x0) / CELL);
    const queue: number[] = [first];
    seen[first] = 1;
    let edge = 0;
    for (let q = 0; q < queue.length; q++) {
      const c = queue[q]!;
      const i = c % nx;
      const j = (c - i) / nx;
      if (i === 0 || j === 0 || i === nx - 1 || j === nz - 1) edge++;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const u = i + di;
        const v = j + dj;
        if (u < 0 || v < 0 || u >= nx || v >= nz || seen[v * nx + u]) continue;
        seen[v * nx + u] = 1;
        if (!blocked(x0 + u * CELL, z0 + v * CELL)) queue.push(v * nx + u);
      }
    }
    t.diagnostic(`${queue.length} cells reachable from the start; ${edge} on the edge of the ${nx} x ${nz} window of ${CELL} m cells; ${rim.length} rim blocks`);
    assert.ok(queue.length > 100_000, `the disc spread to ${queue.length} cells only: the streets and lawns are open`);
    assert.equal(edge, 0, `a car can drive from the start to the edge of the world (${edge} edge cells reached)`);
  });

  it("when a car at 60 m/s is aimed at each side of the rim at a block's middle, a seam and a corner, then it is stopped inside", (t) => {
    const xs = rim.map((p) => p.x);
    const zs = rim.map((p) => p.z);
    const west = Math.min(...xs) + 6;
    const east = Math.max(...xs) - 6;
    const south = Math.min(...zs) + 6;
    const north = Math.max(...zs) - 6;
    const RUN = 45;
    type Launch = { name: string; x: number; z: number; yaw: number };
    /** Where the blocks of one side stand along it, sorted; the middle seam is halfway between the two blocks round the middle. */
    const row = (side: (p: (typeof rim)[number]) => boolean, along: "x" | "z"): { block: number; seam: number } => {
      const at = rim.filter(side).map((p) => p[along]).sort((a, b) => a - b);
      const k = at.length >> 1;
      return { block: at[k]!, seam: (at[k]! + at[k + 1]!) / 2 };
    };
    const southRow = row((p) => p.z === Math.min(...zs), "x");
    const northRow = row((p) => p.z === Math.max(...zs), "x");
    const westRow = row((p) => p.x === Math.min(...xs), "z");
    const eastRow = row((p) => p.x === Math.max(...xs), "z");
    const launches: Launch[] = [
      { name: "south block middle", x: southRow.block, z: south + RUN, yaw: Math.PI },
      { name: "south seam", x: southRow.seam, z: south + RUN, yaw: Math.PI },
      { name: "north block middle", x: northRow.block, z: north - RUN, yaw: 0 },
      { name: "north seam", x: northRow.seam, z: north - RUN, yaw: 0 },
      { name: "west block middle", x: west + RUN, z: westRow.block, yaw: -Math.PI / 2 },
      { name: "west seam", x: west + RUN, z: westRow.seam, yaw: -Math.PI / 2 },
      { name: "east block middle", x: east - RUN, z: eastRow.block, yaw: Math.PI / 2 },
      { name: "east seam", x: east - RUN, z: eastRow.seam, yaw: Math.PI / 2 },
      { name: "south-east corner", x: east - RUN, z: south + RUN, yaw: (3 * Math.PI) / 4 },
      { name: "south-west corner", x: west + RUN, z: south + RUN, yaw: (-3 * Math.PI) / 4 },
      { name: "north-east corner", x: east - RUN, z: north - RUN, yaw: Math.PI / 4 },
      { name: "north-west corner", x: west + RUN, z: north - RUN, yaw: -Math.PI / 4 },
    ];
    /** How far the car's centre is outside the faces (m): positive = through the rim. */
    const past = (x: number, z: number): number => Math.max(west - x, x - east, south - z, z - north);
    let deepest = -Infinity;
    for (const l of launches) {
      const w = mallWorld();
      try {
        const state = { acc: 0 };
        toGreen(w, state);
        const car = w.cars[0]!;
        car.spawnFacing(l.x, l.z, l.yaw, 60);
        let far = -Infinity;
        for (let n = 0; n < 60 * 2; n++) {
          const seat = w.seat;
          seat.mode = "drive";
          seat.carIndex = 0;
          seat.intent.analogGas = true;
          seat.intent.gas = 1;
          seat.intent.analogWheel = true;
          seat.intent.wheel = 0;
          seat.intent.handbrake = false;
          seat.intent.brake = 0;
          frame(w, state);
          far = Math.max(far, past(car.group.position.x, car.group.position.z));
        }
        deepest = Math.max(deepest, far);
        assert.ok(far < 0, `${l.name}: the car got ${far.toFixed(1)} m through the rim`);
      } finally {
        leaveSurvival(w);
      }
    }
    t.diagnostic(`${launches.length} launches at 60 m/s; the car that got furthest stopped ${(-deepest).toFixed(1)} m inside the blocks' inner faces`);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { frame } from "./race-world.test-util.ts";
import { placeProps, propColliders } from "./placements.ts";
import { FLEERS, chase, type Chase, type CopTamper, type Fleer } from "./survival-players.test-util.ts";
import { ARENA } from "./survival-arena.test-util.ts";
import { leaveSurvival, survivalWorld } from "./survival-run.test-util.ts";
import { Track } from "./track.ts";
import { HAVANA } from "./tracks/havana.ts";

/**
 * Survival is a closed city and the pack can win (docs/SURVIVAL.md): a player who holds the throttle and runs never gets away,
 * because there is nowhere to run to. Measured on the real stack with scripted players (`survival-players.test-util.ts`).
 */

const track = new Track(HAVANA);
/** The longest a fleeing player may last (s from the green). */
const END_BY = 300;
/** The rim: the course file's own stucco blocks (the explicit props), one row on each side, edge to edge. */
const RIM = track.json.props.filter((p) => p.prefab === "stucco");

describe("survival: the map is closed", () => {
  it("a car-sized disc starting at the player's start cannot reach the edge of the world through the course's solids", (t) => {
    const solids = propColliders(placeProps(track)).filter((c) => c.body === "solid");
    const half = 1.1;
    const b = track.bounds;
    const x0 = Math.floor(b.minX - 40);
    const z0 = Math.floor(b.minZ - 40);
    const nx = Math.ceil(b.maxX + 40 - x0);
    const nz = Math.ceil(b.maxZ + 40 - z0);
    const blocked = (x: number, z: number): boolean => {
      for (const c of solids) {
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
    const seen = new Uint8Array(nx * nz);
    const start = track.survival!.start;
    const queue: number[] = [Math.round(start.z - z0) * nx + Math.round(start.x - x0)];
    seen[queue[0]!] = 1;
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
        if (!blocked(x0 + u, z0 + v)) queue.push(v * nx + u);
      }
    }
    t.diagnostic(`${queue.length} cells reachable from the start; ${edge} on the edge of the ${nx} x ${nz} m window`);
    assert.equal(edge, 0, `a car can drive from the start to the edge of the world (${edge} edge cells reached)`);
  });

  it("the rim has no gap: a car at 60 m/s aimed at a seam between two blocks, at a block's centre or at a corner is stopped", (t) => {
    const xs = RIM.map((p) => p.x);
    const zs = RIM.map((p) => p.z);
    // The blocks' inner faces (a block is 12 m, so its face is 6 m in from its centre).
    const east = Math.max(...xs) - 6;
    const south = Math.min(...zs) + 6;
    const north = Math.max(...zs) - 6;
    /** How far the car's centre is outside the faces (m): positive = through the rim. */
    const past = (x: number, z: number): number => Math.max(Math.abs(x) - east, south - z, z - north);
    /** The row of one side: where the blocks stand along it, sorted. */
    const row = (pick: (p: (typeof RIM)[number]) => boolean, along: "x" | "z"): number[] => RIM.filter(pick).map((p) => p[along]).sort((a, b) => a - b);
    const RUN = 45;
    type Launch = { name: string; x: number; z: number; yaw: number };
    const launches: Launch[] = [];
    const sides = [
      { name: "south", along: row((p) => p.z === Math.min(...zs), "x"), at: (a: number): Launch => ({ name: "", x: a, z: south + RUN, yaw: Math.PI }) },
      { name: "north", along: row((p) => p.z === Math.max(...zs), "x"), at: (a: number): Launch => ({ name: "", x: a, z: north - RUN, yaw: 0 }) },
      { name: "west", along: row((p) => p.x === Math.min(...xs), "z"), at: (a: number): Launch => ({ name: "", x: -east + RUN, z: a, yaw: -Math.PI / 2 }) },
      { name: "east", along: row((p) => p.x === Math.max(...xs), "z"), at: (a: number): Launch => ({ name: "", x: east - RUN, z: a, yaw: Math.PI / 2 }) },
    ];
    for (const s of sides) {
      const n = s.along.length;
      // Seams: between block k and k + 1, away from the corners (a launch has room to run in only from inside the streets).
      for (const [label, at] of [["first seam", (s.along[1]! + s.along[2]!) / 2], ["middle seam", (s.along[n >> 1]! + s.along[(n >> 1) + 1]!) / 2], ["last seam", (s.along[n - 3]! + s.along[n - 2]!) / 2], ["a block centre", s.along[(n / 3) | 0]!]] as const) {
        launches.push({ ...s.at(at), name: `${s.name} ${label}` });
      }
    }
    for (const [x, z, yaw, name] of [[east - RUN, south + RUN, (3 * Math.PI) / 4, "south-east"], [RUN - east, south + RUN, (-3 * Math.PI) / 4, "south-west"], [east - RUN, north - RUN, Math.PI / 4, "north-east"], [RUN - east, north - RUN, -Math.PI / 4, "north-west"]] as const) {
      launches.push({ name: `${name} corner`, x, z, yaw });
    }
    let deepest = -Infinity;
    for (const l of launches) {
      const w = survivalWorld(undefined, 1);
      try {
        const state = { acc: 0 };
        for (let n = 0; n < 60 * 30 && w.race.phase !== "racing"; n++) frame(w, state);
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

  it("a player who holds the throttle and steers only round solids stays on the map", (t) => {
    const c = chase("flee", 1, 120);
    const b = track.bounds;
    t.diagnostic(`reach x ${c.reach.minX.toFixed(0)}…${c.reach.maxX.toFixed(0)}, z ${c.reach.minZ.toFixed(0)}…${c.reach.maxZ.toFixed(0)}; ended ${c.cause} at ${c.time.toFixed(1)} s`);
    assert.ok(c.reach.minX > b.minX && c.reach.maxX < b.maxX, `drove to x ${c.reach.minX.toFixed(0)}…${c.reach.maxX.toFixed(0)}`);
    assert.ok(c.reach.minZ > b.minZ && c.reach.maxZ < b.maxZ, `drove to z ${c.reach.minZ.toFixed(0)}…${c.reach.maxZ.toFixed(0)}`);
  });
});

describe("survival: a fleeing player's run ends", () => {
  /** The scripted players that avoid the walls: what ends their run is the pack, so a cop is in contact at the end. */
  const PACK_WINS: readonly Fleer[] = ["ring"];
  /** Why `c` is not a run the pack ended (null: it is): still running, ended by something else (or by anything but `only`), or a run that ended itself with no cop near. */
  const miss = (c: Chase, packWins: boolean, by = END_BY, only: string | null = null): string | null => {
    if (!c.ended) return `still running after ${by} s (${c.touches} cop contacts, the last at ${c.lastTouch.toFixed(0)} s)`;
    if (c.cause !== "busted" && c.cause !== "wrecked") return `ended by ${c.cause}`;
    if (only !== null && c.cause !== only) return `ended ${c.cause}, not ${only}`;
    if (packWins && c.time - c.lastTouch >= 2) return `no cop touched the player in the last ${(c.time - c.lastTouch).toFixed(1)} s: it ended itself`;
    return null;
  };
  for (const fleer of FLEERS) {
    it(`${fleer}: the run ends within ${END_BY} s, busted or wrecked${PACK_WINS.includes(fleer) ? ", with a cop in contact" : ""}`, (t) => {
      const c = chase(fleer, 1, END_BY);
      t.diagnostic(`${c.cause} at ${c.time.toFixed(1)} s; ${c.touches} cop contacts, the last at ${c.lastTouch.toFixed(1)} s; ${c.speed.toFixed(1)} m/s at the end; peak ${c.peak} cops`);
      const why = miss(c, PACK_WINS.includes(fleer));
      assert.ok(why === null, why ?? "");
    });
  }

  /**
   * The closed arena (`survival-arena.test-util.ts`: Havana's plaza inside a square of its own stucco, 160 m across): the player runs
   * from the nearest cop, bends round solids and cops, never stops, and cannot leave, so the pack has to catch it. The formation is held
   * until race second `ARENA_RELEASE` (`chase`'s `release`): the player drives 10 s clear, the nearest cop is `ARENA_GAP` m off when the
   * hunters are let go (128 m measured; 11 m held only to the green), and the real pack and rules run from there; ends are timed from the
   * release. A run counts when it ends busted or wrecked within `ARENA_T` s of the release with a powered cop touching in the last 2 s (a
   * wall the player hit itself, or a parked cop it drove into, does not count). Pooled over seeds 1 to 24 like the rest; a run stops
   * early once the bar is out of reach. Measured (docs/SURVIVAL.md): 24 of 24 end, the slowest at 95.5 s, and the bar leaves two runs of
   * slack for a trajectory a seed away. The same count with the cops frozen (their brain's pedals zeroed) is 0 of 24 and with the hunters'
   * steering zeroed 0 of 24: the proof the count can fail.
   */
  const ARENA_T = 200;
  const ARENA_BAR = 22;
  const POOLED_SEEDS = 24;
  const ARENA_RELEASE = 10;
  const ARENA_GAP = 100;
  const FROZEN: CopTamper = (input) => Object.assign(input, { throttle: 0, steer: 0, brake: 1, ebrake: false, boost: false });
  /** `ARENA_BAR`-style pool of `fleer`'s runs: how many ran, and why each that the pack did not end (as `only`, when given) was not. */
  const arena = (fleer: Fleer, bar: number, tamper?: CopTamper, only: string | null = null): { ran: number; bad: string[] } => {
    const bad: string[] = [];
    let seed = 1;
    for (; seed <= POOLED_SEEDS && bad.length <= POOLED_SEEDS - bar; seed++) {
      const why = miss(chase(fleer, seed, ARENA_RELEASE + ARENA_T, ARENA, { tamper, release: ARENA_RELEASE }), only === null, ARENA_T, only);
      if (why !== null) bad.push(`seed ${seed}: ${why}`);
    }
    return { ran: seed - 1, bad };
  };
  it("arena hold-back: the chase starts with the nearest cop 100 m or more off, and with no hold the formation is on the player's tail", (t) => {
    const held = chase("evade", 1, ARENA_RELEASE + 5, ARENA, { release: ARENA_RELEASE });
    const open = chase("evade", 1, 5, ARENA);
    t.diagnostic(`nearest cop at the release: ${held.gap.toFixed(0)} m held to ${ARENA_RELEASE} s, ${open.gap.toFixed(0)} m held only to the green`);
    assert.ok(held.gap >= ARENA_GAP, `the nearest cop is ${held.gap.toFixed(0)} m off at the release`);
    assert.ok(open.gap > 0 && open.gap < ARENA_GAP / 2, `held only to the green the nearest cop is ${open.gap.toFixed(1)} m off (−1: no cop up by 5 s): the control cannot tell a hold from none`);
  });
  it(`arena: the pack ends ≥ ${ARENA_BAR} of ${POOLED_SEEDS} fleeing runs (seeds 1-${POOLED_SEEDS}) within ${ARENA_T} s of the release, busted or wrecked, with a cop in contact`, (t) => {
    const { ran, bad } = arena("evade", ARENA_BAR);
    t.diagnostic(`${ran} runs, ${bad.length} not ended by the pack${bad.length ? `\n${bad.join("\n")}` : ""}`);
    assert.ok(bad.length <= POOLED_SEEDS - ARENA_BAR, `${bad.length} of ${ran} runs were not ended by the pack (at most ${POOLED_SEEDS - ARENA_BAR} of ${POOLED_SEEDS} allowed):\n${bad.join("\n")}`);
  });
  it("arena control: cops that never move end none of those runs", (t) => {
    const { ran, bad } = arena("evade", ARENA_BAR, FROZEN);
    t.diagnostic(`${ran} runs, ${bad.length} not ended by the pack\n${bad.join("\n")}`);
    assert.equal(bad.length, ran, `${ran - bad.length} of ${ran} runs were ended by cops that never move`);
  });
  it(`arena control: hunters that never steer miss the ≥ ${ARENA_BAR} of ${POOLED_SEEDS} bar`, (t) => {
    const { ran, bad } = arena("evade", ARENA_BAR, (input) => void (input.steer = 0));
    t.diagnostic(`${ran} runs, ${bad.length} not ended by the pack\n${bad.join("\n")}`);
    assert.ok(bad.length > POOLED_SEEDS - ARENA_BAR, `${ran - bad.length} of ${ran} runs were ended by hunters that never steer: the bar is met without steering`);
  });

  /**
   * The bust under the real rule (under 20 km/h within 20 m of a chasing cop for `SURVIVAL.bustTime`): the `corner` player runs for the
   * far corner and creeps there at 3 m/s, boxed in with nowhere left to run, and the released pack has to close, hold it and bust it. A
   * run counts when it ends busted (the rule itself needs a chasing cop within 20 m). Pooled like the pursuit count, bar BUST_BAR of 24 (measured: 23
   * of 24 busted, one wrecked; 18.5 to 32.9 s after the release). Controls: cops that never move bust none (they never come within 20 m);
   * and the pursuit count's runner that never stops ("evade") is wrecked in all 24 of its runs, busted in none: a pack does not bust a
   * car that moves.
   */
  const BUST_BAR = 21;
  it(`arena bust: the pack busts ≥ ${BUST_BAR} of ${POOLED_SEEDS} runs of a player cornered at 3 m/s (seeds 1-${POOLED_SEEDS})`, (t) => {
    const { ran, bad } = arena("corner", BUST_BAR, undefined, "busted");
    t.diagnostic(`${ran} runs, ${bad.length} not busted${bad.length ? `\n${bad.join("\n")}` : ""}`);
    assert.ok(bad.length <= POOLED_SEEDS - BUST_BAR, `${bad.length} of ${ran} runs were not busted (at most ${POOLED_SEEDS - BUST_BAR} of ${POOLED_SEEDS} allowed):\n${bad.join("\n")}`);
  });
  it("arena bust control: cops that never move bust none of those runs", (t) => {
    const { ran, bad } = arena("corner", BUST_BAR, FROZEN, "busted");
    t.diagnostic(`${ran} runs, ${bad.length} not busted\n${bad.join("\n")}`);
    assert.equal(bad.length, ran, `${ran - bad.length} of ${ran} runs were busted by cops that never move`);
  });
  it("ring control: with the cops frozen the ring run still ends (wrecked on a parked cop) but no powered cop touches the player", (t) => {
    const c = chase("ring", 1, END_BY, undefined, { tamper: FROZEN });
    const why = miss(c, true);
    t.diagnostic(`${c.cause} at ${c.time.toFixed(1)} s; ${c.touches} powered cop contacts; ${why}`);
    assert.ok(why?.includes("it ended itself"), `frozen cops count as the pack ending the ring run (${why ?? "counted"})`);
  });
});

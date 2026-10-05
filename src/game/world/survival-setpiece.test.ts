import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hash01 } from "../kernel/scalar.ts";
import { holdLine, leaveSurvival, play, survivalWorld } from "./survival-run.test-util.ts";
import type { World } from "./race-world.test-util.ts";

/**
 * Survival's opening set piece, on the real Havana course with the whole stack (docs/SURVIVAL.md): five cops in a staggered
 * formation behind a player who holds the boulevard line at full throttle, like a human (it steers back to its line when shoved).
 * The friend's spec: several cops reach the embankment's foot within about half a second of each other and leave the ground at the
 * crest; and a player who brakes hard near the crest's left makes them overshoot and fly past. Three seeds: each rolls the human's
 * line (x = −6 ± 1.5 m) and how far ahead it looks (25–40 m), and pins the field's dice.
 */

const SEEDS = [1, 2, 3];
/** The embankment's foot (z, m), and the band of z a flight from the crest begins in (the plateau's near edge is at z 18). */
const FOOT = 45;
const CREST: readonly [number, number] = [10, 35];
/** Where the braking player starts to brake (z, m), and the line he veers to: the crest's left. */
const BRAKE_AT = 85;
const LEFT = -9;
const WINDOW = 0.5;

type Piece = {
  /** Seconds each of the five cops first crossed the foot, in order. */
  foot: number[];
  /** The cops that left the ground at the crest. */
  takeoffs: number[];
  /** Cops that got ahead of the player by 5 m or more. */
  passed: number;
  /** The player's farthest stray from his line before the foot (m). */
  stray: number;
  /** The player was never touched before the foot. */
  clean: boolean;
};

function setPiece(seed: number, brake: boolean): Piece {
  const w = survivalWorld(undefined, seed);
  try {
    const line = -6 + (hash01(seed, 1) - 0.5) * 3;
    const look = 25 + 15 * hash01(seed, 2);
    const foot = new Map<number, number>();
    const takeoffs = new Set<number>();
    const passed = new Set<number>();
    const flying = new Set<number>();
    const piece: Piece = { foot: [], takeoffs: [], passed: 0, stray: 0, clean: true };
    const player = (ww: World, t: number): void => {
      const me = ww.cars[0]!;
      const z = me.group.position.z;
      if (brake && z < BRAKE_AT) holdLine(ww, LEFT, look, 0);
      else holdLine(ww, line, look, null);
      // From the 300 m mark on: the first stretch is the player getting from the start (x 0) onto his line.
      if (z > FOOT && z < 300) piece.stray = Math.max(piece.stray, Math.abs(me.group.position.x - line));
      if (z > FOOT && me.crashed) piece.clean = false;
      for (let i = 1; i <= 5; i++) {
        const c = ww.cars[i]!;
        const cz = c.group.position.z;
        if (!foot.has(i) && cz < FOOT) foot.set(i, t);
        if (c.airborne && !flying.has(i) && cz > CREST[0] && cz < CREST[1]) takeoffs.add(i);
        if (c.airborne) flying.add(i);
        else flying.delete(i);
        if (cz < z - 5 && z < 200) passed.add(i);
      }
    };
    play(w, { seconds: 24, player, retry: false });
    piece.foot = [...foot.values()].sort((a, b) => a - b);
    piece.takeoffs = [...takeoffs];
    piece.passed = passed.size;
    return piece;
  } finally {
    leaveSurvival(w);
  }
}

/** The most cops that crossed the foot within `WINDOW` s of each other. */
function together(foot: readonly number[]): number {
  return Math.max(0, ...foot.map((t) => foot.filter((u) => u >= t && u < t + WINDOW).length));
}

for (const seed of SEEDS) {
  describe(`given Survival's opening scene on the Havana course (five cops in a staggered formation behind the player), rolled with seed ${seed}`, () => {
    it("when the player holds the boulevard line at full throttle, then three cops reach the embankment's foot within half a second of each other and leave the ground at the crest", (t) => {
      const p = setPiece(seed, false);
      t.diagnostic(`foot ${p.foot.map((x) => x.toFixed(2)).join(" ")}; ${together(p.foot)} within ${WINDOW} s; ${p.takeoffs.length} took off; the player strayed ${p.stray.toFixed(1)} m, clean ${p.clean}`);
      assert.equal(p.foot.length, 5, "the pack never reached the foot");
      assert.ok(together(p.foot) >= 3, `only ${together(p.foot)} cops within ${WINDOW} s at the foot (${p.foot.map((x) => x.toFixed(2)).join(" ")})`);
      assert.ok(p.takeoffs.length >= 3, `only ${p.takeoffs.length} cops left the ground at the crest`);
      assert.ok(p.stray < 6, `the pack shoved the player ${p.stray.toFixed(1)} m off his line`);
      assert.ok(p.clean, "the pack touched the player before the foot");
    });

    it("when the player brakes hard near the crest's left, then the cops overshoot and fly past", (t) => {
      const p = setPiece(seed, true);
      t.diagnostic(`${p.passed} passed the player; ${p.takeoffs.length} took off at the crest`);
      assert.ok(p.passed >= 3, `only ${p.passed} cops overshot the braking player`);
      assert.ok(p.takeoffs.length >= 3, `only ${p.takeoffs.length} cops flew off the crest`);
    });
  });
}

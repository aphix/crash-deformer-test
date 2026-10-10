import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chase } from "./survival-players.test-util.ts";
import { ARENA } from "./survival-arena.test-util.ts";
import { ARENA_T, CONTROL_SEEDS, SEEDS, arena, release } from "./survival-pack.test-util.ts";

/**
 * Survival's promise (docs/SURVIVAL.md): a player who keeps running is caught; a real player rarely lasts 2 minutes on Havana. In the
 * closed arena the `evade` player runs from the nearest cop, bends round solids and cops and never stops; a run counts when it ends
 * busted or wrecked within `ARENA_T` s with a powered cop touching in the last 2 s (a wall the player hit itself does not count).
 * Measured over seeds 1-24 (10-10): 23 runs, only seed 11 not ended; on `SEEDS` every run ends, so the bar leaves one run of slack.
 * Control: hunters that never steer miss the bar (the count can fail).
 */
const ARENA_GAP = 100;
const BAR = SEEDS.length - 1;

describe(`given the closed arena (Havana's plaza inside a square of its own stucco, 160 m across) with the formation held until a release second, a different one per seed`, () => {
  it(`when the chase starts at the earliest release, then the nearest cop is ${ARENA_GAP} m or more off, whereas with no hold the formation is on the player's tail`, (t) => {
    const held = chase("evade", 1, release(1) + 5, ARENA, { release: release(1) });
    const open = chase("evade", 1, 5, ARENA);
    t.diagnostic(`nearest cop at the release: ${held.gap.toFixed(0)} m held to ${release(1).toFixed(1)} s, ${open.gap.toFixed(0)} m held only to the green`);
    assert.ok(held.gap >= ARENA_GAP, `the nearest cop is ${held.gap.toFixed(0)} m off at the release`);
    assert.ok(open.gap > 0 && open.gap < ARENA_GAP / 2, `held only to the green the nearest cop is ${open.gap.toFixed(1)} m off (−1: no cop up by 5 s): the control cannot tell a hold from none`);
  });
  it(`when an evading player flees in each of seeds ${SEEDS.join(", ")}, then the pack ends at least ${BAR} of the ${SEEDS.length} runs within ${ARENA_T} s, busted or wrecked, with a cop in contact`, (t) => {
    const { ran, bad } = arena("evade", SEEDS, BAR);
    t.diagnostic(`${ran} runs, ${bad.length} not ended by the pack${bad.length ? `\n${bad.join("\n")}` : ""}`);
    assert.ok(bad.length <= SEEDS.length - BAR, `${bad.length} of ${ran} runs were not ended by the pack:\n${bad.join("\n")}`);
  });
  it(`when the hunters never steer, then the pack misses that bar (seeds ${CONTROL_SEEDS.join(", ")})`, (t) => {
    // The pursuit's share (`BAR` of `SEEDS`) over the control's seeds, rounded up: at three seeds every run must end to meet it.
    const controlBar = Math.ceil((CONTROL_SEEDS.length * BAR) / SEEDS.length);
    const { ran, bad } = arena("evade", CONTROL_SEEDS, controlBar, (input) => void (input.steer = 0));
    t.diagnostic(`${ran} runs, ${bad.length} not ended by the pack\n${bad.join("\n")}`);
    assert.ok(bad.length > CONTROL_SEEDS.length - controlBar, `${ran - bad.length} of ${ran} runs were ended by hunters that never steer: the bar is met without steering`);
  });
});
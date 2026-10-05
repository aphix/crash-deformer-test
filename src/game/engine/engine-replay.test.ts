import { sweepSeeds } from "./engine-replay.test-util.ts";

/**
 * Seeds 1 to 8, each its own race (the field piles up in different places: clips that open on wrecks already in motion,
 * wall hits, pile-ups of 3 to 17 cars). Seeds 4 to 8 once missed the bound (a wall impact never reached, dt Infinity;
 * a restored wreck 18 mm off after one step): the solver state a keyframe restored left out each shape cluster's last
 * rotation and warm start (`simState`). Seeds 1 to 64 of the natural field replayed their involved cars up to 4.4 m off
 * (seeds 51, 54; which seeds did moved under a 1e-10 m nudge) until the clip carried what the live world and course knew
 * (the world's step schedule, the course's wall memory and knocked props) and every car that touched a clip car, mass to
 * mass included. `SEEDS=1,2,... node --experimental-strip-types --test src/game/engine/engine-replay.test.ts` runs any others.
 *
 * Then the three seeds of 9 to 64 that diverged, one per cause: 18 (a prop a car outside the clip knocked off its spot
 * before a clip car reached it: `HighlightClip.knocks`), 30 (the clip ends with the race: the harness's last trace
 * entry was the state after the finish, not the one the last step left) and 47 (a car with a torn mirror but no wreck
 * came back with a zero hit frame instead of its own: it carries its solver state like a wreck).
 */
sweepSeeds([1, 2, 3, 4, 5, 6, 7, 8, 18, 30, 47]);

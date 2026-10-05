import { sweepSeeds } from "./engine-replay.test-util.ts";

/**
 * Seeds 1 to 8, each its own race (the field piles up in different places: clips that open on wrecks already in motion,
 * wall hits, pile-ups of 3 to 17 cars). Seeds 4 to 8 once missed the bound (a wall impact never reached, dt Infinity;
 * a restored wreck 18 mm off after one step): the solver state a keyframe restored left out each shape cluster's last
 * rotation and warm start (`simState`). Seeds 1 to 64 of the natural field replayed their involved cars up to 4.4 m off
 * (seeds 51, 54; which seeds did moved under a 1e-10 m nudge) until the clip carried what the live world and course knew
 * (the world's step schedule, the course's wall memory and knocked props) and every car that touched a clip car, mass to
 * mass included. `SEEDS=1,2,... node --experimental-strip-types --test src/game/engine/engine-replay.test.ts` runs any others.
 */
sweepSeeds(1, 8);

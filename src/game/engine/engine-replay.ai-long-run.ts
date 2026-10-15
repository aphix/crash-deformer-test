import { sweepSeeds } from "./engine-replay.test-util.ts";

/**
 * Full-sanity run (`npm run test:ai-long-run`), not per commit: whole seeded races hoping for crashes, every clip of them held to
 * the live sim. Each cause it ever caught has a staged test in the regular suite (a clip over a handful of cars, seconds):
 * - seeds 4 to 8 (a wall impact never reached, dt Infinity; a restored wreck 18 mm off after one step; the solver state a
 *   keyframe restored left out each shape cluster's last rotation and warm start, `simState`): `replay-fidelity.test.ts`,
 *   "a harder head-on happens 3 s after another ... wrecks in the middle of their hit";
 * - seeds 1 to 64 (up to 4.4 m off until the clip carried what the live world and course knew: the course's road-segment
 *   hint, the knocked props, and every car that touched a clip car, mass to mass included): `replay-fidelity.test.ts` "road-segment
 *   hint is the one its first keyframe held", "a pair 300 m away wrecks while another head-on's clip runs" (the world's step
 *   schedule, `HighlightClip.shape`), `engine-record-bystander.test.ts` (knocks, a car that touched a bystander, a car
 *   parked on another's roof);
 * - seed 18 (a prop a car outside the clip knocked off its spot before a clip car reached it: `HighlightClip.knocks`):
 *   `engine-record-bystander.test.ts` "a prop that a car outside the clip knocked off its spot";
 * - seed 30 (the harness's last trace entry was the state after the finish; and a bystander's contact clock): `replay-fidelity.test.ts`
 *   "derby bystander touched";
 * - seed 47 (a car with a torn mirror but no wreck came back with a zero hit frame instead of its own: it carries its solver
 *   state like a wreck): `engine-record-bystander.test.ts` "a car with a torn mirror and no crash".
 * Seeds 1 to 8, each its own race (the field piles up in different places: clips that open on wrecks already in motion,
 * wall hits, pile-ups of 3 to 17 cars). `SEEDS=1,2,... node --experimental-strip-types --test src/game/engine/engine-replay.ai-long-run.ts` runs any others.
 *
 * Seed 4 of the natural field once had its flat-out player hit the far wall head-on at 41 m/s and stop; on the one rigid path
 * the player is 1.3 m further left at z 90, is wrecked by something at z 98, slides 60 m along that wall and no crash of the
 * 75 s ranks as a highlight (nothing to replay), so seed 9 is swept in its place.
 */
sweepSeeds([1, 2, 3, 5, 6, 7, 8, 9, 18, 30, 47]);

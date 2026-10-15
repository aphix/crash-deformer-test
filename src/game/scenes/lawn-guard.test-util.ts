import { FIRE_EVERY, HIT_SHARE, KILL_HITS_MIN, KILL_HITS_SPREAD } from "./lawn-guard.ts";

/** Mean seconds of full-strength fire to one hit past the most a kill can need (`KILL_HITS_MIN + KILL_HITS_SPREAD - 1`): the slack a seeded run's bad luck gets. */
export const KILL_WINDOW_S = ((KILL_HITS_MIN + KILL_HITS_SPREAD) / HIT_SHARE) * FIRE_EVERY;

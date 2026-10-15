import { TRACK_ID } from "./constants.ts";
import { describeRaceCanary } from "./stuck-canary.test-util.ts";

describeRaceCanary(TRACK_ID.stunt, [5, 6, 7, 8]);

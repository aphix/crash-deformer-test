import { TRACKS } from "../world/tracks/index.ts";
import { courseCensus } from "./engine-cine-courses.test-util.ts";

/**
 * Full-sanity run (`npm run test:ai-long-run`): the crash camera's eyes over every wall spot of every course on the menu
 * (`engine-cine.test.ts` runs the stunt course alone, per commit: its tight walls and self-crossing road are what the bars were set on).
 */
courseCensus(TRACKS);

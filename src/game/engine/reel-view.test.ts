import { parseTrack } from "../world/track-schema.ts";
import { Track } from "../world/track.ts";
import city from "../world/tracks/city.json" with { type: "json" };
import stunt from "../world/tracks/stunt.json" with { type: "json" };
import { HAVANA } from "../world/tracks/havana.ts";
import { raceOn } from "./reel-view.test-util.ts";
import { chain, CREST, crashes, reelViewClaims, survivalOn } from "./reel-view-claims.test-util.ts";

/**
 * One staged crash of each kind, each in a race of only its own cars (`reel-view.ai-long-run.ts` walks each kind along the lap and
 * adds a ramming race's own clips): a head-on that throws both drivers on the stunt course and a head-on, a T-bone, a wall hit and a
 * chain of three cars among the city's buildings, a jump over the stunt crest onto a car on the landing, and a launch up havana's
 * plaza face for the Survival player. (The sweep's other wall hits make no clip alone: only crashes that rank are here.)
 */
reelViewClaims(
  "given highlight reels from staged crashes: a head-on, a T-bone, a wall hit and a chain of three cars among the city's buildings, a head-on on the stunt course, a jump over its crest onto a car on the landing, and a launch up havana's plaza face for the Survival player",
  { impact: 7, hit: 1, throw: 6, takeoff: 2, cut: 1 },
  async ({ scene }) => {
    const cityTrack = new Track(parseTrack(city));
    const stuntTrack = new Track(parseTrack(stunt));
    const havana = new Track(parseTrack(HAVANA));
    const cityShift0 = crashes(cityTrack.length, 0);
    await scene("city head-on", raceOn("city", 8, 2), cityTrack, [{ ...cityShift0[0]!, cars: [1, 2] }], 14);
    await scene("city T-bone", raceOn("city", 8, 2), cityTrack, [{ ...cityShift0[2]!, cars: [1, 2] }], 14);
    await scene("city wall", raceOn("city", 8, 1), cityTrack, [{ ...cityShift0[4]!, cars: [1] }], 14);
    await scene("city chain gap 16 m", raceOn("city", 6, 3), cityTrack, chain(0, 16), 14);
    await scene("stunt head-on", raceOn("stunt", 3, 2), stuntTrack, [{ ...crashes(stuntTrack.length, 0)[0]!, cars: [1, 2] }], 14);
    await scene("stunt jump +28 m", raceOn("stunt", 3, 2), stuntTrack, [{ kind: "jump", at: CREST, speed: 30, land: 28, cars: [1, 2] }], 14);
    await scene("havana launch (4, 26)", survivalOn(2), havana, [{ kind: "ramp", x: 4, z: 26, yaw: Math.PI, speed: 32, cars: [0, 1] }], 16);
  },
);

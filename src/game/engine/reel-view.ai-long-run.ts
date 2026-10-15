import { parseTrack } from "../world/track-schema.ts";
import { Track } from "../world/track.ts";
import city from "../world/tracks/city.json" with { type: "json" };
import stunt from "../world/tracks/stunt.json" with { type: "json" };
import { HAVANA } from "../world/tracks/havana.ts";
import { raceOn } from "./reel-view.test-util.ts";
import { chain, CREST, crashes, HAVANA_SHIFTS, reelViewClaims, survivalOn } from "./reel-view-claims.test-util.ts";

/**
 * Full-sanity run (`npm run test:ai-long-run`), not per commit: the reel view's claims (`reel-view-claims.test-util.ts`) over the
 * whole sweep of places, a ramming city race's own clips among them. The per-commit `reel-view.test.ts` stages one crash of each
 * kind; this walks each kind along the lap (six shifts of the head-ons, wall hits and T-bones on the city, the stunt course and
 * havana, three chains at three shifts, two jumps, two launches), in case a building, a wall or a hill hides a moment somewhere else.
 */
reelViewClaims(
  "given highlight reels from a ramming city race; staged head-ons, wall hits and T-bones among the city's buildings and on the stunt course's tight walls; the Survival player's own crashes among havana's blocks; jumps over the stunt crest onto a car on the landing; and launches up havana's plaza face into the monument",
  { impact: 10, hit: 6, throw: 4, takeoff: 4, cut: 1 },
  async ({ scene, cityField }) => {
    const cityTrack = new Track(parseTrack(city));
    await cityField("city field", cityTrack, 70);
    const stuntTrack = new Track(parseTrack(stunt));
    const havana = new Track(parseTrack(HAVANA));
    for (const [i, shift] of [0, 0.03, 0.07, 0.1, 0.13, 0.16].entries()) {
      await scene(`city staged +${shift}`, raceOn("city", 8, 7), cityTrack, crashes(cityTrack.length, shift), 20);
      await scene(`stunt staged +${shift}`, raceOn("stunt", 3, 7), stuntTrack, crashes(stuntTrack.length, shift), 20);
      await scene(`havana survival ${i} +${HAVANA_SHIFTS[i]}`, survivalOn(2), havana, [{ ...crashes(havana.length, HAVANA_SHIFTS[i]!)[i % 5]!, cars: [0, 1] }], 16);
    }
    for (const [gap, seed] of [[7, 5], [16, 6], [24, 7]] as const) {
      for (const shift of [0, 0.05, 0.1]) await scene(`city chain gap ${gap} m +${shift}`, raceOn("city", seed, 7), cityTrack, chain(shift, gap), 16);
    }
    for (const land of [28, 32]) await scene(`stunt jump +${land} m`, raceOn("stunt", 3, 7), stuntTrack, [{ kind: "jump", at: CREST, speed: 30, land }], 14);
    for (const [x, z, speed] of [[4, 26, 32], [-1, 30, 36]] as const) {
      await scene(`havana launch (${x}, ${z})`, survivalOn(2), havana, [{ kind: "ramp", x, z, yaw: Math.PI, speed, cars: [0, 1] }], 16);
    }
  },
);

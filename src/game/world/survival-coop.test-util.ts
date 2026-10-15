import type { DriveInput } from "../vehicle/car-drive.ts";
import { makeWorld, type World } from "./race-world.test-util.ts";

/** A hosted Survival run with the host's car 0 and a network peer on each of the cars in `peers` (`setSeats`). Not a test file itself. */
export function coopWorld(peers: readonly number[], seed = 1): World {
  const w = makeWorld();
  w.race.reseed(seed);
  w.race.setSeats(new Map(peers.map((car) => [car, `Peer ${car}`])));
  w.race.enter(true);
  return w;
}

export const STILL: DriveInput = { throttle: 0, steer: 0, brake: 0, ebrake: true, boost: false };

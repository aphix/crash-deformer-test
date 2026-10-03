import { blankEjection, type Ejection } from "../vehicle/ejection.ts";
import { readEject, type Reader } from "./codec.ts";
import type { NetGame } from "./net-ports.ts";

/** Most thrown drivers a client holds before their draw time comes (a few a race; a flood is dropped). */
const MAX_HELD = 32;

/**
 * The host's thrown drivers (`MSG.eject`) a client has heard of and not launched yet: each waits for the client's
 * draw time (the host clock the snapshots are drawn at, `INTERP_DELAY` behind) to reach the clock he left at, so his
 * dummy appears with the car it left, not ahead of it.
 */
export class EjectQueue {
  private readonly held: { time: number; e: Ejection }[] = [];

  clear(): void {
    this.held.length = 0;
  }

  /** Queues the message `r` holds; a malformed one is a RangeError (`NetPlay.receive` drops it). */
  take(r: Reader): void {
    const e = blankEjection();
    const time = readEject(r, e);
    if (this.held.length < MAX_HELD) this.held.push({ time, e });
  }

  /** Launches the dummies draw time `rt` has reached; while a reel plays the cars are the reel's, so they are dropped. */
  due(rt: number, game: Pick<NetGame, "cars" | "reelPlaying" | "launchEjection">): void {
    for (let k = 0; k < this.held.length; ) {
      const x = this.held[k]!;
      if (x.time > rt) {
        k++;
        continue;
      }
      this.held.splice(k, 1);
      if (!game.reelPlaying() && x.e.car < game.cars().length) game.launchEjection(x.e);
    }
  }
}

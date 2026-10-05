import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Track, segmentAt, blankSegment } from "./track.ts";
import { TRACKS } from "./tracks/index.ts";
import { parseTrack } from "./track-schema.ts";
import { mulberry32 } from "./placements.ts";

/**
 * `TrackGround.deckAt` lists each deck segment only in the 8 m cells its accepted region touches. Its answer (height and the
 * surface of the deck it found) must be the one a scan of every deck segment gives, anywhere a car can be.
 */

function scanAll(track: Track, x: number, z: number, yMax: number): { best: number; surface: number } {
  const p = track.path;
  const seg = blankSegment();
  let best = -Infinity;
  let surface = 0;
  for (let k = 0; k < p.count; k++) {
    if (!p.deck[k]) continue;
    const { b, ex, ez, len2, f } = segmentAt(p, k, x, z, seg);
    if (f < -0.02 || f > 1.02) continue;
    const lat = ((x - p.x[k]! - ex * f) * ez - (z - p.z[k]! - ez * f) * ex) / Math.sqrt(len2);
    const half = p.half[k]!;
    const run = lat > 0 ? p.runL[k]! : p.runR[k]!;
    if (Math.abs(lat) > half + run) continue;
    const yc = p.y[k]! + (p.y[b]! - p.y[k]!) * f - Math.max(-half, Math.min(half, lat)) * Math.tan(p.bank[k]!);
    if (yc > yMax || yc <= best) continue;
    best = yc;
    surface = Math.abs(lat) <= half ? p.surface[k]! : p.runSurface[k]!;
  }
  return { best, surface };
}

describe("deck index", () => {
  for (const json of TRACKS) {
    const track = new Track(json);
    const p = track.path;
    if (!p.deck.includes(1)) continue;
    it(`${parseTrack(json).id}: the cell lists answer as a scan of every deck segment, over and around the deck`, () => {
      const ground = track.ground();
      const rand = mulberry32(7);
      const decks: number[] = [];
      for (let k = 0; k < p.count; k++) if (p.deck[k]) decks.push(k);
      let hits = 0;
      for (let n = 0; n < 40000; n++) {
        const k = decks[Math.floor(rand() * decks.length)]!;
        const reach = p.half[k]! + Math.max(p.runL[k]!, p.runR[k]!) + 3;
        // Over the deck, beyond its edge and at its ends: along ±3 samples, across ±(road + runoff + 3 m).
        const along = (rand() * 7 - 3.5) * 1;
        const across = (rand() * 2 - 1) * reach;
        const x = p.x[k]! + p.tx[k]! * along + p.tz[k]! * across;
        const z = p.z[k]! + p.tz[k]! * along - p.tx[k]! * across;
        const yMax = p.y[k]! + (rand() * 8 - 6);
        const want = scanAll(track, x, z, yMax);
        const got = ground["deckAt"](x, z, yMax);
        assert.equal(got, want.best, `deckAt at (${x.toFixed(3)}, ${z.toFixed(3)}) yMax ${yMax.toFixed(3)}`);
        if (want.best > -Infinity) {
          hits++;
          assert.equal(ground["deckSurface"], want.surface, `deck surface at (${x.toFixed(3)}, ${z.toFixed(3)})`);
        }
      }
      assert.ok(hits > 4000, `the points land on the deck often enough to mean something (${hits})`);
    });
  }
});

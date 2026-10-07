import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Track, segmentAt, blankSegment } from "./track.ts";
import { OFF_MENU, TRACKS } from "./tracks/index.ts";
import { parseTrack } from "./track-schema.ts";
import { mulberry32 } from "./placements.ts";
import { STEP_UP } from "./ground.ts";

/**
 * A course's ground lists each bridge-deck segment only in the 8 m cells its accepted region touches. What a car asks there
 * (height and surface) must be what a scan of every deck segment over the ground under it gives, anywhere a car can be.
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
    const lat = ((x - p.x[k]!) * ez - (z - p.z[k]!) * ex) / Math.sqrt(len2);
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

for (const json of [...TRACKS, ...OFF_MENU]) {
  const track = new Track(json);
  const p = track.path;
  if (!p.deck.includes(1)) continue;
  describe(`given the ${parseTrack(json).id} course, whose deck segments are listed per 8 m cell`, () => {
    it("when points over and around the deck are asked from below, beside and above it, then each answers exactly as a scan of every deck segment over the ground under it does (height and surface)", () => {
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
        const y = p.y[k]! + (rand() * 8 - 6) - STEP_UP;
        // The ground alone: asked from -Infinity no deck reaches the asker.
        const field = ground.heightAt(x, z, -Infinity);
        const fieldSurface = ground.surfaceIndex(x, z, -Infinity);
        const deck = scanAll(track, x, z, y + STEP_UP);
        const onDeck = deck.best >= field;
        const height = ground.heightAt(x, z, y);
        const surface = ground.surfaceIndex(x, z, y);
        const at = `(${x.toFixed(3)}, ${z.toFixed(3)}) from ${y.toFixed(3)}`;
        assert.equal(height, onDeck ? deck.best : field, `height at ${at}`);
        assert.equal(surface, onDeck ? deck.surface : fieldSurface, `surface at ${at}`);
        if (onDeck) hits++;
      }
      assert.ok(hits > 4000, `the points land on the deck often enough to mean something (${hits})`);
    });
  });
}

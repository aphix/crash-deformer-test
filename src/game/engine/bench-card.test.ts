import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { INITIAL_HUD, type CrashHudState } from "../hud/hud-store.ts";
import { DECIMALS, hudSettings, roundCard } from "./bench-card.ts";

/** A card as the bench sent it before the card was shortened: a real one, from a phone (strip, Ultra, 28 cars; 17.9 kB, the HUD's whole state in it). */
const OLD = JSON.parse(readFileSync(new URL("./bench-card.fixture.json", import.meta.url), "utf8")) as { hud: CrashHudState; result: Record<string, unknown> };

/** The card as `engine-bench.ts` `payload` writes it now. */
const NEW = { ...OLD, hud: hudSettings(OLD.hud, INITIAL_HUD), result: roundCard(OLD.result) };

/** Every number in `value` with the dot path it sits under (array elements take their array's name). */
function numbers(value: unknown, path: string[] = []): { key: string; n: number }[] {
  if (typeof value === "number") return [{ key: path.at(-1)!, n: value }];
  if (Array.isArray(value)) return value.flatMap((v) => numbers(v, path));
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([k, v]) => numbers(v, [...path, k]));
  return [];
}

describe("given a real bench card from a phone", () => {
  test("when the card is written for the wire, then its JSON is 9 kB or less (it was 17.9 kB)", () => {
    assert.ok(JSON.stringify(OLD).length > 17_000, "the fixture is the old, whole card");
    const bytes = JSON.stringify(NEW).length;
    assert.ok(bytes <= 9 * 1024, `${bytes} bytes`);
  });

  test("when the numbers are rounded, then each one named in the table is a multiple of its unit, within half a unit of what was measured", () => {
    const before = numbers(OLD.result);
    const after = numbers(NEW.result);
    assert.equal(after.length, before.length);
    let checked = 0;
    for (const [i, { key, n }] of after.entries()) {
      const decimals = DECIMALS[key];
      if (decimals === undefined) {
        assert.equal(n, before[i]!.n, `${key} is not in the table and keeps every digit`);
        continue;
      }
      checked++;
      const unit = 10 ** -decimals;
      assert.ok(Math.abs(n - before[i]!.n) <= unit / 2 + 1e-9, `${key}: ${before[i]!.n} -> ${n}`);
      assert.equal(Number(n.toFixed(decimals)), n, `${key}: ${n} has more than ${decimals} decimals`);
    }
    assert.ok(checked > 100, `${checked} numbers were rounded`);
  });

  test("when the card is written, then only the numbers change: every key and non-number is as it was, and rounding twice is rounding once", () => {
    const shape = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === "number" ? 0 : x)));
    assert.equal(JSON.stringify(shape(NEW.result)), JSON.stringify(shape(OLD.result)));
    assert.equal(JSON.stringify(roundCard(NEW.result)), JSON.stringify(NEW.result));
  });
});

describe("given the HUD's state at the end of a bench", () => {
  test("when the HUD is at its defaults, then the card carries nothing of it", () => {
    assert.deepEqual(hudSettings(INITIAL_HUD, INITIAL_HUD), {});
  });

  test("when a setting differs from its default, then it is kept, and the readouts (the race, the board, the clock) never are", () => {
    const hud = { ...INITIAL_HUD, squash: 0.5, night: true, elapsed: 12, race: {} as CrashHudState["race"], derbyBoard: [{ id: 1, name: "x", score: 1, alive: true, out: false, clock: 0, watched: false }] };
    assert.deepEqual(hudSettings(hud, INITIAL_HUD), { squash: 0.5, night: true });
  });

  test("when the real card's HUD is cut, then what is left are the four settings it differed in", () => {
    assert.deepEqual(Object.keys(NEW.hud).sort(), ["cageCount", "carCount", "fxTier", "seat"]);
  });
});

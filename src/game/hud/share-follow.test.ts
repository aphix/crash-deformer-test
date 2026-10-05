import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeShare, followShare, type ShareState } from "./share-url.ts";

const DEFAULTS = decodeShare("");
/** The state of a page with `change` on it and the run's seed `seed` (the fleet is a seeded scene). */
const page = (change: Partial<ShareState>, seed = 0x3fa2c1): ShareState => ({ ...DEFAULTS, ...change, seed });
const follow = (s: ShareState, bar: string, client = false) => followShare(s, client, bar);

describe("the address bar follows what the user changed", () => {
  it("good: a page opened with no hash writes nothing, whatever seed the run rolled", () => {
    assert.equal(follow(page({}), ""), "");
    assert.equal(follow(page({}, 0x1), ""), "");
  });

  it("good: a page opened with a partial hash keeps it as it is, no seed and no other setting added", () => {
    assert.equal(follow(page({ night: true }), "night=1"), "night=1");
    assert.equal(follow(page({ night: true }, 0xabc), "night=1"), "night=1");
  });

  it("good: the first change writes the settings with the run's seed, so the link spawns the same field", () => {
    assert.equal(follow(page({ night: true }), ""), "night=1&seed=3fa2c1");
    assert.equal(follow(page({ night: true, wet: true }), "night=1"), "night=1&wet=1&seed=3fa2c1");
  });

  it("good: a new seed follows only into a bar that already carries one (Loop's next run)", () => {
    assert.equal(follow(page({ night: true }, 0x77), "night=1&seed=3fa2c1"), "night=1&seed=77");
    assert.equal(follow(page({ night: true }, 0x77), "night=1"), "night=1");
    assert.equal(follow(page({}, 0x77), ""), "");
  });

  it("good: settings put back to the defaults empty the bar, seed included", () => {
    assert.equal(follow(page({}), "night=1&seed=3fa2c1"), "");
  });

  it("good: a scene is a choice the bar records, and leaving it for the fleet takes it out", () => {
    assert.equal(follow({ ...DEFAULTS, scene: "range" }, ""), "scene=range");
    assert.equal(follow(page({}), "scene=range"), "");
  });

  it("good: a hash the page was opened with is not rewritten into the encoder's key order", () => {
    assert.equal(follow(page({ night: true, wet: true }), "wet=1&night=1"), "wet=1&night=1");
  });

  it("good: a netplay client's bar is the room alone, whatever else was typed", () => {
    const client = page({ night: true, room: "ABCD2345" });
    assert.equal(follow(client, "room=ABCD2345&night=1", true), "room=ABCD2345");
    assert.equal(follow(client, "room=ABCD2345", true), "room=ABCD2345");
  });
});

describe("a pasted share URL still applies", () => {
  it("good: its settings and its seed are what the page starts as, and the bar keeps the link as pasted", () => {
    const pasted = "#night=1&ramps=1&seed=3fa2c1";
    const t = decodeShare(pasted);
    assert.equal(t.night, true);
    assert.equal(t.ramps, true);
    assert.equal(t.seed, 0x3fa2c1);
    assert.equal(follow(t, pasted.slice(1)), pasted.slice(1));
  });

  it("good: a pasted seed-only link keeps its seed until the settings or the run move on", () => {
    const t = decodeShare("#seed=3fa2c1");
    assert.equal(t.seed, 0x3fa2c1);
    assert.equal(follow(t, "seed=3fa2c1"), "seed=3fa2c1");
    assert.equal(follow(page({ night: true }), "seed=3fa2c1"), "night=1&seed=3fa2c1");
  });
});

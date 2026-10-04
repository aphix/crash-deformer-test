import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeShare, encodeShare, isShareableRoom, joinsRoom, roomLink, shareFragment, type ShareState } from "./share-url.ts";
import { INITIAL_HUD, KNOB_RANGES } from "./hud-store.ts";

const DEFAULTS = decodeShare("");
const json = (s: ShareState): string => JSON.stringify(s);

describe("share URL", () => {
  it("good: the defaults encode to an empty fragment and an empty fragment decodes to the defaults", () => {
    assert.equal(encodeShare(DEFAULTS), "");
    assert.equal(DEFAULTS.scene, "fleet");
    assert.equal(DEFAULTS.cars, INITIAL_HUD.carCount);
    assert.equal(DEFAULTS.smax, INITIAL_HUD.speedMax);
    assert.equal(DEFAULTS.seed, null);
    assert.equal(DEFAULTS.fx, null);
  });

  it("good: only what differs from the defaults is written, in a readable order", () => {
    const s: ShareState = { ...DEFAULTS, cars: 5, smin: 12, ramps: true, seed: 0x3fa2c1 };
    assert.equal(encodeShare(s), "cars=5&smin=12&ramps=1&seed=3fa2c1");
    // A value equal to its default is dropped even when it was set explicitly.
    assert.equal(encodeShare({ ...DEFAULTS, cars: INITIAL_HUD.carCount, night: false }), "");
  });

  it("good: encode then decode returns the same state (every kind of field)", () => {
    const s: ShareState = {
      ...DEFAULTS,
      scene: "race",
      cars: 9,
      smin: 3.5,
      smax: 40,
      night: true,
      wet: true,
      real: 0.8,
      fx: "low",
      fxd: 1.1,
      squash: KNOB_RANGES.squash.min,
      buckle: 0.9,
      loop: false,
      slomo: false,
      ts: 0.25,
      deform: "lattice",
      car: "monster",
      pkph: 90,
      pkg: 2500,
      phard: 0.5,
      phold: true,
      phop: 3,
      dkph: 30,
      dkg: 800,
      dside: "left",
      track: "figure8",
      laps: 5,
      ai: 11,
      aggr: 0.9,
      police: true,
      noreset: true,
      spectate: true,
      seed: 0xffffffff,
    };
    assert.equal(json(decodeShare(`#${encodeShare(s)}`)), json({ ...s, squash: Math.round(s.squash * 1e4) / 1e4 }));
  });

  it("bad: malformed values and unknown keys fall back to the defaults, never throw", () => {
    const d = decodeShare("#scene=nope&cars=abc&night=yes&seed=zz&fx=ultra&car=tank&dside=up&track=../x&foo=1&smin=&ts=1e3&%=%%&");
    assert.equal(json(d), json(DEFAULTS));
  });

  it("bad: out-of-range numbers clamp to the HUD's own ranges", () => {
    const d = decodeShare("cars=999&smin=-5&smax=500&real=2&fxd=9&buckle=-1&ts=0&ai=0&laps=77&aggr=3&squash=9");
    assert.equal(d.cars, 32);
    assert.equal(d.smin, KNOB_RANGES.speed.min);
    assert.equal(d.smax, KNOB_RANGES.speed.max);
    assert.equal(d.real, KNOB_RANGES.realism.max);
    assert.equal(d.fxd, KNOB_RANGES.fxDensity.max);
    assert.equal(d.buckle, KNOB_RANGES.buckle.min);
    assert.equal(d.ts, KNOB_RANGES.timeScale.min);
    assert.equal(d.ai, 1);
    assert.equal(d.laps, 9);
    assert.equal(d.aggr, 1);
    assert.equal(d.squash, KNOB_RANGES.squash.max);
  });

  it("good: a seed is written in hex, read in either case, holds 32 bits and no more", () => {
    assert.equal(encodeShare({ ...DEFAULTS, seed: 0xab }), "seed=ab");
    assert.equal(decodeShare("seed=AB").seed, 0xab);
    assert.equal(decodeShare("seed=ffffffff").seed, 0xffffffff);
    assert.equal(decodeShare("seed=1ffffffff").seed, null);
  });
});

describe("share URL: the netplay room", () => {
  it("good: a room round-trips, with its link, and is uppercased as the Room field does", () => {
    assert.equal(encodeShare({ ...DEFAULTS, room: "K7M2QX9P" }), "room=K7M2QX9P");
    assert.equal(encodeShare({ ...DEFAULTS, room: "K7M2QX9P", tx: "bc" }), "room=K7M2QX9P&tx=bc");
    const s: ShareState = { ...DEFAULTS, room: "K7M2QX9P", tx: "bc", scene: "race", laps: 4, seed: 0xabc };
    assert.equal(json(decodeShare(`#${encodeShare(s)}`)), json(s));
    assert.equal(decodeShare("room=k7m2qx9p").room, "K7M2QX9P");
    assert.equal(isShareableRoom("K7M2QX9P"), true);
    assert.equal(isShareableRoom("k7m2"), false, "written uppercase only");
  });

  it("good: links made before rooms existed decode as before, with no room", () => {
    const old = "#scene=race&track=figure8&laps=5&ai=11&night=1&seed=3fa2c1";
    const d = decodeShare(old);
    assert.equal(d.room, "");
    assert.equal(d.tx, "rtc");
    assert.equal(d.scene, "race");
    assert.equal(d.track, "figure8");
    assert.equal(d.laps, 5);
    assert.equal(d.seed, 0x3fa2c1);
    assert.equal(json(decodeShare(encodeShare(d))), json(d), "and writes back to the same state");
  });

  it("bad: a malformed room, and any public room's name, is no room (a crafted link cannot join a public match)", () => {
    for (const raw of ["", "a b", "ABCDEFGHJKLMN", "../x", "pub-x", "pub-race-v5-QWERTY", "<script>"]) {
      assert.equal(decodeShare(`room=${encodeURIComponent(raw)}`).room, "", JSON.stringify(raw));
    }
    assert.equal(decodeShare("tx=udp").tx, "rtc");
  });

  it("good: scene=survival round-trips in the # when alone; a link that names a room never opens it (Survival is single player)", () => {
    const alone: ShareState = { ...DEFAULTS, scene: "survival" };
    assert.equal(encodeShare(alone), "scene=survival");
    assert.equal(decodeShare("#scene=survival").scene, "survival");
    assert.equal(json(decodeShare(`#${encodeShare(alone)}`)), json(alone));
    assert.equal(decodeShare("#room=K7M2QX9P&scene=survival").scene, "fleet", "a room's link with Survival in it joins the host's scene");
    assert.equal(decodeShare("#room=K7M2QX9P&scene=survival").room, "K7M2QX9P");
    // The other scenes are still a room's to carry.
    assert.equal(decodeShare("#room=K7M2QX9P&scene=range").scene, "range");
  });

  it("good: a host's # carries its settings and room, a guest's only the room, and leaving drops it", () => {
    const hosting: ShareState = { ...DEFAULTS, room: "ABCD2345", cars: 5 };
    assert.equal(shareFragment(hosting, false), "room=ABCD2345&cars=5");
    assert.equal(shareFragment(hosting, true), "room=ABCD2345", "a guest's scene is the host's");
    assert.equal(shareFragment({ ...hosting, room: "" }, false), "cars=5", "left: the room is gone from the #");
    assert.equal(shareFragment({ ...DEFAULTS, cars: 5, room: "" }, true), "", "a guest that left writes nothing");
  });

  it("good: roomLink is the page URL plus the room alone", () => {
    assert.equal(roomLink("https://x.test/crush/", "ABCD2345", "rtc"), "https://x.test/crush/#room=ABCD2345");
    assert.equal(roomLink("https://x.test/", "ABCD2345", "bc"), "https://x.test/#room=ABCD2345&tx=bc");
    assert.equal(decodeShare(roomLink("https://x.test/", "ABCD2345", "bc").split("#")[1]!).room, "ABCD2345");
  });

  it("good: a # joins only a room this browser is not already in, and one without a room joins nothing", () => {
    const off = { room: "", tx: "rtc" } as const;
    assert.equal(joinsRoom(decodeShare("room=ABCD2345"), off), true);
    assert.equal(joinsRoom(decodeShare("room=ABCD2345"), { room: "ABCD2345", tx: "rtc" }), false, "already there");
    assert.equal(joinsRoom(decodeShare("room=ABCD2345"), { room: "ZZZZ2345", tx: "rtc" }), true, "another room");
    assert.equal(joinsRoom(decodeShare("room=ABCD2345&tx=bc"), { room: "ABCD2345", tx: "rtc" }), true, "same code, other link");
    assert.equal(joinsRoom(decodeShare("night=1"), { room: "ABCD2345", tx: "rtc" }), false, "a # without a room never leaves one");
    assert.equal(joinsRoom(decodeShare(""), off), false);
  });
});

/**
 * Boot precedence: the `#` alone decides what a page load starts as (engine-share.ts `arrive`: `decodeShare`, then
 * `joinsRoom`). The app stores only preferences (driver name and car, HUD layout, saved highlights), so no previous-run
 * session state exists for a hash to lose against.
 */
describe("share URL: what a page load starts as", () => {
  const off = { room: "", tx: "rtc" } as const;

  it("hash with a room: joins it, with the hash's own settings", () => {
    const t = decodeShare("#room=ABCD2345&night=1&scene=race");
    assert.equal(joinsRoom(t, off), true);
    assert.equal(t.room, "ABCD2345");
    assert.equal(t.night, true);
    assert.equal(t.scene, "race");
  });

  it("hash without a room: its settings, no room, no join", () => {
    const t = decodeShare("#night=1&cars=5");
    assert.equal(joinsRoom(t, off), false);
    assert.equal(t.room, "");
    assert.equal(t.night, true);
    assert.equal(t.cars, 5);
  });

  it("no hash: the defaults, no room, no join", () => {
    for (const none of ["", "#"]) {
      const t = decodeShare(none);
      assert.equal(json(t), json(DEFAULTS));
      assert.equal(joinsRoom(t, off), false);
    }
  });
});

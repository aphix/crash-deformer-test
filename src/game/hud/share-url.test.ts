import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeShare, encodeShare, isShareableRoom, joinsRoom, roomLink, shareFragment, type ShareState } from "./share-url.ts";
import { INITIAL_HUD, KNOB_RANGES } from "./hud-store.ts";
import { DRIVER_CARS } from "../match/types.ts";

const DEFAULTS = decodeShare("");
const json = (s: ShareState): string => JSON.stringify(s);

describe("given the default share settings", () => {
  it("when the defaults are encoded and an empty fragment is decoded, then the defaults write an empty fragment and an empty fragment reads back as the defaults", () => {
    assert.equal(encodeShare(DEFAULTS), "");
    assert.equal(DEFAULTS.scene, "fleet");
    assert.equal(DEFAULTS.cars, INITIAL_HUD.carCount);
    assert.equal(DEFAULTS.smax, INITIAL_HUD.speedMax);
    assert.equal(DEFAULTS.seed, null);
    assert.equal(DEFAULTS.fx, null);
  });

  it("when cars, minimum speed, ramps and a seed differ from the defaults, then only those are written, in a readable order, and a value equal to its default is dropped even when set explicitly", () => {
    const s: ShareState = { ...DEFAULTS, cars: 7, smin: 12, ramps: true, seed: 0x3fa2c1 };
    assert.equal(encodeShare(s), "cars=7&smin=12&ramps=1&seed=3fa2c1");
    // A value equal to its default is dropped even when it was set explicitly.
    assert.equal(encodeShare({ ...DEFAULTS, cars: INITIAL_HUD.carCount, night: false }), "");
  });
});

describe("given a share state with every kind of field set", () => {
  it("when it is encoded and decoded again, then it comes back as the same state", () => {
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
      cel: 0.65,
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
});

describe("given the player's car type, any of the shared list's", () => {
  for (const car of DRIVER_CARS) {
    const written = car.id === INITIAL_HUD.playerCar ? "" : `car=${car.id}`;
    it(`when the ${car.label} is picked, then the link writes ${written === "" ? "nothing, it being the default" : `"${written}"`} and reads back as the ${car.label}`, () => {
      const s: ShareState = { ...DEFAULTS, car: car.id };
      assert.equal(encodeShare(s), written);
      assert.equal(decodeShare(`#${encodeShare(s)}`).car, car.id);
    });
  }
});

describe("given the Ultra effects tier pinned in a link", () => {
  it("when the link is written and read, then it carries fx=ultra and reads back as the Ultra tier", () => {
    const s: ShareState = { ...DEFAULTS, fx: "ultra" };
    assert.equal(encodeShare(s), "fx=ultra");
    assert.equal(decodeShare(`#${encodeShare(s)}`).fx, "ultra");
  });
});

describe("given a link with malformed values and unknown keys", () => {
  it("when it is decoded, then every field falls back to its default and nothing throws", () => {
    const d = decodeShare("#scene=nope&cars=abc&night=yes&seed=zz&fx=turbo&car=tank&dside=up&track=../x&foo=1&smin=&ts=1e3&%=%%&");
    assert.equal(json(d), json(DEFAULTS));
  });
});

describe("given a link with out-of-range numbers", () => {
  it("when it is decoded, then each number clamps to the HUD's own range for that setting", () => {
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
});

describe("given the cel (cartoon shading) strength, which is Auto until a manual strength is set", () => {
  it("when it is left Auto, set manually, or decoded from an out-of-range or unreadable value, then Auto is never written, a manual strength is written, 0 is a real value, and out-of-range values clamp", () => {
    assert.equal(DEFAULTS.cel, null);
    assert.equal(encodeShare({ ...DEFAULTS, cel: null }), "");
    assert.equal(encodeShare({ ...DEFAULTS, cel: 0.5 }), "cel=0.5");
    assert.equal(decodeShare("cel=0").cel, 0);
    assert.equal(decodeShare("cel=7").cel, KNOB_RANGES.cel.max);
    assert.equal(decodeShare("cel=-1").cel, KNOB_RANGES.cel.min);
    assert.equal(decodeShare("cel=abc").cel, null);
  });
});

describe("given a random seed in a share link", () => {
  it("when it is written and read, then it is written in hex, read in either case, holds 32 bits and no more", () => {
    assert.equal(encodeShare({ ...DEFAULTS, seed: 0xab }), "seed=ab");
    assert.equal(decodeShare("seed=AB").seed, 0xab);
    assert.equal(decodeShare("seed=ffffffff").seed, 0xffffffff);
    assert.equal(decodeShare("seed=1ffffffff").seed, null);
  });
});

describe("given a share link that may carry a netplay room", () => {
  it("when a room is written to a link and read back, then it round-trips with its transport and its link, is uppercased as the Room field does, and only an all-uppercase code counts as shareable", () => {
    assert.equal(encodeShare({ ...DEFAULTS, room: "K7M2QX9P" }), "room=K7M2QX9P");
    assert.equal(encodeShare({ ...DEFAULTS, room: "K7M2QX9P", tx: "bc" }), "room=K7M2QX9P&tx=bc");
    const s: ShareState = { ...DEFAULTS, room: "K7M2QX9P", tx: "bc", scene: "race", laps: 4, seed: 0xabc };
    assert.equal(json(decodeShare(`#${encodeShare(s)}`)), json(s));
    assert.equal(decodeShare("room=k7m2qx9p").room, "K7M2QX9P");
    assert.equal(isShareableRoom("K7M2QX9P"), true);
    assert.equal(isShareableRoom("k7m2"), false, "written uppercase only");
  });

  it("when a link made before rooms existed is decoded, then it has no room and the same settings, and writes back to the same state", () => {
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

  it("when the room is malformed or is a public room's name, then it is no room (a crafted link cannot join a public match), and an unknown transport falls back to the default", () => {
    for (const raw of ["", "a b", "ABCDEFGHJKLMN", "../x", "pub-x", "pub-race-v5-QWERTY", "<script>"]) {
      assert.equal(decodeShare(`room=${encodeURIComponent(raw)}`).room, "", JSON.stringify(raw));
    }
    assert.equal(decodeShare("tx=udp").tx, "rtc");
  });

  it("when scene=survival is written, then it round-trips in the # alone and with a room (a hosted run is a team's), while a link that names a room never opens a single-player scene, the Lab", () => {
    const alone: ShareState = { ...DEFAULTS, scene: "survival" };
    assert.equal(encodeShare(alone), "scene=survival");
    assert.equal(decodeShare("#scene=survival").scene, "survival");
    assert.equal(json(decodeShare(`#${encodeShare(alone)}`)), json(alone));
    assert.equal(decodeShare("#room=K7M2QX9P&scene=survival").scene, "survival", "Survival is a room's to carry");
    assert.equal(decodeShare("#room=K7M2QX9P&scene=lab").scene, "fleet", "a room's link with the Lab in it joins the host's scene");
    assert.equal(decodeShare("#room=K7M2QX9P&scene=lab").room, "K7M2QX9P");
    // The other scenes are still a room's to carry.
    assert.equal(decodeShare("#room=K7M2QX9P&scene=range").scene, "range");
  });

  it("when the # is written for a host, a guest and someone who left, then a host's carries its settings and room, a guest's only the room, and leaving drops the room", () => {
    const hosting: ShareState = { ...DEFAULTS, room: "ABCD2345", cars: 7 };
    assert.equal(shareFragment(hosting, false), "room=ABCD2345&cars=7");
    assert.equal(shareFragment(hosting, true), "room=ABCD2345", "a guest's scene is the host's");
    assert.equal(shareFragment({ ...hosting, room: "" }, false), "cars=7", "left: the room is gone from the #");
    assert.equal(shareFragment({ ...DEFAULTS, cars: 7, room: "" }, true), "", "a guest that left writes nothing");
  });

  it("when a room link is built from a page URL, then it is the page URL plus the room alone, and the transport only when it is not the default", () => {
    assert.equal(roomLink("https://x.test/crush/", "ABCD2345", "rtc"), "https://x.test/crush/#room=ABCD2345");
    assert.equal(roomLink("https://x.test/", "ABCD2345", "bc"), "https://x.test/#room=ABCD2345&tx=bc");
    assert.equal(decodeShare(roomLink("https://x.test/", "ABCD2345", "bc").split("#")[1]!).room, "ABCD2345");
  });

  it("when a # is checked against the room this browser is in, then it joins only a room this browser is not already in (another room, or the same code over another link), and one without a room joins nothing", () => {
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
describe("given a page load, where the # alone decides what it starts as", () => {
  const off = { room: "", tx: "rtc" } as const;

  it("when the hash names a room, then it joins that room with the hash's own settings", () => {
    const t = decodeShare("#room=ABCD2345&night=1&scene=race");
    assert.equal(joinsRoom(t, off), true);
    assert.equal(t.room, "ABCD2345");
    assert.equal(t.night, true);
    assert.equal(t.scene, "race");
  });

  it("when the hash names no room, then it keeps its settings, has no room and does not join", () => {
    const t = decodeShare("#night=1&cars=5");
    assert.equal(joinsRoom(t, off), false);
    assert.equal(t.room, "");
    assert.equal(t.night, true);
    assert.equal(t.cars, 5);
  });

  it("when there is no hash (empty or a bare #), then it is the defaults with no room and no join", () => {
    for (const none of ["", "#"]) {
      const t = decodeShare(none);
      assert.equal(json(t), json(DEFAULTS));
      assert.equal(joinsRoom(t, off), false);
    }
  });
});

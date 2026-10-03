import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeShare, encodeShare, type ShareState } from "./share-url.ts";
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

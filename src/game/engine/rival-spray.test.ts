import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { createHash } from "node:crypto";
import type * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { HudStore } from "../hud/hud-store.ts";
import { CAR_SPRAY, NO_CAR_PICK } from "../match/look-data.ts";
import type { HighlightClip } from "../match/highlights.ts";
import { readRace, writeRace } from "../net/codec.ts";
import { encodeSaved } from "../net/reel-codec.ts";
import { lookColours } from "../present/car-look.ts";
import { RivalLooks } from "../present/rival-look.ts";
import { BARE_SPRAY } from "../present/spray.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { setGround } from "../world/ground.ts";
import { FRAME_HZ } from "../kernel/constants.ts";
import { assertSameDigest } from "../vehicle/test-support.ts";
import { recordFlat, type Spawn } from "./replay-fidelity.test-util.ts";
import { TRAFFIC_NAME } from "./engine-race-field.ts";
import { CrashEngine } from "./engine.ts";
import { element, stubBrowser } from "./engine-headless.test-util.ts";
import { rivalSeedOf } from "./rival-seed.ts";

/**
 * AI opponents wear rival sprays (docs/CINEMATIC.md, driver looks): through the real engine, race, campaign, netplay client, derby and
 * saved clip, a car's worn spray is read off the paint's own shader hook, the way the renderer would sample it.
 */

const FRAME = 1 / FRAME_HZ;
/** Event-loop turns the saved clip's async decode may take before the row calls it stuck. */
const MAX_TURNS = 5000;
/** The race the rows run: AI racers on car 1-3, the player on car 0, traffic and police cars after them. */
const AI_COUNT = 3;
const AI_SLOTS = [1, 2, 3];
const RACERS = AI_COUNT + 1;
/** The car a netplay peer sits in during the derby row. */
const PEER_SLOT = 2;
/** The garage can's palette index the player's own spray is filled with. */
const OWN_INK = 4;
/** Longest a campaign round races before its order must have changed from the grid's (seconds of sim). */
const MAX_RACING_SECONDS = 120;
/** The saved clip's cars (x, z, heading in rad, m/s): a head-on between cars 0 and 1 with car 2 idle 1.9 m beside their line. */
const HEAD_ON: Spawn[] = [
  { x: 0, z: 0, yaw: Math.PI / 2, speed: 20, throttle: 1 },
  { x: 80, z: 0, yaw: -Math.PI / 2, speed: 20, throttle: 1 },
  { x: 40, z: 1.9, yaw: Math.PI / 2, speed: 0, throttle: 0 },
];
/** The look seed the saved clip carries: the racer's rival spray is drawn from it, not from the engine's own field. */
const CLIP_LOOK = 0x5eed1234;

const rivalsOracle = new RivalLooks();

/**
 * A spray's identity: the digest of its texels (a failed `assert.deepEqual` on two 64 KiB arrays prints a diff that eats the machine).
 * Premultiplied rgba, hashed as the bitmap holds it.
 */
const digestOf = (texels: Uint8Array): string => createHash("sha1").update(texels).digest("hex");

/** Car `car`'s worn spray texture, or null while its paint samples no spray (never worn, or the bare 1 x 1). */
function wornMap(car: DeformableCar): THREE.DataTexture | null {
  const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: "", fragmentShader: "" };
  car.lookMeshes().bodyPaint.onBeforeCompile(shader as never, undefined as never);
  const map = shader.uniforms.sprayMap?.value as THREE.DataTexture | undefined;
  return map === undefined || map === BARE_SPRAY ? null : map;
}

/** Car `car`'s worn spray digest, or null while it wears none. */
const sprayOn = (car: DeformableCar): string | null => {
  const map = wornMap(car);
  return map === null ? null : digestOf(map.image.data as Uint8Array);
};

/** The rival spray `seed` draws on `car` in `slot`, by a `RivalLooks` of the test's own. */
function rivalSprayOf(seed: number, slot: number, car: DeformableCar): string {
  return digestOf(rivalsOracle.of(seed, slot, lookColours(car, NO_CAR_PICK).body).rgba);
}

describe("given pure seeds for a derby and a race", () => {
  const race = { rivalSeed: (slot: number): number | null => (slot === 1 ? 77 : null) };
  const seated = new Set([2]);

  it("when no derby is on, then the race decides: its seed for an AI racer, none for the rest", () => {
    assert.equal(rivalSeedOf(1, race, null), 77);
    assert.equal(rivalSeedOf(0, race, null), null);
  });

  it("when a derby is on, then every car but a seated peer's wears the derby's round, whatever the race says", () => {
    assert.equal(rivalSeedOf(0, race, { round: 5, seated }), 5);
    assert.equal(rivalSeedOf(1, race, { round: 5, seated }), 5);
    assert.equal(rivalSeedOf(3, race, { round: 5, seated }), 5);
    assert.equal(rivalSeedOf(2, race, { round: 5, seated }), null);
  });
});

describe("given the real engine headless", () => {
  // One engine for the file: a second `CrashEngine` in the same process never resolves `ready`. The rows run in order on it.
  let engine: CrashEngine;
  let recorded: HighlightClip;
  let savedText: string;
  const store = new Map<string, string>();
  const run = (seconds: number): void => {
    for (let i = 0; i < seconds * FRAME_HZ; i++) engine.advance(FRAME, { frameDt: FRAME });
  };
  const cars = (): DeformableCar[] => engine["live"]();
  const race = () => engine["race"];
  const wornBy = (slots: readonly number[]): (string | null)[] => slots.map((slot) => sprayOn(cars()[slot]!));
  /** The player's own spray (its garage bitmap) as it is now: its digest. */
  const ownDigest = (): string => digestOf(engine["looks"].mine.carSpray.rgba);
  /** The garage bitmap filled with `OWN_INK`: its digest. */
  const ownSpray = (): string => {
    const mine = engine["looks"].mine.carSpray;
    mine.load(new Uint8Array(mine.texels.length).fill(OWN_INK));
    return digestOf(mine.rgba);
  };
  const startSingle = (): void => {
    engine.raceCommand({ type: "options", options: { trackId: "city", aiCount: AI_COUNT, laps: 1, police: true, campaign: ["oval", "rally"] } });
    engine.raceCommand({ type: "start" });
  };
  /** Every AI racer's worn spray is its seed's rival spray. */
  const assertRivals = (seed: number, why: string): void => {
    for (const slot of AI_SLOTS) {
      const worn = sprayOn(cars()[slot]!);
      assert.notEqual(worn, null, `${why}: car ${slot} wears a spray`);
      assert.equal(worn, rivalSprayOf(seed, slot, cars()[slot]!), `${why}: car ${slot} wears its rival look`);
    }
  };

  before(async () => {
    // The crash is recorded on a flat field before the engine boots: a race's ground would tilt it out of the highlight ranking.
    setGround(null);
    recorded = recordFlat(HEAD_ON, 8, true).clip;
    // Filed on the oval under a look of its own; the bystander's name is the one a clip gives a car that is no racer.
    savedText = await encodeSaved({ ...recorded, trackId: "oval", look: CLIP_LOOK, cars: recorded.cars.map((c) => (c.slot === 2 ? { ...c, name: TRAFFIC_NAME } : c)) });
    stubBrowser();
    globalThis.localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) } as Storage;
    engine = new CrashEngine(element(), new HudStore(), element());
    Object.assign(engine["renderer"], { render() {}, compile() {}, compileAsync: () => Promise.resolve() });
    await engine.ready;
    engine.fadeScenes = false;
    let tick = 0;
    Object.assign(engine.pace, { now: () => (tick += 0.001) });
  });
  after(() => {
    engine.dispose();
    rivalsOracle.dispose();
    setGround(null);
  });

  it("when a single race starts, then every AI racer wears the rival spray of the field's look, and the player's car, the traffic and the police wear none", () => {
    engine.toggleRace();
    startSingle();
    run(1);
    assert.ok(cars().length > RACERS, "the city has traffic or police past the racers");
    assertRivals(race().look, "single race");
    assert.equal(sprayOn(cars()[0]!), ownDigest(), "the player's car wears its own (blank) garage spray, no rival's");
    for (let slot = RACERS; slot < cars().length; slot++) assert.equal(sprayOn(cars()[slot]!), null, `car ${slot} (traffic or police) stays bare`);
  });

  it("when the player has a garage spray and a race starts, then it stays on car 0 byte for byte while the opponents wear rival sprays, even when car 0 is itself an AI racer (spectating)", () => {
    const own = ownSpray();
    engine.raceCommand({ type: "start" });
    run(1);
    assert.equal(sprayOn(cars()[0]!), own, "the player's own spray is on car 0");
    assertRivals(race().look, "after the player's spray");
    engine.raceCommand({ type: "options", options: { spectate: true } });
    engine.raceCommand({ type: "start" });
    run(1);
    assert.equal(race()["entrants"][0]?.kind, "ai", "car 0 is an AI racer in a spectated race");
    assert.equal(sprayOn(cars()[0]!), own, "the player's own spray still wins on car 0");
    engine.raceCommand({ type: "options", options: { spectate: false } });
    engine["looks"].mine.carSpray.load(null);
  });

  it("when a campaign's first round ends and the next starts, then every car index wears the same spray as in round one on a reshuffled grid; a retry keeps them and a new field changes them", () => {
    engine.raceCommand({ type: "campaign" });
    const look = race().look;
    const firstGrid = [...race()["grid"]];
    for (let second = 0; second < MAX_RACING_SECONDS && race().hud().standings.every((row, place) => row.id === firstGrid[place]); second++) run(1);
    assert.notEqual(
      race().hud().standings.map((row) => row.id).join(","),
      firstGrid.join(","),
      "the field's order changed on the road",
    );
    const roundOne = wornBy(AI_SLOTS);
    assertRivals(look, "campaign round one");
    engine.raceCommand({ type: "end" });
    engine.raceCommand({ type: "next" });
    assert.equal(race().menu, "standings", "the round is scored");
    engine.raceCommand({ type: "next" });
    assert.equal(race().menu, null, "round two is racing");
    assert.notEqual(race()["grid"].join(","), firstGrid.join(","), "the grid reordered by the standings");
    assert.equal(race().look, look, "the field's look is the campaign's");
    assertSameDigest(wornBy(AI_SLOTS), roundOne, "round two's opponents wear what they wore in round one");
    engine.raceCommand({ type: "retry" });
    assertSameDigest(wornBy(AI_SLOTS), roundOne, "a retry keeps them");
    engine.raceCommand({ type: "quit" });
    engine.raceCommand({ type: "start" });
    assert.notEqual(race().look, look, "a new field rolls a new look");
    assert.notEqual(wornBy(AI_SLOTS).join("|"), roundOne.join("|"), "and the opponents change with it");
  });

  it("when the race is left, then every car is bare again", () => {
    run(1);
    assert.ok(wornBy(AI_SLOTS).every((spray) => spray !== null), "worn in the race");
    engine.toggleRace();
    assert.equal(race().active, false);
    assert.ok(wornBy(AI_SLOTS).every((spray) => spray === null), "bare in the fleet");
  });

  it("when the FX tier rises to High during a race and falls back, then the opponents' sprays are redrawn twice as fine and then as the garage's again, each the oracle's at that tier, and the player's car keeps its own", () => {
    engine.toggleRace();
    startSingle();
    run(1);
    const standard = wornBy(AI_SLOTS);
    const own = ownDigest();
    const sides = (): string => AI_SLOTS.map((slot) => wornMap(cars()[slot]!)?.image.width).join(",");
    const sidesOf = (width: number): string => AI_SLOTS.map(() => width).join(",");
    assert.equal(sides(), sidesOf(CAR_SPRAY.w), "the garage's size at Minimal");
    // The Sky setting off, so the High tier fetches no sky texture (the headless page has none to give).
    engine.setSky("off");
    try {
      engine["cine"].setTier("high");
      rivalsOracle.useTier("high", "desktop");
      run(0.1);
      assert.equal(sides(), sidesOf(CAR_SPRAY.w * 2), "twice the texels a side at High");
      assertRivals(race().look, "at High");
      assert.equal(sprayOn(cars()[0]!), own, "the player's own spray is as it was");
    } finally {
      engine["cine"].setTier("minimal");
      rivalsOracle.useTier("minimal", "desktop");
    }
    run(0.1);
    assert.equal(sides(), sidesOf(CAR_SPRAY.w), "the garage's size again");
    assertSameDigest(wornBy(AI_SLOTS), standard, "the same sprays as before the rise");
    engine.toggleRace();
  });

  it("when a netplay client adopts the host's race state, then its AI racers wear the host's sprays on a fresh snapshot, and the player's car and the peers' stay bare", () => {
    engine.toggleRace();
    startSingle();
    run(1);
    const hostLook = race().look;
    const host = wornBy(AI_SLOTS);
    assertRivals(hostLook, "host");
    const wire = readRace(writeRace({ lobby: null, trackId: "city", look: hostLook, gate: null, next: null, snap: race().snapshot() }));
    assert.ok(wire?.snap, "the host's race state passes the client's checks");
    engine.raceCommand({ type: "quit" });
    assert.ok(wornBy(AI_SLOTS).every((spray) => spray === null), "the client's setup field is bare");
    assert.notEqual(race().look, hostLook, "the client's own field has its own look");
    race().look = wire.look;
    race().applySnapshot(wire.snap, RACERS + 1);
    assertSameDigest(wornBy(AI_SLOTS), host, "the client's opponents wear the host's sprays");
    assert.equal(sprayOn(cars()[0]!), ownDigest(), "the host's player is a peer here: no rival spray");
    engine.toggleRace();
  });

  it("when a derby begins with a peer seated on a car and the player has a garage spray, then the other AI cars wear the round's rival sprays and the player's car and the peer's do not", () => {
    const own = ownSpray();
    engine["netSeats"] = new Map([[PEER_SLOT, "Zed"]]);
    engine["ensureCars"](RACERS);
    engine.toggleDerby();
    const round = engine["derbyRound"];
    for (const slot of [1, 3]) assert.equal(sprayOn(cars()[slot]!), rivalSprayOf(round, slot, cars()[slot]!), `derby car ${slot} wears round ${round}'s rival look`);
    assert.equal(sprayOn(cars()[PEER_SLOT]!), null, "the seated peer's car wears nothing of ours");
    assert.equal(sprayOn(cars()[0]!), own, "the player's own spray wins on car 0");
    engine["looks"].mine.carSpray.load(null);
  });

  it("when a client adopts the host's derby round, then its AI cars are re-dressed to that round's rival sprays, and leaving the derby makes them bare", () => {
    const state = engine["derbyNetState"]()!;
    const hostRound = state.round;
    const host = wornBy([1, 3]);
    engine["netSeats"] = new Map();
    engine.toggleDerby();
    engine.toggleDerby();
    assert.notEqual(engine["derbyRound"], hostRound, "the client's own derby is a round on");
    assert.notEqual(wornBy([1, 3]).join("|"), host.join("|"), "and its cars wear that round's sprays");
    engine["applyNetDerby"](state, -1);
    assert.equal(engine["derbyRound"], hostRound);
    assertSameDigest(wornBy([1, 3]), host, "the client's AI cars wear the host's round");
    engine.toggleDerby();
    assert.ok(wornBy([1, 3]).every((spray) => spray === null), "the fleet's cars are bare");
  });

  it("when a saved clip is played alone from the setup menu, then its racers wear the sprays of the clip's look, the traffic and the player's own car do not, and bare paint is back when the clip ends", async () => {
    // The clip is the head-on of car 0 (this browser's own) and car 1 beside bystander 2, recorded in `before` by the engine's own recorder.
    assert.deepEqual(recorded.cars.map((c) => c.slot), [0, 1, 2], "the clip holds all three cars");
    const [racer, bystander] = [1, 2];
    store.set("crush.highlight.rival", savedText);
    engine.toggleRace();
    assert.equal(race().menu, "setup", "the race menu is up on its setup screen");
    engine.raceCommand({ type: "savedPlay", key: "rival" });
    for (let turns = 0; turns < MAX_TURNS && engine["highlights"]["solo"] === null; turns++) await yieldToLoop();
    assert.notEqual(engine["highlights"]["solo"], null, "the saved clip is up alone");
    const car = (slot: number): DeformableCar => engine["cars"][slot]!;
    assert.equal(sprayOn(car(racer)), rivalSprayOf(CLIP_LOOK, racer, car(racer)), "the clip's racer wears the clip's look");
    assert.equal(sprayOn(car(bystander)), null, "its bystander stays bare");
    assert.equal(sprayOn(car(0)), ownDigest(), "this browser's own car keeps its own spray");
    engine.raceCommand({ type: "reelBack" });
    assert.equal(sprayOn(car(racer)), null, "the racer is bare once the clip is over");
  });
});

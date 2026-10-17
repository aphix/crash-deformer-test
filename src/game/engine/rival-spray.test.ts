import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { createHash } from "node:crypto";
import type * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { HudStore } from "../hud/hud-store.ts";
import { NO_CAR_PICK } from "../match/look-data.ts";
import { readRace, writeRace } from "../net/codec.ts";
import { makeClip } from "../net/reel-clip.test-util.ts";
import { encodeSaved } from "../net/reel-codec.ts";
import { lookColours } from "../present/car-look.ts";
import { RivalLooks } from "../present/rival-look.ts";
import { BARE_SPRAY } from "../present/spray.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { setGround } from "../world/ground.ts";
import { FRAME_HZ } from "../kernel/constants.ts";
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
/** Seconds of racing past the green light, so the field has an order for a campaign round to reshuffle. */
const RACING_SECONDS = 12;
/** How far ahead of the lead AI car the player is put, so the round's standings put the player first. */
const LEAD_METRES = 25;

const rivalsOracle = new RivalLooks();

/**
 * A spray's identity: the digest of its texels (a failed `assert.deepEqual` on two 64 KiB arrays prints a diff that eats the machine).
 * Premultiplied rgba, hashed as the bitmap holds it.
 */
const digestOf = (texels: Uint8Array): string => createHash("sha1").update(texels).digest("hex");

/** Car `car`'s worn spray digest, or null while its paint samples no spray (never worn, or the bare 1 x 1). */
function sprayOn(car: DeformableCar): string | null {
  const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: "", fragmentShader: "" };
  car.lookMeshes().bodyPaint.onBeforeCompile(shader as never, undefined as never);
  const map = shader.uniforms.sprayMap?.value as THREE.DataTexture | undefined;
  return map === undefined || map === BARE_SPRAY ? null : digestOf(map.image.data as Uint8Array);
}

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

  it("when the player has a garage spray and a race starts, then it stays on car 0 byte for byte while the opponents wear rival sprays", () => {
    const own = ownSpray();
    engine.raceCommand({ type: "start" });
    run(1);
    assert.deepEqual(sprayOn(cars()[0]!), own, "the player's own spray is on car 0");
    assertRivals(race().look, "after the player's spray");
    engine["looks"].mine.carSpray.load(null);
  });

  it("when a campaign's first round ends and the next starts, then every car index wears the same spray as in round one on a reshuffled grid; a retry keeps them and a new field changes them", () => {
    engine.raceCommand({ type: "campaign" });
    engine["keys"].add("KeyW");
    run(RACING_SECONDS);
    engine["keys"].clear();
    const look = race().look;
    const firstGrid = [...race()["grid"]];
    const roundOne = wornBy(AI_SLOTS);
    assertRivals(look, "campaign round one");
    const lead = cars()[1]!;
    const heading = Math.atan2(lead.velocity.x, lead.velocity.z);
    race()["place"](cars()[0]!, lead.group.position.x + Math.sin(heading) * LEAD_METRES, lead.group.position.z + Math.cos(heading) * LEAD_METRES, heading, lead.group.position.y);
    run(1);
    engine.raceCommand({ type: "end" });
    engine.raceCommand({ type: "next" });
    assert.equal(race().menu, "standings", "the round is scored");
    engine.raceCommand({ type: "next" });
    assert.equal(race().menu, null, "round two is racing");
    console.log("DBG", JSON.stringify(firstGrid), JSON.stringify(race()["grid"]), JSON.stringify(race().hud().standings.map((r) => [r.id, r.place, r.name])));
    assert.notDeepEqual(race()["grid"], firstGrid, "the grid reordered by the standings");
    assert.equal(race().look, look, "the field's look is the campaign's");
    assert.deepEqual(wornBy(AI_SLOTS), roundOne, "round two's opponents wear what they wore in round one");
    engine.raceCommand({ type: "retry" });
    assert.deepEqual(wornBy(AI_SLOTS), roundOne, "a retry keeps them");
    engine.raceCommand({ type: "quit" });
    engine.raceCommand({ type: "start" });
    assert.notEqual(race().look, look, "a new field rolls a new look");
    assert.notDeepEqual(wornBy(AI_SLOTS), roundOne, "and the opponents change with it");
  });

  it("when the race is left, then every car is bare again", () => {
    run(1);
    assert.ok(wornBy(AI_SLOTS).every((spray) => spray !== null), "worn in the race");
    engine.toggleRace();
    assert.equal(race().active, false);
    assert.ok(wornBy(AI_SLOTS).every((spray) => spray === null), "bare in the fleet");
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
    assert.deepEqual(wornBy(AI_SLOTS), host, "the client's opponents wear the host's sprays");
    assert.equal(sprayOn(cars()[0]!), ownDigest(), "the host's player is a peer here: no rival spray");
    engine.toggleRace();
  });

  it("when a derby begins with a peer seated on a car and the player has a garage spray, then the other AI cars wear the round's rival sprays and the player's car and the peer's do not", () => {
    const own = ownSpray();
    engine["netSeats"] = new Map([[PEER_SLOT, "Zed"]]);
    engine["ensureCars"](RACERS);
    engine.toggleDerby();
    const round = engine["derbyRound"];
    for (const slot of [1, 3]) assert.deepEqual(sprayOn(cars()[slot]!), rivalSprayOf(round, slot, cars()[slot]!), `derby car ${slot} wears round ${round}'s rival look`);
    assert.equal(sprayOn(cars()[PEER_SLOT]!), null, "the seated peer's car wears nothing of ours");
    assert.deepEqual(sprayOn(cars()[0]!), own, "the player's own spray wins on car 0");
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
    assert.notDeepEqual(wornBy([1, 3]), host, "and its cars wear that round's sprays");
    engine["applyNetDerby"](state, -1);
    assert.equal(engine["derbyRound"], hostRound);
    assert.deepEqual(wornBy([1, 3]), host, "the client's AI cars wear the host's round");
    engine.toggleDerby();
    assert.ok(wornBy([1, 3]).every((spray) => spray === null), "the fleet's cars are bare");
  });

  it("when a saved clip is played alone from the setup menu, then its racers wear the sprays of the clip's look, the traffic and the player's own car do not, and bare paint is back when the clip ends", async () => {
    const { clip } = makeClip();
    const saved = { ...clip, cars: [...clip.cars, { slot: 5, style: clip.cars[0]!.style, cls: clip.cars[0]!.cls, name: "Traffic" }] };
    store.set("crush.highlight.rival", await encodeSaved(saved));
    engine.toggleRace();
    engine.raceCommand({ type: "quit" });
    assert.equal(race().menu, "setup");
    engine.raceCommand({ type: "savedPlay", key: "rival" });
    for (let turns = 0; turns < MAX_TURNS && !engine["highlights"].playing; turns++) await yieldToLoop();
    assert.ok(engine["highlights"].playing, "the saved clip plays");
    for (const { slot } of clip.cars) assert.deepEqual(sprayOn(cars()[slot]!), rivalSprayOf(clip.look, slot, cars()[slot]!), `clip car ${slot} wears the clip's look`);
    assert.equal(sprayOn(cars()[5]!), null, "a traffic car in the clip stays bare");
    engine.raceCommand({ type: "reelBack" });
    for (const { slot } of clip.cars) assert.equal(sprayOn(cars()[slot]!), null, `car ${slot} is bare once the clip is over`);
  });
});

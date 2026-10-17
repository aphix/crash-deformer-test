import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import type { MinigameHudState } from "../scenes/minigame-session.ts";
import { HudStore } from "../hud/hud-store.ts";
import { FRAME_HZ } from "../kernel/constants.ts";
import { MINIGAME_AIM_LEAD } from "../present/ride-cam.ts";
import { BOX_POSE_FLOATS, type ReleaseScale } from "../present/ragdoll-boxes.ts";
import { DISC_RADIUS, activeGround, setGround, type Ground } from "../world/ground.ts";
import { MINIGAME_MODES, REST_HOLD, STATION_ANCHORS, THROW_BOOST, type MinigameMode } from "../scenes/minigame-constants.ts";
import { BOX_COUNT, HighJumpCapture, type TorsoSample } from "../scenes/minigame-high-jump.ts";
import { DRIVER_CARS } from "../match/types.ts";
import { lipHeight } from "../scenes/minigame-profile.ts";
import { ringScore } from "../scenes/minigame-ring.ts";
import { MinigameSession } from "../scenes/minigame-session.ts";
import { BAIL_WINDOW_SECONDS, bailRelease, type BailVerdict } from "../scenes/minigame-bail.ts";
import { CrashEngine } from "./engine.ts";
import { element, stubBrowser } from "./engine-headless.test-util.ts";
import { minigameStore } from "./minigame-store.ts";

/**
 * The Range's minigames in the real engine: each mode's start, throw, score and Retry, the dummy and camera held with no timer, the
 * best kept across a reload, and the attract range left exactly as it was (and back again after Exit).
 */

const FRAME = 1 / FRAME_HZ;
const THROTTLE_KEY = "KeyW";
/** Sim seconds a throw may take from the pedal to rest, and the wait the held dummy must outlast. */
const THROW_TIMEOUT_S = 60;
const HOLD_CHECK_S = 60;
const IDLE_WAIT_S = 3;
const START_TOLERANCE = 0.05;
/** The parked car shows within this share of the frame's half-size from its middle, and the eye stands within this many metres of it. */
const PARKED_CAR_FRAME_LIMIT = 0.5;
const PARKED_CAR_EYE_DISTANCE_LIMIT = 30;
/** A full-throttle long jump with no bail rests between these (m): mid-field, half a perfect bail's range; the landing is about 47-57 m and a 30 degree throw rests within a few metres of it. */
const LONG_JUMP_NO_BAIL_MINIMUM = 40;
const LONG_JUMP_NO_BAIL_MAXIMUM = 70;
/** The eye of the parked-start shot: at least this far behind the car, at most this far off its line, looking this closely along its heading (cosine). */
const PARKED_EYE_BEHIND_MIN = 4;
const PARKED_EYE_ASIDE_MAX = 2;
const PARKED_EYE_LOOKING_MIN = 0.8;
const WHEEL_STEP = 100;
/** Sim seconds the ride camera is given to arrive on a dummy just thrown. */
const RIDE_SETTLE_S = 1;

/** An in-memory `localStorage`, the browser's key/value store. */
function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => void entries.delete(key),
    setItem: (key, value) => void entries.set(key, value),
  };
}

type Launch = { releaseScale: ReleaseScale | undefined };

describe("given the real engine on the Range, with a spy on every dummy launch", () => {
  // One engine for the file: a second `CrashEngine` in the same process never resolves `ready`.
  let engine: CrashEngine;
  let hud: HudStore;
  /** The ground the attract Range plays on, read before any minigame. */
  let attractGround: Ground;
  const launches: Launch[] = [];
  const run = (seconds: number): void => {
    for (let i = 0; i < Math.round(seconds * FRAME_HZ); i++) engine.advance(FRAME, { frameDt: FRAME });
  };
  const minigameHud = () => engine["minigames"].hud();
  const releaseThrottle = (): void => {
    engine["keys"].delete(THROTTLE_KEY);
    run(2 * FRAME);
  };
  const stationLocal = (mode: MinigameMode, world: THREE.Vector3, still: number): TorsoSample => ({ x: world.x - STATION_ANCHORS[mode].x, y: world.y, z: world.z - STATION_ANCHORS[mode].z, still });
  /** The player holds the throttle to the lip (or the barrier) and every frame's torso is read, until the throw scores or the sim runs out. */
  const throwAndRead = (mode: MinigameMode): TorsoSample[] => {
    const samples: TorsoSample[] = [];
    const torso = new THREE.Vector3();
    engine["keys"].add(THROTTLE_KEY);
    for (let frame = 0; frame < THROW_TIMEOUT_S * FRAME_HZ && minigameHud().phase !== "scored"; frame++) {
      engine.advance(FRAME, { frameDt: FRAME });
      const still = engine["ragdolls"].latest(torso);
      if (still >= 0) samples.push(stationLocal(mode, torso, still));
    }
    releaseThrottle();
    return samples;
  };
  /** The mode's score of a throw's torso samples, worked out here from the model's own pieces (the first at-rest sample, the posts' plane crossing). */
  const expectedScore = (mode: MinigameMode, samples: readonly TorsoSample[]): number => {
    if (mode === "highJump") {
      const capture = new HighJumpCapture();
      const { postsX } = engine["minigames"]["highJump"];
      for (let k = 1; k < samples.length; k++) {
        const captured = capture.step(samples[k - 1]!, samples[k]!, postsX, lipHeight("highJump"));
        if (captured !== null) return captured;
      }
    }
    const atRest = samples.find((sample) => sample.still >= REST_HOLD);
    assert.ok(atRest, "the dummy came to rest");
    if (mode === "longJump") return Math.max(0, atRest.x);
    if (mode === "ringFling") return ringScore(atRest.x, atRest.z);
    return 0;
  };

  before(async () => {
    stubBrowser();
    Object.defineProperty(globalThis, "localStorage", { value: memoryStorage(), configurable: true, writable: true });
    hud = new HudStore();
    engine = new CrashEngine(element(), hud, element());
    Object.assign(engine["renderer"], { render() {}, compile() {}, compileAsync: () => Promise.resolve() });
    await engine.ready;
    for (let wait = 0; wait < 200 && engine["ragdolls"]["world"] === null; wait++) await delay(50);
    engine.fadeScenes = false;
    let tick = 0;
    Object.assign(engine.pace, { now: () => (tick += 0.001) });
    const ragdolls = engine["ragdolls"];
    const launch = ragdolls.launch.bind(ragdolls);
    ragdolls.launch = (e, cars, rides, releaseScale) => {
      launches.push({ releaseScale });
      launch(e, cars, rides, releaseScale);
    };
    engine["setScene"]("range");
  });
  after(() => {
    engine.dispose();
    setGround(null);
  });

  describe("given the attract Range before any minigame", () => {

    it("when it runs, then it is the auto-looping jersey-barrier range on the flat ground with its art and studio showing, and no minigame card", () => {
      attractGround = activeGround();
      assert.equal(engine["minigameMode"], null, "no minigame in play");
      assert.ok(engine["barrierUp"], "the jersey barrier stands");
      assert.ok(engine["rangeArt"]?.visible, "the sand and signs show");
      assert.ok(engine["studio"].length > 0 && engine["studio"].every((object) => object.visible), "the studio's disc, grid and rings show");
      assert.ok(engine["looping"], "it loops");
      assert.equal(hud.get().minigame, null, "no minigame card");
      assert.ok(hud.get().range !== null, "the range readout shows");
    });

    it("when the car meets the barrier, then its driver is thrown once with no release boost", () => {
      launches.length = 0;
      for (let frame = 0; frame < 10 * FRAME_HZ && launches.length === 0; frame++) engine.advance(FRAME, { frameDt: FRAME });
      assert.equal(launches.length, 1, "one driver thrown");
      assert.equal(launches[0]!.releaseScale, undefined, "the sandbox's throw is unscaled");
    });
  });

  for (const mode of MINIGAME_MODES) {
    describe(`given the ${mode} station`, () => {
      let samples: TorsoSample[] = [];
      let scoredHud: MinigameHudState;
      const car = () => engine["carA"];

      it("when it starts, then the car stands parked at the station's start, the seat only follows, and the card shows a ready attempt", () => {
        engine.startMinigame(mode);
        const start = engine["minigames"].stationStart();
        const position = car().group.position;
        assert.equal(engine["minigameMode"], mode, "the mode is on");
        assert.ok(Math.abs(position.x - start.x) < START_TOLERANCE && Math.abs(position.z - start.z) < START_TOLERANCE, `at the start (${position.x}, ${position.z})`);
        assert.ok(car().parked, "parked");
        assert.equal(engine["seat"].mode, "follow", "follow, not drive");
        assert.equal(hud.get().minigame?.mode, mode, "the card is the mode's");
        assert.equal(hud.get().minigame?.phase, "ready", "ready");
        assert.equal(hud.get().range, null, "the attract readout is gone");
      });

      it("when three seconds pass with no input, then the car has not moved and the attempt is still ready", () => {
        const before = car().group.position.clone();
        run(IDLE_WAIT_S);
        assert.ok(car().group.position.distanceTo(before) < START_TOLERANCE, `moved ${car().group.position.distanceTo(before)} m`);
        assert.equal(minigameHud().phase, "ready", "ready");
      });

      it("when the camera has settled on the parked car, then the car is in frame, near the middle, within 30 m of the eye", (t) => {
        const camera = engine["camera"];
        camera.clearViewOffset();
        camera.aspect = 4 / 3;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
        const inFrame = car().group.position.clone().project(camera);
        const distance = camera.position.distanceTo(car().group.position);
        t.diagnostic(`${mode}: car at (${inFrame.x.toFixed(2)}, ${inFrame.y.toFixed(2)}) of the frame, ${distance.toFixed(1)} m from the eye`);
        assert.ok(inFrame.z <= 1 && Math.abs(inFrame.x) < PARKED_CAR_FRAME_LIMIT && Math.abs(inFrame.y) < PARKED_CAR_FRAME_LIMIT, `car at (${inFrame.x}, ${inFrame.y})`);
        assert.ok(distance < PARKED_CAR_EYE_DISTANCE_LIMIT, `${distance} m from the eye`);
      });

      it("when the camera has settled on the parked car, then the eye stands behind it on its line and looks down its heading", (t) => {
        const camera = engine["camera"];
        const forward = car().forward;
        const behind = camera.position.clone().sub(car().group.position);
        const metresBehind = -behind.dot(forward);
        const metresAside = Math.abs(behind.x * forward.z - behind.z * forward.x);
        const looking = camera.getWorldDirection(new THREE.Vector3()).dot(forward);
        t.diagnostic(`${mode}: eye ${metresBehind.toFixed(1)} m behind, ${metresAside.toFixed(1)} m aside, looking ${looking.toFixed(2)} along the heading`);
        assert.ok(metresBehind >= PARKED_EYE_BEHIND_MIN && metresAside <= PARKED_EYE_ASIDE_MAX, `${metresBehind} m behind, ${metresAside} m aside`);
        assert.ok(looking >= PARKED_EYE_LOOKING_MIN, `looking ${looking} along the heading`);
      });

      it("when the throttle is pressed, then the seat takes the wheel, the car drives off and the attempt is running", () => {
        const before = car().group.position.clone();
        engine["keys"].add(THROTTLE_KEY);
        run(2);
        assert.equal(engine["seat"].mode, "drive", "driving");
        assert.ok(car().group.position.distanceTo(before) > 5, `moved ${car().group.position.distanceTo(before)} m`);
        assert.equal(minigameHud().phase, "running", "running");
        releaseThrottle();
      });

      it("when Reset run is pressed before the throw, then the car is back at the start, parked, and the attempt is ready and not used", () => {
        const attemptBefore = minigameHud().attempt;
        engine.resetMinigameRun();
        const start = engine["minigames"].stationStart();
        assert.ok(Math.abs(car().group.position.x - start.x) < START_TOLERANCE, "back at the start");
        assert.ok(car().parked, "parked");
        assert.equal(minigameHud().phase, "ready", "ready");
        assert.equal(minigameHud().attempt, attemptBefore, "no attempt used");
      });

      it("when the player drives to the lip, then one driver is thrown with this mode's boost and the throw scores what the model reads from the dummy's torso", () => {
        launches.length = 0;
        samples = throwAndRead(mode);
        assert.equal(launches.length, 1, "exactly one throw");
        const boost = launches[0]!.releaseScale!;
        const expectedBoost = mode === "longJump" ? bailRelease(THROW_BOOST.longJump, 0) : THROW_BOOST[mode];
        assert.equal(boost.forward, expectedBoost.forward, "the mode's forward");
        assert.equal(boost.upward, expectedBoost.upward, "the mode's upward");
        assert.equal(boost.elevation, expectedBoost.elevation, "the mode's elevation");
        scoredHud = minigameHud();
        assert.equal(scoredHud.phase, "scored", "scored");
        assert.equal(scoredHud.lastScore, expectedScore(mode, samples), "the score");
      });

      it("when the best was stored, then a new session on the same storage reads it as this car's and the overall best", () => {
        const fresh = new MinigameSession(minigameStore());
        fresh.begin(mode, { carType: "sedan", throwsPerSet: scoredHud.throwsPerSet ?? undefined, highJump: { postsX: engine["minigames"]["highJump"].postsX, lipY: lipHeight("highJump") } });
        // A Ring Fling set keeps its total only once the set is complete; the other modes keep each throw.
        const recorded = scoredHud.throwsPerSet === null ? scoredHud.lastScore! : scoredHud.setComplete ? scoredHud.setTotal : 0;
        const score = recorded;
        if (score > 0) {
          assert.equal(fresh.hud().best.thisCar, score, "this car's best");
          assert.equal(fresh.hud().best.overall, score, "the overall best");
        } else {
          assert.equal(fresh.hud().best.thisCar, null, "a score of 0 is no best");
        }
        assert.equal(scoredHud.best.thisCar, fresh.hud().best.thisCar, "the engine's card shows this car's best");
        assert.equal(scoredHud.best.overall, fresh.hud().best.overall, "the engine's card shows the overall best");
      });

      it(`when ${HOLD_CHECK_S} s pass after the throw, then the dummy is alive, the camera still rides him, and nothing reset: no timer, no loop`, () => {
        const generation = engine["clearGen"]();
        const before = JSON.stringify(minigameHud());
        run(HOLD_CHECK_S);
        const torso = new THREE.Vector3();
        assert.ok(engine["ragdolls"].latest(torso) >= 0, "the dummy is still out");
        assert.ok(engine["ragdolls"].rideAlong, "the ride camera still follows him");
        assert.equal(engine["clearGen"](), generation, "the scene was not cleared");
        assert.equal(JSON.stringify(minigameHud()), before, "the session is unchanged");
        assert.ok(engine["camera"].position.distanceTo(torso) < 60, `the camera is ${engine["camera"].position.distanceTo(torso)} m from him`);
      });

      it("when Retry is pressed, then the dummy is released, the car is back at the start parked, and the next attempt is ready", () => {
        const attemptBefore = minigameHud().attempt;
        engine.retryMinigame();
        const start = engine["minigames"].stationStart();
        assert.ok(engine["ragdolls"].latest(new THREE.Vector3()) < 0, "no dummy out");
        assert.ok(Math.abs(car().group.position.x - start.x) < START_TOLERANCE, "at the start");
        assert.ok(car().parked, "parked");
        assert.equal(minigameHud().phase, "ready", "ready");
        assert.equal(minigameHud().attempt, attemptBefore + 1, "the next attempt");
      });

      if (mode === "highJump") {
        it("when Retry restacks the boxes, then every box stands at its placement", () => {
          const poses = new Float32Array(BOX_COUNT * BOX_POSE_FLOATS);
          const count = engine["ragdolls"].copyBoxPoses(poses);
          const placements = engine["minigames"]["boxPlacements"].highJump!;
          assert.equal(count, placements.length, "box count");
          for (let box = 0; box < count; box++) {
            const placement = placements[box]!;
            const at = box * BOX_POSE_FLOATS;
            assert.ok(Math.hypot(poses[at]! - placement.x, poses[at + 1]! - placement.y, poses[at + 2]! - placement.z) < 0.01, `box ${box} at its place`);
          }
        });
      }
    });
  }

  describe("given a minigame is on and the player picks the modes in turn", () => {
    const picks = [
      { it: "when Long jump is picked, then the jersey barrier stands, the range's sand shows and only the long jump's station art shows", mode: "longJump", barrier: true, rangeArt: true },
      { it: "when High jump is picked, then the barrier is down, the range's sand is hidden and only the high jump's station art shows", mode: "highJump", barrier: false, rangeArt: false },
      { it: "when Ring Fling is picked, then the barrier is down, the range's sand is hidden and only Ring Fling's station art shows", mode: "ringFling", barrier: false, rangeArt: false },
    ] as const;
    for (const testCase of picks) {
      it(testCase.it, () => {
        engine.startMinigame(testCase.mode);
        const art = engine["minigames"]["art"]!;
        assert.equal(activeGround(), engine["minigames"].groundInPlay, "the minigame ground is the world's ground");
        assert.notEqual(activeGround(), attractGround, "not the flat attract ground");
        assert.equal(engine["barrierUp"], testCase.barrier, "barrier up");
        assert.equal(engine["barrier"].group.visible, testCase.barrier, "barrier drawn");
        assert.equal(engine["rangeArt"]!.visible, testCase.rangeArt, "range art");
        assert.ok(engine["studio"].every((object) => !object.visible), "the studio is hidden");
        assert.ok(art.group.visible, "the minigame art shows");
        for (const mode of MINIGAME_MODES) assert.equal(art["stations"][mode].visible, mode === testCase.mode, `${mode}'s station art`);
      });
    }

    it("when another mode is picked after a throw, then the dummy is released and the car stands at the new station's start", () => {
      engine.startMinigame("ringFling");
      throwAndRead("ringFling");
      assert.ok(engine["ragdolls"].latest(new THREE.Vector3()) >= 0, "the dummy lies out");
      engine.startMinigame("longJump");
      const start = engine["minigames"].stationStart();
      assert.ok(engine["ragdolls"].latest(new THREE.Vector3()) < 0, "the dummy is released");
      assert.ok(Math.abs(engine["carA"].group.position.x - start.x) < START_TOLERANCE, "at the long jump's start");
      assert.equal(minigameHud().mode, "longJump", "the card follows");
      assert.equal(minigameHud().attempt, 1, "a fresh first attempt");
    });

    it("when the Ring Fling set length is changed, then the card shows it, the set starts again at the start, and a later pick keeps it", () => {
      engine.startMinigame("ringFling");
      engine.setMinigameThrowsPerSet(3);
      assert.equal(minigameHud().throwsPerSet, 3, "three throws");
      assert.equal(minigameHud().attempt, 1, "the set restarted");
      assert.equal(minigameHud().phase, "ready", "ready");
      engine.startMinigame("longJump");
      engine.startMinigame("ringFling");
      assert.equal(minigameHud().throwsPerSet, 3, "kept");
    });

    it("when the free camera flies in a minigame, then its reach is the stations' footprint, not the fleet disc", () => {
      const bounds = engine["minigames"].bounds()!;
      engine["flyFree"](FRAME);
      const extent = engine["view"].free.extent;
      assert.equal(extent.radius, Math.hypot(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2, "half the footprint's diagonal");
      assert.ok(extent.radius > DISC_RADIUS, "wider than the disc");
      assert.equal(extent.x, (bounds.minX + bounds.maxX) / 2, "centre x");
      assert.equal(extent.z, (bounds.minZ + bounds.maxZ) / 2, "centre z");
    });
  });

  describe("given a minigame with a dummy out, when Exit is pressed", () => {
    let seatModeBefore: string;
    it("then the attract Range is back exactly: flat ground, the barrier up, the studio and the range's art showing, no minigame card, no dummy", () => {
      engine.startMinigame("highJump");
      seatModeBefore = engine["seat"].mode;
      throwAndRead("highJump");
      engine.exitMinigame();
      assert.equal(engine["minigameMode"], null, "no minigame");
      assert.equal(activeGround(), attractGround, "the flat attract ground");
      assert.ok(engine["barrierUp"] && engine["barrier"].group.visible, "the barrier stands");
      assert.ok(engine["rangeArt"]!.visible, "the range's art shows");
      assert.ok(engine["studio"].every((object) => object.visible), "the studio shows");
      assert.ok(!engine["minigames"]["art"]!.group.visible, "the minigame art is hidden");
      assert.equal(hud.get().minigame, null, "no minigame card");
      assert.ok(hud.get().range !== null, "the attract readout is back");
      assert.ok(engine["ragdolls"].latest(new THREE.Vector3()) < 0, "the dummy is gone");
      assert.notEqual(seatModeBefore, "global", "the minigame had the seat following");
      assert.equal(engine["seat"].mode, "global", "the seat is let go");
    });

    it("then the attract loop runs again: its car is thrown with no boost and the scene loops", () => {
      launches.length = 0;
      const generation = engine["clearGen"]();
      run(30);
      assert.ok(launches.length >= 1, "a driver was thrown");
      for (const launch of launches) assert.equal(launch.releaseScale, undefined, "no boost");
      assert.notEqual(engine["clearGen"](), generation, "the loop reset the scene");
    });

    it("then the free camera's reach is the fleet disc again", () => {
      engine["flyFree"](FRAME);
      assert.equal(engine["view"].free.extent.radius, DISC_RADIUS, "the disc");
    });
  });

  describe("given a minigame is on, when the player picks another scene", () => {
    it("then the minigame is over: its art is hidden, the ground and studio are the new scene's and the dummy is released", () => {
      engine["setScene"]("range");
      engine.startMinigame("highJump");
      throwAndRead("highJump");
      engine["setScene"]("fleet");
      assert.equal(engine["minigames"].mode, null, "the minigame ended");
      assert.ok(!engine["minigames"]["art"]!.group.visible, "the art is hidden");
      assert.notEqual(activeGround(), engine["minigames"]["ground"], "not the minigame ground");
      assert.ok(engine["studio"].every((object) => object.visible), "the studio shows");
      assert.ok(engine["ragdolls"].latest(new THREE.Vector3()) < 0, "the dummy is released");
      assert.equal(hud.get().minigame, null, "no minigame card");
    });

    it("then returning to the Range is the attract range, not the minigame", () => {
      engine["setScene"]("range");
      assert.equal(engine["minigameMode"], null, "no minigame");
      assert.equal(activeGround(), attractGround, "the flat ground");
      assert.ok(engine["barrierUp"], "the barrier stands");
    });
  });

  describe("given a minigame with a scored sedan best, when the player picks another car", () => {
    it("then the card shows the new car's own best (none yet) next to the overall best, and the attempt starts again", () => {
      engine.startMinigame("longJump");
      assert.ok(minigameHud().best.overall !== null, "a long jump best exists from the sedan's throw");
      engine.setPlayerCar("monster");
      assert.equal(minigameHud().best.thisCar, null, "the monster has no best");
      assert.ok(minigameHud().best.overall !== null, "the overall best is kept");
      assert.equal(minigameHud().phase, "ready", "ready");
      assert.equal(engine["minigameMode"], "longJump", "still in the minigame");
    });
  });

  describe("given the long jump driven from the parked start at full throttle by each driver car, with no bail", () => {
    for (const driverCar of DRIVER_CARS) {
      it(`when a ${driverCar.id} holds the throttle to the barrier and presses no bail, then its driver is thrown exactly once and the throw scores the dummy's rest distance, mid-field`, (t) => {
        engine.setPlayerCar(driverCar.id);
        engine.startMinigame("longJump");
        assert.equal(minigameHud().phase, "ready", "ready");
        launches.length = 0;
        const samples = throwAndRead("longJump");
        assert.equal(launches.length, 1, "exactly one throw");
        assert.equal(minigameHud().phase, "scored", "scored");
        t.diagnostic(`${driverCar.id}: scored ${minigameHud().lastScore!.toFixed(1)} m`);
        assert.equal(minigameHud().lastScore, expectedScore("longJump", samples), "the score is the torso's x at rest");
        assert.ok(minigameHud().lastScore! > LONG_JUMP_NO_BAIL_MINIMUM, `he rested at ${minigameHud().lastScore} m, not past ${LONG_JUMP_NO_BAIL_MINIMUM} m`);
        assert.ok(minigameHud().lastScore! < LONG_JUMP_NO_BAIL_MAXIMUM, `he rested at ${minigameHud().lastScore} m, past ${LONG_JUMP_NO_BAIL_MAXIMUM} m`);
      });
    }
  });

  describe("given the High jump's dummy climbing to a great height", () => {
    const FRAME_EDGE = 0.95;
    const cases = [
      { it: "when he is thrown as the sim throws him, then he is inside the central frame in every frame of his flight to rest", upward: 1 },
      { it: "when he is thrown with a 1.2 times faster climb (about 58 m/s up), then he is still inside the central frame in every frame", upward: 1.2 },
    ] as const;
    for (const testCase of cases) {
      it(testCase.it, () => {
        const ragdolls = engine["ragdolls"];
        const spy = ragdolls.launch;
        ragdolls.launch = (e, cars, rides) => spy(e, cars, rides, { forward: 1, upward: testCase.upward, elevation: null });
        const camera = engine["camera"];
        camera.clearViewOffset();
        camera.aspect = 4 / 3;
        engine.startMinigame("highJump");
        const torso = new THREE.Vector3();
        let worstOffCentre = 0;
        let framesOut = 0;
        let framesSeen = 0;
        let firstOut: string | undefined;
        engine["keys"].add(THROTTLE_KEY);
        for (let frame = 0; frame < THROW_TIMEOUT_S * FRAME_HZ; frame++) {
          engine.advance(FRAME, { frameDt: FRAME });
          const still = ragdolls.latest(torso);
          if (still >= REST_HOLD) break;
          if (still < 0) continue;
          camera.updateProjectionMatrix();
          camera.updateMatrixWorld(true);
          const inFrame = torso.clone().project(camera);
          worstOffCentre = Math.max(worstOffCentre, Math.abs(inFrame.x), Math.abs(inFrame.y));
          framesSeen++;
          if (inFrame.z > 1 || Math.abs(inFrame.x) > FRAME_EDGE || Math.abs(inFrame.y) > FRAME_EDGE) {
            framesOut++;
            firstOut ??= `frame ${framesSeen} torso y ${torso.y.toFixed(1)} x ${torso.x.toFixed(1)} ndc (${inFrame.x.toFixed(2)}, ${inFrame.y.toFixed(2)}) z ${inFrame.z.toFixed(2)}`;
          }
        }
        releaseThrottle();
        ragdolls.launch = spy;
        assert.ok(framesSeen > 100, `${framesSeen} frames of flight`);
        assert.equal(framesOut, 0, `${framesOut} frames out of ${framesSeen}, worst ${worstOffCentre} half-heights off centre; first: ${firstOut}`);
      });
    }
  });

  describe("given the player framed the view by hand (the wheel) before the throw", () => {
    const cases = [
      { it: "when a sedan is driven to the long jump's barrier, then the ride camera takes the dummy and the eye is within 60 m of him", mode: "longJump", carId: "sedan" },
      { it: "when a sedan is driven to the high jump's lip, then the ride camera takes the dummy and the eye is within 60 m of him", mode: "highJump", carId: "sedan" },
      { it: "when a monster is driven to the high jump's lip, then the ride camera takes the dummy and the eye is within 60 m of him", mode: "highJump", carId: "monster" },
      { it: "when a sedan is driven to Ring Fling's lip, then the ride camera takes the dummy and the eye is within 60 m of him", mode: "ringFling", carId: "sedan" },
      { it: "when a monster is driven to Ring Fling's lip, then the ride camera takes the dummy and the eye is within 60 m of him", mode: "ringFling", carId: "monster" },
    ] as const;
    for (const testCase of cases) {
      it(testCase.it, () => {
        engine.setPlayerCar(testCase.carId);
        engine.startMinigame(testCase.mode);
        engine["view"]["onWheel"](Object.assign(new Event("wheel"), { deltaY: WHEEL_STEP, preventDefault() {} }) as WheelEvent);
        assert.ok(engine["view"].userFramed, "the wheel framed the view");
        const torso = new THREE.Vector3();
        engine["keys"].add(THROTTLE_KEY);
        for (let frame = 0; frame < THROW_TIMEOUT_S * FRAME_HZ && engine["ragdolls"].latest(torso) < 0; frame++) engine.advance(FRAME, { frameDt: FRAME });
        run(RIDE_SETTLE_S);
        engine["ragdolls"].latest(torso);
        releaseThrottle();
        assert.ok(engine["ragdolls"].rideAlong, "the ride camera follows him");
        assert.ok(engine["camera"].position.distanceTo(torso) < 60, `the eye is ${engine["camera"].position.distanceTo(torso)} m from him`);
      });
    }
  });

  describe("given every driver car driven from the parked start to the lip of the high jump and of Ring Fling", () => {
    const cases = DRIVER_CARS.flatMap((driverCar) => (["highJump", "ringFling"] as const).map((mode) => ({ it: `when a ${driverCar.id} holds the throttle on the ${mode} station, then its driver is thrown exactly once, at the lip, with the mode's boost`, carId: driverCar.id, mode })));
    for (const testCase of cases) {
      it(testCase.it, () => {
        engine.setPlayerCar(testCase.carId);
        engine.startMinigame(testCase.mode);
        launches.length = 0;
        const samples = throwAndRead(testCase.mode);
        assert.equal(launches.length, 1, "exactly one throw");
        assert.equal(launches[0]!.releaseScale, THROW_BOOST[testCase.mode], "the mode's boost");
        assert.ok(samples.length > 0, "he flew");
        assert.equal(minigameHud().phase, "scored", "scored");
      });
    }
  });

  describe("given the ride camera framing a dummy", () => {
    const leads: { it: string; mode: MinigameMode | null; expectedLead: number }[] = [
      { it: "when a High jump dummy is framed, then the aim lead is MINIGAME_AIM_LEAD", mode: "highJump", expectedLead: MINIGAME_AIM_LEAD },
      { it: "when a Long jump dummy is framed, then the aim lead is MINIGAME_AIM_LEAD", mode: "longJump", expectedLead: MINIGAME_AIM_LEAD },
      { it: "when the attract Range's dummy is framed, then there is no aim lead", mode: null, expectedLead: 0 },
    ];
    for (const testCase of leads) {
      it(testCase.it, () => {
        const ragdolls = engine["ragdolls"];
        const original = ragdolls.frameCamera;
        const seen: number[] = [];
        ragdolls.frameCamera = (camera, wallDt, hold, watched, held, lens, sight, lead) => {
          seen.push(lead ?? 0);
          return original.call(ragdolls, camera, wallDt, hold, watched, held, lens, sight, lead);
        };
        if (testCase.mode === null) engine.exitMinigame();
        else engine.startMinigame(testCase.mode);
        engine["looping"] = false;
        engine["keys"].add(THROTTLE_KEY);
        for (let frame = 0; frame < 20 * FRAME_HZ && ragdolls.latest(new THREE.Vector3()) < 0; frame++) engine.advance(FRAME, { frameDt: FRAME });
        run(1);
        releaseThrottle();
        ragdolls.frameCamera = original;
        engine["looping"] = true;
        assert.ok(ragdolls.latest(new THREE.Vector3()) >= 0, "a dummy is out");
        assert.ok(seen.length > 0, "the camera framed him");
        for (const lead of seen) assert.equal(lead, testCase.expectedLead, "the lead passed");
      });
    }
  });

  describe("given the long jump's bail pressed through the real boost key", () => {
    const BOOST_KEY = "ShiftLeft";
    /** How far (s) the stamped press may be from the asked offset: a frame of sim time, slowed by the approach's slow-mo. */
    const PRESS_TOLERANCE_S = 0.04;
    /** A perfect bail rests at least this much (m) past the same run with no press. */
    const PERFECT_OVER_NONE_M = 30;
    /** An early or late 0.1 s press rests this much (m) short of a perfect one and past a no-press one. */
    const FADE_MARGIN_M = 5;
    const WASTED_EARLY_S = -0.6;
    const AFTER_THE_THROW_S = 0.5;
    /** A wasted bail, whose throw goes at the hit with the no-press release, rests this near (m) a no-press run's (the car has moved on a quarter second by the no-press throw). */
    const WASTED_SCATTER_M = 6;
    const BOOST_HOLD_S = 1;
    const FADE_CLASS_IDS = ["sedan", "monster"] as const;
    type BailRun = { verdict: BailVerdict; score: number; hitRelative: number };

    /** A long jump at full throttle with the boost key tapped one frame when the sim has run `pressRelative` s since the throttle went down (null: never). */
    const bailRun = (carId: string, pressRelative: number | null): BailRun => {
      engine.setPlayerCar(carId);
      engine.startMinigame("longJump");
      const origin = engine["elapsedSim"];
      engine["keys"].add(THROTTLE_KEY);
      let pressed = false;
      for (let frame = 0; frame < THROW_TIMEOUT_S * FRAME_HZ && minigameHud().phase !== "scored"; frame++) {
        if (pressRelative !== null && !pressed && engine["elapsedSim"] - origin >= pressRelative) {
          engine["keys"].add(BOOST_KEY);
          pressed = true;
        }
        engine.advance(FRAME, { frameDt: FRAME });
        engine["keys"].delete(BOOST_KEY);
      }
      releaseThrottle();
      return { verdict: minigameHud().bail!.verdict!, score: minigameHud().lastScore!, hitRelative: engine["minigames"]["bail"]["hitAt"]! - origin };
    };

    /** The no-press run every other run of `carId` is read against. A car type's first run after the engine rebuilds it is not the same sim as its later runs (the first is thrown 0.06 s sooner), so the run that counts is the second: after it, every run reaches the barrier at the same moment. */
    const baseline = (carId: string): BailRun => {
      bailRun(carId, null);
      return bailRun(carId, null);
    };

    for (const driverCar of DRIVER_CARS) {
      it(`when a ${driverCar.id} taps the boost key on the hit, then the bail is perfect and he rests at least ${PERFECT_OVER_NONE_M} m past the same run with no press`, () => {
        const none = baseline(driverCar.id);
        const perfect = bailRun(driverCar.id, none.hitRelative);
        assert.equal(none.verdict.kind, "none", "no press is no bail");
        assert.equal(perfect.verdict.kind, "perfect", `${driverCar.id}'s press at ${perfect.verdict.offsetSeconds} s from the hit`);
        assert.ok(Math.abs(perfect.hitRelative - none.hitRelative) < PRESS_TOLERANCE_S, `the barrier was reached ${perfect.hitRelative - none.hitRelative} s apart`);
        assert.ok(perfect.score - none.score >= PERFECT_OVER_NONE_M, `${driverCar.id}: perfect ${perfect.score.toFixed(1)} m against none ${none.score.toFixed(1)} m`);
      });
    }

    for (const carId of FADE_CLASS_IDS) {
      const offsets = [
        { it: "an early", offset: -0.1, expectedKind: "early" },
        { it: "a late", offset: 0.1, expectedKind: "late" },
      ] as const;
      for (const testCase of offsets) {
        it(`when a ${carId} taps the boost key ${Math.abs(testCase.offset)} s from the hit (${testCase.it} press), then the bail is ${testCase.expectedKind} by that much and he rests between the no-press and the perfect run`, () => {
          const none = baseline(carId);
          const perfect = bailRun(carId, none.hitRelative);
          const run = bailRun(carId, none.hitRelative + testCase.offset);
          assert.equal(run.verdict.kind, testCase.expectedKind, `kind at ${run.verdict.offsetSeconds} s`);
          assert.ok(Math.abs(run.verdict.offsetSeconds! - testCase.offset) < PRESS_TOLERANCE_S, `offset ${run.verdict.offsetSeconds} against ${testCase.offset}`);
          assert.ok(run.score > none.score + FADE_MARGIN_M, `${run.score.toFixed(1)} m is not past no press ${none.score.toFixed(1)} m`);
          assert.ok(run.score < perfect.score - FADE_MARGIN_M, `${run.score.toFixed(1)} m is not short of perfect ${perfect.score.toFixed(1)} m`);
        });
      }
    }

    it("when a sedan taps the boost key far too early, then the bail is wasted: too early, and he rests where a no-press run does", () => {
      const none = baseline("sedan");
      const wasted = bailRun("sedan", none.hitRelative + WASTED_EARLY_S);
      assert.equal(wasted.verdict.kind, "tooEarly", "kind");
      assert.ok(Math.abs(wasted.score - none.score) < WASTED_SCATTER_M, `wasted ${wasted.score.toFixed(1)} m against none ${none.score.toFixed(1)} m`);
    });

    it("when a sedan taps the boost key after the throw has gone, then the bail is too late and the throw was the no-press one", () => {
      const none = baseline("sedan");
      const late = bailRun("sedan", none.hitRelative + AFTER_THE_THROW_S);
      assert.equal(late.verdict.kind, "tooLate", "kind");
      assert.ok(Math.abs(late.score - none.score) < 1, `late ${late.score.toFixed(1)} m against none ${none.score.toFixed(1)} m`);
    });

    it("when the boost key is held on the parked car before the throttle, then it is no press and the bail is still open", () => {
      engine.setPlayerCar("sedan");
      engine.startMinigame("longJump");
      engine["keys"].add(BOOST_KEY);
      run(0.5);
      engine["keys"].delete(BOOST_KEY);
      assert.equal(minigameHud().phase, "ready", "still ready");
      assert.equal(minigameHud().bail!.pressed, false, "not pressed");
    });

    it(`when the boost key and the throttle are held for ${BOOST_HOLD_S} s, then the long jump's car never boosts and the meter is not drained, and the high jump's car does`, () => {
      const holdBoost = (mode: MinigameMode) => {
        engine.setPlayerCar("sedan");
        engine.startMinigame(mode);
        engine["keys"].add(THROTTLE_KEY);
        engine["keys"].add(BOOST_KEY);
        run(BOOST_HOLD_S);
        const boosting = engine["carA"].drive.boostK;
        const meter = engine["seat"].boost;
        engine["keys"].delete(BOOST_KEY);
        releaseThrottle();
        return { boosting, meter };
      };
      const longJump = holdBoost("longJump");
      const highJump = holdBoost("highJump");
      assert.equal(longJump.boosting, 0, "the long jump car's boost thrust");
      assert.equal(longJump.meter, 1, "the long jump's meter is full");
      assert.equal(highJump.boosting, 1, "the high jump car's boost thrust");
      assert.ok(highJump.meter < 1, `the high jump's meter drained to ${highJump.meter}`);
    });

    /** What one long jump did to the crash clock: every frame's time scale from the hit to the throw's release, the frames that took, the lowest scale before the hit and after the release, and the bail's verdict. */
    type ClockRun = { scalesHitToRelease: number[]; framesHitToRelease: number; lowestScaleBeforeHit: number; lowestScaleAfterRelease: number; verdict: BailVerdict };

    /** A long jump at full throttle, the throttle let go at x `liftAtX` (null: held to the barrier), the boost key tapped `tapFramesAfterHit` presented frames after the hit (null: never). */
    const clockRun = (liftAtX: number | null, tapFramesAfterHit: number | null): ClockRun => {
      engine.setPlayerCar("sedan");
      engine.startMinigame("longJump");
      engine["keys"].add(THROTTLE_KEY);
      const run: ClockRun = { scalesHitToRelease: [], framesHitToRelease: 0, lowestScaleBeforeHit: 1, lowestScaleAfterRelease: 1, verdict: { kind: "none", offsetSeconds: null, quality: 0 } };
      let hitFrame = -1;
      let released = false;
      for (let frame = 0; frame < THROW_TIMEOUT_S * FRAME_HZ && minigameHud().phase !== "scored"; frame++) {
        if (liftAtX !== null && engine["carA"].group.position.x >= liftAtX) engine["keys"].delete(THROTTLE_KEY);
        if (tapFramesAfterHit !== null && hitFrame >= 0 && frame - hitFrame === tapFramesAfterHit) engine["keys"].add(BOOST_KEY);
        engine.advance(FRAME, { frameDt: FRAME });
        engine["keys"].delete(BOOST_KEY);
        const scale = engine["clock"].timeScale;
        if (engine["minigames"]["bail"]["hitAt"] === null) run.lowestScaleBeforeHit = Math.min(run.lowestScaleBeforeHit, scale);
        else if (!released) {
          if (hitFrame < 0) hitFrame = frame;
          run.scalesHitToRelease.push(scale);
          if (engine["minigames"]["heldThrow"] === null) {
            released = true;
            run.framesHitToRelease = frame - hitFrame;
          }
        } else run.lowestScaleAfterRelease = Math.min(run.lowestScaleAfterRelease, scale);
      }
      releaseThrottle();
      run.verdict = minigameHud().bail!.verdict!;
      return run;
    };

    /** A lifted throttle at this x (m): the car coasts into the barrier slower, which the slow-mo's own prediction (`throwComing`) does not expect to throw him. */
    const COASTING_LIFT_X = -10;
    /** The clock's slow scale (`IMPACT_SCALE`): the throw's slow-mo must come, and only after the release. */
    const SLOW_ENOUGH = 0.5;
    /** The press and the throw's hold are in real time: presented frames from the hit, at 60 Hz. */
    const WINDOW_FRAMES = Math.round(BAIL_WINDOW_SECONDS * FRAME_HZ);
    const FRAME_SLACK = 2;
    const cases = [
      { it: "held to the barrier", liftAtX: null },
      { it: "let go at x -10 so the car coasts into it", liftAtX: COASTING_LIFT_X },
    ] as const;
    for (const testCase of cases) {
      it(`when the throttle is ${testCase.it} and no bail is pressed, then the clock runs at 1x from the start to the release, the throw goes at the window's end in presented time, and the slow-mo comes after it`, () => {
        const run = clockRun(testCase.liftAtX, null);
        assert.equal(run.lowestScaleBeforeHit, 1, "the approach is at 1x");
        assert.ok(run.scalesHitToRelease.length > 0, "the barrier was hit");
        assert.equal(Math.min(...run.scalesHitToRelease), 1, `the lowest scale between the hit and the release, over ${run.scalesHitToRelease.length} frames`);
        assert.ok(Math.abs(run.framesHitToRelease - WINDOW_FRAMES) <= FRAME_SLACK, `${run.framesHitToRelease} presented frames from the hit to the release, not ${WINDOW_FRAMES}`);
        assert.ok(run.lowestScaleAfterRelease < SLOW_ENOUGH, `the slow-mo after the release reached only ${run.lowestScaleAfterRelease}`);
      });
    }

    const presses = [
      { it: "0.1 s", framesAfterHit: Math.round(0.1 * FRAME_HZ), expectedKind: "late", expectedOffsetS: 0.1 },
      { it: "0.5 s", framesAfterHit: Math.round(0.5 * FRAME_HZ), expectedKind: "tooLate", expectedOffsetS: 0.5 },
    ] as const;
    for (const press of presses) {
      it(`when the boost key is tapped ${press.it} of presented time after the hit on a coasting run, then the bail is ${press.expectedKind} by that much and not perfect`, () => {
        const run = clockRun(COASTING_LIFT_X, press.framesAfterHit);
        assert.equal(run.verdict.kind, press.expectedKind, `verdict at ${run.verdict.offsetSeconds} s`);
        assert.ok(Math.abs(run.verdict.offsetSeconds! - press.expectedOffsetS) < PRESS_TOLERANCE_S, `offset ${run.verdict.offsetSeconds} against ${press.expectedOffsetS}`);
      });
    }
  });
});

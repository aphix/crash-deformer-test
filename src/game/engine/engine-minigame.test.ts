import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import type { MinigameHudState } from "../scenes/minigame-session.ts";
import { HudStore } from "../hud/hud-store.ts";
import { FRAME_HZ } from "../kernel/constants.ts";
import { BOX_POSE_FLOATS } from "../present/ragdoll-boxes.ts";
import { DISC_RADIUS, activeGround, setGround, type Ground } from "../world/ground.ts";
import { MINIGAME_MODES, REST_HOLD, STATION_ANCHORS, THROW_BOOST, type MinigameMode } from "../scenes/minigame-constants.ts";
import { BOX_COUNT, HighJumpCapture, type TorsoSample } from "../scenes/minigame-high-jump.ts";
import { DRIVER_CARS } from "../match/types.ts";
import { lipHeight } from "../scenes/minigame-profile.ts";
import { ringScore } from "../scenes/minigame-ring.ts";
import { MinigameSession } from "../scenes/minigame-session.ts";
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
/** The High jump's dummy may be outside the central 95% of the frame for at most this share of his flight (the ride camera lags his climb; 50 degrees measures about 0.25). */
const MAX_SHARE_OUT_OF_FRAME = 0.05;

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

type Launch = { releaseScale: unknown };

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
  /** The player holds the throttle (the long jump lets go before its barrier) and every frame's torso is read, until the throw scores or the sim runs out. */
  const throwAndRead = (mode: MinigameMode): TorsoSample[] => {
    const samples: TorsoSample[] = [];
    const torso = new THREE.Vector3();
    const car = engine["carA"];
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
        assert.equal(launches[0]!.releaseScale, THROW_BOOST[mode], "the mode's boost");
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

  describe("given the long jump driven from the parked start at full throttle by each driver car", () => {
    for (const driverCar of DRIVER_CARS) {
      it(`when a ${driverCar.id} holds the throttle to the barrier, then its driver is thrown exactly once and the throw scores the dummy's rest distance`, () => {
        engine.setPlayerCar(driverCar.id);
        engine.startMinigame("longJump");
        assert.equal(minigameHud().phase, "ready", "ready");
        launches.length = 0;
        const samples = throwAndRead("longJump");
        assert.equal(launches.length, 1, "exactly one throw");
        assert.equal(minigameHud().phase, "scored", "scored");
        assert.equal(minigameHud().lastScore, expectedScore("longJump", samples), "the score is the torso's x at rest");
        assert.ok(minigameHud().lastScore! > 0, "he landed past the lip");
      });
    }
  });

  describe("given the High jump's dummy climbing to a great height", () => {
    const FRAME_EDGE = 0.95;
    const cases = [
      { it: "when he is thrown as the sim throws him, then he is inside the central frame for all but a twentieth of his flight to rest", upward: 1 },
      { it: "when he is thrown with a 1.6 times faster climb (about twice the apex), then he is still inside the central frame for all but a twentieth of it", upward: 1.6 },
    ] as const;
    for (const testCase of cases) {
      it(testCase.it, () => {
        const ragdolls = engine["ragdolls"];
        const spy = ragdolls.launch;
        ragdolls.launch = (e, cars, rides) => spy(e, cars, rides, { forward: 1, upward: testCase.upward });
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
        assert.ok(framesOut <= MAX_SHARE_OUT_OF_FRAME * framesSeen, `${framesOut} frames out of ${framesSeen}, worst ${worstOffCentre} half-heights off centre; first: ${firstOut}`);
      });
    }
  });
});

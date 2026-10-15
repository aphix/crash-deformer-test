import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { launch, makeCar, makeWorld, PARKED } from "../contact/crash-scenarios.test-util.ts";
import { CLIP_NO_CAR, type HighlightClip } from "../match/highlights.ts";
import { GroundsArt } from "../present/grounds-art.ts";
import { RagdollSystem } from "../present/engine-ragdoll.ts";
import { People, VIP_LOOK, VipEscort } from "../present/people.ts";
import { PoseBlend } from "../present/pose-blend.ts";
import { TRACK_ID } from "../world/constants.ts";
import { setGround } from "../world/ground.ts";
import { Track } from "../world/track.ts";
import { TRACKS } from "../world/tracks/index.ts";
import { parseTrack } from "../world/track-schema.ts";
import { armKill, DEFAULT_REALISM, HANDLING } from "../vehicle/vehicle-classes.ts";
import type { DriveInput } from "../vehicle/car-drive.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import type { Ejection } from "../vehicle/ejection.ts";
import { CrashRecorder } from "./engine-record.ts";
import { ClipSim } from "./engine-replay.ts";
import { clipTimeline, ReelDirector, type ReelHost } from "./engine-highlights.ts";
import { phaseClock } from "../match/phase.ts";
import { settleStep, stepWorld } from "./world-step.ts";
import { FINE_HZ } from "../kernel/constants.ts";

/**
 * The National Mall's VIP in a replay of the driver's ejection (owner, 2026-10-15: "the ragdoll fix and persistence of the secret guest after the Konami code don't
 * replay correctly in ejections"). The player's car parked on the North Lawn, the Konami code in: the VIP walks out of the White House, gets into the passenger seat and rides.
 * Then the player drives at a car coming the other way, both at full throttle: the driver is thrown out of his windshield and the VIP with him. The sim never knows the VIP, so the
 * recorder is told where he rides (`CrashRecorder.vipRides`, as `RaceDirector.frame` tells it once per drawn frame).
 */
const track = new Track(TRACKS.find((j) => parseTrack(j).id === TRACK_ID.nationalMall)!);
const spec = track.json.guards!;
const ground = track.ground();
setGround(ground);
const H = Math.fround(1 / FINE_HZ);
/** Steps of a drawn frame (a 60 Hz one). */
const FRAME_STEPS = FINE_HZ / 60;
const FRAME = FRAME_STEPS * H;
const LAWN = { x: -990, z: -1104 };
/** How far (m) up the lawn the oncoming car waits, and the seconds the player sits once the VIP is in before he drives off. */
const RUN = 120;
const SIT_S = 1;
/** Race seconds after the ejection that the live run goes on for (the clip's post-roll and more), and the longest the VIP takes to walk out and get in. */
const AFTER_S = 5;
const WALK_S = 40;
/** Frames the dummies are compared over from their launch: they have not met anything the replay's cars differ from the live ones in. */
const FLIGHT_FRAMES = 20;
/** Metres a replayed dummy may stand from the live one over `FLIGHT_FRAMES`. */
const NEAR = 0.05;
const GO: DriveInput = { throttle: 1, steer: 0, brake: 0, ebrake: false, boost: false };

/** Every dummy out in the ragdoll system, by slot: torso (x, y, z) after each frame since the first launch. */
type Flight = number[][];

function sampleFlight(ragdolls: RagdollSystem, flight: Flight): void {
  const dolls: { live: boolean; cur: Float32Array }[] = ragdolls["dolls"];
  if (!dolls.some((d) => d.live) && flight.length === 0) return;
  for (const [slot, d] of dolls.entries()) {
    if (!d.live) continue;
    (flight[slot] ??= []).push(d.cur[0]!, d.cur[1]!, d.cur[2]!);
  }
}

type Run = {
  clip: HighlightClip;
  cars: DeformableCar[];
  ejections: Ejection[];
  /** Live: the throws of the VIP asked of the dummies' world (the car), and every dummy's flight. */
  passengerThrows: number[];
  flight: Flight;
};

/** The race above with the secret out (`secretOut`) or still in (the VIP stays inside), played until `AFTER_S` after the driver is thrown. */
async function race(secretOut: boolean): Promise<Run> {
  const cars = [makeCar(), makeCar()];
  for (const car of cars) {
    car.deform.setMode("shape");
    car.deform.squash = 0.32;
    car.deform.buckle = 0.45;
    armKill(car.deform, "sedan", DEFAULT_REALISM, "default");
  }
  launch(cars[0]!, LAWN.x, LAWN.z, 0, 0, 0);
  launch(cars[1]!, LAWN.x, LAWN.z + RUN, Math.PI, 0, 0);
  const w = makeWorld(cars, false, false, null);
  for (const car of cars) w.pedals.set(car, PARKED);
  const rec = new CrashRecorder();
  rec.begin("flat", HANDLING.realism, false, cars.length, (i) => `c${i}`, 1);
  const vip = new VipEscort(spec, ground, new People(spec.count + 1), 0);
  const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
  await ragdolls.preload();
  const ejections: Ejection[] = [];
  const passengerThrows: number[] = [];
  const flight: Flight = [];
  const throwPassenger = (car: number, look: typeof VIP_LOOK): void => {
    passengerThrows.push(car);
    ragdolls.throwPassenger(car, look);
  };
  let sitFrom = -1;
  let released = false;
  let ejectedAt = -1;
  for (let s = 0; s < (WALK_S + SIT_S + 12 + AFTER_S) * FINE_HZ && (ejectedAt < 0 || s < ejectedAt + AFTER_S * FINE_HZ); s++) {
    rec.startStep(cars);
    stepWorld(w.world, H);
    for (const e of w.world.ejection!.take()) {
      ejections.push({ ...e, pos: e.pos.clone(), quat: e.quat.clone(), spin: e.spin.clone(), dir: e.dir.clone() });
      ragdolls.launch(e, cars);
      rec.eject(e);
      if (ejectedAt < 0) ejectedAt = s;
    }
    rec.endStep(cars, H, w.world.shape);
    settleStep(cars, H, false);
    if (s % FRAME_STEPS !== FRAME_STEPS - 1) continue;
    vip.frame(FRAME, secretOut, 0, cars, throwPassenger, () => {});
    rec.vipRides(vip.ridingIn);
    ragdolls.update(FRAME, cars, true, false, null);
    sampleFlight(ragdolls, flight);
    if (sitFrom < 0 && (vip.ridingIn === 0 || (!secretOut && s > 6 * FINE_HZ))) sitFrom = s;
    // Seated (or, the secret in, six seconds of waiting): off they go.
    if (!released && sitFrom >= 0 && s - sitFrom >= SIT_S * FINE_HZ) {
      released = true;
      w.pedals.set(cars[0]!, GO);
      w.pedals.set(cars[1]!, GO);
    }
  }
  rec.end();
  ragdolls.dispose();
  const clip = rec.ledger.kept[0]!;
  assert.ok(clip, "the head-on made no clip");
  return { clip, cars, ejections, passengerThrows, flight };
}

/** A replay of a clip: the replay, the driver throws it fired and whether the VIP went with each, every dummy's flight, whether the VIP was drawn in the seat after each drawn frame, and the frame of the first throw. */
type Replayed = { sim: ClipSim; thrown: Ejection[]; passengers: boolean[]; flight: Flight; seatedFrames: boolean[]; ejectionFrame: number };

/** What a peer sees of `run`'s clip: its replay stepped a drawn frame at a time, the dummies it throws (as `ReelDirector.launch` hands them to the host) and the grounds' VIP drawn from `ClipSim.vipRide`, while this browser's own race has the secret `viewerSecretOut`. */
async function replay(run: Run, viewerSecretOut: boolean): Promise<Replayed> {
  const { clip, cars } = run;
  const sim = new ClipSim(clip, clip.cars.map((c) => cars[c.slot]!), { dress: () => {}, collide: () => {}, guards: () => spec, blend: new PoseBlend() });
  const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
  await ragdolls.preload();
  const art = new GroundsArt(spec, ground, new THREE.Group());
  const host = { sparks: () => {}, throwPassenger: () => {}, throwFigure: () => {} };
  const thrown: Ejection[] = [];
  const passengers: boolean[] = [];
  const flight: Flight = [];
  const seatedFrames: boolean[] = [];
  let ejectionFrame = -1;
  sim.restart();
  for (let frame = 0; !sim.done; frame++) {
    for (let k = 0; k < FRAME_STEPS && !sim.done; k++) sim.advanceTo(sim.time + 1e-6);
    // As `ReelDirector.launch` hands them to the host: every driver of the look, then the VIP with his.
    const fired = sim.take();
    for (const e of fired) ragdolls.launch(e, run.cars);
    for (const e of fired) if (e.vip) ragdolls.throwPassenger(e.car, VIP_LOOK);
    for (const e of fired) {
      thrown.push(e);
      passengers.push(e.vip);
      if (ejectionFrame < 0) ejectionFrame = frame;
    }
    ragdolls.update(FRAME, run.cars, true, false, null);
    sampleFlight(ragdolls, flight);
    // The viewer's own race: the secret as it stands there, no player car.
    art.frame(FRAME, null, viewerSecretOut, run.cars, -1, host, { squad: null, vip: sim.vipRide });
    seatedFrames.push((art["people"]["mesh"]["shown"] & 1) === 1);
  }
  ragdolls.dispose();
  return { sim, thrown, passengers, flight, seatedFrames, ejectionFrame };
}

describe("given the Konami code typed on the National Mall, the VIP riding with the player, and the player's head-on with a car coming the other way that throws him out", () => {
  let run: Run;
  let again: Replayed;

  it("when the race is played, then the VIP gets in and is thrown with the driver, once, as the dummies' world has it live", async () => {
    run = await race(true);
    assert.ok(run.ejections.some((e) => e.car === 0), `the player's driver is thrown (${run.ejections.length} throws)`);
    assert.deepEqual(run.passengerThrows, [0], "the VIP is thrown once, from the player's car");
    assert.equal(run.flight.length, run.ejections.length + 1, "a dummy out for each driver thrown, and the VIP's beside his");
  });

  it("when the clip is filed, then it says the VIP rode in the player's car at its start and no longer once the driver was thrown", () => {
    const { clip } = run;
    const player = clip.cars.findIndex((c) => c.slot === 0);
    assert.ok(player >= 0, "the player's car is in the clip");
    assert.equal(clip.vip.start, player, "the VIP rides in the player's car at the clip's start");
    assert.ok(clip.vip.events.length === 1 && clip.vip.events[0]!.car === CLIP_NO_CAR, `his ride ends once, in the throw: ${JSON.stringify(clip.vip.events)}`);
    const thrownAt = clip.ejections.find((x) => x.e.car === player)!.step;
    assert.ok(clip.vip.events[0]!.step > thrownAt, "he is told out of the car after the driver's step, as the drawn frame that threw him comes after it");
  });

  it("when the clip is replayed in a browser whose own race has no secret out, then the VIP is drawn in the seat until the driver is thrown, thrown with him, and gone after, and no player car of the viewer's is needed", async () => {
    again = await replay(run, false);
    const { seatedFrames, ejectionFrame, thrown, passengers } = again;
    assert.ok(thrown.some((e) => e.car === 0), "the driver is thrown again");
    assert.deepEqual(thrown.map((e, k) => [e.car, passengers[k]]), [[0, true], [1, false]], "the VIP is thrown with the player's driver and no other");
    assert.ok(seatedFrames.slice(0, ejectionFrame).every(Boolean), "he sits in the seat in every frame before the throw");
    assert.ok(seatedFrames.slice(ejectionFrame).every((seated) => !seated), "he is gone from the seat from the frame the driver is thrown");
  });

  it("when the replay's dummies fly, then the driver's and the VIP's flights follow the live ones' within a few centimetres for the first frames", () => {
    assert.equal(again.flight.length, run.flight.length, "as many dummies out as live");
    for (const [slot, live] of run.flight.entries()) {
      const replayed = again.flight[slot]!;
      let worst = 0;
      for (let k = 0; k < FLIGHT_FRAMES * 3; k++) worst = Math.max(worst, Math.abs(live[k]! - replayed[k]!));
      assert.ok(worst < NEAR, `dummy ${slot}: ${worst.toFixed(3)} m apart within ${FLIGHT_FRAMES} frames of the launch`);
    }
  });

  it("when the replay is restarted, then the VIP is seated again at once and thrown again at the same step", () => {
    const { sim } = again;
    sim.restart();
    assert.equal(sim.vipRide, 0, "seated before any step");
    const steps = [];
    while (!sim.done) {
      sim.advanceTo(sim.time + 1e-6);
      for (const e of sim.take()) steps.push({ car: e.car, vip: e.vip, step: sim.step });
    }
    assert.deepEqual(steps.map((x) => [x.car, x.vip]), [[0, true], [1, false]]);
  });

  it("when the reel hands the throws of the step the driver is thrown in to its host, then every driver comes first and the VIP last, with his", () => {
    const { clip, cars } = run;
    const sim = new ClipSim(clip, clip.cars.map((c) => cars[c.slot]!), { dress: () => {}, collide: () => {}, guards: () => spec, blend: new PoseBlend() });
    const calls: string[] = [];
    const nowhere = (): never => {
      throw new Error("a reel's cameras are not under test");
    };
    const host: ReelHost = {
      carsOf: () => [],
      live: () => cars,
      scene: { dress: () => {}, collide: () => {}, blend: new PoseBlend() },
      resetProps: () => {},
      clear: () => {},
      sight: nowhere,
      still: nowhere,
      clock: phaseClock(),
      crash: () => {},
      impact: () => {},
      fudge: () => {},
      hit: () => {},
      eject: (e) => void calls.push(`eject ${e.car}`),
      passenger: (car) => void calls.push(`passenger ${car}`),
      strike: () => {},
      ride: () => false,
    };
    sim.restart();
    while (sim.step <= clip.ejections[0]!.step) sim.advanceTo(sim.time + 1e-6);
    new ReelDirector(host)["launch"]({ id: 1, from: "reel", clip, sim, tl: clipTimeline(clip.firstImpact, sim.length, []), shots: [], beat: 0 });
    assert.deepEqual(calls, ["eject 0", "eject 1", "passenger 0"]);
  });
});

describe("given the same race with the course's secret still in, so the VIP never leaves the house", () => {
  it("when the clip of the player's ejection is replayed, then no VIP rides in it, none is thrown with the driver and none is drawn", async () => {
    const run = await race(false);
    assert.deepEqual(run.passengerThrows, [], "live: nobody thrown with him");
    assert.equal(run.clip.vip.start, CLIP_NO_CAR, "the clip lists no ride at its start");
    assert.equal(run.clip.vip.events.length, 0, "and none in its steps");
    const { thrown, passengers, seatedFrames } = await replay(run, true);
    assert.ok(thrown.length > 0, "a driver is thrown");
    assert.ok(passengers.every((vip) => !vip), "no VIP thrown with him");
    assert.ok(seatedFrames.every((seated) => !seated), "no VIP drawn, though the viewer's own race has the secret out");
  });
});

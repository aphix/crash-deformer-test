import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { RagdollSystem } from "../present/engine-ragdoll.ts";
import { assertSameNumbers } from "../vehicle/test-support.ts";
import { setGround } from "./ground.ts";
import { FRAME, makeWorld, raceOnce } from "./race-world.test-util.ts";
import { Track } from "./track.ts";
import { parseTrack } from "./track-schema.ts";
import { TRACKS } from "./tracks/index.ts";

/** City, 4 AI rivals and the AI-driven player slot, seed 5: its first 40 s knock three of the course's cones and crates (a scenario input: the seed is picked for its knocks). */
const SECONDS = 40;
const SEED = 5;

type Run = { knocks: number[]; knocked: number; state: number[]; flying: number };

/** The race, with the dummies' world taking its knocks (props tumbling in Rapier) or with no such world. */
async function race(withProps: boolean): Promise<Run> {
  const track = new Track(parseTrack(TRACKS.find((j) => parseTrack(j).id === "city")!));
  const w = makeWorld();
  const sys = withProps ? new RagdollSystem(new THREE.Scene(), () => {}, () => {}) : null;
  await sys?.preload();
  const knocks: number[] = [];
  let frames = 0;
  w.onKnock = (index, car, vx, vy, vz) => {
    knocks.push(frames, index, car);
    sys?.knockProp(index, car, vx, vy, vz);
  };
  w.race.enter();
  raceOnce(w, track, SECONDS, SEED, 1, (n) => {
    frames = n + 1;
    if (!sys) return;
    if (n === 0) sys.setCourse(w.race["track"]!, w.race["placed"], null);
    sys.update(FRAME, w.live(), true, false, 0, null);
  });
  const state = w.live().flatMap((c) => [...c.group.position.toArray(), ...c.group.quaternion.toArray(), ...c.velocity.toArray()]);
  const knocked = w.race["knocked"].reduce((n, k) => n + k, 0);
  const flying = sys ? sys["props"].count : 0;
  sys?.dispose();
  w.race.exit();
  setGround(null);
  return { knocks, knocked, state, flying };
}

describe("given a city race whose cars knock cones and crates over", () => {
  it("when the knocked props tumble in the dummies' physics, then the race knocks the same props with the same cars at the same steps and every car ends exactly where it does with no such physics", async () => {
    const bare = await race(false);
    const tumbling = await race(true);
    assert.ok(bare.knocked >= 2, `the race knocked ${bare.knocked} props: nothing to compare`);
    assert.equal(tumbling.flying, tumbling.knocked, "every knocked prop is out in the dummies' physics");
    assertSameNumbers(tumbling.knocks, bare.knocks, "the knocks: frame, prop and car");
    assert.equal(tumbling.knocked, bare.knocked, "the knocked count");
    assertSameNumbers(tumbling.state, bare.state, "the cars' poses and velocities");
  });
});

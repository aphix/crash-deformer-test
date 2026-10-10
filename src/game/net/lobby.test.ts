import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "../world/ground.ts";
import { Track } from "../world/track.ts";
import { parseTrack } from "../world/track-schema.ts";
import { OFF_MENU, TRACKS } from "../world/tracks/index.ts";
import { frame, makeWorld, type World } from "../world/race-world.test-util.ts";
import { NO_CAR_PICK, NO_PERSON_PICK, CAR_SPRAY, PERSON_SPRAY } from "../match/look-data.ts";
import type { Ejection } from "../vehicle/ejection.ts";
import { NetPlay } from "./net-play.ts";
import { PHASES, type NetGame } from "./net-ports.ts";
import { FRAME_MS, Hub } from "./net-hub.test-util.ts";

/**
 * The Havana lobby on the real race stack: a host and a guest, each a `RaceDirector` world (the headless engine minus the renderer),
 * linked through netplay. The host steps its world; the guest only draws the host's snapshots, as a browser guest does.
 */
const havana = new Track([...TRACKS, ...OFF_MENU].find((j) => parseTrack(j).id === "havana"));

/** The engine's `NetGame` seam over a headless world: what `CrashEngine.net` wires, minus the derby, reels, looks and presentation. */
function worldGame(w: World, name: string) {
  const log = { cleared: 0, gen: 0 };
  const game: NetGame = {
    cars: () => w.live(),
    setCarCount: (n) => w.race["host"].setCarCount(n),
    matchCar: () => {},
    setRealism: () => {},
    phase: () => PHASES[0]!,
    timeScale: () => 1,
    mirrorClock: () => {},
    race: () => (w.race.active ? w.race : null),
    enterRace: (survival, lobby = false) => {
      if (w.race.active) {
        if (w.race.survival === survival && (!lobby || w.race.free)) return;
        w.race.exit();
      }
      w.race.enter(survival, lobby);
    },
    exitRace: () => w.race.exit(),
    startRace: () => w.race.command({ type: "start" }),
    setSeats: (seats) => w.race.setSeats(seats),
    playerName: () => name,
    hostFit: () => true,
    remoteDrivable: () => true,
    derbyPhase: () => null,
    derbyState: () => null,
    applyDerby: () => {},
    derbyLobby: () => {},
    startDerby: () => {},
    resetLobbyCar: (i) => w.race.resetLobbyCar(i),
    // The engine's `randomizeAndReset`: the clear count moves, then the director puts its lobby back.
    resetLobbyScene: () => {
      log.gen = (log.gen + 1) & 127;
      w.race.reset();
    },
    setVaporized: () => {},
    clearGen: () => log.gen,
    clearScene: () => void log.cleared++,
    playReel: () => {},
    reelPlaying: () => false,
    launchEjection: (_e: Ejection) => {},
    meterOf: () => null,
    playerLook: () => ({ car: { ...NO_CAR_PICK }, person: { ...NO_PERSON_PICK }, carSpray: new Uint8Array(CAR_SPRAY.w * CAR_SPRAY.h), personSpray: new Uint8Array(PERSON_SPRAY.w * PERSON_SPRAY.h) }),
    wearLook: () => {},
    dropLooks: () => {},
    seat: w.seat,
  };
  return { game, log };
}

/** A host and one guest in room R, both in the lobby, on one clock. */
function lobby(opts: { minPlayers?: number } = {}) {
  const hub = new Hub();
  let now = 1000;
  const hw = makeWorld();
  const gw = makeWorld();
  const hg = worldGame(hw, "Ann");
  const gg = worldGame(gw, "Zed");
  const host = new NetPlay(hg.game, { connect: hub.connect, now: () => now });
  const guest = new NetPlay(gg.game, { connect: hub.connect, now: () => now });
  open.push(host, guest);
  host.host("R", "bc");
  if (opts.minPlayers !== undefined) host.setMinPlayers(opts.minPlayers);
  guest.join("R", "bc");
  const state = { acc: 0 };
  const s = {
    hub,
    hw,
    gw,
    hg,
    gg,
    host,
    guest,
    /** `n` net frames of 1/30 s: the host's world steps two 1/60 s frames and sends, the guest draws and sends its input. */
    step(n: number): void {
      for (let k = 0; k < n; k++) {
        now += FRAME_MS;
        frame(hw, state);
        frame(hw, state);
        host.frame(FRAME_MS / 1000);
        guest.frame(FRAME_MS / 1000);
        hub.flush();
      }
    },
    /** The guest's seat holds W. */
    holdThrottle(): void {
      gw.seat.sample(new Set(["KeyW"]), null);
    },
    /** The guest's seat lets go of every key. */
    release(): void {
      gw.seat.sample(new Set(), null);
    },
  };
  s.step(60);
  assert.equal(guest.status().car, 1, "the guest got car 1");
  return s;
}

const open: NetPlay[] = [];
afterEach(() => {
  for (const n of open.splice(0)) n.leave();
  setGround(null);
});

/** Whether (x, z) lies inside the course's bounds. */
const inHavana = (x: number, z: number): boolean => x >= havana.bounds.minX && x <= havana.bounds.maxX && z >= havana.bounds.minZ && z <= havana.bounds.maxZ;

/** The course's start anchor, where the lobby's cars stand abreast (`humanSlot`): the plaza's middle is inside the bounds too, so bounds alone would not tell a placed car from an unplaced one. */
const start = havana.survival!.start;

describe("given a host and a guest waiting in the Havana lobby", () => {
  it("when they have waited a second, then every car on both worlds is on the Havana course, the lobby is the one course both load, and nobody races or hunts", () => {
    const s = lobby();
    for (const [who, w] of [["host", s.hw], ["guest", s.gw]] as const) {
      assert.equal(w.race.active, true, `${who}: race mode`);
      assert.equal(w.race.free, true, `${who}: free drive, no rules`);
      assert.equal(w.race.courseId, "havana", `${who}: the course`);
      assert.equal(w.race.phase, null, `${who}: no session`);
      assert.equal(w.live().length, 2, `${who}: a car each`);
      for (const [i, car] of w.live().entries()) {
        const { x, z } = car.group.position;
        assert.ok(inHavana(x, z), `${who}'s car ${i} at (${x.toFixed(1)}, ${z.toFixed(1)}) is inside Havana's bounds`);
        assert.ok(Math.hypot(x - start.x, z - start.z) < 12, `${who}'s car ${i} stands at the start anchor, not where the fleet left it`);
      }
    }
    assert.equal(s.hw.race["police"], null, "no hunters");
  });

  it("when the guest holds the throttle, then its car drives away from the spawn on the host and the guest sees it move; the host's car stays where it was", () => {
    const s = lobby();
    const spawn = s.hw.live()[1]!.group.position.clone();
    const own = s.hw.live()[0]!.group.position.clone();
    s.holdThrottle();
    s.step(90);
    assert.ok(s.hw.live()[1]!.group.position.distanceTo(spawn) > 5, "the guest's car drove");
    assert.ok(s.gw.live()[1]!.group.position.distanceTo(spawn) > 5, "and the guest draws it moving");
    assert.ok(s.hw.live()[0]!.group.position.distanceTo(own) < 0.5, "the host's car is where it was");
    for (const w of [s.hw, s.gw]) {
      const { x, z } = w.live()[1]!.group.position;
      assert.ok(inHavana(x, z), "the driven car is still on the course");
    }
  });

  it("when the guest has crashed into the alley wall and asks to reset, then its car is repaired, upright and back at a spawn on the host and on the guest, and the host's own car was never touched", () => {
    const s = lobby();
    const car = s.hw.live()[1]!;
    const own = s.hw.live()[0]!;
    const spawn = car.group.position.clone();
    // The alley wall of `prop-wall.test.ts`: five panels across x = −40.25, the approach from +x; the guest drives straight into it.
    car.spawnFacing(-30, 12, -Math.PI / 2, 25);
    car.velocity.set(-25, 0, 0);
    s.holdThrottle();
    for (let k = 0; k < 60 && !car.crashed; k++) s.step(1);
    assert.equal(car.crashed, true, "the guest's car is wrecked");
    const wreckedAt = car.group.position.clone();
    const ownBefore = own.group.position.clone();
    s.release();
    s.step(10);
    s.guest.requestRespawn();
    s.step(6);
    assert.equal(car.crashed, false, "repaired on the host");
    assert.ok(car.group.position.distanceTo(spawn) < 8, `back at a Havana spawn, ${car.group.position.distanceTo(spawn).toFixed(1)} m from the first one`);
    assert.ok(car.group.position.distanceTo(wreckedAt) > 20, "and not where it crashed");
    assert.ok(car.group.matrixWorld.elements[5]! > 0.9, "upright");
    assert.ok(car.velocity.length() < 2, "at rest");
    assert.ok(own.group.position.distanceTo(ownBefore) < 0.5, "the host's car was not moved by the guest's reset");
    s.step(30);
    const drawn = s.gw.live()[1]!;
    assert.equal(drawn.crashed, false, "repaired on the guest");
    assert.ok(drawn.group.position.distanceTo(car.group.position) < 1, "the guest draws it where the host has it");
    assert.ok(inHavana(drawn.group.position.x, drawn.group.position.z));
  });

  it("when the host resets the scene, then every car on both worlds is repaired and at its spawn, the props the cars knocked are back, and the guest is told to clear its own debris through the clear count", () => {
    const s = lobby();
    const [a, b] = [s.hw.live()[0]!, s.hw.live()[1]!];
    const spawns = [a.group.position.clone(), b.group.position.clone()];
    for (const car of [a, b]) {
      car.spawnFacing(-30, 12 + 6 * s.hw.live().indexOf(car), -Math.PI / 2, 25);
      car.velocity.set(-25, 0, 0);
    }
    s.hw.race["knocked"][0] = 1;
    s.holdThrottle();
    for (let k = 0; k < 60 && !(a.crashed && b.crashed); k++) s.step(1);
    assert.equal(b.crashed, true, "the guest's car is wrecked");
    s.release();
    s.step(10);
    const cleared = s.gg.log.cleared;
    s.guest.resetScene();
    assert.equal(b.crashed, true, "a guest cannot reset the scene");
    s.host.resetScene();
    s.step(10);
    for (const [i, car] of [a, b].entries()) {
      assert.equal(car.crashed, false, `car ${i} repaired`);
      assert.ok(car.group.position.distanceTo(spawns[i]!) < 1, `car ${i} back at its spawn`);
      assert.ok(car.velocity.length() < 2, `car ${i} at rest`);
    }
    assert.equal(s.hw.race["knocked"][0], 0, "the knocked prop is back on its spot");
    assert.equal(s.gg.log.cleared, cleared + 1, "the guest cleared its scene once, from the host's clear count");
    for (const [i, car] of s.gw.live().entries()) assert.ok(car.group.position.distanceTo(spawns[i]!) < 1, `the guest draws car ${i} at its spawn`);
  });

  it("when the host presses Go with two players, then the race starts on both worlds and the lobby is gone: no free drive, a session with both humans", () => {
    const s = lobby();
    assert.equal(s.host.go(), true);
    s.step(40);
    for (const w of [s.hw, s.gw]) {
      assert.equal(w.race.free, false, "no free drive");
      assert.notEqual(w.race.phase, null, "a race session");
    }
    assert.ok(s.hw.race.hud().standings.some((r) => r.name === "Zed"), "the guest is seated as a racer, under its name");
  });
});

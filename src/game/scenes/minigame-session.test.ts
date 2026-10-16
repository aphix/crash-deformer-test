import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { REST_HOLD, THROWS_PER_SET, type MinigameMode } from "./minigame-constants.ts";
import { CAPTURE_HALF_WIDTH } from "./minigame-high-jump.ts";
import type { TorsoSample } from "./minigame-high-jump.ts";
import { RING_CUPS, RING_POCKETS } from "./minigame-ring.ts";
import { MinigameSession, type MinigameBestPair, type MinigameBests, type MinigameFrame } from "./minigame-session.ts";

const CAR_TYPE = "muscle";
const POSTS_X = 40;
const LIP_Y = 2.5;
const HIGH_JUMP_OPTIONS = { carType: CAR_TYPE, highJump: { postsX: POSTS_X, lipY: LIP_Y } };
const LONG_JUMP_OPTIONS = { carType: CAR_TYPE };
const STILL_BEFORE_REST = REST_HOLD / 2;
const FRAMES_AFTER_SCORING = 1000;
const SET_LENGTH = 3;

type RecordedScore = { mode: MinigameMode; throwsPerSet: number | null; carType: string; score: number };

/** A bests double: keeps the best pair and remembers every `record` call. */
function fakeBests(initial: MinigameBestPair = { thisCar: null, overall: null }): MinigameBests & { recorded: RecordedScore[] } {
  const recorded: RecordedScore[] = [];
  let current = initial;
  return {
    recorded,
    bestFor: () => current,
    record(mode, throwsPerSet, carType, score) {
      recorded.push({ mode, throwsPerSet, carType, score });
      current = { thisCar: Math.max(score, current.thisCar ?? 0), overall: Math.max(score, current.overall ?? 0) };
      return true;
    },
  };
}

function torsoAt(x: number, y: number, z: number, still: number): TorsoSample {
  return { x, y, z, still };
}

const PEDAL: MinigameFrame = { pedalPressed: true, thrown: false, torso: null };
const THROW: MinigameFrame = { pedalPressed: false, thrown: true, torso: null };

function flying(torso: TorsoSample): MinigameFrame {
  return { pedalPressed: false, thrown: true, torso };
}

/** Pedal, ejection, then the torso lying still at (x, 0, z) for the rest hold: the attempt scores on the last frame. */
function throwAndRestAt(session: MinigameSession, x: number, z = 0): { scored: number } | null {
  session.step(PEDAL);
  session.step(THROW);
  session.step(flying(torsoAt(x, 0, z, STILL_BEFORE_REST)));
  return session.step(flying(torsoAt(x, 0, z, REST_HOLD)));
}

describe("given a long jump session", () => {
  it("when no pedal is pressed, then it stays ready, even when the ejection flag is up", () => {
    const session = new MinigameSession(fakeBests());
    session.begin("longJump", LONG_JUMP_OPTIONS);
    session.step({ pedalPressed: false, thrown: false, torso: null });
    session.step(THROW);
    assert.equal(session.hud().phase, "ready", "phase without a pedal press");
  });

  it("when the pedal is pressed, then it runs, and when he is ejected, then it is thrown", () => {
    const session = new MinigameSession(fakeBests());
    session.begin("longJump", LONG_JUMP_OPTIONS);
    session.step(PEDAL);
    assert.equal(session.hud().phase, "running", "phase after the pedal");
    session.step({ pedalPressed: false, thrown: false, torso: null });
    assert.equal(session.hud().phase, "running", "phase while driving on");
    session.step(THROW);
    assert.equal(session.hud().phase, "thrown", "phase after the ejection");
  });

  it("when he is flying or lying still for less than the rest hold, then nothing scores and the live value is his distance past the lip", () => {
    const session = new MinigameSession(fakeBests());
    session.begin("longJump", LONG_JUMP_OPTIONS);
    session.step(PEDAL);
    session.step(THROW);
    assert.equal(session.step(flying(torsoAt(30, 4, 0, 0))), null, "frame in flight");
    assert.equal(session.hud().liveValue, 30, "live distance in flight");
    for (let frame = 0; frame < FRAMES_AFTER_SCORING; frame++) {
      assert.equal(session.step(flying(torsoAt(52, 0, 0, REST_HOLD - 0.01))), null, "frame just short of the rest hold");
    }
    assert.equal(session.hud().phase, "thrown", "phase just short of the rest hold");
    assert.equal(session.hud().lastScore, null, "no score yet");
  });

  it("when his torso has lain still for the rest hold, then the score is its x in metres and the card shows it", () => {
    const bests = fakeBests();
    const session = new MinigameSession(bests);
    session.begin("longJump", LONG_JUMP_OPTIONS);
    const result = throwAndRestAt(session, 57.25);
    assert.deepEqual(result, { scored: 57.25 }, "score on the resting frame");
    const card = session.hud();
    assert.equal(card.phase, "scored", "phase");
    assert.equal(card.lastScore, 57.25, "last score");
    assert.equal(card.liveValue, null, "live value once scored");
    assert.deepEqual(card.setScores, [], "no set in the long jump");
    assert.equal(card.throwsPerSet, null, "no set length in the long jump");
    assert.deepEqual(bests.recorded, [{ mode: "longJump", throwsPerSet: null, carType: "muscle", score: 57.25 }], "the throw is recorded");
  });

  it("when he comes to rest behind the lip, then the score is floored at 0", () => {
    const session = new MinigameSession(fakeBests());
    session.begin("longJump", LONG_JUMP_OPTIONS);
    assert.deepEqual(throwAndRestAt(session, -3), { scored: 0 }, "score behind the lip");
  });

  it("when the session has scored, then a thousand more frames of any kind change nothing", () => {
    const bests = fakeBests();
    const session = new MinigameSession(bests);
    session.begin("longJump", LONG_JUMP_OPTIONS);
    throwAndRestAt(session, 20);
    const before = session.hud();
    for (let frame = 0; frame < FRAMES_AFTER_SCORING; frame++) {
      assert.equal(session.step({ pedalPressed: frame % 2 === 0, thrown: true, torso: torsoAt(90 + frame, 9, 0, REST_HOLD + frame) }), null, "frame after scoring");
    }
    assert.equal(JSON.stringify(session.hud()), JSON.stringify(before), "card after the idle frames");
    assert.equal(bests.recorded.length, 1, "nothing recorded again");
  });

  it("when retry follows a scored attempt, then the next attempt is ready and numbered 2, keeping the last score", () => {
    const session = new MinigameSession(fakeBests());
    session.begin("longJump", LONG_JUMP_OPTIONS);
    throwAndRestAt(session, 20);
    session.retry();
    const card = session.hud();
    assert.equal(card.phase, "ready", "phase");
    assert.equal(card.attempt, 2, "attempt");
    assert.equal(card.lastScore, 20, "last score stays on the card");
    assert.equal(throwAndRestAt(session, 25)?.scored, 25, "the second attempt scores");
  });

  it("when retry comes before the attempt has scored, then it does nothing", () => {
    const session = new MinigameSession(fakeBests());
    session.begin("longJump", LONG_JUMP_OPTIONS);
    session.retry();
    assert.deepEqual([session.hud().phase, session.hud().attempt], ["ready", 1], "after retry in ready");
    session.step(PEDAL);
    session.retry();
    assert.deepEqual([session.hud().phase, session.hud().attempt], ["running", 1], "after retry while running");
    session.step(THROW);
    session.retry();
    assert.deepEqual([session.hud().phase, session.hud().attempt], ["thrown", 1], "after retry while thrown");
  });

  it("when the run is reset before the throw, then it is ready again, the attempt number is unchanged and nothing is recorded", () => {
    const bests = fakeBests();
    const session = new MinigameSession(bests);
    session.begin("longJump", LONG_JUMP_OPTIONS);
    session.step(PEDAL);
    session.resetRun();
    assert.deepEqual([session.hud().phase, session.hud().attempt], ["ready", 1], "after the reset");
    assert.deepEqual(bests.recorded, [], "nothing recorded");
    assert.equal(throwAndRestAt(session, 12)?.scored, 12, "the same attempt then scores");
    assert.equal(session.hud().attempt, 1, "attempt after scoring");
  });

  it("when the run is reset after the throw, then it does nothing", () => {
    const session = new MinigameSession(fakeBests());
    session.begin("longJump", LONG_JUMP_OPTIONS);
    session.step(PEDAL);
    session.step(THROW);
    session.resetRun();
    assert.equal(session.hud().phase, "thrown", "phase after a reset once thrown");
  });

  it("when the mode's best comes from the store, then the card shows the stored pair, and after the throw the store's new pair", () => {
    const stored = { thisCar: 31, overall: 44 };
    const session = new MinigameSession(fakeBests(stored));
    session.begin("longJump", LONG_JUMP_OPTIONS);
    assert.deepEqual(session.hud().best, { thisCar: 31, overall: 44 }, "best before the throw");
    throwAndRestAt(session, 36);
    assert.deepEqual(session.hud().best, { thisCar: 36, overall: 44 }, "best after a throw that beats this car's but not the overall");
  });
});

describe("given a high jump session", () => {
  it("when he is begun without his posts and lip, then it fails loudly", () => {
    const session = new MinigameSession(fakeBests());
    assert.throws(() => session.begin("highJump", LONG_JUMP_OPTIONS), /posts/, "begin without the high jump's numbers");
  });

  it("when his torso crosses the posts' plane in flight, then the score is the interpolated height above the lip the moment it does, while he is still flying", () => {
    const bests = fakeBests();
    const session = new MinigameSession(bests);
    session.begin("highJump", HIGH_JUMP_OPTIONS);
    session.step(PEDAL);
    session.step(THROW);
    assert.equal(session.step(flying(torsoAt(POSTS_X - 4, LIP_Y + 18, 0, 0))), null, "frame before the plane");
    assert.equal(session.hud().liveValue, 18, "live height above the lip");
    const result = session.step(flying(torsoAt(POSTS_X + 4, LIP_Y + 10, 0, 0)));
    assert.deepEqual(result, { scored: 14 }, "score at the crossing, halfway between the samples");
    assert.equal(session.hud().phase, "scored", "phase at the crossing");
    assert.equal(session.hud().lastScore, 14, "last score");
    assert.deepEqual(bests.recorded, [{ mode: "highJump", throwsPerSet: null, carType: "muscle", score: 14 }], "the throw is recorded");
  });

  it("when he comes to rest without ever reaching the plane, then the score is 0 only once the rest hold passes", () => {
    const session = new MinigameSession(fakeBests());
    session.begin("highJump", HIGH_JUMP_OPTIONS);
    session.step(PEDAL);
    session.step(THROW);
    assert.equal(session.step(flying(torsoAt(POSTS_X - 15, LIP_Y + 1, 0, STILL_BEFORE_REST))), null, "frame lying short of the plane");
    assert.deepEqual(session.step(flying(torsoAt(POSTS_X - 15, LIP_Y + 1, 0, REST_HOLD))), { scored: 0 }, "score at rest short of the plane");
    assert.equal(session.hud().phase, "scored", "phase");
  });

  it("when he crosses the plane wide of the capture band, then the score is 0 at rest", () => {
    const session = new MinigameSession(fakeBests());
    session.begin("highJump", HIGH_JUMP_OPTIONS);
    session.step(PEDAL);
    session.step(THROW);
    session.step(flying(torsoAt(POSTS_X - 2, LIP_Y + 8, CAPTURE_HALF_WIDTH + 5, 0)));
    assert.equal(session.step(flying(torsoAt(POSTS_X + 2, LIP_Y + 8, CAPTURE_HALF_WIDTH + 5, 0))), null, "frame crossing wide of the band");
    assert.deepEqual(session.step(flying(torsoAt(POSTS_X + 9, LIP_Y, CAPTURE_HALF_WIDTH + 5, REST_HOLD))), { scored: 0 }, "score at rest");
  });

  it("when retry follows, then the capture is armed again for the next throw", () => {
    const session = new MinigameSession(fakeBests());
    session.begin("highJump", HIGH_JUMP_OPTIONS);
    session.step(PEDAL);
    session.step(THROW);
    session.step(flying(torsoAt(POSTS_X - 4, LIP_Y + 6, 0, 0)));
    session.step(flying(torsoAt(POSTS_X + 4, LIP_Y + 6, 0, 0)));
    session.retry();
    session.step(PEDAL);
    session.step(THROW);
    session.step(flying(torsoAt(POSTS_X - 4, LIP_Y + 20, 0, 0)));
    assert.deepEqual(session.step(flying(torsoAt(POSTS_X + 4, LIP_Y + 20, 0, 0))), { scored: 20 }, "score of the second throw");
  });
});

describe("given a Ring Fling session", () => {
  const cupCentre = (index: number) => ({ x: RING_CUPS[index]!.centreX, z: RING_CUPS[index]!.centreZ });

  it("when he comes to rest in a cup, a pocket or off the board, then the score is that zone's", () => {
    const session = new MinigameSession(fakeBests());
    session.begin("ringFling", { carType: CAR_TYPE, throwsPerSet: 10 });
    const expectations: { at: { x: number; z: number }; score: number }[] = [
      ...RING_CUPS.map((cup) => ({ at: { x: cup.centreX, z: cup.centreZ }, score: cup.score })),
      ...RING_POCKETS.map((pocket) => ({ at: { x: pocket.centreX, z: pocket.centreZ }, score: pocket.score })),
      { at: { x: -50, z: 0 }, score: 0 },
    ];
    for (const { at, score } of expectations) {
      assert.equal(throwAndRestAt(session, at.x, at.z)?.scored, score, `score at (${at.x.toFixed(2)}, ${at.z.toFixed(2)})`);
      session.retry();
    }
  });

  it("when he lies over a cup short of the rest hold, then the live value is the zone under him and nothing scores", () => {
    const session = new MinigameSession(fakeBests());
    session.begin("ringFling", { carType: CAR_TYPE });
    session.step(PEDAL);
    session.step(THROW);
    const { x, z } = cupCentre(2);
    assert.equal(session.step(flying(torsoAt(x, 1, z, STILL_BEFORE_REST))), null, "frame short of the rest hold");
    assert.equal(session.hud().liveValue, RING_CUPS[2]!.score, "live zone");
  });

  it("when the session is begun, then the set length is the default and the card says attempt 1 of it", () => {
    const session = new MinigameSession(fakeBests());
    session.begin("ringFling", { carType: CAR_TYPE });
    const card = session.hud();
    assert.equal(card.attempt, 1, "fresh set attempt");
    assert.equal(card.throwsPerSet, THROWS_PER_SET.default, "fresh set length");
    assert.equal(card.setTotal, 0, "fresh set total");
    assert.equal(card.setComplete, false, "fresh set complete");
  });

  it("when a set of three is thrown, then attempts count 1 to 3, the total sums the scores, and only the finished set's total is recorded", () => {
    const bests = fakeBests();
    const session = new MinigameSession(bests);
    session.begin("ringFling", { carType: CAR_TYPE, throwsPerSet: SET_LENGTH });
    const SET_SCORES_AFTER_THROW = ["10", "10,40", "10,40,100"];
    const scoresInOrder = [RING_CUPS[0]!, RING_CUPS[3]!, RING_POCKETS[0]!];
    for (let throwIndex = 0; throwIndex < SET_LENGTH; throwIndex++) {
      const zone = scoresInOrder[throwIndex]!;
      throwAndRestAt(session, zone.centreX, zone.centreZ);
      const card = session.hud();
      assert.equal(card.attempt, throwIndex + 1, `attempt number after throw ${throwIndex + 1}`);
      assert.equal(card.setComplete, throwIndex === SET_LENGTH - 1, `set complete after throw ${throwIndex + 1}`);
      assert.equal(card.setScores.join(","), SET_SCORES_AFTER_THROW[throwIndex], `set scores after throw ${throwIndex + 1}`);
      if (throwIndex < SET_LENGTH - 1) {
        assert.deepEqual(bests.recorded, [], "no best recorded before the set is complete");
        session.retry();
      }
    }
    assert.equal(session.hud().setTotal, 10 + 40 + 100, "set total");
    assert.deepEqual(bests.recorded, [{ mode: "ringFling", throwsPerSet: 3, carType: "muscle", score: 150 }], "set total recorded under its set length");
  });

  it("when retry follows the set's last throw, then a new set starts: attempt 1, no scores, total 0", () => {
    const session = new MinigameSession(fakeBests());
    session.begin("ringFling", { carType: CAR_TYPE, throwsPerSet: 1 });
    throwAndRestAt(session, RING_CUPS[0]!.centreX, RING_CUPS[0]!.centreZ);
    assert.equal(session.hud().setComplete, true, "the one-throw set is complete");
    session.retry();
    const card = session.hud();
    assert.deepEqual([card.phase, card.attempt, card.setScores, card.setTotal, card.setComplete], ["ready", 1, [], 0, false], "new set");
  });

  it("when the run is reset mid-set, then the attempt number is unchanged and no score is recorded", () => {
    const bests = fakeBests();
    const session = new MinigameSession(bests);
    session.begin("ringFling", { carType: CAR_TYPE, throwsPerSet: SET_LENGTH });
    throwAndRestAt(session, RING_CUPS[0]!.centreX, RING_CUPS[0]!.centreZ);
    session.retry();
    session.step(PEDAL);
    session.resetRun();
    const card = session.hud();
    assert.deepEqual([card.phase, card.attempt, card.setScores.length], ["ready", 2, 1], "after the reset");
    assert.deepEqual(bests.recorded, [], "nothing recorded");
  });

  it("when the set length is out of range, then it is clamped to the min and max, and a new length starts a new set", () => {
    const session = new MinigameSession(fakeBests());
    session.begin("ringFling", { carType: CAR_TYPE, throwsPerSet: 4 });
    throwAndRestAt(session, RING_CUPS[0]!.centreX, RING_CUPS[0]!.centreZ);
    session.retry();
    session.setThrowsPerSet(THROWS_PER_SET.max + 7);
    let card = session.hud();
    assert.equal(card.throwsPerSet, THROWS_PER_SET.max, "above the max: clamped");
    assert.equal(card.attempt, 1, "above the max: new set");
    assert.equal(card.setScores.length, 0, "above the max: no scores");
    assert.equal(card.phase, "ready", "above the max: ready");
    session.setThrowsPerSet(0);
    assert.equal(session.hud().throwsPerSet, THROWS_PER_SET.min, "below the min: clamped");
    session.begin("ringFling", { carType: CAR_TYPE, throwsPerSet: -5 });
    card = session.hud();
    assert.equal(card.throwsPerSet, THROWS_PER_SET.min, "begin clamps the same way");
  });

  it("when the set length is set to what it already is, then the set carries on", () => {
    const session = new MinigameSession(fakeBests());
    session.begin("ringFling", { carType: CAR_TYPE, throwsPerSet: 4 });
    throwAndRestAt(session, RING_CUPS[0]!.centreX, RING_CUPS[0]!.centreZ);
    session.setThrowsPerSet(4);
    assert.deepEqual([session.hud().attempt, session.hud().setScores.length, session.hud().phase], [1, 1, "scored"], "same length");
  });

  it("when the set length changes, then the bests shown are those of the new length", () => {
    const asked: (number | null)[] = [];
    const bests: MinigameBests = {
      bestFor: (_mode, throwsPerSet) => {
        asked.push(throwsPerSet);
        return { thisCar: null, overall: null };
      },
      record: () => false,
    };
    const session = new MinigameSession(bests);
    session.begin("ringFling", { carType: CAR_TYPE, throwsPerSet: 4 });
    session.setThrowsPerSet(6);
    assert.deepEqual(asked, [4, 6], "set lengths the bests were read for");
  });
});

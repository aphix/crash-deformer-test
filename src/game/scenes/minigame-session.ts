import { THROWS_PER_SET, REST_HOLD, type MinigameMode } from "./minigame-constants.ts";
import { HighJumpCapture, type TorsoSample } from "./minigame-high-jump.ts";
import { ringScore } from "./minigame-ring.ts";

/**
 * One minigame session: the state machine of a station's attempts (ready -> running -> thrown -> scored), the set of throws in a Ring
 * Fling and the scoring rule of each mode. Pure like `RangeRun` (no THREE, no DOM): the engine feeds it one frame at a time and reads
 * the `hud()` card back. Every coordinate is station-local (+x throw direction, x = 0 the lip, z = 0 the lane centre, y from the pad).
 * Nothing here runs on a timer: a scored attempt stays scored until `retry()`, `resetRun()` or `begin()`.
 */

export type MinigamePhase = "ready" | "running" | "thrown" | "scored";

/** The pair of bests a mode keeps: for the driver's car type, and over every car type. */
export type MinigameBestPair = { thisCar: number | null; overall: number | null };

/**
 * Where the bests live. `throwsPerSet` is the set length in a Ring Fling (its best is per set length) and null in the other modes.
 * `record` is true when the score is a new best for the car type or overall.
 */
export interface MinigameBests {
  bestFor(mode: MinigameMode, throwsPerSet: number | null, carType: string): MinigameBestPair;
  record(mode: MinigameMode, throwsPerSet: number | null, carType: string, score: number): boolean;
}

/** What the HUD shows of the running minigame (null outside a minigame, mounted as `CrashHudState.minigame`). */
export type MinigameHudState = {
  mode: MinigameMode;
  phase: MinigamePhase;
  /** 1-based: the current or just-finished attempt (in a Ring Fling, the throw's place in its set). */
  attempt: number;
  /** Ring Fling only, else null. */
  throwsPerSet: number | null;
  /** Metres past the lip (long jump), metres above the lip (high jump), the ring zone under him (Ring Fling); null while he is not flying. */
  liveValue: number | null;
  lastScore: number | null;
  /** Ring Fling only: the scores of this set's finished throws; empty in the other modes. */
  setScores: number[];
  setTotal: number;
  setComplete: boolean;
  /** The mode's bests (Ring Fling: the set totals of this set length). */
  best: MinigameBestPair;
};

export type MinigameBeginOptions = {
  carType: string;
  /** Ring Fling only. */
  throwsPerSet?: number;
  /** High jump only: the posts' plane (m past the lip) and the lip's height above the pad. */
  highJump?: { postsX: number; lipY: number };
};

/** One render frame's input to the session. */
export type MinigameFrame = {
  pedalPressed: boolean;
  /** True from the frame the driver is ejected. */
  thrown: boolean;
  /** The dummy's torso while he is out; `still` is the sim seconds his speed has been under 0.4 m/s. */
  torso: TorsoSample | null;
};

function clampThrowsPerSet(count: number): number {
  return Math.min(THROWS_PER_SET.max, Math.max(THROWS_PER_SET.min, Math.round(count)));
}

export class MinigameSession {
  private mode: MinigameMode = "longJump";
  private carType = "";
  private throwsPerSetCount: number = THROWS_PER_SET.default;
  private highJump: { postsX: number; lipY: number } | null = null;
  private phase: MinigamePhase = "ready";
  private attempt = 1;
  private liveValue: number | null = null;
  private lastScore: number | null = null;
  private setScores: number[] = [];
  private best: MinigameBestPair = { thisCar: null, overall: null };
  private previousTorso: TorsoSample | null = null;
  private readonly capture = new HighJumpCapture();

  private readonly bests: MinigameBests;

  constructor(bests: MinigameBests) {
    this.bests = bests;
  }

  /** Start the mode's first attempt (a new set in a Ring Fling). */
  begin(mode: MinigameMode, options: MinigameBeginOptions): void {
    if (mode === "highJump" && options.highJump === undefined) throw new Error("the high jump needs its posts' plane and lip height");
    this.mode = mode;
    this.carType = options.carType;
    this.throwsPerSetCount = clampThrowsPerSet(options.throwsPerSet ?? THROWS_PER_SET.default);
    this.highJump = options.highJump ?? null;
    this.attempt = 1;
    this.setScores = [];
    this.lastScore = null;
    this.readyAgain();
    this.refreshBest();
  }

  /** One call per render frame; the score on the frame the attempt scores, else null. */
  step(frame: MinigameFrame): { scored: number } | null {
    if (this.phase === "ready" && frame.pedalPressed) this.phase = "running";
    if (this.phase === "running" && frame.thrown) this.phase = "thrown";
    if (this.phase !== "thrown") return null;
    const { torso } = frame;
    if (torso === null) return null;
    this.liveValue = this.liveValueAt(torso);
    const score = this.scoreAt(torso);
    this.previousTorso = torso;
    if (score === null) return null;
    this.finishAttempt(score);
    return { scored: score };
  }

  /** The next attempt at the same station; after a Ring Fling set's last throw, a new set. A no-op before the attempt scores. */
  retry(): void {
    if (this.phase !== "scored") return;
    if (this.mode === "ringFling" && this.setScores.length >= this.throwsPerSetCount) {
      this.setScores = [];
      this.attempt = 1;
    } else {
      this.attempt++;
    }
    this.readyAgain();
  }

  /** Back to ready without consuming an attempt; a no-op once he is thrown. */
  resetRun(): void {
    if (this.phase !== "ready" && this.phase !== "running") return;
    this.readyAgain();
  }

  /** Ring Fling's set length (clamped); a different length starts a new set. */
  setThrowsPerSet(count: number): void {
    const clamped = clampThrowsPerSet(count);
    if (this.mode !== "ringFling" || clamped === this.throwsPerSetCount) return;
    this.throwsPerSetCount = clamped;
    this.attempt = 1;
    this.setScores = [];
    this.lastScore = null;
    this.readyAgain();
    this.refreshBest();
  }

  hud(): MinigameHudState {
    const ringFling = this.mode === "ringFling";
    const setTotal = this.setScores.reduce((total, score) => total + score, 0);
    return {
      mode: this.mode,
      phase: this.phase,
      attempt: this.attempt,
      throwsPerSet: ringFling ? this.throwsPerSetCount : null,
      liveValue: this.liveValue,
      lastScore: this.lastScore,
      setScores: [...this.setScores],
      setTotal,
      setComplete: ringFling && this.setScores.length >= this.throwsPerSetCount,
      best: { ...this.best },
    };
  }

  private readyAgain(): void {
    this.phase = "ready";
    this.liveValue = null;
    this.previousTorso = null;
    this.capture.reset();
  }

  private refreshBest(): void {
    this.best = this.bests.bestFor(this.mode, this.mode === "ringFling" ? this.throwsPerSetCount : null, this.carType);
  }

  private liveValueAt(torso: TorsoSample): number {
    if (this.mode === "longJump") return Math.max(0, torso.x);
    if (this.mode === "highJump") return Math.max(0, torso.y - this.highJumpPlane.lipY);
    return ringScore(torso.x, torso.z);
  }

  private get highJumpPlane(): { postsX: number; lipY: number } {
    if (this.highJump === null) throw new Error("the high jump has no posts' plane");
    return this.highJump;
  }

  /** The attempt's score once it is decided, else null. At rest is the torso's own still-time, never the ragdoll's `settled` flag. */
  private scoreAt(torso: TorsoSample): number | null {
    const atRest = torso.still >= REST_HOLD;
    if (this.mode === "highJump") {
      const { postsX, lipY } = this.highJumpPlane;
      const captured = this.capture.step(this.previousTorso, torso, postsX, lipY);
      if (captured !== null) return captured;
      return atRest ? 0 : null;
    }
    if (!atRest) return null;
    return this.mode === "longJump" ? Math.max(0, torso.x) : ringScore(torso.x, torso.z);
  }

  private finishAttempt(score: number): void {
    this.phase = "scored";
    this.liveValue = null;
    this.lastScore = score;
    if (this.mode !== "ringFling") {
      this.bests.record(this.mode, null, this.carType, score);
    } else {
      this.setScores.push(score);
      if (this.setScores.length >= this.throwsPerSetCount) {
        const setTotal = this.setScores.reduce((total, throwScore) => total + throwScore, 0);
        this.bests.record(this.mode, this.throwsPerSetCount, this.carType, setTotal);
      }
    }
    this.refreshBest();
  }
}

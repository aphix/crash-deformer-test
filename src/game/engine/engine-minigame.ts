import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import type { Ejection, EjectionWatch } from "../vehicle/ejection.ts";
import { BOX_POSE_FLOATS, type BoxPlacement, type ReleaseScale } from "../present/ragdoll-boxes.ts";
import type { RagdollSystem } from "../present/engine-ragdoll.ts";
import { MinigameArt } from "../present/minigame-art.ts";
import { NET_HALF_WIDTH } from "../present/high-jump-art.ts";
import { HIGH_JUMP_MEASURED, MINIGAME_MODE, STATION_ANCHORS, THROW_BOOST, THROWS_PER_SET, type MinigameMode } from "../scenes/minigame-constants.ts";
import { bailRelease, LongJumpBail } from "../scenes/minigame-bail.ts";
import { MinigameGround, type MinigameBounds, type StationStart } from "../scenes/minigame-ground.ts";
import { BOX_COUNT, highJumpLayout, type TorsoSample } from "../scenes/minigame-high-jump.ts";
import { lipHeight } from "../scenes/minigame-profile.ts";
import { MinigameSession, type MinigameHudState } from "../scenes/minigame-session.ts";
import { minigameStore } from "./minigame-store.ts";

/** What `Minigames.begin` needs from the engine: the scene its art joins, and the cars and the ejection watch the lip throws act on. */
type MinigameStart = { mode: MinigameMode; carType: string; scene: THREE.Object3D; cars: readonly DeformableCar[]; ejection: EjectionWatch };

function blankTorsoSample(): TorsoSample {
  return { x: 0, y: 0, z: 0, still: 0 };
}

/**
 * The Range's minigames inside scene "range" (`MinigameSession` is their state machine, `MinigameGround` their floor, `MinigameArt` their
 * look): which mode is on, the throw's bookkeeping and the per-frame feed from the thrown dummy into the session. The engine owns the car,
 * the camera and the scene; this owns everything a mode adds to them. Nothing here is on a timer: a scored throw waits for the player.
 */
export class Minigames {
  private readonly session = new MinigameSession(minigameStore());
  private activeMode: MinigameMode | null = null;
  private carType = "";
  private throwsPerSet: number = THROWS_PER_SET.default;
  /** An ejection has been launched for this attempt. */
  private thrown = false;
  private art: MinigameArt | null = null;
  private ground: MinigameGround | null = null;
  private collideHook: ((car: DeformableCar, index: number) => void) | null = null;
  /** The modes that have a box pile, and where their boxes stand (world coordinates). */
  private boxPlacements: Partial<Record<MinigameMode, readonly BoxPlacement[]>> = {};
  private readonly highJumpLipY = lipHeight(MINIGAME_MODE.highJump);
  private readonly highJump = highJumpLayout(HIGH_JUMP_MEASURED, this.highJumpLipY);
  private readonly boxPoses = new Float32Array(BOX_COUNT * BOX_POSE_FLOATS);
  private readonly torsoWorld = new THREE.Vector3();
  /** The session keeps the previous frame's sample to interpolate the posts' plane: two buffers take turns. */
  private readonly torsoSamples = [blankTorsoSample(), blankTorsoSample()];
  private nextTorsoSample = 0;
  /** The Long jump's bail: this attempt's press and hit, and the barrier's throw held for a late press. */
  private readonly bail = new LongJumpBail();
  private heldThrow: Ejection | null = null;
  private boostWasDown = false;

  /** The mode in play, null while the Range runs its attract loop. */
  get mode(): MinigameMode | null {
    return this.activeMode;
  }

  /** The range's sand and distance signs belong to the attract loop and the long jump. */
  get rangeArtShown(): boolean {
    return this.activeMode === null || this.activeMode === MINIGAME_MODE.longJump;
  }

  /** The physics ground the mode plays on; null in the attract loop (the flat ground). */
  get groundInPlay(): MinigameGround | null {
    return this.activeMode === null ? null : this.ground;
  }

  /** The world rectangle the free camera may roam while a mode is on, else null. */
  bounds(): MinigameBounds | null {
    return this.groundInPlay?.minigameBounds() ?? null;
  }

  /** The session's card for the HUD, the Long jump's bail on it. */
  hud(): MinigameHudState {
    const card = this.session.hud();
    if (this.activeMode === MINIGAME_MODE.longJump) card.bail = { pressed: this.bail.pressed, verdict: this.bail.verdict };
    return card;
  }

  /**
   * Switch to `mode` with a fresh first attempt (a new set in Ring Fling). Builds the floor, the art (joined to `scene`) and the lip trigger
   * the first time any mode starts; returns true then, for the engine to queue its shader warm-up.
   */
  begin(start: MinigameStart): boolean {
    const built = this.ground === null;
    if (built) this.build(start);
    this.activeMode = start.mode;
    this.carType = start.carType;
    this.thrown = false;
    this.heldThrow = null;
    this.bail.reset();
    this.beginSession(start.mode);
    return built;
  }

  private build(start: MinigameStart): void {
    this.ground = new MinigameGround({ highJump: { netX: this.highJump.netX, netHalfWidth: NET_HALF_WIDTH, netHeight: this.highJump.netHeight } });
    this.collideHook = this.ground.collideHook(start.cars, start.ejection);
    this.art = new MinigameArt();
    this.boxPlacements = { highJump: this.art.setHighJumpLayout(this.highJump, this.highJumpLipY) };
    start.scene.add(this.art.group);
  }

  /** Leave the minigames: the held dummy goes, the boxes and the station art with it. The engine resets the scene after. */
  end(ragdolls: RagdollSystem): void {
    if (this.activeMode === null) return;
    this.activeMode = null;
    this.thrown = false;
    this.heldThrow = null;
    this.bail.reset();
    ragdolls.releaseThrown();
    ragdolls.clearBoxes();
    this.art?.setMode(null);
  }

  /** The active station's art shows while the Range is the scene; anywhere else every station is hidden. */
  showArt(inRange: boolean): void {
    this.art?.setMode(inRange ? this.activeMode : null);
  }

  /** A scene reset puts the player's car type in: another type is another best, so the first attempt starts again. */
  syncCarType(carType: string): void {
    if (this.activeMode === null || carType === this.carType) return;
    this.carType = carType;
    this.beginSession(this.activeMode);
  }

  private beginSession(mode: MinigameMode): void {
    this.session.begin(mode, { carType: this.carType, throwsPerSet: this.throwsPerSet, highJump: { postsX: this.highJump.postsX, lipY: this.highJumpLipY } });
  }

  /** A new attempt's scene (after `ragdolls.reset`, which drops both): the dummy lives until released, the boxes stand again, no bail yet. */
  armRagdolls(ragdolls: RagdollSystem): void {
    this.thrown = false;
    this.heldThrow = null;
    this.bail.reset();
    ragdolls.holdThrown();
    const boxes = this.activeMode === null ? undefined : this.boxPlacements[this.activeMode];
    if (boxes) ragdolls.setBoxes(boxes);
  }

  /** The Long jump's boost control, once per frame: `down` is the control held, `tapped` a press the poll saw begin. The first press of a run is the bail, stamped at game time `now`; before the car moves it is nothing. */
  sampleBoost(down: boolean, tapped: boolean, now: number): void {
    const pressed = tapped || (down && !this.boostWasDown);
    this.boostWasDown = down;
    if (!pressed || this.activeMode !== MINIGAME_MODE.longJump) return;
    const phase = this.session.attemptPhase;
    if (phase === "running" || phase === "thrown") this.bail.press(now);
  }

  /** The barrier's throw at game time `now`: the dummy waits (up to the bail window) for a late press. */
  holdForBail(event: Ejection, now: number): void {
    this.heldThrow = event;
    this.bail.hit(now);
  }

  /** The held throw and its release once the bail has decided it at game time `now`, else null. */
  bailThrowDue(now: number): { event: Ejection; release: ReleaseScale } | null {
    if (this.heldThrow === null) return null;
    const verdict = this.bail.launchDue(now);
    if (verdict === null) return null;
    const event = this.heldThrow;
    this.heldThrow = null;
    return { event, release: bailRelease(THROW_BOOST.longJump, verdict.quality) };
  }

  /** Where the active station parks the player's car. */
  stationStart(): StationStart {
    if (this.activeMode === null || this.ground === null) throw new Error("no minigame is on");
    return this.ground.stationStart(this.activeMode);
  }

  /** `world.collide`'s per-car hook while a mode is on: the lip throws of the high jump and Ring Fling. */
  collide(car: DeformableCar, index: number): void {
    this.collideHook?.(car, index);
  }

  /** The driver was ejected this step. */
  noteThrown(): void {
    this.thrown = true;
  }

  /**
   * One render frame: the dummy's torso (station-local, from the ragdoll's latest) and whether the player has pressed a pedal go to the
   * session, and the high jump's boxes are drawn where the physics left them.
   */
  step(ragdolls: RagdollSystem, pedalPressed: boolean): void {
    if (this.activeMode === null) return;
    const still = ragdolls.latest(this.torsoWorld);
    let torso: TorsoSample | null = null;
    if (still >= 0) {
      const anchor = STATION_ANCHORS[this.activeMode];
      torso = this.torsoSamples[this.nextTorsoSample]!;
      this.nextTorsoSample = 1 - this.nextTorsoSample;
      torso.x = this.torsoWorld.x - anchor.x;
      torso.y = this.torsoWorld.y;
      torso.z = this.torsoWorld.z - anchor.z;
      torso.still = still;
    }
    this.session.step({ pedalPressed, thrown: this.thrown, torso });
    if (this.boxPlacements[this.activeMode]) this.art?.updateBoxes(this.boxPoses, ragdolls.copyBoxPoses(this.boxPoses));
  }

  /** Retry after a scored throw (a new set after a Ring Fling set's last); false, and nothing changes, before the throw is scored. */
  retry(): boolean {
    if (this.session.hud().phase !== "scored") return false;
    this.session.retry();
    return true;
  }

  /** Back to the start without consuming an attempt; false once he is thrown. */
  resetRun(): boolean {
    const phase = this.session.hud().phase;
    if (phase !== "ready" && phase !== "running") return false;
    this.session.resetRun();
    return true;
  }

  /** The Ring Fling set length (kept for every later start); true when the set restarts because of it. */
  setThrowsPerSet(count: number): boolean {
    this.session.setThrowsPerSet(count);
    const changed = this.session.hud().throwsPerSet;
    if (changed === null || changed === this.throwsPerSet) return false;
    this.throwsPerSet = changed;
    return true;
  }
}

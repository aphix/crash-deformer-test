import type { DeformableCar } from "../vehicle/car.ts";
import { layOnGround } from "../vehicle/car-air-points.ts";
import type { MinigameMode } from "../scenes/minigame-constants.ts";
import { EngineDerby } from "./engine-derby.ts";

/**
 * The Range's minigame commands: what the HUD's pick, Retry, Reset run, the set-length stepper and Exit ask of the engine, and the
 * parking of the player's car at a station's start. The scene's own reset (`EngineScenes.randomizeAndReset`) lays the station out.
 */
export abstract class EngineMinigames extends EngineDerby {
  /** The Range's HUD pick: play `mode` (or switch to it): its station, the player's car parked on the hilltop, a fresh first attempt. */
  startMinigame(mode: MinigameMode): void {
    if (!this.showRange || this.net.client) return;
    if (this.minigames.begin({ mode, carType: this.playerCar.id, scene: this.scene, cars: this.cars, ejection: this.ejection })) this.queueWarm();
    this.tryUnlockAudio();
    this.restartMinigameAttempt();
  }

  /** After a scored throw: the car back on the hilltop and the next attempt (a new set after a Ring Fling set's last). */
  retryMinigame(): void {
    if (this.minigameMode === null || !this.minigames.retry()) return;
    this.restartMinigameAttempt();
  }

  /** Before the throw: the car back on the hilltop, no attempt used. */
  resetMinigameRun(): void {
    if (this.minigameMode === null || !this.minigames.resetRun()) return;
    this.restartMinigameAttempt();
  }

  setMinigameThrowsPerSet(count: number): void {
    if (this.minigameMode === null) return;
    if (this.minigames.setThrowsPerSet(count)) this.restartMinigameAttempt();
    else this.emitHud();
  }

  /** Back to the Range's attract loop. */
  exitMinigame(): void {
    if (this.minigameMode === null) return;
    this.endMinigames();
    this.seat.clear();
    this.restartMinigameAttempt();
  }

  /** The minigame over (leaving the Range, or Exit): the dummy, boxes and art go. */
  protected endMinigames(): void {
    if (this.minigames.mode === null) return;
    this.minigames.end(this.ragdolls);
  }

  /** The scene resets (the car to its start, the dummy and the boxes released and restacked, the camera back on the car) and the HUD follows. */
  private restartMinigameAttempt(): void {
    this.view.leaveFree();
    this.randomizeAndReset();
    this.emitHud();
  }

  /** The minigame's attempt begins: the car stands parked on its station's hilltop, the seat only following it (the first pedal press promotes it to driving), the dummy to live until released and the boxes to stand. */
  protected parkAtMinigameStart(car: DeformableCar): void {
    this.minigames.syncCarType(this.playerCar.id);
    const start = this.minigames.stationStart();
    car.spawnFacing(start.x, start.z, start.yaw, 0);
    car.group.position.y = start.y;
    layOnGround(car);
    this.dressCar(car);
    car.parked = true;
    this.seat.focus(0);
    this.minigames.armRagdolls(this.ragdolls);
  }
}

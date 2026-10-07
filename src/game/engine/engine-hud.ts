import { stackLoads } from "../scenes/stack-rig.ts";
import { compactorStage } from "../scenes/compactor.ts";
import type { HudStore, LabHud } from "../hud/hud-store.ts";
import { carGauge } from "../match/car-view.ts";
import { HANDLING } from "../vehicle/vehicle-classes.ts";
import { mayRecoverFlipped } from "../vehicle/car-drive.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { EngineWarm } from "./engine-warm.ts";
import type { RaceHud } from "../match/types.ts";
import { WALL } from "./engine-lab.ts";

/**
 * HUD publish: the engine's state as one `CrashHudState` snapshot.
 */
export abstract class EngineHud extends EngineWarm {
  /** The UI's store (CrashLab's, passed to the constructor): one per engine. */
  protected hudStore!: HudStore;

  protected emitHud(): void {
    const cars = this.live();
    const relVel = this.fleetClosing();
    const eta =
      this.clock.phase === "approach" && !this.rigScene ? this.contactEta() : 0;
    const carMass = this.carA.deform.totalMass;
    const pistonEnergy = this.pistons.shotEnergy(carMass);
    // The driven car outside a race (a race publishes its own view): a derby driver gets the race's speed, gear and boost gauge; a sandbox driver only its wreck state (the reset controls' glow).
    const driven = this.seat.mode === "drive" && !this.race.active ? cars[this.seat.carIndex] : undefined;
    const drivenView = driven && {
      id: this.seat.carIndex,
      racer: null,
      ...carGauge(driven),
      boost: this.seat.boost,
      chase: null,
      canReset: this.mayRecover(driven),
    };
    this.hudStore.publish({
      playing: this.playing,
      looping: this.looping,
      showRig: this.showRig,
      showParticles: this.showParticles,
      showBarrier: this.barrierUp,
      showBalls: this.ballsUp,
      showRamps: this.rampsUp,
      showCompactor: this.showCompactor,
      showPistons: this.showPistons,
      pistons: {
        selected: this.pistonSelected,
        speedKph: this.pistons.config.speedKph,
        massKg: this.pistons.config.massKg,
        hardness: this.pistons.config.hardness,
        holdCar: this.pistons.config.holdCar,
        hopSeconds: this.pistons.config.hopSeconds,
        hopSynced: this.pistonHopSynced(),
        busy: this.pistons.busy,
        energyKj: pistonEnergy / 1000,
        ebsKph: Math.sqrt((2 * pistonEnergy) / carMass) * 3.6,
      },
      showDoors: this.showDoors,
      showCorkscrew: this.showCorkscrew,
      stack: this.showStack ? { ...this.stack.config, dropped: this.stack.dropped, ...stackLoads(cars, this.stack.dropped) } : null,
      lab: this.showLab ? { preset: this.lab.preset ?? "cards", shot: this.labShotHud() } : null,
      pendingScene: this.sceneFade.pending,
      inRoom: this.net.role !== "off",
      doors: {
        side: this.doorRig.side,
        kph: this.doorRig.kph,
        kg: this.doorRig.kg,
        open: this.carA.doorHinge(this.doorRig.side).theta > 0.01,
        busy: this.doorRig.phase === "run",
        energyJ: 0.5 * this.doorRig.kg * (this.doorRig.kph / 3.6) ** 2,
        shot: this.doorShot && {
          detached: this.doorShot.detached,
          doorDeg: this.doorShot.doorDeg,
          latched: this.doorShot.latched,
          panelHinge: this.doorShot.panelHinge,
          bodyMm: Math.max(this.doorShot.bodyParticleMm, this.doorShot.bodyVertexMm),
        },
      },
      range: this.showRange ? { distance: this.rangeRun.distance, landed: this.rangeRun.landed } : null,
      autoRotate: this.autoRotate,
      autoSlomo: this.autoSlomo,
      audioOn: this.audioOn,
      fxTier: this.cine.tier,
      fxAuto: this.autoFx.auto,
      celLook: this.celLook,
      night: this.stage.night,
      wet: this.stage.wet,
      deformMode: this.deformMode,
      phase: this.clock.phase,
      timeScale: this.clock.timeScale,
      userTimeScale: this.clock.userTimeScale,
      elapsed: this.elapsedWall,
      speedA: this.showCompactor ? 0 : (cars[0]?.velocity.length() ?? 0),
      speedB: this.showCompactor ? 0 : (cars[1]?.velocity.length() ?? 0),
      closingKph: relVel * 3.6,
      impactKph: this.impactKph,
      eta: Number.isFinite(eta) ? eta : 0,
      cageCount: this.carA.deform.cageCount,
      sensorCount: this.carA.deform.sensorCount,
      squash: this.squash,
      buckle: this.buckle,
      fxDensity: this.fxDensity,
      carCount: this.carCount,
      speedMin: this.speedMin,
      speedMax: this.speedMax,
      traceSamples: this.captureTrace ? this.trace.samples.length : this.trace.setupCopied ? 1 : 0,
      wallGap: this.showCompactor ? this.compactor.face * 2 : 0,
      compactStage: this.showCompactor ? compactorStage(this.compactor.face) : "open",
      fps: this.fps,
      captureTrace: this.captureTrace,
      derby: this.derbyMode,
      derbyWinner: this.derby.winnerName,
      derbyDecided: this.derby.decided,
      derbyTime: this.derby.active ? this.derby.time : null,
      derbyView: this.derbyMode ? (drivenView ?? null) : null,
      fleetView: this.derbyMode ? null : (drivenView ?? null),
      derbyBoard: this.derby.board.map((r) => ({
        id: r.id,
        name: r.name,
        score: r.score,
        alive: r.alive,
        out: r.out,
        clock: r.clock,
        watched: this.seat.mode !== "global" && this.seat.carIndex === r.id,
      })),
      race: this.race.active ? { ...this.race.hud(), ...this.reelHud() } : null,
      seat: this.seat.mode,
      boost: this.seat.boost,
      view: this.seat.view,
      cam: this.seat.mode === "follow" && !this.rigScene ? this.view.specView(this.race.chase) : null,
      pad: this.pad.label,
      realism: HANDLING.realism,
      playerCar: this.playerCar.id,
      mouseLook: this.view.locked,
    });
    this.syncShareUrl();
  }

  /** R / D-pad ↓ may put `car` back on its wheels: always, but in a derby only a flipped car that still runs (`mayRecoverFlipped`, no free heal): the player's and the AI's R alike. */
  protected mayRecover(car: DeformableCar): boolean {
    return !this.derbyMode || mayRecoverFlipped(car);
  }

  /** The Lab's last throw as the HUD reads it (`LabHud.shot`). */
  private labShotHud(): LabHud["shot"] {
    const s = this.lab.shot;
    if (!s) return null;
    if (s.hit === null) return { hit: null, speed: s.launch.length(), fell: s.fell.length };
    const item = s.hit === WALL ? null : this.lab.layout[s.hit]!;
    const hit = item === null ? "pegboard" : item.kind === "prop" ? item.prefab : item.kind;
    return { hit, speed: s.speedBefore, fell: s.fell.length };
  }

  /** The results reel's part of the race HUD (docs/HIGHLIGHTS.md). */
  protected abstract reelHud(): Pick<RaceHud, "reel" | "solo" | "shown" | "saved">;
}

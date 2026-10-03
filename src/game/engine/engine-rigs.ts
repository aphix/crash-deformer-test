import * as THREE from "three";
import { COMPACTOR, compactorStage } from "../scenes/compactor.ts";
import { PISTON, PISTON_IDS, type PistonConfig } from "../scenes/piston-rig.ts";
import { PISTON_ORBIT_RATE, pistonAhead, pistonToGo } from "../present/engine-pistons.ts";
import { DOOR_LANES, RAM, type DoorScenario } from "../scenes/door-rig.ts";
import { CORKSCREW } from "../scenes/corkscrew.ts";
import { EngineScenes } from "./engine-scenes.ts";

const _bn = new THREE.Vector3();
const _bp = new THREE.Vector3();

/** Piston loop: the next ram is parked this long (s) before its shot, and no sooner after the last one. */
const PISTON_PARK_LEAD = 1;

/**
 * The rig scenes' commands and per-step drive: compactor press, piston bank and door ram, and the corkscrew's show.
 */
export abstract class EngineRigs extends EngineScenes {
  /** Fire piston `index` (0–7 in key order) or all eight (8). A free car already shoved off the pad is parked fresh first. */
  firePiston(index: number): void {
    if (!this.showPistons || this.pistons.busy) return;
    if (this.pistonFired && this.carA.group.position.lengthSq() > 0.09) this.randomizeAndReset();
    if (index < PISTON_IDS.length) this.pistonSelected = index;
    this.pistonAll = index >= PISTON_IDS.length;
    this.pistonFired = true;
    this.pistonSinceFire = 0;
    this.pistons.fire(index < PISTON_IDS.length ? PISTON_IDS[index]! : "all");
    // The run-up lasts a few hundredths of a second: slow down now so it reads.
    if (this.autoSlomo && this.clock.userTimeScale == null && this.clock.phase === "approach") {
      this.clock.targetScale = 0.15;
      this.clock.timeScale = Math.min(this.clock.timeScale, 0.15);
    }
    this.tryUnlockAudio();
    this.emitHud();
  }

  setPistonConfig(patch: Partial<PistonConfig>): void {
    this.pistons.setConfig(patch);
    this.pistonBank.sync(this.pistons, this.pistonSelected, this.pistonAll);
    this.emitHud();
  }

  /** Fire a sketch scene (A/B/C: door and mirror; D/E: quarter panel) on the selected side; a car missing the part it needs is parked fresh first. */
  fireDoorRam(scenario: DoorScenario): void {
    if (!this.showDoors || this.doorRig.phase === "run") return;
    const side = this.doorRig.side;
    const gone =
      DOOR_LANES[scenario].part === "panel"
        ? this.carA.partOff(side < 0 ? "quarterL" : "quarterR")
        : this.carA.partOff(side < 0 ? "doorL" : "doorR") || this.carA.partOff(side < 0 ? "mirrorL" : "mirrorR");
    if (gone) this.randomizeAndReset();
    this.doorShot = null;
    this.doorFx = false;
    this.doorRig.fire(scenario, side);
    // A fast ram crosses the car in a few tenths of a second: slow it down so it reads.
    if (this.autoSlomo && this.clock.userTimeScale == null) this.clock.targetScale = this.doorRig.kph > 15 ? 0.3 : 1;
    this.tryUnlockAudio();
    this.emitHud();
  }

  setDoorConfig(patch: { kph?: number; kg?: number; side?: -1 | 1 }): void {
    if (patch.kph != null) this.doorRig.kph = THREE.MathUtils.clamp(patch.kph, 1, 120);
    if (patch.kg != null) this.doorRig.kg = THREE.MathUtils.clamp(patch.kg, 5, 5000);
    if (patch.side != null && this.doorRig.phase === "idle") {
      this.doorRig.side = patch.side;
      this.doorRam.sync(this.doorRig);
    }
    this.emitHud();
  }

  /** Swing the selected door between shut (latched) and the B/C start angle. */
  toggleDoorOpen(): void {
    if (!this.showDoors || this.doorRig.phase === "run") return;
    const side = this.doorRig.side;
    this.carA.setDoorOpen(side, this.carA.doorHinge(side).theta > 0.01 ? 0 : DOOR_LANES.overOpen.open);
    this.emitHud();
  }

  /** A rig scene's slice: the rig drives the car (the press and pistons also step its loose parts); the corkscrew only watches it. */
  protected readonly rigSlice = (h: number): boolean => {
    if (this.showCorkscrew) return this.watchCorkscrew();
    if (this.showCompactor) {
      this.stepCompactor(h);
      this.carA.afterContacts(h, this.bounceWorld);
    } else if (this.showPistons) {
      this.stepPistons(h);
      this.carA.afterContacts(h, this.bounceWorld);
    } else {
      this.stepDoors(h);
    }
    return true;
  };
  private stepCompactor(dt: number): void {
    const hit = this.compactor.step(dt);
    this.press.sync(this.compactor.face);
    if (this.carA.deform.massActive) {
      if (hit.hits > 0 && this.elapsedWall > this.compactFxAt) {
        this.compactFxAt = this.elapsedWall + 0.2;
        _bp.set(0, 0.34, this.compactor.face);
        _bn.set(0, 0, -1);
        this.sparks.poof(_bp, _bn, Math.max(10, (18 * this.fxDensity) | 0));
        _bp.z = -this.compactor.face;
        _bn.set(0, 0, 1);
        this.sparks.poof(_bp, _bn, Math.max(10, (18 * this.fxDensity) | 0));
        if (this.clock.phase === "approach") {
          this.beginCinematic(_bp, _bn, COMPACTOR.speed * 8);
          if (this.autoSlomo) this.clock.targetScale = this.clock.reduceMotion ? 0.28 : 0.42;
        }
      }
    }
    const stage = compactorStage(this.compactor.face);
    if (stage === "contact" || stage === "wells") this.clock.phase = this.clock.phase === "approach" ? "impact" : this.clock.phase;
    if (stage === "mid") this.clock.phase = "slowmo";
    if (stage === "max") this.clock.phase = "aftermath";
  }

  /**
   * The world step flies the corkscrew's car (`DeformableCar.airborne`); the scene times the show: slow-mo when it
   * leaves the lip, the impact cinematic when it first comes down, the aftermath when it rolls back out unflown.
   */
  private watchCorkscrew(): false {
    const car = this.carA;
    if (this.corkFlight === "ground" && car.airborne) {
      this.corkFlight = "air";
      // The roll reads in slow motion (the door ram's rule); the landing's impact phase hands time back.
      if (this.autoSlomo && this.clock.userTimeScale == null) this.clock.targetScale = 0.35;
    } else if (this.corkFlight === "air" && (car.airContact || !car.airborne)) {
      this.corkFlight = "down";
      this.beginCinematic(car.group.position.clone(), _bn.set(0, 1, 0), car.velocity.length());
    } else if (this.corkFlight === "ground" && this.clock.phase === "approach" && car.velocity.z < 0 && car.group.position.z < CORKSCREW.mouthZ) {
      this.clock.phase = "aftermath";
    }
    return false;
  }


  /**
   * Piston loop: park the next ram `PISTON_PARK_LEAD` before its shot, then fire it. While the
   * orbit paces the hops each ram fires as the camera passes behind it (one per eighth of a turn,
   * next in the orbit's direction); otherwise every `hopSeconds`, in key order.
   */
  protected stepPistonLoop(wallDt: number): void {
    this.pistonSinceFire += wallDt;
    const synced = this.pistonHopSynced();
    const bearing = this.view.bearing;
    if (this.pistonFired) {
      if (this.pistonSinceFire < PISTON_PARK_LEAD) return;
      let next = (this.pistonSelected + 1) % PISTON_IDS.length;
      if (synced) {
        next = pistonAhead(bearing, 0);
        if (pistonToGo(next, bearing) > PISTON_ORBIT_RATE * PISTON_PARK_LEAD) return;
      } else if (this.pistonSinceFire < this.pistons.config.hopSeconds - PISTON_PARK_LEAD) {
        return;
      }
      this.pistonSelected = next;
      this.pistonAll = false;
      this.randomizeAndReset();
      this.emitHud();
      return;
    }
    if (!synced) {
      if (this.elapsedWall >= PISTON_PARK_LEAD) this.firePiston(this.pistonSelected);
      return;
    }
    const togo = pistonToGo(this.pistonSelected, bearing);
    if (togo <= 0 && togo > -0.3) {
      this.firePiston(this.pistonSelected);
      return;
    }
    // Parked for a ram the camera isn't heading to (orbit just took over): wait for the next one instead.
    const ahead = pistonAhead(bearing, 0);
    if (ahead === this.pistonSelected) return;
    this.pistonSelected = ahead;
    this.pistonAll = false;
    this.pistonBank.sync(this.pistons, ahead, false);
    this.emitHud();
  }

  private stepPistons(dt: number): void {
    const rig = this.pistons;
    rig.step(dt);
    this.pistonBank.sync(rig, this.pistonSelected, this.pistonAll);
    if (rig.takeHit()) {
      _bn.copy(rig.hitNormal).negate();
      if (this.clock.phase === "approach") this.beginCinematic(rig.hitPoint, _bn, rig.hitClosing);
      else this.sparks.poof(rig.hitPoint, _bn, Math.max(10, (24 * this.fxDensity) | 0));
    }
    if (this.elapsedWall < this.pistonFxAt) return;
    for (const h of rig.heads) {
      if (!h.touching) continue;
      this.pistonFxAt = this.elapsedWall + 0.15;
      const s = h.face(rig.honey) + h.pad;
      _bp.set(h.ax + h.nx * s, PISTON.faceY, h.az + h.nz * s);
      _bn.set(-h.nx, 0.35, -h.nz).normalize();
      this.sparks.poof(_bp, _bn, Math.max(6, (12 * this.fxDensity) | 0));
      break;
    }
  }

  private stepDoors(dt: number): void {
    const rig = this.doorRig;
    const was = rig.phase;
    this.carA.integrate(dt);
    rig.step(dt);
    this.doorRam.sync(rig);
    if (rig.touched && !this.doorFx) {
      this.doorFx = true;
      rig.centre(_bp);
      _bp.z += rig.lane.dir * RAM.length * 0.5;
      _bn.set(0, 0.35, -rig.lane.dir).normalize();
      this.sparks.poof(_bp, _bn, Math.max(6, (14 * this.fxDensity) | 0));
    }
    if (was !== "idle" && rig.phase === "idle") {
      this.doorShot = rig.result();
      // The shot is over, and so is fireDoorRam's slow-mo.
      if (this.clock.userTimeScale == null) this.clock.targetScale = 1;
      this.emitHud();
    }
  }

}

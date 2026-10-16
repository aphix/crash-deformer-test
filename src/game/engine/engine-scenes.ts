import * as THREE from "three";
import { beginFakeFall, DeformableCar } from "../vehicle/car.ts";
import { BOOST } from "../vehicle/car-drive.ts";
import { COMPACTOR } from "../scenes/compactor.ts";
import { KPH_PER_MS } from "../kernel/constants.ts";
import { PISTON_ORBIT_RATE, pistonBearing } from "../present/engine-pistons.ts";
import { VAPOR_DEPTH, edgeAction, fleetEmptied, layoutFleet, layoutDerby, respawnSlot } from "../scenes/fleet.ts";
import { RANGE } from "../scenes/range.ts";
import { LAB_PRESET } from "../scenes/constants.ts";
import { makeRangeArt } from "../present/range-art.ts";
import { LAB_LIGHT, LabArt } from "../present/lab-art.ts";
import { LabFlick } from "./lab-flick.ts";
import { Garage } from "./garage.ts";
import { GARAGE } from "../present/garage-art.ts";
import { pickedLook } from "../present/driver-look.ts";
import type { LabPresetId } from "../scenes/lab.ts";
import { CORKSCREW } from "../scenes/corkscrew.ts";
import { stackShot } from "../scenes/stack-rig.ts";
import { activeGround, DISC_GROUND, setGround } from "../world/ground.ts";
import { armSolids } from "../world/surfaces.ts";
import { type ContactHit, scatterRampBalls } from "../scenes/engine-props.ts";
import { foldPole, RIG_BALL_FIRST, RIG_POLE_FIRST, shatterBall } from "../scenes/rig-solids.ts";
import { propContact, sideContact, type PropHits } from "../contact/prop-contact.ts";
import { DERBY_RADIUS } from "../scenes/derby-arena.ts";
import { DERBY_FREE_PROPS } from "../scenes/derby-ground.ts";
import type { RaceCommand } from "../match/types.ts";
import { SOLO_SCENES, type SceneId } from "../scenes/scene-id.ts";
import { mulberry32 } from "../world/placements.ts";
import { celStrength } from "../present/scene-fade.ts";
import { EngineDerby } from "./engine-derby.ts";
import type { DerbyCarFlag } from "../match/derby.ts";
import { aimLabShot, LAB_FOV, LAB_SHOT } from "./lab-shot.ts";
import { detSin, detCos } from "../kernel/physics-core.js";
import { layOnGround } from "../vehicle/car-air-points.ts";
import type { MinigameMode } from "../scenes/minigame-constants.ts";
import { HIGH_JUMP_LENS_DEGREES } from "./engine-minigame.ts";

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

/** Race commands a netplay client may run: viewing only (the host starts, pauses and ends races). */
const CLIENT_RACE_COMMANDS: ReadonlySet<RaceCommand["type"]> = new Set(["fullUi", "cycle", "watch", "spectate"]);

export abstract class EngineScenes extends EngineDerby {
  /** The corkscrew's car this run: not yet flown, in the air, or down again (`EngineRigs.watchCorkscrew`). */
  protected corkFlight: "ground" | "air" | "down" = "ground";

  /** The fleet props are the host's (netplay), and ignored while the press, a rig, the range, the Lab or the race owns the pad (the HUD locks them too). */
  private get fleetPropsLocked(): boolean {
    return this.net.client || this.rigScene || this.showRange || this.showLab || this.showGarage || this.race.active;
  }

  toggleBarrier(): void {
    if (this.fleetPropsLocked) return;
    this.showBarrier = !this.showBarrier;
    if (this.derbyMode) {
      this.setDerby(false);
      this.randomizeAndReset();
    } else {
      this.barrier.group.visible = this.showBarrier;
      if (this.showBarrier && this.showRamps) {
        this.barrier.yaw = this.ramps.group.rotation.y;
        this.barrier.group.rotation.y = this.barrier.yaw;
      } else if (this.showBarrier) this.barrier.orient(this.carA.group.position);
      this.ramps.place(this.barrier.yaw, this.showBarrier ? this.barrier : null);
    }
    this.tryUnlockAudio();
    this.emitHud();
  }

  toggleBalls(): void {
    if (this.fleetPropsLocked) return;
    this.showBalls = !this.showBalls;
    if (this.derbyMode) {
      this.setDerby(false);
      this.randomizeAndReset();
    } else {
      scatterRampBalls(this.balls, this.showBalls, this.sceneRng(1));
    }
    this.tryUnlockAudio();
    this.emitHud();
  }

  toggleRamps(): void {
    if (this.fleetPropsLocked) return;
    this.showRamps = !this.showRamps;
    if (this.derbyMode) {
      this.setDerby(false);
      this.randomizeAndReset();
    } else {
      if (!this.showBarrier) this.barrier.orient(this.carA.group.position, true);
      this.ramps.place(this.barrier.yaw, this.showBarrier ? this.barrier : null);
      this.ramps.group.visible = this.showRamps;
      setGround(this.showRamps ? this.ramps : DISC_GROUND);
    }
    this.tryUnlockAudio();
    this.emitHud();
  }

  /** Off for probes and scripts that read the new scene right after a toggle; the shared link, the net and the boot never fade (`applyScene`). */
  fadeScenes = true;
  private veilBlack = 0;

  /** Scene picker (HUD, keys): every pick goes through here; picking the scene in play (or on its way) goes back to the fleet. The switch waits for the transition's black frame, and a pick mid-transition retargets it. */
  protected setScene(next: SceneId): void {
    // A room refuses the single-player scenes; a public room, which runs the race or derby its name says, refuses Survival too (a private room's host may run it as a team). A host in the lobby picks its game in the session panel, not here.
    if (this.net.client || this.net.status().gate !== null || (this.net.role !== "off" && (SOLO_SCENES[next] || (next === "survival" && this.net.status().public !== null)))) return;
    if (next === (this.sceneFade.pending ?? this.sceneId)) next = "fleet";
    if (this.fadeScenes && !this.warming) {
      this.sceneFade.request(next);
      this.emitHud();
    } else this.applyScene(next, true);
  }

  protected stepSceneFade(wallDt: number): void {
    const fade = this.sceneFade;
    // The Lab and the garage are single player: a room (hosted or joined) takes the player back to the fleet. So does a guest's own Survival run: a hosted one is the host's.
    if ((SOLO_SCENES[this.sceneId] || (this.sceneId === "survival" && this.net.client && !this.race.mirrored)) && this.net.role !== "off") {
      this.setRace(false);
      if (this.showLab || this.showGarage) {
        this.sceneId = "fleet";
        this.ensureCars(this.sandboxCars);
        this.followSceneTypes();
      }
      this.randomizeAndReset();
      this.emitHud();
    }
    // The canvas-only tiers have no cel pass: they fade to black and back alone.
    const calm = this.clock.reduceMotion || this.cine.tier === "off" || this.cine.tier === "minimal";
    const next = fade.frame(wallDt, calm, this.warmsInFlight > 0);
    if (next !== null) this.applyScene(next, true);
    this.cine.post.cel = celStrength(this.celLook, fade.cel);
    // Black is a DOM veil over the canvas and the HUD at every tier; written only while it changes.
    if (fade.black !== this.veilBlack) {
      this.veilBlack = fade.black;
      this.veil.style.opacity = fade.black > 0 ? String(fade.black) : "";
    }
  }

  /** `menu`: the player picked the scene (bar, key): Survival opens its course menu first. A `#` (`engine-share.ts`) starts the run at once, as every other scene starts. */
  protected applyScene(next: SceneId, menu = false): void {
    if (this.net.client) return;
    this.endMinigames();
    // A new scene is a new place: the free eye, left where the last one was, would hang in the new one's walls or sky.
    this.view.leaveFree();
    // The range and the garage are one-car scenes: the sandbox's field comes back after them (the range's wall is its own, never the user's).
    // The stack and the Lab run their own car counts and give the sandbox's back.
    const wasLab = this.showLab;
    const wasGarage = this.showGarage;
    if (this.showRange || this.showStack || this.showLab || this.showGarage) this.ensureCars(this.sandboxCars);
    if (this.race.active && next !== this.sceneId) this.setRace(false);
    // The workshop's lights go with the Lab and the garage, before a race lights its course.
    if ((wasLab && next !== "lab") || (wasGarage && next !== "garage")) this.stage.look(null);
    if (this.derbyMode !== (next === "derby")) this.setDerby(next === "derby");
    if (next === "range" || next === "stack" || next === "lab" || next === "garage") {
      this.sandboxCars = this.carCount;
      this.ensureCars(next === "range" || next === "garage" ? 1 : next === "lab" ? this.lab.types.length : this.stack.config.cars);
    }
    if (next === "race" || next === "survival") this.setRace(true, next === "survival", false, next === "survival" && menu && this.net.role === "off");
    else this.sceneId = next;
    this.followSceneTypes();
    this.tryUnlockAudio();
    this.randomizeAndReset();
    // Frame only on entering: re-parks and loop hops keep the user's view and the orbit running. The camera
    // starts 1.2 s of orbit short of the front-right ram so the first synced shot comes from its side.
    if (next === "pistons") this.view.frameReset(true, this.live(), pistonBearing(2) - PISTON_ORBIT_RATE * 1.2);
    if (next === "stack") this.frameStack();
    if (next === "lab") {
      this.stage.look(LAB_LIGHT);
      this.view.setLens(LAB_FOV);
      this.frameLab();
    } else if (wasLab) this.view.setLens(null);
    if (next === "garage") {
      this.stage.look(LAB_LIGHT);
      this.view.frameReset(true, this.live(), GARAGE.angle, GARAGE.shot);
    }
    this.emitHud();
  }

  toggleCompactor(): void {
    this.setScene("press");
  }

  togglePistons(): void {
    this.setScene("pistons");
  }

  toggleDoors(): void {
    this.setScene("doors");
  }

  toggleRange(): void {
    this.setScene("range");
  }

  toggleLab(): void {
    this.setScene("lab");
  }

  toggleGarage(): void {
    this.setScene("garage");
  }

  setLabPreset(id: LabPresetId): void {
    if (!this.showLab || this.lab.preset === id) return;
    this.lab.load(id);
    this.ensureCars(this.lab.types.length);
    this.retypeCars();
    this.randomizeAndReset();
    this.frameLab();
    this.emitHud();
  }

  /** The Range's HUD pick: play `mode` (or switch to it): its station, the player's car parked on the hilltop, a fresh first attempt. */
  startMinigame(mode: MinigameMode): void {
    if (!this.showRange || this.net.client) return;
    if (this.minigames.begin({ mode, carType: this.playerCar.id, scene: this.scene, cars: this.cars, ejection: this.ejection })) this.queueWarm();
    this.view.setLens(mode === "highJump" ? HIGH_JUMP_LENS_DEGREES : null);
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

  /** The minigame over (leaving the Range, or Exit): the dummy, boxes, art and the High jump's wide lens go. */
  private endMinigames(): void {
    if (this.minigames.mode === null) return;
    this.minigames.end(this.ragdolls);
    this.view.setLens(null);
  }

  /** The scene resets (the car to its start, the dummy and the boxes released and restacked, the camera back on the car) and the HUD follows. */
  private restartMinigameAttempt(): void {
    this.view.leaveFree();
    this.randomizeAndReset();
    this.emitHud();
  }

  protected readonly labLook = new THREE.Vector3();
  protected labUpright = false;

  protected frameLab(): void {
    const from = this.lab.centre(0, _v);
    const f = this.lab.focus;
    const upright = this.camera.aspect < 1;
    this.labUpright = upright;
    const shot = upright ? LAB_SHOT.upright : LAB_SHOT.wide;
    const short = !upright && this.canvas.clientHeight <= LAB_SHOT.wide.shortPx;
    const look = this.labLook;
    const bearing = aimLabShot(from, f, shot, short, look);
    let radius = LAB_SHOT.upright.radius;
    if (!upright) {
      // The farthest item off the look point across the screen (along the camera's right), and the distance that fits it.
      let span = 0;
      for (let k = 0; k < this.lab.layout.length; k++) {
        this.lab.centre(k, _w).sub(look);
        span = Math.max(span, Math.abs(_w.x * detCos(bearing) - _w.z * detSin(bearing)));
      }
      radius = (span + LAB_SHOT.wide.fit) / (Math.tan(THREE.MathUtils.degToRad(LAB_FOV) / 2) * this.camera.aspect);
      look.y = Math.min(look.y, from.y + LAB_SHOT.wide.low * radius * Math.tan(THREE.MathUtils.degToRad(LAB_FOV) / 2));
    }
    this.view.frameReset(true, this.live(), bearing, { lookX: look.x, lookY: look.y, lookZ: look.z, radius, pitch: shot.pitch });
  }

  /** A flick let go (`LabFlick`, or the `?bench=lab` page's throws): the thing leaves at `velocity`, and the crash starts over so the slow-mo and the crash cam catch its hit. */
  flickLab(thing: number, velocity: THREE.Vector3): void {
    this.restartCrash();
    this.view.userFramed = false;
    this.lab.launch(thing, velocity);
    this.tryUnlockAudio();
    this.emitHud();
  }

  toggleCorkscrew(): void {
    this.setScene("corkscrew");
  }

  toggleSurvival(): void {
    this.setScene("survival");
  }

  toggleStack(): void {
    this.setScene("stack");
  }

  toggleDerby(): void {
    this.setScene("derby");
  }

  toggleRace(): void {
    this.setScene("race");
  }

  /** HUD → race. The HUD never touches race state itself. A netplay client only views: the host runs the race. */
  raceCommand(cmd: RaceCommand): void {
    if (this.reelCommand(cmd)) {
      this.emitHud();
      return;
    }
    if (this.net.client && !CLIENT_RACE_COMMANDS.has(cmd.type)) return;
    this.race.command(cmd);
    this.emitHud();
  }

  /** The results reel's commands (this browser only: true when handled); a command leaving the results stops the reel first. */
  protected abstract reelCommand(cmd: RaceCommand): boolean;
  /** Stop the results reel or a solo view now, giving the cars back as they were. */
  protected abstract stopReel(): void;

  protected requestRespawn(): void {
    if (this.net.client) this.net.requestRespawn();
    else this.race.requestRespawn();
  }

  protected requestHoldReset(): void {
    if (this.net.client) this.net.requestHoldReset();
    else this.race.holdReset();
  }

  protected setRace(on: boolean, survival = false, lobby = false, menu = false): void {
    if (on === this.race.active) return;
    if (on) {
      if (this.derbyMode) this.setDerby(false);
      this.sceneId = survival ? "survival" : "race";
      this.barrier.group.visible = false;
      this.ramps.group.visible = false;
      scatterRampBalls(this.balls, false, this.sceneRng(1));
      this.press.group.visible = false;
      this.pistonBank.group.visible = false;
      this.doorRam.group.visible = false;
      this.corkscrew.group.visible = false;
      if (this.clock.userTimeScale == null) {
        this.clock.timeScale = 1;
        this.clock.targetScale = 1;
      }
      this.sandboxCars = this.carCount;
    }
    for (const o of this.studio) o.visible = !on;
    for (const p of this.poles) p.group.visible = !on;
    if (on) {
      // The seats first: a Survival run starts at `enter`, with whoever is seated.
      this.race.setSeats(this.netSeats);
      this.race.enter(survival, lobby, menu);
    } else {
      this.stopReel();
      this.sceneId = "fleet";
      this.race.exit();
      this.ensureCars(this.sandboxCars);
    }
  }

  /** One stream of the run's seeded picks per `salt`: the fleet's spots and its balls draw apart, the same every time for a seed. */
  private sceneRng(salt: number): () => number {
    return mulberry32(this.sceneSeed + salt);
  }

  protected randomizeAndReset(): void {
    // A new run rolls a new seed (24 bits: up to six hex digits in the share URL) unless a pasted URL pinned one.
    this.sceneSeed = this.pinnedSeed ?? Math.floor(Math.random() * 0x1000000);
    // Under the fade's black or not, every transition, loop and reset empties the last scene here, before the scene spawns its cars.
    this.clearScene();
    this.compactor.face = COMPACTOR.startFace;
    this.compactFxAt = 0;
    // Built on first entry, not at boot: its programs link with this switch (`queueWarm`), never in the boot warm-up.
    if (this.showRange && !this.rangeArt) {
      this.rangeArt = makeRangeArt();
      this.scene.add(this.rangeArt);
      this.queueWarm();
    }
    if (this.rangeArt) this.rangeArt.visible = this.showRange && this.minigames.rangeArtShown;
    this.minigames.showArt(this.showRange);
    this.ragdolls.sand = this.showRange;
    if (this.showLab && !this.labArt) {
      this.labArt = new LabArt();
      this.labFlick = new LabFlick(this.camera, () => this.canvas.getBoundingClientRect(), this.lab, (thing, velocity) => this.flickLab(thing, velocity));
      this.scene.add(this.labArt.group);
      this.queueWarm();
    }
    if (this.labArt) this.labArt.group.visible = this.showLab;
    if (this.showGarage && !this.garage) {
      this.garage = new Garage(this.camera, () => this.canvas.getBoundingClientRect(), () => this.cars[0], this.looks, () => this.emitHud());
      this.scene.add(this.garage.art.group);
      this.queueWarm();
    }
    if (this.garage) this.garage.art.group.visible = this.showGarage;
    // In the Lab a press on a car picks it for a flick, in the garage it sprays it (can on); elsewhere every press is the camera's.
    this.view.take = this.showLab ? this.labFlick : this.showGarage ? this.garage : null;
    if (this.race.active) {
      this.race.reset();
      this.finishResetCommon();
      return;
    }
    setGround(this.showCorkscrew ? this.corkscrew : this.showLab ? this.lab.ground : this.derbyMode ? this.derbyGround : this.showRange ? this.minigames.groundInPlay : this.rigScene || this.showGarage ? null : this.showRamps ? this.ramps : DISC_GROUND);
    armSolids(this.showLab ? this.lab.prisms : this.rigs);
    this.stage.ground.scale.setScalar(this.showCorkscrew ? 3 : 1);
    for (const o of this.studio) o.visible = !this.showLab && !this.showGarage && !this.derbyMode && this.minigameMode === null;
    // A rig owns its car (the press and rams move it, the corkscrew's spawn speed coasts it): a reset hands it back from the driver, whose pedals would unpark it and brake the run.
    if (this.rigScene && !this.showStack && this.seat.mode === "drive") {
      this.seat.esc();
      this.emitHud();
    }
    if (this.showCompactor) {
      this.parkCompactor();
      this.finishResetCommon();
      return;
    }
    if (this.showPistons) {
      this.parkPistons();
      this.finishResetCommon();
      return;
    }
    if (this.showDoors) {
      this.parkDoors();
      this.finishResetCommon();
      return;
    }
    if (this.showCorkscrew) {
      this.parkCorkscrew();
      this.finishResetCommon();
      return;
    }
    if (this.showStack) {
      this.parkStack();
      this.finishResetCommon();
      return;
    }
    this.press.group.visible = false;
    this.pistonBank.group.visible = false;
    this.doorRam.group.visible = false;
    this.corkscrew.group.visible = false;
    if (this.derbyMode) this.spawnDerby();
    else if (this.showRange) this.spawnRange();
    else if (this.showLab) this.spawnLab();
    else if (this.showGarage) this.spawnGarage();
    else this.spawnFleet();
    this.barrierHits.fill(false);
    this.barrier.group.visible = this.barrierUp;
    // With the ramps up the slab lies end-on to the lead car, so the jump runs along its line (owner's sketch).
    if (this.barrierUp || this.rampsUp) this.barrier.orient(this.carA.group.position, this.rampsUp);
    this.ramps.group.visible = this.rampsUp;
    this.ramps.place(this.barrier.yaw, this.barrierUp ? this.barrier : null);
    scatterRampBalls(this.balls, this.ballsUp, this.sceneRng(1));
    for (const p of this.poles) p.group.visible = !this.derbyMode && !this.showRange && !this.showLab && !this.showGarage;
    this.finishResetCommon();
  }

  private spawnFleet(): void {
    const cars = this.live();
    const slots = layoutFleet(cars.length, this.speedMin, this.speedMax, this.sceneRng(0));
    for (let i = 0; i < cars.length; i++) {
      const slot = slots[i]!;
      const car = cars[i]!;
      car.group.visible = true;
      car.spawn(slot.x, slot.z, slot.speed);
      this.dressCar(car);
    }
    this.parkExtras();
  }

  private parkExtras(): void {
    for (let i = this.carCount; i < this.cars.length; i++) {
      const extra = this.cars[i]!;
      extra.group.visible = false;
      extra.group.position.set(80 + i * 6, 0, 80);
      extra.velocity.set(0, 0, 0);
    }
  }

  private spawnLab(): void {
    if (this.labArt) this.lab.tumble = this.labArt.show(this.lab.preset ?? LAB_PRESET.cards);
    const cars = this.live();
    this.lab.placeCars(cars);
    for (const car of cars) {
      car.group.visible = true;
      this.dressCar(car);
    }
    this.parkExtras();
  }

  /** Car A on the range's run-up at speed, aimed down +x at the barrier on the origin (the wall, balls and ramps are the scene's: `SCENE_PROPS`). A minigame parks it at its station's start instead. */
  private spawnRange(): void {
    const car = this.carA;
    car.group.visible = true;
    if (this.minigameMode !== null) {
      this.parkAtMinigameStart(car);
      return;
    }
    car.spawnFacing(-RANGE.run, 0, Math.PI / 2, RANGE.kph / KPH_PER_MS);
    this.dressCar(car);
  }

  /** The minigame's attempt begins: the car stands parked on its station's hilltop, the seat only following it (the first pedal press promotes it to driving), the dummy to live until released and the boxes to stand. */
  private parkAtMinigameStart(car: DeformableCar): void {
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

  private spawnGarage(): void {
    const car = this.carA;
    car.group.visible = true;
    car.spawnFacing(0, 0, 0, 0);
    this.dressCar(car);
    this.garage!.art.stand(pickedLook(GARAGE.driver, this.looks.mine.person), this.looks.mine.personSpray);
    this.parkExtras();
  }

  private spawnDerby(): void {
    // Network peers' cars join when a match begins (one seated mid-match waits for this): the field grows to hold them.
    let need = this.carCount;
    for (const i of this.netSeats.keys()) need = Math.max(need, i + 1);
    if (need > this.carCount) this.ensureCars(need);
    this.derbySeated = new Set(this.netSeats.keys());
    this.derbyRound++;
    const cars = this.live();
    const slots = layoutDerby(cars.length, DERBY_RADIUS, this.sceneRng(0), DERBY_FREE_PROPS);
    this.derby.begin(
      cars.map((c, i) => ({ id: i, name: this.netSeats.get(i) ?? c.paint.name })),
      { radius: DERBY_RADIUS },
    );
    this.winnerSpot.off();
    for (let i = 0; i < cars.length; i++) {
      const slot = slots[i]!;
      const car = cars[i]!;
      car.group.visible = true;
      car.spawnFacing(slot.x, slot.z, slot.yaw, 0);
      this.dressCar(car);
    }
    this.parkExtras();
    this.arena.visible = true;
    for (const p of this.poles) p.group.visible = false;
  }

  private parkSolo(): DeformableCar {
    this.ensureCars(Math.max(this.carCount, 1));
    const parked = this.carA;
    parked.group.visible = true;
    parked.yaw = 0;
    parked.pitch = 0;
    parked.roll = 0;
    parked.group.position.set(0, 0, 0);
    parked.group.rotation.set(0, 0, 0, "YXZ");
    parked.group.quaternion.identity();
    parked.velocity.set(0, 0, 0);
    parked.angular.set(0, 0, 0);
    parked.crashed = false;
    parked.speed = 0;
    parked.spawnSpeed = 0;
    parked.parked = true;
    parked.refreshBasis();
    this.dressCar(parked);
    parked.deform.bindKinematic(parked.group, parked.velocity, parked.angular);

    for (let i = 1; i < this.cars.length; i++) {
      const extra = this.cars[i]!;
      extra.group.visible = false;
      extra.group.position.set(48 + i * 4, 0, 48);
      extra.velocity.set(0, 0, 0);
    }

    this.barrier.group.visible = false;
    this.ramps.group.visible = false;
    this.barrierHits.fill(false);
    for (const b of this.balls) b.mesh.visible = false;
    // The corkscrew's run passes through two of the lamp posts' spots.
    for (const p of this.poles) p.group.visible = !this.showCorkscrew;
    this.press.group.visible = false;
    this.pistonBank.group.visible = false;
    this.doorRam.group.visible = false;
    this.corkscrew.group.visible = false;
    return parked;
  }

  private parkCompactor(): void {
    const parked = this.parkSolo();
    this.compactor.attach(parked);
    this.press.group.visible = true;
    this.press.sync(this.compactor.face);
  }

  private parkPistons(): void {
    const parked = this.parkSolo();
    this.pistonFired = false;
    this.pistonFxAt = 0;
    this.pistons.attach(parked);
    this.pistonBank.group.visible = true;
    this.pistonBank.sync(this.pistons, this.pistonSelected, this.pistonAll);
  }

  private parkDoors(): void {
    const parked = this.parkSolo();
    this.doorRig.attach(parked);
    this.doorShot = null;
    this.doorFx = false;
    this.doorRam.group.visible = true;
    this.doorRam.sync(this.doorRig);
  }

  /** One car lined up 6 m short of the corkscrew's mouth at a spawn-slider speed: the speed decides the stunt. */
  private parkCorkscrew(): void {
    const car = this.parkSolo();
    car.spawnFacing(0, CORKSCREW.mouthZ - 6, 0, layoutFleet(1, this.speedMin, this.speedMax, this.sceneRng(0))[0]!.speed);
    this.dressCar(car);
    this.corkFlight = "ground";
    this.corkscrew.group.visible = true;
  }

  /** The base car alone at the origin; the rest wait upright out of the way, each to fall in turn (`stepStack`). */
  private parkStack(): void {
    this.parkSolo();
    this.stack.restart();
    for (let i = 1; i < this.carCount; i++) this.cars[i]!.spawnFacing(48 + i * 4, 48, 0, 0);
  }

  /** Height the stack's orbit looks at, eased: the middle of the tallest car's roof (the rest of the pile follows a topple down). */
  private stackEye = 0;
  private stackPortrait = false;

  /** The stack's opening shot: far enough back for the finished tower (`stackShot`), further on a portrait screen, looking at the base car. */
  protected frameStack(): void {
    const shot = stackShot(this.stack.config.cars);
    this.stackPortrait = this.camera.aspect < 1;
    if (this.stackPortrait) shot.radius = Math.min(32, shot.radius * 1.3);
    this.stackEye = shot.lookY;
    this.view.frameReset(true, this.live(), undefined, shot);
  }

  /** Height the stack's orbit looks at this frame; a screen that turned portrait (or back) before the user touched the view is framed again. */
  protected stackLookY(wallDt: number): number {
    if (this.camera.aspect < 1 !== this.stackPortrait && !this.view.userFramed) this.frameStack();
    let top = 0;
    const cars = this.live();
    for (let i = 0; i < cars.length; i++) top = Math.max(top, cars[i]!.group.position.y);
    this.stackEye += ((top + 1.3) / 2 - this.stackEye) * (1 - Math.exp(-3 * wallDt));
    return this.stackEye;
  }

  private restartCrash(): void {
    this.clock.phase = "approach";
    if (this.clock.userTimeScale != null) {
      this.clock.timeScale = this.clock.userTimeScale;
      this.clock.targetScale = this.clock.userTimeScale;
    } else {
      this.clock.timeScale = 1;
      this.clock.targetScale = 1;
    }
    this.clock.wallSinceImpact = 0;
    this.clock.slomoAt = 0;
    this.clock.preImpactBy = NaN;
    this.impactKph = null;
    this.fxPoofed = false;
  }

  private finishResetCommon(): void {
    this.restartCrash();
    this.audio.releaseVoices();
    this.elapsedWall = 0;
    this.elapsedSim = 0;
    this.impactLightLife = 0;
    this.impactLight.intensity = 0;

    this.view.rim = this.derbyMode ? DERBY_RADIUS : Infinity;
    // The pistons, the stack, the Lab and the garage frame on entering only (`applyScene`): their resets keep the user's view.
    if (!this.showPistons && !this.showStack && !this.showLab && !this.showGarage) this.view.frameReset(this.showCompactor || this.showDoors, this.live());
    this.smokeUntil.fill(0);
    this.deadSmokeAcc.length = 0;
    this.vaporAt.length = 0;
    this.sparkAt = -10;
    this.barrier.reset();
    this.trace.setupCopied = false;
    this.trace.snapshotInitial(this.traceSetup(), this.live());
    if (this.captureTrace) this.beginTrace();
    else this.trace.clear();
  }

  /** Derby hit credit: how hard each car drove into the other along the contact normal. */
  protected readonly derbyHit = (a: number, b: number, hit: ContactHit): void => {
    const ca = this.world.cars[a]!;
    const cb = this.world.cars[b]!;
    const n = hit.normal;
    this.derby.noteHit(a, b, -(ca.velocity.x * n.x + ca.velocity.z * n.z), cb.velocity.x * n.x + cb.velocity.z * n.z, hit.impulse);
  };

  /** A derby car's footprint against the arena's prisms: the wall, the containers, the rails, the pads and the tyre berms (`derbyGround.contact`); the rises are the ground itself. */
  protected readonly derbyCollide = (car: DeformableCar, i: number, h: number): void => this.derbyGround.contact(car, i, this.derbyHits, h);

  private readonly derbyHits: PropHits = {
    knock: () => {},
    fx: (at, n, closing) => {
      this.debris.burst(at, n, Math.min(48, 10 + closing) * this.fxDensity);
      this.sparks.poof(at, n, Math.min(28, 6 + closing * 0.5) * this.fxDensity);
    },
    wall: (_index, i, closing) => this.noteHit(i, closing),
  };

  protected readonly raceCollide = (car: DeformableCar, i: number, h: number): void => this.race.collide(car, i, h);

  private readonly rampHits: PropHits = {
    knock: () => {},
    fx: () => {},
    wall: (_index, i, closing, x, z, nx, nz) => {
      this.noteHit(i, closing);
      this.world.strongest.offer({ impulse: Math.max(closing, 0.5), contact: new THREE.Vector3(x, 0.4, z), normal: new THREE.Vector3(nx, 0, nz) });
    },
  };

  protected readonly rampCollide = (car: DeformableCar, _i: number, h: number): void => {
    this.ramps.sync();
    sideContact(car, this.ramps, this.rampHits, h);
  };

  /** Car `i` against the fleet's rigs: the ramps' sides while they are up, and the lamp posts and ramp balls (prisms of `rigs`, met by the one prop rule). */
  protected readonly rigCollide = (car: DeformableCar, i: number, h: number): void => {
    if (this.rampsUp) this.rampCollide(car, i, h);
    propContact(car, i, this.rigs, this.rigKnocked, this.rigHits, h);
  };

  /** What the fleet's rig prisms do when a car meets them: a lamp post folds over, a ramp ball shatters from `BALL_BREAK_CLOSING` m/s, any hit has its sparks and debris. */
  private readonly rigHits: PropHits = {
    knock: (index, _car, vx, _vy, vz) => foldPole(this.poles[index - RIG_POLE_FIRST]!, vx, vz),
    fx: (at, n, closing) => {
      this.debris.burst(at, n, Math.min(48, 10 + closing) * this.fxDensity);
      this.sparks.poof(at, n, Math.min(28, 6 + closing * 0.5) * this.fxDensity);
    },
    wall: (index, carIndex, closing, x, z, nx, nz) => {
      this.noteHit(carIndex, closing);
      this.world.strongest.offer({ impulse: Math.max(closing, 0.5), contact: new THREE.Vector3(x, 0.4, z), normal: new THREE.Vector3(nx, 0, nz) });
      if (index < RIG_BALL_FIRST || !shatterBall(this.balls[index - RIG_BALL_FIRST]!, this.world.cars[carIndex]!, closing)) return;
      this.trace.ballHits.push({ t: this.elapsedWall, ball: index - RIG_BALL_FIRST, closing, broken: true });
    },
  };

  protected syncRigs(): void {
    this.rigs.syncSlab(this.barrierUp ? this.barrier : null);
    this.rigs.syncPoles(this.poles, this.rigKnocked);
    this.rigs.syncBalls(this.balls, this.ballsUp);
  }

  protected readonly corkCollide = (car: DeformableCar): void => this.corkscrew.contact(car);

  protected stepDerby(dt: number): void {
    if (!this.derbyMode) return;
    const cars = this.live();
    // A netplay client shows the host's match (applyNetDerby) and never steps its own.
    const status = this.net.client ? "running" : this.derby.step(dt, this.derbyFlags(cars));
    const winId = this.derby.winnerId;
    const champ = winId == null ? undefined : cars[winId];
    if (champ) this.winnerSpot.follow(champ.group.position.x, champ.group.position.z);
    else this.winnerSpot.off();
    if (status === "loop" && this.looping) this.randomizeAndReset();
  }

  /** A takedown's boost for attacker `id`: the seat's meter when the player drives that car, else the derby AI's. */
  protected takedownBoost(id: number): void {
    if (id === this.seat.carIndex && this.seat.mode === "drive") this.seat.addBoost(BOOST.takedown);
    else this.derby.brain.addBoost(id, BOOST.takedown);
  }

  private readonly derbyFlagPool: DerbyCarFlag[] = [];
  private derbyFlags(cars: readonly DeformableCar[]): readonly DerbyCarFlag[] {
    const flags = this.derbyFlagPool;
    while (flags.length < cars.length) flags.push({ id: flags.length, name: "", alive: true, x: 0, z: 0 });
    flags.length = cars.length;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i]!;
      const f = flags[i]!;
      f.name = c.paint.name;
      f.alive = c.deform.drivetrainAlive;
      f.x = c.group.position.x;
      f.z = c.group.position.z;
    }
    return flags;
  }

  /** Fleet disc, once per frame after physics: `edgeAction` fakes, vaporizes or respawns a car; a falling fake shrinks over its last 4 m (also on a netplay client, which mirrors the host's events). */
  protected stepEdge(): void {
    if (activeGround() !== DISC_GROUND && activeGround() !== this.ramps) return;
    const cars = this.live();
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i]!;
      if (car.falling) car.group.scale.setScalar(0.2 + 0.8 * THREE.MathUtils.clamp((car.group.position.y + VAPOR_DEPTH) / 4, 0, 1));
      if (this.net.client) continue;
      // Driven here or by a network peer: either comes back after vaporizing.
      const driven = (i === this.seat.carIndex && this.seat.mode === "drive") || this.net.remoteCar(i);
      const act = edgeAction(car.group.position.y, car.falling, car.vaporized, driven, this.elapsedWall - (this.vaporAt[i] ?? 0));
      if (act === "fake") beginFakeFall(car);
      else if (act === "vaporize") this.setVaporized(i, true);
      else if (act === "respawn") this.respawnOnDisc(i);
    }
    // No hit ever ends the run once every car has driven off the rim: the loop's own reset (`updatePhase`) waits on a crash.
    if (this.looping && !this.net.client && !this.showLab && !this.showGarage && fleetEmptied(cars, this.vaporAt, this.elapsedWall)) this.randomizeAndReset();
  }

  /** Car `i` bursts into smoke and leaves the sim (`on`): hidden, repaired and frozen where it vanished; `off` puts it back as it stands. A netplay client mirrors the host's flag through here. */
  setVaporized(i: number, on: boolean): void {
    const car = this.cars[i];
    if (!car || car.vaporized === on) return;
    if (on) {
      car.refreshBasis();
      const n = Math.max(8, (14 * this.fxDensity) | 0);
      for (const x of [-0.6, 0.6]) {
        for (const z of [-1.6, 0, 1.6]) this.smoke.vapour(car.group.localToWorld(_v.set(x, 0.6, z)), car.velocity, n);
      }
      car.resetVisual();
      car.vaporized = true;
      car.velocity.set(0, 0, 0);
      car.angular.set(0, 0, 0);
      this.vaporAt[i] = this.elapsedWall;
    } else {
      car.vaporized = false;
    }
    car.group.visible = !on && i < this.carCount;
    this.emitHud();
  }

  respawnOnDisc(i: number): void {
    const car = this.cars[i];
    if (!car) return;
    const others = this.live().filter((c) => c !== car && !c.vaporized).map((c) => c.group.position);
    const s = respawnSlot(car.group.position.x, car.group.position.z, others);
    car.spawnFacing(s.x, s.z, s.yaw, 0);
    car.group.visible = true;
    this.dressCar(car);
    this.emitHud();
  }
}

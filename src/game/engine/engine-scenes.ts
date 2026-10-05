import * as THREE from "three";
import { beginFakeFall, DeformableCar } from "../vehicle/car.ts";
import { BOOST } from "../vehicle/car-drive.ts";
import { separateSphereFromAabb } from "../deform/physics-util.ts";
import { COMPACTOR } from "../scenes/compactor.ts";
import { PISTON_ORBIT_RATE, pistonBearing } from "../present/engine-pistons.ts";
import { VAPOR_DEPTH, edgeAction, layoutFleet, layoutDerby, respawnSlot } from "../scenes/fleet.ts";
import { RANGE } from "../scenes/range.ts";
import { makeRangeArt } from "../present/range-art.ts";
import { CORKSCREW } from "../scenes/corkscrew.ts";
import { stackShot } from "../scenes/stack-rig.ts";
import { bounceGround, bounceOffCar } from "../present/engine-fx.ts";
import { activeGround, DISC_GROUND, NO_FLOOR, setGround } from "../world/ground.ts";
import { type ContactHit, resolveLampPoles, resolveRampBalls, scatterRampBalls } from "../scenes/engine-props.ts";
import { clipDerbyCar, DERBY_RADIUS, derbyRadius } from "../scenes/derby-arena.ts";
import type { DerbyNetState } from "../net/codec.ts";
import type { RaceCommand } from "../match/types.ts";
import { SOLO_SCENES, type SceneId } from "../scenes/scene-id.ts";
import { mulberry32 } from "../world/placements.ts";
import { celStrength } from "../present/scene-fade.ts";
import { EngineHud } from "./engine-hud.ts";
import type { DerbyCarFlag } from "../match/derby.ts";

const _v = new THREE.Vector3();

/** Race commands a netplay client may run: viewing only (the host starts, pauses and ends races). */
const CLIENT_RACE_COMMANDS: ReadonlySet<RaceCommand["type"]> = new Set(["fullUi", "cycle", "watch", "spectate"]);

/**
 * Scenes: switching between the fleet, the rigs, the derby and the race, resetting and spawning the field, the
 * derby's netplay mirror and the fleet disc's edge.
 */
export abstract class EngineScenes extends EngineHud {
  /** The corkscrew's car this run: not yet flown, in the air, or down again (`EngineRigs.watchCorkscrew`). */
  protected corkFlight: "ground" | "air" | "down" = "ground";

  toggleBarrier(): void {
    // A fleet prop: the host's (netplay), and ignored while the press, a rig, the range or the race owns the pad (the HUD locks it too).
    if (this.net.client || this.rigScene || this.showRange || this.race.active) return;
    this.showBarrier = !this.showBarrier;
    if (this.derbyMode) {
      // Out of the bowl like every scene switch: the reset brings back the disc ground, poles and fresh spots, and places the barrier.
      this.setDerby(false);
      this.randomizeAndReset();
    } else {
      this.barrier.group.visible = this.showBarrier;
      // With the ramps up the slab takes their line; alone it faces the lead car broadside.
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
    if (this.net.client || this.rigScene || this.showRange || this.race.active) return;
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

  /** The jump ramps on the slab's ends (`FleetRamps`): a fleet prop like the slab and the balls. */
  toggleRamps(): void {
    if (this.net.client || this.rigScene || this.showRange || this.race.active) return;
    this.showRamps = !this.showRamps;
    if (this.derbyMode) {
      this.setDerby(false);
      this.randomizeAndReset();
    } else {
      // On the slab's ends where it stands; alone, end-on to the lead car so it jumps them.
      if (!this.showBarrier) this.barrier.orient(this.carA.group.position, true);
      this.ramps.place(this.barrier.yaw, this.showBarrier ? this.barrier : null);
      this.ramps.group.visible = this.showRamps;
      setGround(this.showRamps ? this.ramps : DISC_GROUND);
    }
    this.tryUnlockAudio();
    this.emitHud();
  }

  /**
   * Whether a scene pick fades through the cel look and black (`SceneFade`). Probes and scripts that read the new
   * scene right after a toggle clear it; the shared link, the net and the boot never fade (`applyScene`).
   */
  fadeScenes = true;
  private veilBlack = 0;

  /**
   * Scene picker (HUD, keys): the one entry every pick goes through. Picking the scene in play (or on its way) goes
   * back to the fleet. The switch itself (`applyScene`) waits for the black frame of the transition, which is local
   * presentation only; a pick mid-transition retargets it.
   */
  protected setScene(next: SceneId): void {
    if (this.net.client || (SOLO_SCENES[next] && this.net.role !== "off")) return;
    if (next === (this.sceneFade.pending ?? this.sceneId)) next = "fleet";
    if (this.fadeScenes && !this.warming) {
      this.sceneFade.request(next);
      this.emitHud();
    } else this.applyScene(next);
  }

  /** Per wall frame: advances the transition, makes the switch on its black frame and feeds the cel pass and the veil. */
  protected stepSceneFade(wallDt: number): void {
    const fade = this.sceneFade;
    // Survival is single player: a room (hosted or joined) takes the player back to the fleet.
    if (SOLO_SCENES[this.sceneId] && this.net.role !== "off") {
      this.setRace(false);
      this.randomizeAndReset();
      this.emitHud();
    }
    // The canvas-only tiers have no cel pass: they fade to black and back alone.
    const calm = this.clock.reduceMotion || this.cine.tier === "off" || this.cine.tier === "minimal";
    const next = fade.frame(wallDt, calm, this.warmsInFlight > 0);
    if (next !== null) this.applyScene(next);
    this.cine.post.cel = celStrength(this.celLook, fade.cel);
    // Black is a DOM veil over the canvas and the HUD at every tier; written only while it changes.
    if (fade.black !== this.veilBlack) {
      this.veilBlack = fade.black;
      this.veil.style.opacity = fade.black > 0 ? String(fade.black) : "";
    }
  }

  /**
   * The switch itself: `next` replaces the scene in play. Leaves the race or the derby first, then resets the field.
   */
  protected applyScene(next: SceneId): void {
    if (this.net.client) return;
    // The range is a one-car scene: the sandbox's field comes back after it (its wall is the range's own, never the user's).
    if (this.showRange) this.ensureCars(this.sandboxCars);
    // The stack runs its own car count and gives the sandbox's back.
    if (this.showStack) this.ensureCars(this.sandboxCars);
    if (this.race.active && next !== this.sceneId) this.setRace(false);
    if (this.derbyMode !== (next === "derby")) this.setDerby(next === "derby");
    if (next === "range" || next === "stack") {
      this.sandboxCars = this.carCount;
      this.ensureCars(next === "range" ? 1 : this.stack.config.cars);
    }
    if (next === "race" || next === "survival") this.setRace(true, next === "survival");
    else this.sceneId = next;
    this.tryUnlockAudio();
    this.randomizeAndReset();
    // Frame only on entering: re-parks and loop hops keep the user's view and the orbit running. The camera
    // starts 1.2 s of orbit short of the front-right ram so the first synced shot comes from its side.
    if (next === "pistons") this.view.frameReset(true, this.live(), pistonBearing(2) - PISTON_ORBIT_RATE * 1.2);
    if (next === "stack") this.frameStack();
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

  toggleCorkscrew(): void {
    this.setScene("corkscrew");
  }

  /** Survival (docs/SURVIVAL.md): single player, on its own course. */
  toggleSurvival(): void {
    this.setScene("survival");
  }

  /** Stack (docs/LOAD_CRUSH.md): cars dropped one at a time onto a base car. */
  toggleStack(): void {
    this.setScene("stack");
  }

  toggleDerby(): void {
    this.setScene("derby");
  }

  protected setDerby(on: boolean): void {
    if (on) this.sceneId = "derby";
    else if (this.sceneId === "derby") this.sceneId = "fleet";
    this.arena.visible = on;
    for (const p of this.poles) p.group.visible = !on;
    if (on) {
      this.barrier.group.visible = false;
      this.ramps.group.visible = false;
      if (this.clock.userTimeScale == null) {
        this.clock.timeScale = 1;
        this.clock.targetScale = 1;
      }
    } else {
      this.derby.end();
      this.winnerSpot.off();
    }
  }

  /** Race scene on / off (scene picker, X). */
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

  /** R / D-pad down: back on the track (a netplay client asks the host). */
  protected requestRespawn(): void {
    if (this.net.client) this.net.requestRespawn();
    else this.race.requestRespawn();
  }

  protected setRace(on: boolean, survival = false): void {
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
      this.race.enter(survival);
      this.race.setSeats(this.netSeats);
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
    if (this.rangeArt) this.rangeArt.visible = this.showRange;
    this.ragdolls.sand = this.showRange;
    if (this.race.active) {
      this.race.reset();
      this.finishResetCommon();
      return;
    }
    // The fleet's ground ends at the disc's rim (with the ramps, they and the slab's top too); the derby bowl, the rigs
    // and the range keep the endless pad; the corkscrew's channel is the ground over a pad drawn three times wider for
    // its far landings.
    setGround(this.showCorkscrew ? this.corkscrew : this.derbyMode || this.rigScene || this.showRange ? null : this.showRamps ? this.ramps : DISC_GROUND);
    this.stage.ground.scale.setScalar(this.showCorkscrew ? 3 : 1);
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
    else this.spawnFleet();
    this.barrierHits.fill(false);
    this.barrier.group.visible = this.barrierUp;
    // With the ramps up the slab lies end-on to the lead car, so the jump runs along its line (owner's sketch).
    if (this.barrierUp || this.rampsUp) this.barrier.orient(this.carA.group.position, this.rampsUp);
    this.ramps.group.visible = this.rampsUp;
    this.ramps.place(this.barrier.yaw, this.barrierUp ? this.barrier : null);
    scatterRampBalls(this.balls, this.ballsUp, this.sceneRng(1));
    for (const p of this.poles) p.group.visible = !this.derbyMode && !this.showRange;
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
    for (let i = this.carCount; i < this.cars.length; i++) {
      const extra = this.cars[i]!;
      extra.group.visible = false;
      extra.group.position.set(80 + i * 6, 0, 80);
      extra.velocity.set(0, 0, 0);
    }
  }

  /** Car A on the range's run-up at speed, aimed down +x at the barrier on the origin (the wall, balls and ramps are the scene's: `SCENE_PROPS`). */
  private spawnRange(): void {
    const car = this.carA;
    car.group.visible = true;
    car.spawnFacing(-RANGE.run, 0, Math.PI / 2, RANGE.kph / 3.6);
    this.dressCar(car);
  }

  private spawnDerby(): void {
    // Network peers' cars join when a match begins (one seated mid-match waits for this): the field grows to hold them.
    let need = this.carCount;
    for (const i of this.netSeats.keys()) need = Math.max(need, i + 1);
    if (need > this.carCount) this.ensureCars(need);
    this.derbySeated = new Set(this.netSeats.keys());
    this.derbyRound++;
    const cars = this.live();
    this.derbyR = derbyRadius(cars.length);
    const slots = layoutDerby(cars.length, this.derbyR, this.sceneRng(0));
    this.derby.begin(
      cars.map((c, i) => ({ id: i, name: this.netSeats.get(i) ?? c.paint.name })),
      { radius: this.derbyR },
    );
    // Walls and lip scale out with the bowl (slabs lengthen and thicken in proportion).
    this.arena.scale.set(this.derbyR / DERBY_RADIUS, 1, this.derbyR / DERBY_RADIUS);
    this.winnerSpot.off();
    for (let i = 0; i < cars.length; i++) {
      const slot = slots[i]!;
      const car = cars[i]!;
      car.group.visible = true;
      car.spawnFacing(slot.x, slot.z, slot.yaw, 0);
      this.dressCar(car);
    }
    for (let i = this.carCount; i < this.cars.length; i++) {
      const extra = this.cars[i]!;
      extra.group.visible = false;
      extra.group.position.set(80 + i * 6, 0, 80);
      extra.velocity.set(0, 0, 0);
    }
    this.arena.visible = true;
    for (const p of this.poles) p.group.visible = false;
  }

  /** Netplay host: this derby as clients render it (null outside derby mode). */
  protected derbyNetState(): DerbyNetState | null {
    if (!this.derbyMode) return null;
    const d = this.derby;
    let seats = 0;
    for (const i of this.derbySeated) seats |= 1 << i;
    return {
      round: this.derbyRound,
      active: d.active,
      time: d.time,
      hold: d.hold,
      radius: this.derbyR,
      winnerId: d.winnerId,
      winnerName: d.winnerName,
      decided: d.decided,
      lobby: null,
      seats,
      board: d.board,
    };
  }

  /**
   * Netplay client: the host's derby as car `self` (null: leave derby mode). The board, clock and result
   * are shown as they are, never stepped. A new match drives this peer's car if the host seated it;
   * otherwise (joined mid-match, or a lobby) it watches the field until the next one.
   */
  protected applyNetDerby(s: DerbyNetState | null, self: number): void {
    if (!s) {
      if (this.derbyMode) {
        this.setDerby(false);
        this.randomizeAndReset();
      }
      this.emitHud();
      return;
    }
    if (!this.derbyMode) {
      if (this.race.active) this.setRace(false);
      this.setDerby(true);
      this.emitHud();
    }
    if (s.radius !== this.derbyR) {
      this.derbyR = s.radius;
      this.arena.scale.set(s.radius / DERBY_RADIUS, 1, s.radius / DERBY_RADIUS);
    }
    const seated = self >= 0 && ((s.seats >>> self) & 1) === 1;
    for (const r of s.board) {
      if (r.id === self && seated) r.name = "You";
      else if (r.id === 0) r.name = "Host";
    }
    const d = this.derby;
    d.active = s.active;
    d.time = s.time;
    d.hold = s.hold;
    d.decided = s.decided;
    d.board = s.board;
    d.winnerId = s.winnerId;
    d.winnerName = s.winnerId == null ? null : (s.board.find((r) => r.id === s.winnerId)?.name ?? s.winnerName);
    if (s.round === this.derbyRound) return;
    this.derbyRound = s.round;
    if (seated) {
      this.seat.focus(self);
      this.seat.mode = "drive";
      this.seat.boost = 1;
      return;
    }
    const watch = s.board.find((r) => r.alive && r.id !== self);
    if (watch) this.seat.focus(watch.id);
    else this.seat.clear();
  }

  /** Netplay host's public derby: the lobby (a `field`-car field parked, no match), or a fresh match seating every peer. */
  protected netDerbyMatch(start: boolean, field: number): void {
    if (this.race.active) this.setRace(false);
    if (!this.derbyMode) this.setDerby(true);
    if (this.carCount < field) this.ensureCars(field);
    this.randomizeAndReset();
    if (start) {
      this.seat.focus(0);
      this.seat.mode = "drive";
      this.seat.boost = 1;
    } else {
      this.derby.end();
      for (const car of this.live()) {
        car.velocity.set(0, 0, 0);
        car.speed = 0;
      }
    }
    this.emitHud();
  }

  /** One car parked at the origin facing +Z, everything else put away. */
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
  /** The screen shape the opening shot was framed for (a portrait one stands the camera further back). */
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
    for (const car of this.live()) top = Math.max(top, car.group.position.y);
    this.stackEye += ((top + 1.3) / 2 - this.stackEye) * (1 - Math.exp(-3 * wallDt));
    return this.stackEye;
  }

  private finishResetCommon(): void {
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
    this.elapsedWall = 0;
    this.elapsedSim = 0;
    this.impactKph = null;
    this.impactLightLife = 0;
    this.impactLight.intensity = 0;

    if (!this.showPistons && !this.showStack) this.view.frameReset(this.showCompactor || this.showDoors, this.live());
    this.smokeUntil.fill(0);
    this.deadSmokeAcc.length = 0;
    this.vaporAt.length = 0;
    this.sparkAt = -10;
    this.fxPoofed = false;
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

  protected readonly ballHit = (car: DeformableCar): ContactHit | null =>
    resolveRampBalls(this.balls, car, this.elapsedWall, this.trace.ballHits, this.ballBreak);

  private readonly ballBreak = (at: THREE.Vector3, n: THREE.Vector3, closing: number): void => {
    this.debris.burst(at, n, Math.min(48, 14 + closing * 1.2) * this.fxDensity);
    this.sparks.poof(at, n, Math.min(28, 8 + closing * 0.6) * this.fxDensity);
  };

  protected readonly poleHit = (car: DeformableCar): boolean => resolveLampPoles(this.poles, car, this.poleBreak) !== null;

  private readonly poleBreak = (at: THREE.Vector3, n: THREE.Vector3, closing: number): void => {
    this.debris.burst(at, n, Math.min(40, 10 + closing) * this.fxDensity);
    this.sparks.poof(at, n, Math.min(22, 6 + closing * 0.5) * this.fxDensity);
  };

  protected readonly clipDerby = (car: DeformableCar): void => clipDerbyCar(car, this.derbyR);

  protected readonly raceCollide = (car: DeformableCar, i: number, h: number): void => this.race.collide(car, i, h);

  /** The fleet ramps' side and back faces; a hit can start the crash cinematic like any other. */
  protected readonly rampCollide = (car: DeformableCar, _i: number, h: number): void => {
    const hit = this.ramps.contact(car, h);
    if (hit) this.world.strongest.offer(hit);
  };

  /** The corkscrew's walls hold a car on its floor. */
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

  /**
   * A takedown's boost for attacker `id` (`DerbyMatch.consumeBoosts`), by one rule for every driver: the seat's meter
   * when the player drives that car, else the derby AI's (`DerbyBrain.addBoost`).
   */
  protected takedownBoost(id: number): void {
    if (id === this.seat.carIndex && this.seat.mode === "drive") this.seat.addBoost(BOOST.takedown);
    else this.derby.brain.addBoost(id, BOOST.takedown);
  }

  /** `derby.step`'s per-car flags, refilled in place (the match copies what it keeps); grows once per new car. */
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

  /**
   * Fleet disc, once per frame after physics: `edgeAction` turns a car `FAKE_DEPTH` below the top into a
   * falling fake (`beginFakeFall`), vaporizes it at `VAPOR_DEPTH` and brings the driven one back. A falling
   * fake shrinks away over its last 4 m (also on a netplay client, which mirrors the host's events).
   */
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
  }

  /**
   * Car `i` bursts into smoke and leaves the sim (`on`): hidden, repaired and frozen where it vanished, so it
   * costs no physics, skinning or draw calls. `off` puts it back as it stands. Netplay: the host sets it
   * from `stepEdge`, a client mirrors the host's flag through here.
   */
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

  /** Car `i` back on the disc (`respawnSlot`: on the bearing it fell from, facing the centre, clear of the others). */
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

  protected bounceWorld = (pos: THREE.Vector3, vel: THREE.Vector3, r: number): void => {
    // Loose parts and FX past the fleet disc's rim fall on: no ground there.
    if (activeGround().heightAt(pos.x, pos.z, pos.y) !== NO_FLOOR) bounceGround(pos, vel, r);
    for (const car of this.live()) if (!car.vaporized) bounceOffCar(car, pos, vel, r);
    if (this.showCompactor) {
      const hz = 0.24;
      const hy = 1.05;
      const hx = 1.8;
      const z = this.compactor.face + 0.24;
      separateSphereFromAabb(pos, vel, r, 0, 1.02, z, hx, hy, hz);
      separateSphereFromAabb(pos, vel, r, 0, 1.02, -z, hx, hy, hz);
    }
    if (this.barrierUp) this.barrier.bounce(pos, vel, r);
  };

}

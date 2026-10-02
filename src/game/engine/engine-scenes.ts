import * as THREE from "three";
import { beginFakeFall, DeformableCar } from "../vehicle/car.ts";
import { separateSphereFromAabb } from "../deform/physics-util.ts";
import { COMPACTOR } from "../scenes/compactor.ts";
import { PISTON_ORBIT_RATE, pistonBearing } from "../present/engine-pistons.ts";
import { VAPOR_DEPTH, edgeAction, layoutFleet, layoutDerby, respawnSlot } from "../scenes/fleet.ts";
import { bounceGround, bounceOffCar } from "../present/engine-fx.ts";
import { activeGround, DISC_GROUND, NO_FLOOR, setGround } from "../world/ground.ts";
import { type ContactHit, resetLampPoles, resolveLampPoles, resolveRampBalls, scatterRampBalls } from "../scenes/engine-props.ts";
import { clipDerbyCar, DERBY_RADIUS, derbyRadius } from "../scenes/derby-arena.ts";
import type { DerbyNetState } from "../net/codec.ts";
import type { RaceCommand } from "../match/types.ts";
import type { SceneId } from "./engine-core.ts";
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
  toggleBarrier(): void {
    // A fleet prop: the host's (netplay), and ignored while the press, a rig or the race owns the pad (the HUD locks it too).
    if (this.net.client || this.rigScene || this.race.active) return;
    this.showBarrier = !this.showBarrier;
    if (this.derbyMode) {
      // Out of the bowl like every scene switch: the reset brings back the disc ground, poles and fresh spots, and places the barrier.
      this.setDerby(false);
      this.randomizeAndReset();
    } else {
      this.barrier.group.visible = this.showBarrier;
      if (this.showBarrier) this.barrier.orient(this.carA.group.position);
    }
    this.tryUnlockAudio();
    this.emitHud();
  }

  toggleBalls(): void {
    if (this.net.client || this.rigScene || this.race.active) return;
    this.showBalls = !this.showBalls;
    if (this.derbyMode) {
      this.setDerby(false);
      this.randomizeAndReset();
    } else {
      scatterRampBalls(this.balls, this.showBalls);
    }
    this.tryUnlockAudio();
    this.emitHud();
  }

  /**
   * Scene picker: `next` replaces the scene in play; picking the one in play goes back to the fleet. Leaves the race
   * or the derby first, then resets the field.
   */
  protected setScene(next: SceneId): void {
    if (this.net.client) return;
    if (next === this.sceneId) next = "fleet";
    if (this.race.active && next !== "race") this.setRace(false);
    if (this.derbyMode !== (next === "derby")) this.setDerby(next === "derby");
    if (next === "race") this.setRace(true);
    else this.sceneId = next;
    this.tryUnlockAudio();
    this.randomizeAndReset();
    // Frame only on entering: re-parks and loop hops keep the user's view and the orbit running. The camera
    // starts 1.2 s of orbit short of the front-right ram so the first synced shot comes from its side.
    if (next === "pistons") this.view.frameReset(true, this.live(), pistonBearing(2) - PISTON_ORBIT_RATE * 1.2);
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

  toggleDerby(): void {
    this.setScene("derby");
  }

  protected setDerby(on: boolean): void {
    if (on) this.sceneId = "derby";
    else if (this.sceneId === "derby") this.sceneId = "fleet";
    this.arena.visible = on;
    for (const p of this.poles) p.group.visible = !on;
    if (on) {
      this.showBarrier = false;
      this.showBalls = false;
      this.barrier.group.visible = false;
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
    if (this.net.client && !CLIENT_RACE_COMMANDS.has(cmd.type)) return;
    this.race.command(cmd);
    this.emitHud();
  }

  /** R / D-pad down: back on the track (a netplay client asks the host). */
  protected requestRespawn(): void {
    if (this.net.client) this.net.requestRespawn();
    else this.race.requestRespawn();
  }

  protected setRace(on: boolean): void {
    if (on === this.race.active) return;
    if (on) {
      if (this.derbyMode) this.setDerby(false);
      this.showBarrier = false;
      this.showBalls = false;
      this.sceneId = "race";
      this.barrier.group.visible = false;
      scatterRampBalls(this.balls, false);
      this.press.group.visible = false;
      this.pistonBank.group.visible = false;
      this.doorRam.group.visible = false;
      if (this.clock.userTimeScale == null) {
        this.clock.timeScale = 1;
        this.clock.targetScale = 1;
      }
      this.sandboxCars = this.carCount;
    }
    for (const o of this.studio) o.visible = !on;
    for (const p of this.poles) p.group.visible = !on;
    if (on) {
      this.race.enter();
      this.race.setSeats(this.netSeats);
    } else {
      this.sceneId = "fleet";
      this.race.exit();
      this.ensureCars(this.sandboxCars);
    }
  }

  protected randomizeAndReset(): void {
    this.compactor.face = COMPACTOR.startFace;
    this.compactFxAt = 0;
    if (this.race.active) {
      this.race.reset();
      this.finishResetCommon();
      return;
    }
    // The fleet's ground ends at the disc's rim; the derby bowl and the rigs keep the endless pad.
    setGround(this.derbyMode || this.showCompactor || this.showPistons || this.showDoors ? null : DISC_GROUND);
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
    this.press.group.visible = false;
    this.pistonBank.group.visible = false;
    this.doorRam.group.visible = false;
    if (this.derbyMode) this.spawnDerby();
    else this.spawnFleet();
    this.barrierHits.fill(false);
    this.barrier.group.visible = this.showBarrier;
    if (this.showBarrier) this.barrier.orient(this.carA.group.position);
    scatterRampBalls(this.balls, this.showBalls);
    resetLampPoles(this.poles, !this.derbyMode);
    this.finishResetCommon();
  }

  private spawnFleet(): void {
    const cars = this.live();
    const slots = layoutFleet(cars.length, this.speedMin, this.speedMax);
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

  private spawnDerby(): void {
    // Network peers' cars join when a match begins (one seated mid-match waits for this): the field grows to hold them.
    let need = this.carCount;
    for (const i of this.netSeats.keys()) need = Math.max(need, i + 1);
    if (need > this.carCount) this.ensureCars(need);
    this.derbySeated = new Set(this.netSeats.keys());
    this.derbyRound++;
    const cars = this.live();
    this.derbyR = derbyRadius(cars.length);
    const slots = layoutDerby(cars.length, this.derbyR, 12);
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
      car.spawnFacing(slot.x, slot.z, slot.yaw, slot.speed);
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
    parked.resetVisual();
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
      extra.resetVisual();
      extra.group.visible = false;
      extra.group.position.set(48 + i * 4, 0, 48);
      extra.velocity.set(0, 0, 0);
    }

    this.barrier.group.visible = false;
    this.barrierHits.fill(false);
    for (const b of this.balls) b.mesh.visible = false;
    this.press.group.visible = false;
    this.pistonBank.group.visible = false;
    this.doorRam.group.visible = false;
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
    this.elapsedWall = 0;
    this.elapsedSim = 0;
    this.impactKph = null;
    this.impactLightLife = 0;
    this.impactLight.intensity = 0;
    this.debris.reset();
    this.sparks.reset();
    this.glassDots.reset();
    this.smoke.reset();
    this.cine.reset();

    if (!this.showPistons) this.view.frameReset(this.showCompactor || this.showDoors, this.live());
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

  protected readonly raceCollide = (car: DeformableCar, i: number): void => this.race.collide(car, i);

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
    if (activeGround() !== DISC_GROUND) return;
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
    if (this.showBarrier) this.barrier.bounce(pos, vel, r);
  };

}

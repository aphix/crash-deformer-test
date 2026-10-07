import type { DerbyNetState } from "../net/codec.ts";
import { DERBY_RADIUS } from "../scenes/derby-arena.ts";
import { EngineHud } from "./engine-hud.ts";

/**
 * The derby's scene switch and its netplay mirror: entering and leaving the bowl, the host's state out, a client's view of
 * it in, and the host's public lobby or match. The match's per-step work stays with the scenes (`EngineScenes.stepDerby`).
 */
export abstract class EngineDerby extends EngineHud {
  /** The scene's reset: a fresh seed, the last scene emptied, the scene's cars spawned (`EngineScenes`). */
  protected abstract randomizeAndReset(): void;
  /** Race scene on / off (`EngineScenes`). */
  protected abstract setRace(on: boolean, survival?: boolean): void;

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
}

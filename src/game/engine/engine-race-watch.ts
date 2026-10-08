import { AutoWatch } from "../match/auto-watch.ts";
import { RaceField } from "./engine-race-field.ts";

/**
 * Spectating a race by hand: following another car (`watch`, `cycle`) or handing the pick to Auto (`goAuto`;
 * `RaceDirector.autoStep` runs it each frame), and whether this browser may watch at all.
 */
export abstract class RaceWatch extends RaceField {
  /**
   * Auto spectating (the Auto entry of the driver list, standings row and `watch` id -1): the director picks which car
   * the camera rides (`autoStep`). Cleared whenever spectating ends or a car is picked by hand.
   */
  auto = false;
  protected readonly autoWatch = new AutoWatch();

  /**
   * Standings click / engine `watchCar`: follow another car only when the player is not racing. A car id turns Auto off;
   * `id` -1 (the standings' Auto row) turns it on and keeps the car in view until Auto picks another.
   */
  watch(id: number): void {
    if (!this.session || id < -1 || id >= this.entrants.length) return;
    if (!this.mayWatch()) return;
    if (id < 0) {
      this.goAuto();
      return;
    }
    this.auto = false;
    if (this.mine(id)) {
      this.spectating = false;
      this.host.seat.focus(this.self);
      return;
    }
    this.spectating = true;
    this.host.seat.focus(id);
  }

  /**
   * Q/E, LB/RB: next / previous racer still on track (never our own racing car; police and traffic cars stand past the
   * racers and are never watched), then Auto (one more entry, after the last racer, before the list wraps), when
   * watching is allowed.
   */
  cycle(dir: 1 | -1): void {
    const s = this.session;
    if (!s || !this.mayWatch()) return;
    const n = this.entrants.length;
    // Slots 0 … n − 1 are racers, slot n is Auto.
    let i = this.auto ? n : this.host.seat.carIndex;
    for (let k = 0; k <= n; k++) {
      i = (((i + dir) % (n + 1)) + (n + 1)) % (n + 1);
      if (i === n) {
        this.goAuto();
        return;
      }
      const st = s.cars[this.rowOf[i]!]!.status;
      const ok = !this.mine(i) && (st === "racing" || st === "respawning" || st === "finished");
      if (ok) {
        this.spectating = true;
        this.auto = false;
        this.host.seat.focus(i);
        return;
      }
    }
  }

  /** Auto on: the car in view stays until `autoStep` picks another; a fresh Auto starts its clocks over. */
  protected goAuto(): void {
    this.spectating = true;
    if (this.auto) return;
    this.autoWatch.reset();
    this.auto = true;
  }

  protected mayWatch(): boolean {
    const s = this.session;
    if (!s) return false;
    if (this.entrants[this.self]?.kind !== "player") return true;
    const st = s.cars[this.rowOf[this.self]!]!.status;
    return this.spectating || st === "out" || st === "finished" || st === "dnf" || s.phase === "finished";
  }

  protected watchLeader(): void {
    const s = this.session;
    if (!s) return;
    for (const id of s.order()) {
      const st = s.cars[this.rowOf[id]!]!.status;
      if (!this.mine(id) && (st === "racing" || st === "respawning" || st === "finished")) {
        this.host.seat.focus(id);
        return;
      }
    }
  }

  /** Car `i` is this browser's player car (a spectator race has none). */
  protected mine(i: number): boolean {
    return i === this.self && this.entrants[i]?.kind === "player";
  }
}

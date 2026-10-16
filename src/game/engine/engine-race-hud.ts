import type { DeformableCar } from "../vehicle/car.ts";
import { NO_DRIFT, type DriftView } from "../vehicle/car-drive.ts";
import { carGauge } from "../match/car-view.ts";
import { clamp } from "../kernel/scalar.ts";
import { surfaceAt } from "../ai/race-ai.ts";
import { brakeCueAt } from "../ai/brake-cue.ts";
import { projectPath, type TrackPath } from "../world/track.ts";
import { carClass, classStats } from "../vehicle/vehicle-classes.ts";
import { RACE_MODE, type RaceHud, type RaceHudRow, type RaceView } from "../match/types.ts";
import { RaceWatch } from "./engine-race-watch.ts";

/** A police unit's boost meter as the gauge shows it: always full (police boost with no meter, `cop-brain.ts`). */
const POLICE_METER = 1;

/** What a race shows and where its menus lead: the HUD read model, the boost meters, the next-course flow and the setup menu. */
export abstract class RaceHudLayer extends RaceWatch {
  /** How far the hold of this browser's reset control is, 0–1 (`ResetHold.fill`): the input layer writes it each frame, the HUD's fill reads it. */
  holdFill = 0;

  /**
   * Car `id`'s boost meter as its driver keeps it (0-1): this browser's seat, the race AI where this browser runs it, a police unit's
   * always full, else what netplay heard (a peer's own meter; on a client, the host's). Null for a car with no nitrous: traffic, nobody heard.
   */
  meterOf(id: number): number | null {
    if (this.free) return id === this.self ? this.host.seat.boost : this.host.heardMeter(id);
    if (this.seatDrives(id)) return this.host.seat.boost;
    if (this.aiDrives(id) && this.brain) return this.brain.meter[id]!;
    if (id >= this.policeFrom && id < this.host.live().length) return POLICE_METER;
    return this.host.heardMeter(id);
  }

  /** Car `id`'s slide as the HUD shows it: this browser's seat keeps it (the same cars `meterOf` reads the seat's meter for), every other car has none. A copy: the seat goes on writing its own. */
  private driftOf(id: number): DriftView {
    return (this.free ? id === this.self : this.seatDrives(id)) ? { ...this.host.seat.drift } : NO_DRIFT;
  }

  /** The braking cue (0..1) for car `id` on the main loop: its forward speed against what the planned braking allows for a corner ahead. No allocation. */
  private brakeCue(id: number, car: DeformableCar, path: TrackPath): number {
    const p = car.group.position;
    const pr = projectPath(path, p.x, p.z, this.seg[id]!, this.proj);
    const along = car.velocity.x * car.fwdFlat.x + car.velocity.z * car.fwdFlat.z;
    return brakeCueAt(path, classStats(carClass(car)), pr.s, along, surfaceAt(path, pr.k).grip);
  }

  /** The race's part of the HUD read model; the engine adds the reel's (`reel`, `solo`, `shown`, `saved`, `outdated`, `autoPurge`). */
  hud(): Omit<RaceHud, "reel" | "solo" | "shown" | "saved" | "outdated" | "autoPurge"> {
    const s = this.session;
    const tr = this.track;
    const cars = this.host.live();
    const seat = this.host.seat;
    const standings: RaceHudRow[] = [];
    let you: RaceHud["you"] = null;
    if (s) {
      for (const id of s.order()) {
        const c = s.cars[this.rowOf[id]!]!;
        const win = s.winnerId == null ? null : s.cars[this.rowOf[s.winnerId]!]!;
        // A finisher a lap or more down has no time gap; the HUD shows its laps behind.
        const gap =
          c.place === 1
            ? null
            : c.status === "finished" && c.finishTime != null && win?.finishTime != null
              ? c.lap < s.laps
                ? null
                : c.finishTime - win.finishTime
              : c.split;
        standings.push({
          id,
          name: c.name,
          place: c.place,
          lap: c.lap,
          status: c.status,
          gap,
          bestLap: c.bestLap,
          you: c.kind === "player",
          watched: seat.mode !== "global" && seat.carIndex === id,
        });
      }
      const me = this.entrants[this.self]?.kind === "player" ? s.cars[this.rowOf[this.self]!] : undefined;
      if (me) {
        you = {
          id: this.self,
          place: me.place,
          lap: Math.min(s.laps, me.lap + 1),
          status: me.status,
          wrongWay: me.wrongWay,
          missed: me.missed && me.status === "racing",
          respawnIn: me.respawnAt == null ? null : Math.max(0, me.respawnAt - s.time),
          finishTime: me.finishTime,
          busted: me.bustedAt != null,
          driverOut: cars[this.self]?.driverOut != null,
        };
      }
    }
    const id = seat.mode === "global" ? -1 : seat.carIndex;
    const car = s && id >= 0 ? cars[id] : undefined;
    let view: RaceView | null = null;
    if (s && car) {
      const c = id < this.entrants.length ? s.cars[this.rowOf[id]!] : undefined;
      // Race distance covered: the rules' own ranking measure (`progress`), a finisher's all of it.
      const total = s.laps * s.track.length;
      const done = c === undefined ? 0 : c.status === "finished" ? 1 : clamp(c.progress / total, 0, 1);
      const cops = c !== undefined ? (this.police?.copsOn(id) ?? 0) : 0;
      const asking = c !== undefined && this.mine(id) && !this.spectating && this.menu === null && s.phase === "racing" && c.status === "racing";
      view = {
        id,
        racer: c
          ? {
              place: c.place,
              lap: Math.min(s.laps, c.lap + 1),
              lapTime: s.phase === "racing" && c.status !== "finished" ? Math.max(0, s.time - c.lapStart) : 0,
              lastLap: c.lapTimes.length > 0 ? c.lapTimes[c.lapTimes.length - 1]! : null,
              bestLap: c.bestLap,
              split: c.split,
              drafting: c.draft > 0,
              done: s.endless ? null : done,
              toGo: s.endless ? null : (1 - done) * total,
            }
          : null,
        ...carGauge(car),
        brakeCue: this.brakeCue(id, car, s.track.path),
        boost: this.meterOf(id),
        drift: this.driftOf(id),
        chase: c !== undefined && c.status === "racing" && (cops > 0 || c.stopped > 0) ? { cops: Math.max(1, cops), hold: Math.min(1, c.stopped / s.bustTime), left: Math.max(0, s.bustTime - c.stopped) } : null,
        // R / D-pad ↓ acts unless `requestRespawn` refuses it (a menu is up, spectating) or the rules do (no-reset race, not racing); holding it acts wherever `holdReset` does: a no-reset race too, not Survival.
        canReset: asking && !s.noReset,
        canHold: asking && !s.endless,
        resetHold: this.holdFill,
      };
    }
    const winner = s && s.winnerId != null ? s.cars[this.rowOf[s.winnerId]!]!.name : null;
    const watched =
      this.spectating && seat.carIndex >= 0 ? (this.entrants[seat.carIndex]?.name ?? (seat.carIndex >= this.policeFrom ? "Police" : null)) : null;
    return {
      menu: this.menu,
      mode: this.campaign ? RACE_MODE.campaign : RACE_MODE.single,
      options: { ...this.options },
      courses: this.courses,
      survivalCourses: this.survivalCourses,
      survivalCourse: this.survivalId,
      phase: s ? s.phase : null,
      trackName: tr ? tr.name : "",
      laps: s ? s.laps : this.rules.laps,
      noReset: s ? s.noReset : this.rules.noReset,
      time: s ? s.time : 0,
      you,
      view,
      field: s ? s.cars.length : this.rules.aiCount + 1,
      standings,
      spectating: watched,
      auto: this.auto && watched !== null,
      winnerName: winner,
      winBy: s ? s.winBy : null,
      results: s && s.phase === "finished" ? s.results() : null,
      campaign: this.campaign ? this.campaign.snapshot() : null,
      nextCourse: this.nextCourseName(),
      fullUi: this.fullUi,
      survival: this.survivalHud(),
      team: s ? s.team() : null,
    };
  }

  protected next(): void {
    if (this.menu === "results") {
      if (this.campaign) {
        // A team that did not win its event plays it again: the round counts once a human finishes first.
        if (this.session?.team()?.won === false) {
          this.start(this.campaign.trackId!, this.campaign.grid());
          return;
        }
        if (this.session) this.campaign.record(this.session.results());
        this.menu = "standings";
        return;
      }
      const id = this.nextTrackId();
      if (id) this.start(id, this.defaultGrid());
      return;
    }
    if (this.menu === "standings" && this.campaign) {
      if (this.campaign.done) {
        this.toSetup();
        return;
      }
      this.pegCampaign();
      this.start(this.campaign.trackId!, this.campaign.grid());
    }
  }

  /**
   * Netplay host, a campaign round has ended: moves on from wherever the room is, as the host's own Next presses would (results: the round
   * is scored, or replayed when no human won it; standings: the next round, or after the last the setup menu). Nothing without one.
   */
  advance(): void {
    if (!this.campaign || this.session?.phase !== "finished") return;
    if (this.menu !== "standings") {
      this.menu = "results";
      this.next();
    }
    if (this.menu === "standings") this.next();
  }

  /** Each rival keeps the aggression it rolled when the campaign began. */
  private pegCampaign(): void {
    if (!this.campaign) return;
    for (const r of this.campaign.standings()) {
      const e = this.entrants[r.id];
      if (e?.kind === "ai") e.aggression = r.aggression;
    }
  }

  private nextTrackId(): string | null {
    if (!this.track || this.courses.length < 2) return null;
    const i = this.courses.findIndex((c) => c.id === this.track!.id);
    return this.courses[(i + 1) % this.courses.length]!.id;
  }

  private nextCourseName(): string | null {
    if (this.campaign) {
      if (this.menu === "results") return "Standings";
      const id = this.campaign.trackId;
      return id ? (this.courses.find((c) => c.id === id)?.name ?? null) : null;
    }
    const id = this.nextTrackId();
    return id ? (this.courses.find((c) => c.id === id)?.name ?? null) : null;
  }

  /** Setup menu: the chosen course with the field parked on its grid, no race running. In Survival (`enter(true, false, true)`): the Survival menu, the picked Survival course's start, no run. */
  protected toSetup(): void {
    this.campaign = null;
    this.setProgram(null);
    this.session = null;
    this.brain = null;
    this.traffic = null;
    this.police = null;
    this.spectating = false;
    this.auto = false;
    this.menu = this.survival ? "survival" : "setup";
    this.host.setPaused(false);
    this.host.seat.clear();
    this.park();
  }
}

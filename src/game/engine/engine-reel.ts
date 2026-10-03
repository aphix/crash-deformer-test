import { carClass } from "../vehicle/vehicle-classes.ts";
import { activeGround, NO_FLOOR } from "../world/ground.ts";
import { carLayout } from "../net/car-pose.ts";
import { decodeSaved, packReel, unpackReel } from "../net/reel-codec.ts";
import type { HighlightClip } from "../match/highlights.ts";
import type { RaceCommand, RaceHud, SavedHud } from "../match/types.ts";
import { RESULTS_DELAY } from "./engine-race.ts";
import type { ReelDirector } from "./engine-highlights.ts";
import { deleteSaved, listSaved, loadSaved, saveClip } from "./highlight-store.ts";
import { EngineInput } from "./engine-input.ts";

/** The engine's crash highlights layer (docs/HIGHLIGHTS.md): the reel's start, its commands, saved clips. */
export abstract class EngineReel extends EngineInput {
  /** The results reel and its solo view. */
  protected abstract readonly highlights: ReelDirector;
  /** The camera's field of view before the reel took it. */
  protected reelFov: number | null = null;
  /** `listSaved()`, re-read after a save or a delete. */
  private savedList: SavedHud[] | null = null;

  /** Race over (host or offline): the reel from the results' first moment. Every peer, this one too, replays the decoded bytes. */
  protected startReel(clips: readonly HighlightClip[]): void {
    if (clips.length === 0 || this.net.client) return;
    const lay = carLayout(this.cars[0]!);
    const reel = { seed: (Math.random() * 2 ** 32) >>> 0, clips: [...clips] };
    const startAt = performance.now() / 1000 + RESULTS_DELAY;
    const current = (): boolean => this.race.active && this.race.phase === "finished";
    void (async () => {
      const { msg } = await packReel(reel, startAt);
      if (!current()) return;
      this.net.sendReel(msg);
      const got = await unpackReel(msg, lay);
      if (current()) this.highlights.play(got.reel, got.startAt);
    })().catch((err: unknown) => console.error("Crush Stream highlight reel failed", err));
  }

  protected reelCommand(cmd: RaceCommand): boolean {
    const r = this.highlights;
    switch (cmd.type) {
      case "reelView":
        this.cine.direct(this.camera, 0, false);
        r.view(cmd.clip, performance.now() / 1000);
        return true;
      case "reelBack":
        this.cine.direct(this.camera, 0, false);
        r.back();
        return true;
      case "reelSave": {
        const clip = r.clip(cmd.clip);
        if (!clip) return true;
        const course = this.race.courses.find((c) => c.id === clip.trackId)?.name ?? clip.trackId;
        void saveClip(clip, course).then((res) => {
          if (res === "saved") r.markSaved(cmd.clip);
          else console.warn(`Highlight not saved: ${res}`);
          this.savedList = null;
          this.emitHud();
        });
        return true;
      }
      case "savedPlay":
        void this.playSaved(cmd.key);
        return true;
      case "savedDelete":
        deleteSaved(cmd.key);
        this.savedList = null;
        return true;
      case "start":
      case "campaign":
      case "retry":
      case "next":
      case "quit":
        // Leaving the results: the cars go back before the race moves them.
        this.stopReel();
        return false;
      default:
        return false;
    }
  }

  protected stopReel(): void {
    this.highlights.stop();
    this.cine.direct(this.camera, 0, false);
  }

  /** Setup menu: a saved highlight alone, on its course and its cars' looks; the setup field comes back after. */
  private async playSaved(key: string): Promise<void> {
    const text = loadSaved(key);
    const clip = text === null ? "corrupt" : await decodeSaved(text, carLayout(this.cars[0]!));
    if (typeof clip === "string") {
      console.warn(`Saved highlight cannot replay here: ${clip}`);
      return;
    }
    if (!this.race.active || this.race.menu !== "setup") return;
    const track = this.race.options.trackId;
    this.race.command({ type: "options", options: { trackId: clip.trackId } });
    this.ensureCars(Math.max(this.carCount, ...clip.cars.map((c) => c.slot + 1)));
    const looks = clip.cars.map((c) => ({ slot: c.slot, style: this.cars[c.slot]!.style.id, cls: carClass(this.cars[c.slot]!) }));
    for (const c of clip.cars) this.matchCar(c.slot, c.style, c.cls);
    this.highlights.viewSaved(clip, performance.now() / 1000, () => {
      for (const l of looks) this.matchCar(l.slot, l.style, l.cls);
      this.race.command({ type: "options", options: { trackId: track } });
      this.race.reset();
    });
    this.emitHud();
  }

  /** Per frame: once the reel is over, the camera's lens comes back. */
  protected reelFrame(on: boolean): void {
    if (on || this.reelFov === null) return;
    this.camera.fov = this.reelFov;
    this.camera.updateProjectionMatrix();
    this.reelFov = null;
  }

  protected reelHud(): Pick<RaceHud, "reel" | "solo" | "saved"> {
    this.savedList ??= listSaved();
    return { ...this.highlights.hud(), saved: this.savedList };
  }

  /**
   * The crash is basically over, so a ride-along may take the camera (owner, 2026-10-03): the crash cam with its bars
   * has handed back and time is back near 1× with no slow-mo still to come (in the aftermath, about 2 s after the
   * hold ends); under a fixed HUD speed, once the crash settles into the aftermath.
   */
  protected rideReady(): boolean {
    if (this.cine.directing) return false;
    if (this.clock.userTimeScale != null) return this.clock.phase === "aftermath";
    return this.clock.timeScale >= 0.9 && this.clock.slomoAt === 0;
  }

  /** Which rig holds the camera, mirroring `aimRigs`' and `updateCamera`'s precedence from the state they read (the trace's `camera.rig`). */
  protected cameraRig(): string {
    if (this.highlights.playing) return this.cine.cutting ? "crash-cam" : "reel";
    const followed = this.followedCar();
    const shown = followed?.group.visible === true;
    if (shown && this.view.rear) return "rear-view";
    if (this.ragdolls.rideAlong && (this.showRange || this.rideReady())) return "ragdoll";
    if (this.cine.cutting) return "crash-cam";
    const fp = followed?.group.position;
    if (followed && fp && (followed.falling || followed.vaporized || (fp.y < -0.01 && activeGround().heightAt(fp.x, fp.z, fp.y) === NO_FLOOR))) return "fall-watch";
    if (shown && this.seat.mode === "drive") return `drive-${this.seat.view}`;
    const spec = this.view.specView(this.race.chase);
    if (shown && !this.rigScene && spec !== "orbit") return `spectate-${spec}`;
    return this.view.userFramed ? "orbit-user" : "orbit";
  }
}

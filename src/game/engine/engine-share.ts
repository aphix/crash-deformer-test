import { decodeShare, followShare, isShareableRoom, joinsRoom, type ShareState } from "../hud/share-url.ts";
import { DEFAULT_RACE_OPTIONS } from "../match/types.ts";
import { SEEDED_SCENES } from "../scenes/scene-id.ts";
import { HANDLING } from "../vehicle/vehicle-classes.ts";
import { EngineReel } from "./engine-reel.ts";

/**
 * The shareable URL (docs/CONTROLS.md): the page's `#` follows the HUD state (scene, settings that differ from the
 * defaults, the run's spawn seed, the netplay room hosted or joined), and a pasted or edited `#` sets it. The hash is
 * untrusted: `decodeShare` validates it and every value then goes through the setter the HUD uses, which clamps again.
 * The `#` is the only thing that decides what a page load starts as: nothing the last run left in localStorage
 * (only preferences live there: name, car, HUD layout, saved highlights) picks a scene, a setting or a room.
 */
export abstract class EngineShare extends EngineReel {
  /** Off until `attachShare` has read the page's `#`, so boot never overwrites it. */
  private shareOn = false;
  /** True while `applyShare` runs: its setters publish half-applied states the URL must not show. */
  private sharing = false;

  /** The shared state as the engine holds it now. */
  private shareState(): ShareState {
    const sc = this.sceneId;
    // Race options persist after leaving the race; they are shared only while it is the scene.
    const o = sc === "race" ? this.race.options : DEFAULT_RACE_OPTIONS;
    const p = this.pistons.config;
    return {
      // A public match's `pub-…` name is not shared by the URL (Play online finds those); only a private code is.
      room: this.net.role !== "off" && isShareableRoom(this.net.room) ? this.net.room : "",
      tx: this.net.role === "off" ? "rtc" : this.net.tx,
      scene: sc,
      // The race, the range, the stack and Survival put their own field up; the sandbox's size waits in `sandboxCars`.
      cars: sc === "race" || sc === "range" || sc === "stack" || sc === "survival" ? this.sandboxCars : this.carCount,
      smin: this.speedMin,
      smax: this.speedMax,
      night: this.stage.night,
      wet: this.stage.wet,
      real: HANDLING.realism,
      // Automatic: the machine chose the tier (`AutoFx`), so the URL does not pin it.
      fx: this.autoFx.auto ? null : this.cine.tier,
      fxd: this.fxDensity,
      cel: this.celLook,
      squash: this.squash,
      buckle: this.buckle,
      loop: this.looping,
      slomo: this.autoSlomo,
      ts: this.clock.userTimeScale,
      deform: this.deformMode,
      car: this.playerCar.id,
      // Fleet props of the fleet: another scene's own wall, balls and ramps are its state, not a setting (`SCENE_PROPS`).
      barrier: sc === "fleet" && this.showBarrier,
      balls: sc === "fleet" && this.showBalls,
      ramps: sc === "fleet" && this.showRamps,
      pkph: p.speedKph,
      pkg: p.massKg,
      phard: p.hardness,
      phold: p.holdCar,
      phop: p.hopSeconds,
      scars: this.stack.config.cars,
      sdrop: this.stack.config.drop,
      sgap: this.stack.config.gap,
      dkph: this.doorRig.kph,
      dkg: this.doorRig.kg,
      dside: this.doorRig.side < 0 ? "left" : "right",
      track: o.trackId,
      laps: o.laps,
      ai: o.aiCount,
      aggr: o.aggression,
      police: o.police,
      noreset: o.noReset,
      spectate: o.spectate,
      seed: SEEDED_SCENES[sc] ? this.sceneSeed : null,
    };
  }

  /** Called by every HUD publish: the page URL follows the state. A netplay client's scene is the host's, so its URL keeps the room alone. */
  protected syncShareUrl(): void {
    if (!this.shareOn || this.sharing) return;
    const { pathname, search, hash } = window.location;
    const bar = hash.replace(/^#/, "");
    const frag = followShare(this.shareState(), this.net.client, bar);
    if (frag === bar) return;
    // replaceState: no history entry, no reload (and the router's history.state stays).
    window.history.replaceState(window.history.state, "", pathname + search + (frag ? `#${frag}` : ""));
  }

  /**
   * Set the engine to `t`, through the HUD's setters and only where it differs (the field resets once, not per
   * setting). A seed in `t` pins the spawns of every reset on the way. `boot` also does the first reset.
   */
  private applyShare(t: ShareState, boot: boolean): void {
    this.pinnedSeed = t.seed;
    this.sharing = true;
    try {
      let c = this.shareState();
      const differs = (...keys: (keyof ShareState)[]): boolean => keys.some((k) => t[k] !== c[k]);
      // The race, the range, the stack and Survival ignore the sandbox's car count: leave them first, the switch below stores it again.
      if ((c.scene === "race" || c.scene === "range" || c.scene === "stack" || c.scene === "survival") && (t.scene !== c.scene || differs("cars"))) {
        this.applyScene("fleet");
        c = this.shareState();
      }
      if (differs("cars")) this.setCarCount(t.cars);
      if (differs("smin", "smax")) this.setSpeedRange(t.smin, t.smax);
      if (differs("night")) this.setNight(t.night);
      if (differs("wet")) this.setWet(t.wet);
      if (differs("real")) this.setRealism(t.real);
      if (differs("fxd")) this.setFxDensity(t.fxd);
      if (differs("cel")) this.setCelLook(t.cel);
      if (differs("squash")) this.setSquash(t.squash);
      if (differs("buckle")) this.setBuckle(t.buckle);
      // A tier only ever gets picked: leaving `fx=` out keeps the automatic one (or a `?fx=` bench pick).
      if (t.fx !== null && differs("fx")) this.setFxTier(t.fx);
      if (differs("ts")) this.setTimeScale(t.ts);
      if (differs("loop")) this.toggleLoop();
      if (differs("slomo")) this.toggleSlomo();
      if (differs("deform")) this.toggleDeformMode();
      if (differs("car")) this.setPlayerCar(t.car);
      if (differs("pkph", "pkg", "phard", "phold", "phop")) {
        this.setPistonConfig({ speedKph: t.pkph, massKg: t.pkg, hardness: t.phard, holdCar: t.phold, hopSeconds: t.phop });
      }
      if (differs("scars", "sdrop", "sgap")) this.setStackConfig({ cars: t.scars, drop: t.sdrop, gap: t.sgap });
      if (differs("dkph", "dkg", "dside")) this.setDoorConfig({ kph: t.dkph, kg: t.dkg, side: t.dside === "left" ? -1 : 1 });
      if (t.scene !== this.sceneId) this.applyScene(t.scene);
      if (t.scene === "fleet") {
        c = this.shareState();
        if (differs("barrier")) this.toggleBarrier();
        if (differs("balls")) this.toggleBalls();
        if (differs("ramps")) this.toggleRamps();
      }
      if (t.scene === "race") {
        this.raceCommand({
          type: "options",
          options: { trackId: t.track, laps: t.laps, aiCount: t.ai, aggression: t.aggr, police: t.police, noReset: t.noreset, spectate: t.spectate },
        });
      }
      if (boot || (t.seed !== null && SEEDED_SCENES[t.scene] && t.seed !== this.sceneSeed)) this.randomizeAndReset();
    } finally {
      this.pinnedSeed = null;
      this.sharing = false;
    }
    this.emitHud();
  }

  /** Boot: apply the page's `#` (this is the first sandbox reset, so the first run already uses it), then follow it. */
  protected attachShare(): void {
    this.shareOn = true;
    const t = decodeShare(window.location.hash);
    // The stored car pick arrives after this (crash-lab's effect): a `#` that names a car keeps it (`driverCarApplies`).
    this.linkNamedCar = t.car !== decodeShare("").car;
    this.arrive(t, true);
    window.addEventListener("hashchange", this.onShareHash);
  }

  protected detachShare(): void {
    this.shareOn = false;
    window.removeEventListener("hashchange", this.onShareHash);
  }

  /**
   * A `#` lands (page load or edit): its settings first, unless this browser follows a host (the host's scene wins), then its
   * room, joined as a guest when it differs from the one this browser is in. A `#` without a room never leaves one.
   */
  private arrive(t: ShareState, boot: boolean): void {
    if (!this.net.client) this.applyShare(t, boot);
    if (joinsRoom(t, this.shareState())) this.net.join(t.room, t.tx);
    this.emitHud();
  }

  /** The `#` was edited or pasted (our own `replaceState` fires no event). */
  private onShareHash = (): void => {
    this.arrive(decodeShare(window.location.hash), false);
  };
}

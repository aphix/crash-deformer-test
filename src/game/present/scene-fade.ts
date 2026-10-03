/** Seconds: the view blends into the cel look, cuts to black, holds black, then fades up onto the new scene. */
export const FADE = { out: 0.25, cut: 0.06, hold: 0.05, inBlack: 0.2, inCel: 0.35, calm: 0.2, waitMax: 3 } as const;

/**
 * The scene-switch transition: wall-clock presentation only (the sim never reads it). `cel` (0-1) is how far the view
 * has gone to the cel look, `black` (0-1) how far to black. `request` stores the target; `frame` returns it on the
 * frame after the first fully black one was drawn, for the caller to switch while nothing shows (the switch's hitch
 * then holds that black frame). A request mid-way only replaces the
 * target (or, once the switch happened, runs the out ramp again from where the values stand).
 * With `calm` (reduced motion) it is a plain short fade to and from black, no cel.
 */
export class SceneFade<T> {
  cel = 0;
  black = 0;
  /** The scene the transition is heading for (not yet switched to), or null. */
  pending: T | null = null;
  private phase: "idle" | "out" | "cut" | "hold" | "in" = "idle";
  private holdLeft = 0;
  private waited = 0;

  /**
   * True from the switch frame until the fade-in starts: the new scene is built but hidden behind black, so the
   * caller holds its sim (a slow first-use warm-up must not play the scene's opening unseen).
   */
  get holding(): boolean {
    return this.phase === "hold";
  }

  request(target: T): void {
    this.pending = target;
    this.phase = "out";
  }

  /** Advance by `dt` wall seconds; returns the target on the frame after the screen first is black, else null. */
  frame(dt: number, calm: boolean, wait = false): T | null {
    switch (this.phase) {
      case "idle":
        return null;
      case "out": {
        if (!calm) this.cel = Math.min(1, this.cel + dt / FADE.out);
        // Black starts once the cel pulse peaked (at once when calm, or when a retarget finds black already up).
        if (calm || this.cel >= 1 || this.black > 0) this.black = Math.min(1, this.black + dt / (calm ? FADE.calm : FADE.cut));
        if (this.black < 1 || (!calm && this.cel < 1)) return null;
        this.phase = "cut";
        return null;
      }
      case "cut": {
        // A black frame has been drawn: the switch's hitch holds that frame on screen.
        const target = this.pending;
        this.pending = null;
        this.phase = "hold";
        this.holdLeft = FADE.hold;
        this.waited = 0;
        return target;
      }
      case "hold":
        // Black stays up while the new scene's first-use warm-up runs (its link stall and its one stray draw onto the
        // canvas), up to `waitMax`, then for `hold` more so the stray frame is overdrawn black.
        if (wait && (this.waited += dt) < FADE.waitMax) this.holdLeft = FADE.hold;
        else this.holdLeft -= dt;
        if (this.holdLeft <= 0) this.phase = "in";
        return null;
      case "in":
        this.black = Math.max(0, this.black - dt / (calm ? FADE.calm : FADE.inBlack));
        this.cel = Math.max(0, this.cel - dt / FADE.inCel);
        if (this.black === 0 && this.cel === 0) this.phase = "idle";
        return null;
    }
  }
}

import type { SprayTool } from "../hud/hud-store.ts";
import type { LookData } from "../net/look-codec.ts";
import { SPRAY_PALETTE, type CarPart, type PersonPick } from "../match/look-data.ts";
import { EngineShare } from "./engine-share.ts";
import { SPRAY_RADIUS } from "./garage.ts";
import type { SprayTarget } from "./player-looks.ts";

/**
 * The garage's controls (its HUD panel) and the player looks netplay carries: the player's own picks and spray, and each
 * peer's look worn on its car and driver (`MSG.look`). Choices live in this page (the picks in its URL, the spray in
 * localStorage) and travel to other players once, when they join.
 */
export abstract class EngineGarage extends EngineShare {
  /** Car part `part` takes colour `colour` (sRGB), or (null) its own again. */
  setCarColour(part: CarPart, colour: number | null): void {
    this.wearPicks({ ...this.looks.mine.car, [part]: colour }, this.looks.mine.person);
  }

  /** The player's driver takes `pick`'s fields. */
  setPersonPick(pick: Partial<PersonPick>): void {
    this.wearPicks(this.looks.mine.car, { ...this.looks.mine.person, ...pick });
  }

  /** The spray can: on or off, its radius (m, clamped to `SPRAY_RADIUS`), its palette colour (never bare). */
  setSprayTool(tool: Partial<SprayTool>): void {
    if (!this.garage) return;
    const t = this.garage.tool;
    if (tool.on !== undefined) t.on = tool.on;
    if (tool.radius !== undefined) t.radius = Math.min(SPRAY_RADIUS.max, Math.max(SPRAY_RADIUS.min, tool.radius));
    if (tool.colour !== undefined && tool.colour >= 1 && tool.colour < SPRAY_PALETTE.length) t.colour = Math.floor(tool.colour);
    this.emitHud();
  }

  /** `target`'s spray comes off, here and in storage. */
  clearSpray(target: SprayTarget): void {
    this.looks.sprayOf(target).load(null);
    this.looks.save(target);
    this.restyle();
  }

  protected playerLook(): LookData {
    return this.looks.data();
  }

  protected wearLook(i: number, look: LookData | null): void {
    this.looks.wear(i, look);
    const car = this.cars[i];
    if (car) this.dressCar(car);
  }

  protected dropLooks(): void {
    const peers = [...this.looks.peerCars()];
    this.looks.drop();
    for (const i of peers) {
      const car = this.cars[i];
      if (car) this.dressCar(car);
    }
  }
}

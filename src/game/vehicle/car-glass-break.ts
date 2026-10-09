import * as THREE from "three";
import { CarCore, type GlassName, type GlassPane } from "./car-core.ts";

/**
 * A car's panes as events and queries: a pane cracks or shatters (the frame strain in `CarParts.evaluateBreakage`, a thrown
 * torso, a net state), and reports its state and world centre.
 */
export abstract class CarGlass extends CarCore {
  /** Pane `g` bursts: hidden, its shards thrown from where it stood at the car's velocity there (`onGlass`). */
  protected shatterGlass(g: GlassPane): void {
    g.state = "shattered";
    g.mesh.visible = false;
    this.group.updateMatrixWorld();
    const origin = new THREE.Vector3();
    g.mesh.getWorldPosition(origin);
    origin.y += 0.12;
    const vel = this.pointVelocity(origin, new THREE.Vector3());
    vel.y += 1.5 + Math.abs(this.angular.x) * 2;
    this.onGlass?.(origin, vel, 56);
  }

  /** Pane `g` cracks: the crack map over a hazier pane. Every crack goes through here (the frame strain, a thrown torso, a net state). */
  protected crackGlass(g: GlassPane): void {
    g.state = "cracked";
    this.wearGlass(g, "cracked");
  }

  /**
   * A thrown driver's torso struck pane `name` (`RagdollSystem`): an intact pane cracks and holds, a cracked one (by a
   * torso or by its frame's strain) shatters. False if it was already gone. Authority only, as `smashGlass`.
   */
  hitGlass(name: GlassName): boolean {
    for (const g of this.glassPanes) {
      if (g.name !== name) continue;
      if (g.state === "shattered") return false;
      if (g.state === "intact") this.crackGlass(g);
      else this.shatterGlass(g);
      return true;
    }
    return false;
  }

  /** Every pane's state, 2 bits each in `GLASS_NAMES` order: 0 intact, 1 cracked, 2 shattered (the net state's `glass`). */
  glassBits(): number {
    let glass = 0;
    for (let i = 0; i < this.glassPanes.length; i++) {
      const s = this.glassPanes[i]!.state;
      glass |= (s === "cracked" ? 1 : s === "shattered" ? 2 : 0) << (i * 2);
    }
    return glass;
  }

  /** Shatter pane `name` now (a driver thrown through it); false if it is already gone. Call it on the
   *  authority only: netplay carries the pane to clients in the glass bits. */
  smashGlass(name: GlassName): boolean {
    const g = this.glassPanes.find((p) => p.name === name);
    if (!g || g.state === "shattered") return false;
    this.shatterGlass(g);
    return true;
  }

  /** World centre of pane `name` (its rest shape's box centre on its current seat). */
  glassWorld(name: GlassName, out: THREE.Vector3): THREE.Vector3 {
    const g = this.glassPanes.find((p) => p.name === name)!;
    const geo = g.mesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    g.mesh.updateWorldMatrix(true, false);
    return geo.boundingBox!.getCenter(out).applyMatrix4(g.mesh.matrixWorld);
  }
}

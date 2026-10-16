import * as THREE from "three";
import { DummyMesh } from "../present/ragdoll-mesh.ts";
import { ShowcaseArt } from "../present/showcase-art.ts";

/** The screen box the pointer's client coordinates are read in (the canvas's `getBoundingClientRect`). */
type Rect = { readonly left: number; readonly top: number; readonly width: number; readonly height: number };

const _ndc = new THREE.Vector2();

/**
 * The showcase's runtime (`#scene=showcase`, reachable by link only): its set (`ShowcaseArt`) and the press that knocks a figure
 * over. A press on a standing figure hands him to `knock` (the ragdoll world takes him, as it takes a guard a car runs down) and
 * the set lets him go; a press elsewhere still turns the camera. A reset stands everyone up again.
 */
export class Showcase {
  readonly art = new ShowcaseArt();
  private readonly camera: THREE.Camera;
  private readonly rect: () => Rect;
  private readonly knock: (slot: number) => boolean;
  private readonly ray = new THREE.Raycaster();

  /** `knock(slot)`: hand figure `slot` to the ragdoll world; whether it took him. */
  constructor(camera: THREE.Camera, rect: () => Rect, knock: (slot: number) => boolean) {
    this.camera = camera;
    this.rect = rect;
    this.knock = knock;
  }

  down(x: number, y: number): boolean {
    const r = this.rect();
    _ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(_ndc, this.camera);
    const hit = this.ray.intersectObject(this.art.people.group, true).find((h) => h.object instanceof DummyMesh);
    if (hit?.instanceId === undefined) return false;
    if (this.knock(hit.instanceId)) this.art.take(hit.instanceId);
    return true;
  }

  move(): void {}

  up(): void {}

  dispose(): void {
    this.art.dispose();
  }
}

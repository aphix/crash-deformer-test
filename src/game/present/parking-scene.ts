import * as THREE from "three";

/**
 * A scene that keeps its hidden direct children out of the graph. A hidden rig, arena or pooled car that stayed a child still
 * cost the renderer's matrix pass every frame (three walks `children` whatever `visible` says); parked, it costs nothing.
 * `visible` stays the one switch the owners use: `sync` takes the hidden children out and brings the shown parked ones back.
 */
export class ParkingScene extends THREE.Scene {
  private readonly parked: THREE.Object3D[] = [];

  /** Once a frame before the renderer's matrix pass: shown parked children come back; hidden children go out unless `takeOutHidden` is false (a warm-up needs them all in the graph). Lights stay children: their count and order key the lit programs. */
  sync(takeOutHidden: boolean): void {
    const parked = this.parked;
    for (let i = parked.length - 1; i >= 0; i--) {
      const object = parked[i]!;
      if (!object.visible) continue;
      parked.splice(i, 1);
      super.add(object);
      object.updateMatrixWorld(true);
    }
    if (!takeOutHidden) return;
    const children = this.children;
    for (let i = children.length - 1; i >= 0; i--) {
      const object = children[i]!;
      if (object.visible || (object as THREE.Light).isLight) continue;
      super.remove(object);
      parked.push(object);
    }
  }

  /** Every parked child back in the graph (the warm-up draws everything, shown or not). */
  unparkAll(): void {
    for (const object of this.parked) super.add(object);
    this.parked.length = 0;
  }

  /** The parked children are the scene's too: dispose and the Ultra restyle walk them. */
  override traverse(callback: (object: THREE.Object3D) => unknown): void {
    super.traverse(callback);
    for (const object of this.parked) object.traverse(callback);
  }

  override add(...objects: THREE.Object3D[]): this {
    for (const object of objects) this.forget(object);
    return super.add(...objects);
  }

  override remove(...objects: THREE.Object3D[]): this {
    for (const object of objects) this.forget(object);
    return super.remove(...objects);
  }

  override clear(): this {
    this.parked.length = 0;
    return super.clear();
  }

  private forget(object: THREE.Object3D): void {
    const at = this.parked.indexOf(object);
    if (at >= 0) this.parked.splice(at, 1);
  }
}

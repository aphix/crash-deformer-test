import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { CAR_STYLES } from "../vehicle/car-variants.ts";
import { CLASS_LIFT } from "../vehicle/constants.ts";
import type { CageFields, CageStyle } from "./ragdoll-proxy.ts";
import {
  CAR_FLAGS,
  CAR_FLOATS,
  CAR_GLASS,
  CAR_LIFT_POSITION,
  CAR_LIFT_QUATERNION,
  CAR_POSITION,
  CAR_QUATERNION,
  CAR_SPEED,
  CAR_VELOCITY,
  FLAG_FALLING,
  FLAG_LIFT,
  FLAG_VAPORIZED,
  type CageMessage,
} from "./ragdoll-wire.ts";

/** What the dummies' world fits a car's proxy to: the cage's serial, its fields, its style, and its plan field. */
export interface CageView {
  readonly serial: number;
  readonly fields: CageFields;
  readonly style: CageStyle;
  planField(): Float32Array;
}

/**
 * What the dummies' world reads of a car: its pose and motion, its glass, and the cage its proxy is fitted to. A
 * `DeformableCar` is one; in the world's worker a `RemoteCar` stands in for each. `cage` null: not sent yet, so no proxy.
 * `classLift`: the class body's lift (m), where the car's class is not its style's. The world never writes to a car: a pane it
 * strikes is reported (`CarProxies.strikes`) and the sim applies it `LAG` frames later.
 */
export type RagCar = Pick<DeformableCar, "group" | "velocity" | "speed" | "falling" | "vaporized" | "style" | "glassBits"> & {
  readonly cage: CageView | null;
  readonly classLift?: number;
};

/** A car as the world's thread has it: what the main thread sent with the last frame (`setFrame`) and its last cage (`setCage`). */
export class RemoteCar implements RagCar {
  readonly group = new THREE.Group();
  readonly velocity = new THREE.Vector3();
  speed = 0;
  falling = false;
  vaporized = false;
  style = CAR_STYLES.sedan;
  classLift = 0;
  cage: CageView | null = null;
  /** The cage's own plan field, read by `CageView.planField`. */
  private plan: Float32Array = new Float32Array(0);
  private readonly lift = new THREE.Object3D();
  private frameBits = 0;
  /** Which car of the main thread this stands for (`CageMessage.car`; 0: none sent yet). */
  readonly token: number;
  /** Counts the cages received: each is a new fit, whatever serial the car's own cage had. */
  private version = 0;

  constructor(token: number) {
    this.token = token;
    this.lift.name = CLASS_LIFT;
  }

  setCage(m: CageMessage): void {
    this.style = CAR_STYLES[m.style];
    this.classLift = m.classLift;
    this.plan = m.plan;
    this.cage = {
      serial: ++this.version,
      fields: { top: m.top, covered: m.covered, planBox: m.planBox, heightMax: m.heightMax },
      style: { step: m.step, nu: m.nu, nv: m.nv, u0: m.u0, v0: m.v0 },
      planField: () => this.plan,
    };
  }

  /** Car record `n` of `cars`. */
  setFrame(cars: Float64Array, n: number): void {
    const o = n * CAR_FLOATS;
    this.group.position.fromArray(cars, o + CAR_POSITION);
    this.group.quaternion.fromArray(cars, o + CAR_QUATERNION);
    this.velocity.fromArray(cars, o + CAR_VELOCITY);
    this.speed = cars[o + CAR_SPEED]!;
    const flags = cars[o + CAR_FLAGS]!;
    this.falling = (flags & FLAG_FALLING) !== 0;
    this.vaporized = (flags & FLAG_VAPORIZED) !== 0;
    if ((flags & FLAG_LIFT) !== 0) {
      this.lift.position.fromArray(cars, o + CAR_LIFT_POSITION);
      this.lift.quaternion.fromArray(cars, o + CAR_LIFT_QUATERNION);
      if (this.lift.parent === null) this.group.add(this.lift);
    } else if (this.lift.parent !== null) this.group.remove(this.lift);
    this.frameBits = cars[o + CAR_GLASS]!;
  }

  glassBits(): number {
    return this.frameBits;
  }
}

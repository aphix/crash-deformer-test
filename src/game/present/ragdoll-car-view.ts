import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import type { GlassName } from "../vehicle/car-core.ts";
import { GLASS_NAMES } from "../vehicle/car-glass.ts";
import { CAR_STYLES } from "../vehicle/car-variants.ts";
import { CLASS_LIFT } from "../vehicle/constants.ts";
import type { CageFields, CageStyle } from "./ragdoll-proxy.ts";
import { PANE_GONE } from "./ragdoll-proxy.ts";
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
  LAG,
  type CageMessage,
  type GlassHit,
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
 * `classLift`: the class body's lift (m), where the car's class is not its style's.
 */
export type RagCar = Pick<DeformableCar, "group" | "velocity" | "speed" | "falling" | "vaporized" | "style" | "refitCage" | "glassBits" | "hitGlass"> & {
  readonly cage: CageView | null;
  readonly classLift?: number;
};

/** The state of pane `pane` in glass bits `bits` (`CarGlass.glassBits`: 0 intact, 1 cracked, 2 gone). */
const paneState = (bits: number, pane: number): number => (bits >> (2 * pane)) & 3;

/**
 * A car as the world's thread has it: what the main thread sent with the last frame (`setFrame`) and its last cage (`setCage`).
 * A pane the world strikes shows its new state at once (`overlay`), the main thread's glass catching up `LAG` frames later; the
 * strike goes to the main thread as a `GlassHit` (`hitGlass`), which applies it to the real car.
 */
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
  private frameSeq = 0;
  /** Panes struck here that the main thread's glass has not shown yet: the frame struck in, the pane, its new state. */
  private overlay: { seq: number; pane: number; state: number }[] = [];
  private readonly slot: number;
  private readonly hits: GlassHit[];
  /** Which car of the main thread this stands for (`CageMessage.car`; 0: none sent yet). */
  readonly token: number;
  /** Counts the cages received: each is a new fit, whatever serial the car's own cage had. */
  private version = 0;

  constructor(slot: number, hits: GlassHit[], token: number) {
    this.slot = slot;
    this.hits = hits;
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

  /** Car record `n` of `cars` (frame `seq`'s). */
  setFrame(cars: Float64Array, n: number, seq: number): void {
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
    this.frameSeq = seq;
    this.overlay = this.overlay.filter((s) => s.seq + LAG > seq);
  }

  refitCage(): boolean {
    return false;
  }

  glassBits(): number {
    let bits = this.frameBits;
    for (const s of this.overlay) if (paneState(bits, s.pane) < s.state) bits = (bits & ~(3 << (2 * s.pane))) | (s.state << (2 * s.pane));
    return bits;
  }

  hitGlass(name: GlassName): boolean {
    const pane = GLASS_NAMES.indexOf(name);
    const state = paneState(this.glassBits(), pane);
    if (state === PANE_GONE) return false;
    this.overlay.push({ seq: this.frameSeq, pane, state: state + 1 });
    this.hits.push({ car: this.slot, pane });
    return true;
  }
}

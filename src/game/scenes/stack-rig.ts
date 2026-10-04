import type { DeformableCar } from "../vehicle/car.ts";
import { ROOF_REST_Y } from "../vehicle/car-parts.ts";
import { bodyTopY } from "../vehicle/car-mesh.ts";
import type { BodyStyle } from "../vehicle/car-variants.ts";

/**
 * The stack scene (docs/LOAD_CRUSH.md): cars dropped one at a time onto a base car, so the bottom roof crushes by the
 * weight above it. The physics is the headless test's (`vehicle/stack-crush.test.ts`): the same world step, the same
 * load crush; only the drop is sequential.
 */

export type StackConfig = {
  /** Cars in the finished stack, the base car included. */
  cars: number;
  /** Gap (m) from the stack's top to the belly of the car about to fall. */
  drop: number;
  /** Seconds from one drop to the next, and from the last drop to the loop's restart. */
  gap: number;
};

/** The test's own values: `stack(4)` (cars), `GAP = 0.02` (drop), `SETTLE_S = 8` (gap). */
export const STACK_DEFAULTS: Readonly<StackConfig> = { cars: 4, drop: 0.02, gap: 8 };

/** Slider and share-URL bounds: the owner's perf smoke tests run 10 to 20 cars. */
export const STACK_RANGES = {
  cars: { min: 2, max: 20 },
  drop: { min: 0.02, max: 2 },
  gap: { min: 1, max: 20 },
} as const;

/** Seconds from the scene's start to the first drop: the empty base car shows first. */
const LEAD_S = 1;
/** A car's belly over its origin (m): its roof's height less this is the room a car above it stands in (the test's 1.17 m for a 1.3 m roof). */
const BELLY_Y = 0.13;
const G = 9.81;

const roofTops = new WeakMap<BodyStyle, number>();

/** Highest point of a body style's roof along its centreline (m over the car's origin), the surface a car above stands on. */
function roofTop(style: BodyStyle): number {
  let top = roofTops.get(style);
  if (top === undefined) {
    top = 0;
    for (let z = -2.2; z <= 2.2; z += 0.1) top = Math.max(top, bodyTopY(0, z, style) || 0);
    roofTops.set(style, top);
  }
  return top;
}

/** The opening orbit shot for a finished stack of `n` cars (one car adds about 1.17 m): looking at the base car's roof, far enough back for the whole tower. */
export function stackShot(n: number): { lookY: number; radius: number; pitch: number } {
  return { lookY: 0.65, radius: Math.min(30, Math.max(12, (n * 1.17 + BELLY_Y) * 1.3)), pitch: 0.32 };
}

export class StackRig {
  config: StackConfig = { ...STACK_DEFAULTS };
  /** Cars in the stack so far, the base car included. */
  dropped = 1;

  /** A fresh run: the base car alone. */
  restart(): void {
    this.dropped = 1;
  }

  /**
   * Where the run stands at sim time `t` (s the physics has stepped since the restart): "drop" when the next car falls now
   * (`dropped` already counts it), "loop" once the finished stack has had its last gap. Drops are on the physics clock, so
   * a slow frame that steps less does not drop ahead of the stack.
   */
  step(t: number): "drop" | "loop" | null {
    const { cars, gap } = this.config;
    if (this.dropped < cars) {
      if (t < LEAD_S + (this.dropped - 1) * gap) return null;
      this.dropped++;
      return "drop";
    }
    return t >= LEAD_S + (cars - 1) * gap ? "loop" : null;
  }
}

/** Stand car `k` (hidden or spent) upright over the roof of the stack below it (`cars[0..k-1]`), `drop` m clear, falling. */
export function placeDrop(cars: readonly DeformableCar[], k: number, drop: number): void {
  let top = 0;
  for (let i = 0; i < k; i++) top = Math.max(top, cars[i]!.group.position.y + roofTop(cars[i]!.style) - BELLY_Y);
  const car = cars[k]!;
  car.group.visible = true;
  car.spawnFacing(0, 0, 0, 0);
  car.group.position.y = top + drop;
  car.airborne = true;
  // The load crush reads the car below's matrixWorld in the next step; the renderer's update comes after it.
  car.group.updateMatrixWorld(true);
}

/** How far (m) a car may sit off the axis of the car under it and still stand on it. */
const COLUMN_OFFSET = 0.6;
/** Origin-to-origin height (m) of a car standing on the one under it: a crushed roof and a low body 0.9 m, a tall one with a clear drop 1.5 m. */
const COLUMN_RISE = { min: 0.6, max: 1.5 } as const;
/** Face-up: the car's up axis within about 25 degrees of vertical (`matrixWorld` Y component). */
const UPRIGHT = 0.9;

/**
 * Per car in the stack (bottom first): the weight above it (kN) and its roof's sink (mm), read off the sim's cars. Load
 * counts the cars still standing in the column on the base car, each upright, within `COLUMN_OFFSET` of the car under
 * it and one car's height above it; a car off the column (toppled, fallen, still in the air) carries and reads null.
 * The load-crush step's own force is per slice and is not kept, so the column is read from the poses.
 */
export function stackLoads(cars: readonly DeformableCar[], n: number): { loadKn: (number | null)[]; crushMm: number[] } {
  let column = 1;
  while (column < n && stands(cars[column - 1]!, cars[column]!)) column++;
  const loadKn: (number | null)[] = [];
  const crushMm: number[] = [];
  let above = 0;
  for (let i = n - 1; i >= 0; i--) {
    const c = cars[i]!;
    if (i < column) {
      loadKn[i] = (above * G) / 1000;
      above += c.deform.totalMass;
    } else loadKn[i] = null;
    crushMm[i] = (ROOF_REST_Y - c.deform.massLocal("roof").y) * 1000;
  }
  return { loadKn, crushMm };
}

/** Whether `upper` stands on `lower`: upright, near its axis and one car's height over it. */
function stands(lower: DeformableCar, upper: DeformableCar): boolean {
  const a = lower.group.position;
  const b = upper.group.position;
  const rise = b.y - a.y;
  return upper.group.matrixWorld.elements[5]! > UPRIGHT && Math.hypot(b.x - a.x, b.z - a.z) < COLUMN_OFFSET && rise > COLUMN_RISE.min && rise < COLUMN_RISE.max;
}

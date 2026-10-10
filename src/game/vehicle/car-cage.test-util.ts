import type { CarCage, CageLive } from "./car-cage.ts";
import { CageRig } from "./car-cage-rig.ts";
import type { DeformableCar } from "./car.ts";
import { cellI, cellJ, cellX, cellZ, type DrawnField, NX, type Region, reliefGap, type TopGaps } from "./drawn-body.test-util.ts";
import { CLASSES, carClass } from "./vehicle-classes.ts";

export { cageOf, cageSourceOf } from "./car-cage-rig.ts";

/** A fresh `CageLive` of `car` as it stands: what a `CageRig` reads off the car at its refit (allocates). */
export function cageLiveOf(car: DeformableCar): CageLive {
  const rig = new CageRig(car);
  rig.refit();
  return rig.live;
}

/**
 * Re-bakes `car`'s skin from its masses as they are now (so the drawn mesh and the inputs below are one bake) and fits `cage` to it. A
 * car's own refit runs at the sim's bake (`DeformableCar.stepBreakage`), so it needs none of this.
 */
export function fitToDrawn(car: DeformableCar, cage: CarCage): boolean {
  car.deform.bakeSkin();
  car.flushDeferredSkin();
  car.updateSkin();
  car.flushDeferredSkin();
  return cage.refit(cageLiveOf(car));
}

/** The height (m) the car's class body stands at over the car's origin: where the cage's heights (the body mesh's frame) sit in the car's frame. */
export function bodyLift(car: DeformableCar): number {
  const body = car.group.getObjectByName("classLift");
  return body === undefined || body === null ? CLASSES[carClass(car)].lift : body.position.y;
}

/** Bilinear height of node field `field` at car-frame (x, z); NaN when any of the four nodes has none. */
export function fieldAt(cage: CarCage, field: Float32Array, x: number, z: number): number {
  const { step, nu, nv, u0, v0 } = cage.style;
  const fu = (x - u0) / step;
  const fv = (z - v0) / step;
  const i = Math.floor(fu);
  const j = Math.floor(fv);
  if (i < 0 || j < 0 || i + 1 >= nu || j + 1 >= nv) return NaN;
  const a = fu - i;
  const b = fv - j;
  const k = j * nu + i;
  return (field[k]! * (1 - a) + field[k + 1]! * a) * (1 - b) + (field[k + nu]! * (1 - a) + field[k + nu + 1]! * a) * b;
}

/**
 * The cage's top (or bottom) over each drawn top cell of `region` against the drawn top (cage minus drawn, + is the cage above the
 * drawn body), in the car's own frame; `missing` counts cells where the cage has no height. A gap is read against the drawn
 * relief (`reliefGap`), as `gapsOver` reads the surface other cars stand on.
 */
export function cageGaps(car: DeformableCar, cage: CarCage, drawn: DrawnField, region: Region, which: "top" | "bottom" = "top"): TopGaps {
  const lift = bodyLift(car);
  const field = which === "top" ? cage.fields.top : cage.fields.bottom;
  const reference = which === "top" ? drawn.top : drawn.bottom;
  const gaps: number[] = [];
  let missing = 0;
  let worstUp = 0;
  let worstDown = 0;
  for (let j = cellJ(region.z0); j <= cellJ(region.z1); j++) {
    for (let i = cellI(region.x0); i <= cellI(region.x1); i++) {
      const y = reference[j * NX + i]!;
      if (!Number.isFinite(y)) continue;
      const h = fieldAt(cage, field, cellX(i), cellZ(j));
      if (!Number.isFinite(h)) {
        missing++;
        continue;
      }
      const gap = reliefGap(reference, i, j, h + lift - y);
      gaps.push(gap);
      worstUp = Math.max(worstUp, gap);
      worstDown = Math.min(worstDown, gap);
    }
  }
  const sorted = gaps.map(Math.abs).sort((p, q) => p - q);
  return { cells: gaps.length + missing, p95: sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!, worstUp, worstDown, missing };
}


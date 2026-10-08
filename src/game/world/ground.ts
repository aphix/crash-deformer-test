import { SURFACE_IDS, type SurfaceId } from "./catalog.ts";
import { activate, C_GRIP, C_NX, C_NY, C_NZ, C_SURF, contactIn, heightIn, HIT_SIZE, PQ_SIZE, PQ_X, PQ_Y, PQ_Z, Surface } from "./surfaces.ts";

/** A surface this far (m) above a body still counts as under it (kerbs, ramp lips, a wreck's dropped hub). */
export const STEP_UP = 1.2;

/**
 * `heightAt` past the fleet disc's rim: no floor, the body falls. Every clamp of the form
 * `clamp(y, floor, floor + k)` or `y < floor + k` must test for it first (`floor + k` stays -Infinity).
 */
export const NO_FLOOR = -Infinity;

/** Radius (m) of the fleet scene's asphalt disc (`WorldStage`'s ground mesh, sandbox marks). */
export const DISC_RADIUS = 48;

const _out = new Float64Array(HIT_SIZE);
const _q = new Float64Array(PQ_SIZE);

/** `contactIn` of `g` at (x, z) asked from y, into `_out` (the point goes in a typed array: no boxed doubles cross the call). */
function ask(g: Ground, x: number, z: number, y: number): void {
  _q[PQ_X] = x;
  _q[PQ_Z] = z;
  _q[PQ_Y] = y;
  contactIn(g, _q, _out);
}

/**
 * The world's ground: a scene's static set of solid surfaces (what `setGround` loads), asked by height, up-normal, grip and
 * surface at a ground point (x, z). Physics, wheels and FX read the active ground through `activeGround()`; a race track swaps
 * in its baked heightfield with `setGround` and restores `FLAT_GROUND` (y = 0 asphalt, grip 1) when it leaves. The fleet scene
 * sets `DISC_GROUND`: that plane ends at the disc's rim.
 *
 * Where roads cross (a bridge over a road) there are two surfaces at one (x, z). Every query takes the asking body's current
 * height `y`: the answer is the highest surface at most its patch's reach above it (`STEP_UP` for a deck or a kerb), so a car
 * under a bridge sees the road and a car on it sees the deck. Omitting `y` answers for the top surface. The four queries are
 * one-line readings of `contactIn` (`world/surfaces.ts`): the one answer every body gets.
 */
export class Ground extends Surface {
  /** Surface height (m) at world (x, z); `NO_FLOOR` where nothing is under the body. */
  heightAt(x: number, z: number, y = Infinity): number {
    _q[PQ_X] = x;
    _q[PQ_Z] = z;
    _q[PQ_Y] = y;
    return heightIn(this, _q);
  }

  /** Writes the unit up-normal at (x, z) into `out` and returns it. */
  normalAt<T extends { x: number; y: number; z: number }>(x: number, z: number, out: T, y = Infinity): T {
    ask(this, x, z, y);
    out.x = _out[C_NX]!;
    out.y = _out[C_NY]!;
    out.z = _out[C_NZ]!;
    return out;
  }

  /** Grip multiplier at (x, z): 1 = dry asphalt (today's μ), gravel ≈ 0.6, grass ≈ 0.5, 0 over `NO_FLOOR`. */
  frictionAt(x: number, z: number, y = Infinity): number {
    ask(this, x, z, y);
    return _out[C_GRIP]!;
  }

  /** Index into `SURFACE_IDS` of the surface at (x, z). */
  surfaceIndex(x: number, z: number, y = Infinity): number {
    ask(this, x, z, y);
    return _out[C_SURF]!;
  }

  /** Surface material at (x, z) (`SURFACES` in world/catalog.ts has its grip, speed and colour). */
  surfaceAt(x: number, z: number, y = Infinity): SurfaceId {
    return SURFACE_IDS[this.surfaceIndex(x, z, y)]!;
  }
}

/** y = 0 asphalt, grip 1, under everything. */
class FlatGround extends Ground {
  constructor() {
    super();
    this.addPlane(0, -1e7, 1e7, -1e7, 1e7, Infinity);
  }
}

/** The fleet scene: `FLAT_GROUND` inside the disc's rim, `NO_FLOOR` (grip 0) past it; a body sunk past `STEP_UP` below its top is beside it. */
class DiscGround extends Ground {
  constructor() {
    super();
    this.addPlane(0, -DISC_RADIUS, DISC_RADIUS, -DISC_RADIUS, DISC_RADIUS, STEP_UP, DISC_RADIUS);
  }
}

export const FLAT_GROUND: Ground = new FlatGround();
export const DISC_GROUND: Ground = new DiscGround();

let active: Ground = FLAT_GROUND;
activate(active);

export function activeGround(): Ground {
  return active;
}

/** `null` restores the flat plane. */
export function setGround(g: Ground | null): void {
  active = g ?? FLAT_GROUND;
  activate(active);
}

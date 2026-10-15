import { DERBY_RADIUS } from "../scenes/derby-arena.ts";
import { DERBY_BOXES, DERBY_PROP } from "../scenes/derby-ground.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { CAR_HALF } from "../vehicle/car-mesh.ts";
import { activeGround, FLAT_GROUND } from "../world/ground.ts";
import { occluder, type Occluder, type Sight } from "./spectate-cam.ts";

/** A reusable list of occluders for a scene whose solids move: entries are overwritten in place, so a frame allocates nothing once the pool has grown to the scene. */
export class OccluderPool {
  /** Every pooled entry: the first `used` are this frame's, the rest are parked (`y0` = Infinity, which `inside` never reaches). */
  readonly list: Occluder[] = [];
  private used = 0;

  begin(): void {
    this.used = 0;
  }

  add(x: number, z: number, cos: number, sin: number, hx: number, hz: number, circle: boolean, y0: number, y1: number): void {
    let o = this.list[this.used];
    if (!o) {
      o = occluder(0, 0, 0, 0, 0, false, 0, 0);
      this.list.push(o);
    }
    o.x = x;
    o.z = z;
    o.cos = cos;
    o.sin = sin;
    o.hx = hx;
    o.hz = hz;
    o.circle = circle;
    o.y0 = y0;
    o.y1 = y1;
    this.used++;
  }

  /** Parks every entry past the ones added since `begin`. */
  end(): void {
    for (let i = this.used; i < this.list.length; i++) this.list[i]!.y0 = Infinity;
  }
}

/** The derby bowl's free-standing prisms (tyre berms, containers, rails, pads) as occluders; its ring wall is the Sight's `rim`. */
const DERBY_OCCLUDERS: readonly Occluder[] = DERBY_BOXES.filter((b) => b.kind !== DERBY_PROP.wall).map((b) => occluder(b.x, b.z, b.yaw, b.hx, b.hz, false, 0, b.height));

const NO_CARS: readonly DeformableCar[] = [];

/**
 * The one Sight a chase, rear or orbit eye keeps its line clear of (`EyeClear`), rebuilt in place each frame: the scene's own
 * solids (a course's, the derby bowl's, the sandbox's) and, in `cars`, every other visible car's tight box (`CAR_HALF`'s footprint
 * turned with its flat heading, floor to roof). No allocation once the pools have grown.
 */
export class ChaseSolids {
  private readonly boxes = new OccluderPool();
  private readonly sandbox = new OccluderPool();
  private readonly sight: Sight = { ground: FLAT_GROUND, path: null, wallTop: 0, rim: Infinity, occ: [], cars: this.boxes.list };
  /** `fillSandbox` writes the sandbox's own solids (lamp poles, the barrier, the balls, the Lab's wall) into the pool it is given. */
  private readonly fillSandbox: (pool: OccluderPool) => void;

  constructor(fillSandbox: (pool: OccluderPool) => void) {
    this.fillSandbox = fillSandbox;
  }

  /** The sight for this frame: `course` (a race's solids) if there is one, else the derby bowl's or the sandbox's; `cars` (empty: none) but `except` stand in it too. Valid until the next call. */
  frame(course: Sight | null, derby: boolean, cars: readonly DeformableCar[] | null, except: DeformableCar | null): Sight {
    const list = cars ?? NO_CARS;
    this.boxes.begin();
    for (let i = 0; i < list.length; i++) {
      const car = list[i]!;
      if (car === except || car.vaporized || !car.group.visible) continue;
      const p = car.group.position;
      this.boxes.add(p.x, p.z, car.fwdFlat.z, car.fwdFlat.x, CAR_HALF.x, CAR_HALF.z, false, p.y, p.y + 2 * CAR_HALF.y);
    }
    this.boxes.end();
    const s = this.sight;
    if (course) {
      s.ground = course.ground;
      s.path = course.path;
      s.wallTop = course.wallTop;
      s.rim = course.rim;
      s.occ = course.occ;
      s.grid = course.grid;
      return s;
    }
    s.ground = activeGround();
    s.path = null;
    s.wallTop = 0;
    s.grid = undefined;
    if (derby) {
      s.rim = DERBY_RADIUS;
      s.occ = DERBY_OCCLUDERS;
      return s;
    }
    s.rim = Infinity;
    this.sandbox.begin();
    this.fillSandbox(this.sandbox);
    this.sandbox.end();
    s.occ = this.sandbox.list;
    return s;
  }
}

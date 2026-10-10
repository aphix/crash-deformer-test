/** Shared spawn layout so 1–N cars never start overlapping. */

import { hypot2, detSin, detCos } from "../kernel/physics-core.js";
import { FLEET_STYLE_IDS, type CarStyleId } from "../vehicle/car-variants.ts";
import { CLASSES, STYLE_CLASS, type VehicleClassId } from "../vehicle/vehicle-classes.ts";

/** Car pool size: the per-car typed arrays (derby/race AI, race, traffic), wheel batch and lamp pool are sized for it,
 *  `setCarCount` clamps to it and the HUD Cars slider stops at it. Set in the initial export (7a09b34), not measured. */
export const MAX_CARS = 32;
/** Closest two fleet spawns sit, centre to centre (m): one 4.44 m car (2 × CAR_HALF.z) plus ~1 m. From the initial
 *  export (7a09b34); fleet.test.ts holds every layout to it and `respawnSlot` keeps it from every other car. */
export const FLEET_MIN_SEP = 5.4;
/** The six lamp posts stand on a ring this far (m) from the pad's centre, at bearings `k / LAMP_POSTS` of a turn from +z (`resetLampPoles`). */
export const LAMP_RING_R = 16;
export const LAMP_POSTS = 6;
/** A spawn keeps this far (m) from every lamp post and from the path its car drives to the centre (a car's half width 1 + the post 0.12 + a margin). */
const LAMP_CLEAR = 2;

/** Whether a car at (x, z) driving straight at the centre passes within `LAMP_CLEAR` of a lamp post (or starts on one). */
function lampInPath(x: number, z: number): boolean {
  const len = hypot2(x, z);
  if (len < 1e-6) return false;
  for (let k = 0; k < LAMP_POSTS; k++) {
    const a = (k / LAMP_POSTS) * Math.PI * 2;
    const px = detSin(a) * LAMP_RING_R;
    const pz = detCos(a) * LAMP_RING_R;
    // The post's position along the spawn-to-centre line, clamped to the segment, and its distance from that line.
    const t = Math.max(0, Math.min(1, (px * x + pz * z) / (len * len)));
    if (hypot2(px - x * t, pz - z * t) < LAMP_CLEAR) return true;
  }
  return false;
}

/** Slot cycle (fleet and derby share the pool): every fleet body style in its own class, then a monster truck. */
const SLOT_STYLES: readonly CarStyleId[] = [...FLEET_STYLE_IDS, CLASSES.monster.style];
const SLOT_CLASSES: readonly VehicleClassId[] = [...FLEET_STYLE_IDS.map((s) => STYLE_CLASS[s]), "monster"];

/** Vehicle class of car slot `i`: any 6+ car field has every class; slot 0 stays a sedan. */
export function fleetClass(i: number): VehicleClassId {
  return SLOT_CLASSES[i % SLOT_CLASSES.length]!;
}

/** Body style of car slot `i`: any 5+ car field shows every style; slot 0 stays the sedan. */
export function fleetStyle(i: number): CarStyleId {
  return SLOT_STYLES[i % SLOT_STYLES.length]!;
}

/** A car's body and how it drives. */
export type CarType = { cls: VehicleClassId; style: CarStyleId };

/**
 * What car slot `i` is built as: slot 0 is the player's pick, and in the Stack scene every car is, so the tower is one
 * type; otherwise the fleet's cycle (`fleetClass`, `fleetStyle`).
 */
export function slotType(i: number, player: CarType, stack: boolean): CarType {
  return i === 0 || stack ? player : { cls: fleetClass(i), style: fleetStyle(i) };
}

type FleetSlot = { x: number; z: number; speed: number };
export type DerbySlot = { x: number; z: number; yaw: number };

function speedInRange(min: number, max: number, rng: () => number): number {
  const lo = Math.max(0, Math.min(min, max));
  const hi = Math.max(0, Math.max(min, max));
  const span = hi - lo;
  return lo + (span <= 0 ? 0 : rng() * span);
}

/**
 * Place `count` cars on the pad, non-intersecting, aimed at the origin
 * (DeformableCar.spawn lookAt(0,0,0)). 1–2 cars sit opposite for a
 * reliable crash; 3+ scatter on a ring.
 */
export function layoutFleet(
  count: number,
  speedMin: number,
  speedMax: number,
  rng: () => number = Math.random,
): FleetSlot[] {
  const n = Math.max(1, Math.min(MAX_CARS, Math.round(count) || 1));
  const spd = () => speedInRange(speedMin, speedMax, rng);

  if (n === 1) {
    return [{ x: 0, z: 10.5, speed: spd() }];
  }

  if (n === 2) {
    const a = rng() * Math.PI * 2;
    const r = 9.2;
    return [
      { x: detSin(a) * r, z: detCos(a) * r, speed: spd() },
      { x: detSin(a + Math.PI) * r, z: detCos(a + Math.PI) * r, speed: spd() },
    ];
  }

  const slots: FleetSlot[] = [];
  const padR = 7 + Math.min(16, n * 1.1);
  for (let i = 0; i < n; i++) {
    let x = 0;
    let z = 0;
    let placed = false;
    for (let attempt = 0; attempt < 48; attempt++) {
      const ang = rng() * Math.PI * 2;
      const r = 6.4 + rng() * padR;
      x = detSin(ang) * r;
      z = detCos(ang) * r;
      placed = !lampInPath(x, z);
      for (let j = 0; j < i && placed; j++) {
        const o = slots[j]!;
        if (hypot2(x - o.x, z - o.z) < FLEET_MIN_SEP) {
          placed = false;
          break;
        }
      }
      if (placed) break;
    }
    if (!placed) {
      const ang = (i / n) * Math.PI * 2;
      const r = Math.max(8.2, (FLEET_MIN_SEP * n) / (Math.PI * 1.7));
      x = detSin(ang) * r;
      z = detCos(ang) * r;
    }
    slots.push({ x, z, speed: spd() });
  }
  return slots;
}

/** Spread round the bowl, each car stopped and facing its centre (the start lights hold them until green). */
export function layoutDerby(count: number, radius: number, rng: () => number = Math.random): DerbySlot[] {
  const n = Math.max(1, Math.min(MAX_CARS, Math.round(count) || 1));
  const slots: DerbySlot[] = [];
  const r = Math.max(5.5, radius - 5.2);
  const spin = rng() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = spin + (i / n) * Math.PI * 2;
    slots.push({ x: detSin(a) * r, z: detCos(a) * r, yaw: a + Math.PI });
  }
  return slots;
}

/** Fleet disc: a car this far (m) below its top leaves the soft-body sim and falls on as a fake (`beginFakeFall`). */
export const FAKE_DEPTH = 2;
/** Fleet disc: a car this far (m) below its top vaporizes into smoke. */
export const VAPOR_DEPTH = 20;
/** The driven car is back on the disc this long (s) after vaporizing; AI cars stay gone until reset. */
export const RESPAWN_S = 2;
/**
 * Fleet loop: wall seconds the disc stays empty (every car vaporized past the rim) before the run resets. The crash
 * clock's reset only fires after a hit, so a run where no car meets another would otherwise never end. Under
 * `RESPAWN_S`, so the driven car's respawn never keeps the disc from counting as empty.
 */
export const FLEET_EMPTY_S = 1;

/** Whether the fleet's disc has been empty for `FLEET_EMPTY_S`: every car vaporized, the last at `vaporAt` (wall s) per car, `now` wall s. */
export function fleetEmptied(cars: readonly { vaporized: boolean }[], vaporAt: readonly (number | undefined)[], now: number): boolean {
  let last = 0;
  for (let i = 0; i < cars.length; i++) {
    if (!cars[i]!.vaporized) return false;
    last = Math.max(last, vaporAt[i] ?? 0);
  }
  return cars.length > 0 && now - last >= FLEET_EMPTY_S;
}

/** Respawn this far (m) out from the disc's centre. */
const RESPAWN_R = 36;

/**
 * The fleet disc's edge rule for one car this frame at group height `y`: past `FAKE_DEPTH` the real car
 * becomes a falling fake, past `VAPOR_DEPTH` it vaporizes; vaporized for `goneFor` s, only the `driven`
 * car comes back.
 */
export function edgeAction(
  y: number,
  falling: boolean,
  vaporized: boolean,
  driven: boolean,
  goneFor: number,
): "fake" | "vaporize" | "respawn" | null {
  if (vaporized) return driven && goneFor > RESPAWN_S ? "respawn" : null;
  if (y < -VAPOR_DEPTH) return "vaporize";
  return !falling && y < -FAKE_DEPTH ? "fake" : null;
}

/**
 * Where a car that fell off at (x, z) comes back: `RESPAWN_R` out on the bearing it fell from, facing the
 * centre, stepped round the ring until `FLEET_MIN_SEP` clear of every car in `others`.
 */
export function respawnSlot(x: number, z: number, others: readonly { x: number; z: number }[]): DerbySlot {
  let a = Math.atan2(x, z);
  for (let k = 0; k < 24; k++) {
    const sx = detSin(a) * RESPAWN_R;
    const sz = detCos(a) * RESPAWN_R;
    if (!others.some((o) => hypot2(o.x - sx, o.z - sz) < FLEET_MIN_SEP)) break;
    a += 0.27;
  }
  return { x: detSin(a) * RESPAWN_R, z: detCos(a) * RESPAWN_R, yaw: a + Math.PI };
}

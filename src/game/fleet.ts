/** Shared spawn layout so 1–N cars never start overlapping. */

import { FLEET_STYLE_IDS, type CarStyleId } from "./car-variants.ts";
import { CLASSES, STYLE_CLASS, type VehicleClassId } from "./vehicle-classes.ts";

/** Car pool size: the per-car typed arrays (derby/race AI, race, traffic), wheel batch and lamp pool are sized for it,
 *  `setCarCount` clamps to it and the HUD Cars slider stops at it. Set in the initial export (7a09b34), not measured. */
export const MAX_CARS = 32;
/** Closest two fleet spawns sit, centre to centre (m): one 4.44 m car (2 × CAR_HALF.z) plus ~1 m. From the initial
 *  export (7a09b34); fleet.test.ts holds every layout to it and `respawnSlot` keeps it from every other car. */
export const FLEET_MIN_SEP = 5.4;

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

type FleetSlot = { x: number; z: number; speed: number };
export type DerbySlot = { x: number; z: number; yaw: number; speed: number };

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
      { x: Math.sin(a) * r, z: Math.cos(a) * r, speed: spd() },
      { x: Math.sin(a + Math.PI) * r, z: Math.cos(a + Math.PI) * r, speed: spd() },
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
      x = Math.sin(ang) * r;
      z = Math.cos(ang) * r;
      placed = true;
      for (let j = 0; j < i; j++) {
        const o = slots[j]!;
        if (Math.hypot(x - o.x, z - o.z) < FLEET_MIN_SEP) {
          placed = false;
          break;
        }
      }
      if (placed) break;
    }
    if (!placed) {
      const ang = (i / n) * Math.PI * 2;
      const r = Math.max(8.2, (FLEET_MIN_SEP * n) / (Math.PI * 1.7));
      x = Math.sin(ang) * r;
      z = Math.cos(ang) * r;
    }
    slots.push({ x, z, speed: spd() });
  }
  return slots;
}

/**
 * Scatter around the bowl, facing tangent so they don't all donate the nose
 * on frame one.
 */
export function layoutDerby(
  count: number,
  radius: number,
  speed: number,
  rng: () => number = Math.random,
): DerbySlot[] {
  const n = Math.max(1, Math.min(MAX_CARS, Math.round(count) || 1));
  const slots: DerbySlot[] = [];
  const r = Math.max(5.5, radius - 5.2);
  const spin = rng() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = spin + (i / n) * Math.PI * 2;
    slots.push({
      x: Math.sin(a) * r,
      z: Math.cos(a) * r,
      yaw: a + Math.PI / 2,
      speed,
    });
  }
  return slots;
}

/** Fleet disc: a car this far (m) below its top leaves the soft-body sim and falls on as a fake (`beginFakeFall`). */
export const FAKE_DEPTH = 2;
/** Fleet disc: a car this far (m) below its top vaporizes into smoke. */
export const VAPOR_DEPTH = 20;
/** The driven car is back on the disc this long (s) after vaporizing; AI cars stay gone until reset. */
export const RESPAWN_S = 2;
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
    const sx = Math.sin(a) * RESPAWN_R;
    const sz = Math.cos(a) * RESPAWN_R;
    if (!others.some((o) => Math.hypot(o.x - sx, o.z - sz) < FLEET_MIN_SEP)) break;
    a += 0.27;
  }
  return { x: Math.sin(a) * RESPAWN_R, z: Math.cos(a) * RESPAWN_R, yaw: a + Math.PI, speed: 0 };
}

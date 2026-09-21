/** Shared spawn layout so 1–N cars never start overlapping. */

export const MAX_CARS = 32;
export const FLEET_MIN_SEP = 5.4;

export type FleetSlot = { x: number; z: number; speed: number };

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

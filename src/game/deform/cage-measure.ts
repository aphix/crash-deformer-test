import type { Cage, Sensor } from "./deform-rig.ts";

/** Per cage name: the indices (in sensor order) of the sensors that read that cage. The rig's sensors and cages never change after it is built. */
export function sensorsByPart(cages: readonly Cage[], sensors: readonly Sensor[]): Record<string, Int32Array> {
  const lists: Record<string, number[]> = {};
  for (let si = 0; si < sensors.length; si++) {
    const part = cages[sensors[si]!.partIndex]?.spec.name;
    if (part !== undefined) (lists[part] ??= []).push(si);
  }
  const out: Record<string, Int32Array> = {};
  for (const part of Object.keys(lists)) out[part] = Int32Array.from(lists[part]!);
  return out;
}

/** The largest compression (m) among the sensors `list` names; 0 for none. */
export function maxCompression(sensors: readonly Sensor[], list: Int32Array | undefined): number {
  let max = 0;
  if (list === undefined) return max;
  for (let k = 0; k < list.length; k++) {
    const c = sensors[list[k]!]!.compression;
    if (c > max) max = c;
  }
  return max;
}

/** What `CageStrain` keeps for one cage: the corners it last measured (xyz x 8), its answer for them, and the cage's rest corner-to-corner spans (28, a < b). */
interface Memo {
  at: Float64Array;
  strain: number;
  valid: boolean;
  rest: Float64Array;
}

/**
 * A cage's frame strain (m): the largest change of any corner-to-corner distance from rest; rigid motion reads 0. The glass reads it
 * every step of every crashed car, and a cage whose corners have not moved since the last measure (a damaged car driving on) is not
 * measured again: the answer is the same function of the same corners. The rest spans are measured once.
 */
export class CageStrain {
  private readonly memos = new WeakMap<Cage, Memo>();

  measure(cage: Cage): number {
    const c = cage.corners;
    let memo = this.memos.get(cage);
    if (memo === undefined) {
      const rest = new Float64Array(28);
      let k = 0;
      for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) rest[k++] = cage.restCorners[a]!.distanceTo(cage.restCorners[b]!);
      memo = { at: new Float64Array(24), strain: 0, valid: false, rest };
      this.memos.set(cage, memo);
    }
    const at = memo.at;
    let same = memo.valid;
    for (let i = 0; i < 8 && same; i++) {
      const p = c[i]!;
      same = p.x === at[3 * i]! && p.y === at[3 * i + 1]! && p.z === at[3 * i + 2]!;
    }
    if (same) return memo.strain;
    for (let i = 0; i < 8; i++) {
      const p = c[i]!;
      at[3 * i] = p.x;
      at[3 * i + 1] = p.y;
      at[3 * i + 2] = p.z;
    }
    const rest = memo.rest;
    let max = 0;
    let k = 0;
    for (let a = 0; a < 8; a++) {
      for (let b = a + 1; b < 8; b++) max = Math.max(max, Math.abs(c[a]!.distanceTo(c[b]!) - rest[k++]!));
    }
    memo.strain = max;
    memo.valid = true;
    return max;
  }
}

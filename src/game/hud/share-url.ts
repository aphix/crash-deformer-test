/**
 * The shareable URL: the netplay room, the scene, every setting that differs from `INITIAL_HUD` and the spawn seed, as a
 * `#key=value&…` fragment. `encodeShare` writes it; `decodeShare` reads untrusted text back into a full
 * `ShareState` (an unknown key or a malformed value falls back to its default, a number clamps to the HUD's own
 * range). The engine applies the result through the setters the HUD uses (`engine-share.ts`).
 */

import { INITIAL_HUD, KNOB_RANGES } from "./hud-store.ts";
import { DEFAULT_RACE_OPTIONS } from "../match/types.ts";
import { FX_TIERS } from "../present/engine-post.ts";
import { MAX_CARS } from "../scenes/fleet.ts";
import { SCENE_IDS } from "../scenes/scene-id.ts";
import { VEHICLE_CLASS_IDS } from "../vehicle/vehicle-classes.ts";

/** One URL value: its default, how to read it back (undefined = malformed) and how to write it. */
type Field<T> = { def: T; parse(raw: string): T | undefined; fmt(v: T): string };

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

/** A number clamped to [min, max] (rounded when `int`), written to 4 decimals. */
const num = (min: number, max: number, def: number, int = false): Field<number> => ({
  def,
  parse: (raw) => (/^-?\d+(\.\d+)?$/.test(raw) ? clamp(int ? Math.round(Number(raw)) : Number(raw), min, max) : undefined),
  fmt: (v) => String(Math.round(v * 1e4) / 1e4),
});
const flag = (def: boolean): Field<boolean> => ({ def, parse: (raw) => (raw === "1" ? true : raw === "0" ? false : undefined), fmt: (v) => (v ? "1" : "0") });
const pick = <T extends string>(of: readonly T[], def: T): Field<T> => ({ def, parse: (raw) => of.find((x) => x === raw), fmt: (v) => v });
/** Race course ids come from the course list, which the engine checks; here only a plain id shape passes. */
const slug = (def: string): Field<string> => ({ def, parse: (raw) => (/^[a-z0-9_-]{1,32}$/i.test(raw) ? raw : undefined), fmt: (v) => v });
/** A run's seed: up to 8 hex digits. */
const hex: Field<number | null> = {
  def: null,
  parse: (raw) => (/^[0-9a-f]{1,8}$/i.test(raw) ? parseInt(raw, 16) : undefined),
  fmt: (v) => (v ?? 0).toString(16),
};
/** `null` (the default) is "not set": the setting is not pinned by the URL. */
const orNull = <T>(f: Field<T>): Field<T | null> => ({ def: null, parse: (raw) => f.parse(raw), fmt: (v) => f.fmt(v as T) });
/**
 * A private room code as the Room field takes it (`[A-Z0-9]`, ≤ 12, uppercased here as the field does); "" is no room. A
 * public room (`pub-…`) is never accepted, so a crafted link cannot send a visitor into one, or into polling a dead code (docs/MULTIPLAYER.md).
 */
const roomCode: Field<string> = {
  def: "",
  parse: (raw) => (/^[A-Za-z0-9]{1,12}$/.test(raw) ? raw.toUpperCase() : undefined),
  fmt: (v) => v,
};
/** Whether `room` is a code the `#` can carry (what `room=` accepts back). */
export const isShareableRoom = (room: string): boolean => roomCode.parse(room) === room;

const R = KNOB_RANGES;
const D = INITIAL_HUD;
const O = DEFAULT_RACE_OPTIONS;

/**
 * Every shared setting, in URL order: the trace JSON's settings (`engine-trace.ts`) plus the piston and door
 * rigs' knobs and the race setup. The piston and door ranges mirror the rigs' own setter clamps, which apply again.
 */
const FIELDS = {
  // The room first: it is what a link is for. `tx` is `bc` only for two tabs of one browser.
  room: roomCode,
  tx: pick(["rtc", "bc"] as const, "rtc"),
  scene: pick(SCENE_IDS, "fleet"),
  cars: num(1, MAX_CARS, D.carCount, true),
  smin: num(R.speed.min, R.speed.max, D.speedMin),
  smax: num(R.speed.min, R.speed.max, D.speedMax),
  night: flag(D.night),
  wet: flag(D.wet),
  real: num(R.realism.min, R.realism.max, D.realism),
  // null = automatic: `AutoFx` picks the tier, so the URL pins it only after a manual pick.
  fx: orNull(pick(FX_TIERS, D.fxTier)),
  fxd: num(R.fxDensity.min, R.fxDensity.max, D.fxDensity),
  squash: num(R.squash.min, R.squash.max, D.squash),
  buckle: num(R.buckle.min, R.buckle.max, D.buckle),
  loop: flag(D.looping),
  slomo: flag(D.autoSlomo),
  ts: orNull(num(R.timeScale.min, R.timeScale.max, 1)),
  deform: pick(["shape", "lattice"] as const, D.deformMode),
  car: pick(VEHICLE_CLASS_IDS, D.playerClass),
  barrier: flag(D.showBarrier),
  balls: flag(D.showBalls),
  ramps: flag(D.showRamps),
  pkph: num(1, 200, D.pistons.speedKph),
  pkg: num(50, 20000, D.pistons.massKg),
  phard: num(0.05, 1, D.pistons.hardness),
  phold: flag(D.pistons.holdCar),
  phop: num(1.5, 20, D.pistons.hopSeconds),
  dkph: num(1, 120, D.doors.kph),
  dkg: num(5, 5000, D.doors.kg),
  dside: pick(["left", "right"] as const, D.doors.side < 0 ? "left" : "right"),
  track: slug(O.trackId),
  laps: num(1, 9, O.laps, true),
  ai: num(1, MAX_CARS - 1, O.aiCount, true),
  aggr: num(0, 1, O.aggression),
  police: flag(O.police),
  noreset: flag(O.noReset),
  spectate: flag(O.spectate),
  seed: hex,
};

export type ShareState = { [K in keyof typeof FIELDS]: (typeof FIELDS)[K]["def"] };
const KEYS = Object.keys(FIELDS) as (keyof ShareState)[];

/** The fragment (no leading `#`) for `s`: only what differs from the defaults, "" when nothing does. */
export function encodeShare(s: ShareState): string {
  const out: string[] = [];
  for (const k of KEYS) {
    const f = FIELDS[k] as Field<unknown>;
    const v = s[k];
    if (v === null || (f.def !== null && f.fmt(v) === f.fmt(f.def))) continue;
    out.push(`${k}=${f.fmt(v)}`);
  }
  return out.join("&");
}

/** The state a fragment (with or without its `#`) describes: whatever is missing or malformed is the default. */
export function decodeShare(fragment: string): ShareState {
  const p = new URLSearchParams(fragment.replace(/^#/, ""));
  const out: Record<string, unknown> = {};
  for (const k of KEYS) {
    const raw = p.get(k);
    out[k] = (raw === null ? undefined : FIELDS[k].parse(raw)) ?? FIELDS[k].def;
  }
  return out as ShareState;
}

const DEFAULTS = decodeShare("");

/** A tab's `#` for state `s`: a host's is every setting plus its room; a client's scene is the host's, so its `#` is the room alone. */
export function shareFragment(s: ShareState, client: boolean): string {
  return encodeShare(client ? { ...DEFAULTS, room: s.room, tx: s.tx } : s);
}

/** The link that joins `room` (over `tx`): the page URL `base` (no `#`) plus a fragment of the room alone. */
export function roomLink(base: string, room: string, tx: ShareState["tx"]): string {
  return `${base}#${encodeShare({ ...DEFAULTS, room, tx })}`;
}

/** Whether a `#` that names `want` makes this browser join: it names a room and the one it is in (`have`, "" when none) is another. */
export function joinsRoom(want: Pick<ShareState, "room" | "tx">, have: Pick<ShareState, "room" | "tx">): boolean {
  return want.room !== "" && (want.room !== have.room || want.tx !== have.tx);
}

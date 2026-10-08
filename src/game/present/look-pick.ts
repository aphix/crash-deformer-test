import type { DriverLook } from "./driver-look.ts";

/**
 * A player's own look, picked in the garage: a colour per car part and the driver's clothes. Null is "not picked": the
 * car keeps its own paint there and the driver his drawn look (`driverLook`). Each pick rides the URL and the netplay
 * look message as text (`carPickText`, `personPickText`): its slots joined by ".", a colour as 6 hex digits, "" unpicked.
 */

/** The car's parts a colour can be picked for, in text order. */
export const CAR_PARTS = ["body", "doors", "hood", "trunk", "bumpers", "rims", "glass"] as const;
export type CarPart = (typeof CAR_PARTS)[number];
export type CarPick = Record<CarPart, number | null>;

/** The driver's colours in text order, after the build slot; `hat` null is no cap. */
export const PERSON_COLOURS = ["shirt", "pants", "hair", "hat"] as const;
export type PersonPick = { woman: boolean | null; shirt: number | null; pants: number | null; hair: number | null; hat: number | null; mustache: boolean };

export const NO_CAR_PICK: CarPick = { body: null, doors: null, hood: null, trunk: null, bumpers: null, rims: null, glass: null };
export const NO_PERSON_PICK: PersonPick = { woman: null, shirt: null, pants: null, hair: null, hat: null, mustache: false };

/** Colour `c` (sRGB) as 6 hex digits: a pick's slot, and after a "#" a colour input's value. */
export const hexOf = (c: number): string => c.toString(16).padStart(6, "0");

/** One slot's colour, null when empty; undefined when it is not 6 hex digits. */
function colourOf(slot: string): number | null | undefined {
  if (slot === "") return null;
  return /^[0-9a-f]{6}$/i.test(slot) ? parseInt(slot, 16) : undefined;
}

export function carPickText(pick: CarPick): string {
  return CAR_PARTS.map((part) => (pick[part] === null ? "" : hexOf(pick[part]))).join(".");
}

/** The pick `text` names; null when it is not one (untrusted: a link's or a peer's). */
export function parseCarPick(text: string): CarPick | null {
  const slots = text.split(".");
  if (slots.length !== CAR_PARTS.length) return null;
  const pick = { ...NO_CAR_PICK };
  for (const [i, part] of CAR_PARTS.entries()) {
    const colour = colourOf(slots[i]!);
    if (colour === undefined) return null;
    pick[part] = colour;
  }
  return pick;
}

export function personPickText(pick: PersonPick): string {
  const build = pick.woman === null ? "" : pick.woman ? "w" : "m";
  return [build, ...PERSON_COLOURS.map((key) => (pick[key] === null ? "" : hexOf(pick[key]))), pick.mustache ? "1" : ""].join(".");
}

/** The pick `text` names; null when it is not one (untrusted: a link's or a peer's). */
export function parsePersonPick(text: string): PersonPick | null {
  const slots = text.split(".");
  if (slots.length !== PERSON_COLOURS.length + 2) return null;
  const build = slots[0];
  const mustache = slots.at(-1);
  if ((build !== "" && build !== "w" && build !== "m") || (mustache !== "" && mustache !== "1")) return null;
  const pick: PersonPick = { ...NO_PERSON_PICK, woman: build === "" ? null : build === "w", mustache: mustache === "1" };
  for (const [i, key] of PERSON_COLOURS.entries()) {
    const colour = colourOf(slots[i + 1]!);
    if (colour === undefined) return null;
    pick[key] = colour;
  }
  return pick;
}

/** The driver `base` (his drawn look) with the player's picks over it. The cap and the moustache are the player's alone. */
export function pickedLook(base: DriverLook, pick: PersonPick): DriverLook {
  return {
    woman: pick.woman ?? base.woman,
    shirt: pick.shirt ?? base.shirt,
    pants: pick.pants ?? base.pants,
    hair: pick.hair ?? base.hair,
    hat: pick.hat,
    mustache: pick.mustache,
  };
}

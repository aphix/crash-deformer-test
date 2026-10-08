import { CAR_SPRAY, carPickText, packSpray, parseCarPick, parsePersonPick, PERSON_SPRAY, personPickText, unpackSpray, type CarPick, type PersonPick } from "../match/look-data.ts";
import { MSG } from "./codec.ts";

/** A player's look as the wire carries it: the picks and both spray bitmaps' texels (a palette index each). */
export type LookData = { car: CarPick; person: PersonPick; carSpray: Uint8Array; personSpray: Uint8Array };

/**
 * `MSG.look`: a player's look, sent once on the reliable channel when a guest is seated (to the host) and by the host to every
 * guest (its own and each other player's). Type, the car it is for, the car and driver picks as text (`carPickText`, a length
 * byte first), then each spray bitmap packed (`packSpray`, a u16 length first): a few hundred bytes for a bare car, 8 KiB a
 * bitmap at most.
 */
export function packLook(car: number, look: LookData): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const parts = [enc.encode(carPickText(look.car)), enc.encode(personPickText(look.person))];
  const sprays = [packSpray(look.carSpray), packSpray(look.personSpray)];
  const out = new Uint8Array(2 + parts[0]!.length + 1 + parts[1]!.length + 1 + sprays[0]!.length + 2 + sprays[1]!.length + 2);
  out[0] = MSG.look;
  out[1] = car;
  let o = 2;
  for (const part of parts) {
    out[o++] = part.length;
    out.set(part, o);
    o += part.length;
  }
  for (const spray of sprays) {
    out[o++] = spray.length & 0xff;
    out[o++] = spray.length >> 8;
    out.set(spray, o);
    o += spray.length;
  }
  return out;
}

/** A `MSG.look` message's car and look; null when it is not one this build reads (untrusted: a peer's). */
export function readLook(data: Uint8Array): { car: number; look: LookData } | null {
  if (data.length < 2 || data[0] !== MSG.look) return null;
  const dec = new TextDecoder();
  let o = 2;
  const texts: string[] = [];
  for (let k = 0; k < 2; k++) {
    const n = data[o++];
    if (n === undefined || o + n > data.length) return null;
    texts.push(dec.decode(data.subarray(o, o + n)));
    o += n;
  }
  const bitmaps: Uint8Array[] = [];
  for (const layout of [CAR_SPRAY, PERSON_SPRAY]) {
    if (o + 2 > data.length) return null;
    const n = data[o]! | (data[o + 1]! << 8);
    o += 2;
    if (o + n > data.length) return null;
    const texels = unpackSpray(data.subarray(o, o + n), layout.w * layout.h);
    if (!texels) return null;
    bitmaps.push(texels);
    o += n;
  }
  const car = parseCarPick(texts[0]!);
  const person = parsePersonPick(texts[1]!);
  if (!car || !person || o !== data.length) return null;
  return { car: data[1]!, look: { car, person, carSpray: bitmaps[0]!, personSpray: bitmaps[1]! } };
}

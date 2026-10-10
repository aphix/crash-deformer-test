import { ROOM_MAX } from "../../lib/multiplayer/rooms.ts";
import { MAX_NET_CARS, MSG } from "./codec.ts";

/** One seated player: the transport peer id the relay knows it by, and the car it drives. */
export interface RosterEntry {
  peer: string;
  car: number;
}

/** The relay's peer id shape (`signaling.server.ts`): a peer id read off the wire must match it. */
const PEER_ID = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * `MSG.roster`: the host's table of who drives which car, sent reliably to every guest whenever a seat changes, so a guest can
 * tell which car a remote voice belongs to. Type, entry count, then per entry the car, the peer id's length and its ASCII bytes.
 */
export function packRoster(entries: readonly RosterEntry[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const ids = entries.map((entry) => encoder.encode(entry.peer));
  const out = new Uint8Array(2 + entries.length * 2 + ids.reduce((sum, id) => sum + id.length, 0));
  out[0] = MSG.roster;
  out[1] = entries.length;
  let offset = 2;
  for (let i = 0; i < entries.length; i++) {
    out[offset++] = entries[i]!.car;
    out[offset++] = ids[i]!.length;
    out.set(ids[i]!, offset);
    offset += ids[i]!.length;
  }
  return out;
}

/** A `MSG.roster` message's entries; null when it is not one this build reads (untrusted: a peer's). */
export function readRoster(data: Uint8Array): RosterEntry[] | null {
  if (data.length < 2 || data[0] !== MSG.roster || data[1]! > ROOM_MAX) return null;
  const decoder = new TextDecoder();
  const entries: RosterEntry[] = [];
  let offset = 2;
  for (let i = 0; i < data[1]!; i++) {
    const car = data[offset];
    const idLength = data[offset + 1];
    if (car === undefined || idLength === undefined || car >= MAX_NET_CARS) return null;
    offset += 2;
    if (offset + idLength > data.length) return null;
    const peer = decoder.decode(data.subarray(offset, offset + idLength));
    if (!PEER_ID.test(peer)) return null;
    entries.push({ peer, car });
    offset += idLength;
  }
  return offset === data.length ? entries : null;
}

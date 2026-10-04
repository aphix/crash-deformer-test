import { MSG } from "./codec.ts";

/**
 * `MSG.reelPart`: the reel message (`packReel`) cut into frames the relay's message cap (240 KiB) and WebRTC's (256 KiB)
 * take. Type, flags (`FIRST`, `LAST`), then up to `REEL_PART` bytes of the message. The reliable channel is ordered, so the
 * parts arrive in sequence; a `FIRST` part starts a fresh message (a reel that never finished is dropped), and the `LAST` one
 * ends it.
 */
const FIRST = 1;
const LAST = 2;
export const REEL_PART = 32 * 1024;
/** A decoder never gathers more than this (the inflate cap, `INFLATE_MAX`, is 4 MiB of clips; they deflate to far less). */
const REEL_WIRE_MAX = 4 << 20;

/** `msg` as the frames to send, in order. */
export function reelParts(msg: Uint8Array): Uint8Array<ArrayBuffer>[] {
  const out: Uint8Array<ArrayBuffer>[] = [];
  for (let at = 0; at === 0 || at < msg.length; at += REEL_PART) {
    const body = msg.subarray(at, at + REEL_PART);
    const part = new Uint8Array(2 + body.length);
    part[0] = MSG.reelPart;
    part[1] = (at === 0 ? FIRST : 0) | (at + REEL_PART >= msg.length ? LAST : 0);
    part.set(body, 2);
    out.push(part);
  }
  return out;
}

/** A client's end: gathers one host's parts back into the reel message. */
export class ReelParts {
  private parts: Uint8Array[] = [];
  private bytes = 0;

  /** The whole message when `part` completes it, else null (more to come, or a part that does not belong, which drops what was gathered). */
  take(part: Uint8Array): Uint8Array | null {
    if (part.length < 2) return null;
    const flags = part[1]!;
    if (flags & FIRST) this.reset();
    else if (this.parts.length === 0) return null;
    this.bytes += part.length - 2;
    if (this.bytes > REEL_WIRE_MAX) {
      this.reset();
      return null;
    }
    this.parts.push(part.slice(2));
    if (!(flags & LAST)) return null;
    const msg = new Uint8Array(this.bytes);
    let at = 0;
    for (const p of this.parts) {
      msg.set(p, at);
      at += p.length;
    }
    this.reset();
    return msg;
  }

  private reset(): void {
    this.parts = [];
    this.bytes = 0;
  }
}

import { ROOM_MAX } from "./rooms.ts";

/** Token bucket: `rate` requests per second, bursts up to `burst`. */
export interface Limit {
  rate: number;
  burst: number;
}

/**
 * One peer polls every 0.4 s while its pairs connect (p2p.ts FAST_POLL_MS) and posts an offer or
 * answer plus a few ICE candidates per pair: ~30 requests in its first seconds in an 8-peer mesh.
 * Friends share a NAT, so one IP gets a full room's worth; one peer id flooding gets one peer's.
 */
const PEER: Limit = { rate: 10, burst: 100 };
export const LIMITS = {
  peer: PEER,
  ip: { rate: PEER.rate * ROOM_MAX, burst: PEER.burst * ROOM_MAX },
} as const satisfies Record<string, Limit>;

const BUCKETS_MAX = 20_000;

/**
 * The signaling relay's rate limits, in process: exact on one long-lived node server, per instance
 * on serverless. Peer buckets are keyed by IP + peer id, so a spoofed peer id from another address
 * cannot spend someone else's; no bucket is shared by callers at different addresses.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  /** Every request, before parsing: the caller's address (all peers behind one NAT share it). */
  ip(ip: string, now = Date.now()): boolean {
    return this.take(`ip:${ip}`, LIMITS.ip, now);
  }

  /** A poll, signal or leave from `peer` at `ip`. */
  peer(ip: string, peer: string, now = Date.now()): boolean {
    return this.take(`peer:${ip}|${peer}`, LIMITS.peer, now);
  }

  /** The public-room list, as one more peer at `ip`. */
  list(ip: string, now = Date.now()): boolean {
    return this.take(`list:${ip}`, LIMITS.peer, now);
  }

  /**
   * False once `key` has spent its bucket. A full map evicts its least recently used bucket (Map
   * order is use order: every take re-inserts its key), so minted keys never lock new callers out;
   * an evicted caller just starts again from a full bucket.
   */
  private take(key: string, limit: Limit, now: number): boolean {
    let b = this.buckets.get(key);
    if (b) this.buckets.delete(key);
    else {
      b = { tokens: limit.burst, at: now };
      if (this.buckets.size >= BUCKETS_MAX) this.buckets.delete(this.buckets.keys().next().value!);
    }
    this.buckets.set(key, b);
    b.tokens = Math.min(limit.burst, b.tokens + ((now - b.at) / 1000) * limit.rate);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}

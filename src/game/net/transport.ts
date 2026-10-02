/** One remote peer as the transport sees it. */
export interface NetPeer {
  id: string;
  /** Round trip (ms), null until measured. */
  rttMs: number | null;
}

/**
 * What netplay needs from a network (docs/MULTIPLAYER.md): unreliable, unordered binary messages
 * between the peers of one room. Swapping WebRTC for a relay (PartyKit, …) is a new class.
 */
export interface NetTransport {
  readonly selfId: string;
  onMessage: ((from: string, data: Uint8Array) => void) | null;
  /** To one peer, else to all. `data` may be a view of a reused buffer: send copies it. */
  send(data: Uint8Array<ArrayBuffer>, to?: string): void;
  peers(): readonly NetPeer[];
  close(): void;
}

type BcMessage =
  | { from: string; to?: string; kind: "data"; data: ArrayBuffer }
  | { from: string; to?: string; kind: "ping" | "pong"; t: number };

const PING_MS = 1000;
const PEER_TTL_MS = 3000;

/** Same-origin tabs of one browser (smoke tests, local play): a BroadcastChannel per room. */
export class BroadcastTransport implements NetTransport {
  onMessage: ((from: string, data: Uint8Array) => void) | null = null;
  private readonly channel: BroadcastChannel;
  private readonly seen = new Map<string, NetPeer & { at: number }>();
  private readonly timer: number;
  readonly selfId: string;

  constructor(room: string, selfId: string) {
    this.selfId = selfId;
    this.channel = new BroadcastChannel(`crush-net:${room}`);
    this.channel.onmessage = (e: MessageEvent<BcMessage>) => this.receive(e.data);
    const ping = () => this.channel.postMessage({ from: this.selfId, kind: "ping", t: performance.now() } satisfies BcMessage);
    this.timer = window.setInterval(ping, PING_MS);
    ping();
  }

  send(data: Uint8Array, to?: string): void {
    this.channel.postMessage({ from: this.selfId, to, kind: "data", data: data.slice().buffer } satisfies BcMessage);
  }

  peers(): readonly NetPeer[] {
    const now = performance.now();
    const out: NetPeer[] = [];
    for (const p of this.seen.values()) if (now - p.at < PEER_TTL_MS) out.push({ id: p.id, rttMs: p.rttMs });
    return out;
  }

  close(): void {
    window.clearInterval(this.timer);
    this.channel.close();
  }

  private receive(m: BcMessage): void {
    if (m.to !== undefined && m.to !== this.selfId) return;
    let peer = this.seen.get(m.from);
    if (!peer) {
      peer = { id: m.from, rttMs: null, at: 0 };
      this.seen.set(m.from, peer);
    }
    peer.at = performance.now();
    if (m.kind === "data") this.onMessage?.(m.from, new Uint8Array(m.data));
    else if (m.kind === "ping") this.channel.postMessage({ from: this.selfId, to: m.from, kind: "pong", t: m.t } satisfies BcMessage);
    else peer.rttMs = Math.round((performance.now() - m.t) * 10) / 10;
  }
}

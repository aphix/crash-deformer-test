import { P2PRoom } from "../../lib/multiplayer/p2p.ts";
import { NetTransport, type NetPeer } from "./transport.ts";

/** Cross-machine: the template's WebRTC mesh (`P2PRoom`), signaled through `/api/rtc`; binary on its unreliable channel, or its reliable one on request. */
export class RtcTransport extends NetTransport {
  private readonly room: P2PRoom;

  /** `role` is the roster tag the relay lists public rooms by ("host" / "client"); no personal name is sent. `meta` is read on every poll: a public host's match tag. */
  constructor(room: string, selfId: string, role: "host" | "client", meta: () => string) {
    super(selfId);
    this.room = new P2PRoom({
      room,
      selfId,
      name: role,
      meta,
      onBinary: (from, data) => this.onMessage?.(from, new Uint8Array(data)),
    });
    void this.room.join();
  }

  /** The relay's refusal ("room full", "host taken", …) while it lasts; the Net panel shows it. */
  override get error(): string | null {
    return this.room.error;
  }

  send(data: Uint8Array<ArrayBuffer>, to?: string, reliable = false): void {
    this.room.sendBinary(data, to, reliable);
  }

  peers(): readonly NetPeer[] {
    const out: NetPeer[] = [];
    for (const p of this.room.peerList()) {
      if (p.connectionState === "connected") out.push({ id: p.id, rttMs: p.rttMs, host: p.name === "host" });
    }
    return out;
  }

  close(): void {
    this.room.close();
  }
}

import { P2PRoom } from "../../lib/multiplayer/p2p.ts";
import type { NetPeer, NetTransport } from "./transport.ts";

/** Cross-machine: the template's WebRTC mesh (`P2PRoom`), signaled through `/api/rtc`; binary on its unreliable channel. */
export class RtcTransport implements NetTransport {
  onMessage: ((from: string, data: Uint8Array) => void) | null = null;
  readonly selfId: string;
  private readonly room: P2PRoom;

  /** `role` is the roster tag the relay lists public rooms by ("host" / "client"); no personal name is sent. */
  constructor(room: string, selfId: string, role: "host" | "client") {
    this.selfId = selfId;
    this.room = new P2PRoom({
      room,
      selfId,
      name: role,
      onBinary: (from, data) => this.onMessage?.(from, new Uint8Array(data)),
    });
    void this.room.join();
  }

  send(data: Uint8Array<ArrayBuffer>, to?: string): void {
    this.room.sendBinary(data, to);
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

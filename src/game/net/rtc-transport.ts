import { P2PRoom } from "@/lib/multiplayer";
import type { NetPeer, NetTransport } from "./transport.ts";

/** Cross-machine: the template's WebRTC mesh (`P2PRoom`), signaled through `/api/rtc`; binary on its unreliable channel. */
export class RtcTransport implements NetTransport {
  onMessage: ((from: string, data: Uint8Array) => void) | null = null;
  readonly selfId: string;
  private readonly room: P2PRoom;

  constructor(room: string, selfId: string) {
    this.selfId = selfId;
    this.room = new P2PRoom({
      room: `crush-${room}`,
      selfId,
      name: selfId,
      onBinary: (from, data) => this.onMessage?.(from, new Uint8Array(data)),
    });
    void this.room.join();
  }

  send(data: Uint8Array<ArrayBuffer>, to?: string): void {
    this.room.sendBinary(data, to);
  }

  peers(): readonly NetPeer[] {
    const out: NetPeer[] = [];
    for (const p of this.room.peerList()) if (p.connectionState === "connected") out.push({ id: p.id, rttMs: p.rttMs });
    return out;
  }

  close(): void {
    this.room.close();
  }
}

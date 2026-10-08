import { useMemo, type RefObject } from "react";
import { RoomShare } from "@/components/room-share";
import type { CrashEngine } from "@/game/engine/engine";
import { roomLink } from "@/game/hud/share-url";
import { NET_TX, type NetStatus } from "@/game/net/net-ports";
import { ROOM_MAX } from "@/lib/multiplayer/rooms";
import { encodeQr } from "@/lib/qr";

/** The invite link as a QR code: one SVG path, black on a white quiet zone so phones read it on a dark HUD. */
function InviteQr({ link }: { link: string }) {
  const qr = useMemo(() => {
    const { size, dark } = encodeQr(link);
    let d = "";
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (dark[y * size + x]) d += `M${x + 4} ${y + 4}h1v1h-1z`;
    return { view: size + 8, d };
  }, [link]);
  return (
    <svg viewBox={`0 0 ${qr.view} ${qr.view}`} className="mx-auto block h-40 w-40 rounded bg-white" role="img" aria-label="QR code of the invite link" shapeRendering="crispEdges">
      <path d={qr.d} fill="#000" />
    </svg>
  );
}

/**
 * The session behind the chip (docs/MULTIPLAYER.md): a private room's code with Copy link and Share (`RoomShare`) and its QR
 * code; for every session the players, this peer's car, the snapshot rate, the lobby countdown and each peer's ping.
 */
export function SessionDetails({ engine, status }: { engine: RefObject<CrashEngine | null>; status: NetStatus }) {
  // The link under the app's base path (the VPS serves it below /crush/); the QR code carries it.
  const invite = roomLink(`${window.location.origin}${import.meta.env.BASE_URL}`, status.room, status.tx);
  return (
    <>
      <div className="space-y-2">
        {status.public ? null : <RoomShare engine={engine} status={status} />}
        <p className="text-muted">
          {status.peers.length + 1}/{ROOM_MAX} players · car {status.car < 0 ? "…" : status.car}
          {status.role === "host" ? " (host)" : ""} · {status.snapHz.toFixed(0)} snapshots/s · {(status.bytesPerSec / 1024).toFixed(1)} KB/s
        </p>
        {status.lobby != null ? (
          <p className="font-display">
            {status.role === "host" ? "Waiting for players…" : `Waiting for the ${status.public ?? "match"}…`} starts in {status.lobby} s
            {status.role === "host" ? "; AI drives the empty seats" : ""}
          </p>
        ) : null}
        <ul className="space-y-0.5" aria-label="Connected peers">
          {status.peers.length === 0 ? <li className="text-subtle">{status.public ? "Waiting for players…" : "No peers yet"}</li> : null}
          {status.peers.map((p) => (
            <li key={p.id} className="flex justify-between tabular-nums">
              <span>{p.id}</span>
              <span className="text-muted">{p.rttMs == null ? "–" : `${p.rttMs} ms`}</span>
            </li>
          ))}
        </ul>
      </div>
      {status.public || status.tx !== NET_TX.rtc ? null : <InviteQr link={invite} />}
    </>
  );
}

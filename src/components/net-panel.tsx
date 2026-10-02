import { useEffect, useMemo, useState, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import type { CrashEngine } from "@/game/engine";
import type { NetStatus, NetTx } from "@/game/net/net-play";
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
 * Multiplayer: host or join a room (docs/MULTIPLAYER.md). `?net=host|join&room=CODE[&tx=rtc]`
 * starts it from the URL. Shows peers, ping and the snapshot rate.
 */
export function NetPanel({ engine }: { engine: RefObject<CrashEngine | null> }) {
  const [open, setOpen] = useState(false);
  const [room, setRoom] = useState("");
  const [tx, setTx] = useState<NetTx>("rtc");
  const [status, setStatus] = useState<NetStatus | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    let pending = params.get("net");
    const code = params.get("room") ?? "";
    const urlTx: NetTx = params.get("tx") === "bc" ? "bc" : "rtc";
    if (pending && code) setOpen(true);
    const id = window.setInterval(() => {
      const e = engine.current;
      if (!e) return;
      if (pending && code) {
        if (pending === "host") e.net.host(code, urlTx);
        else e.net.join(code, urlTx);
        pending = null;
      }
      setStatus(e.net.status());
    }, 500);
    return () => window.clearInterval(id);
  }, [engine]);

  if (!open) {
    return (
      <div className="pointer-events-auto absolute left-1/2 top-3 z-20 -translate-x-1/2">
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          {status && status.role !== "off" ? `Net · ${status.role} ${status.room}` : "Net"}
        </Button>
      </div>
    );
  }

  const start = (role: "host" | "join") => {
    const e = engine.current;
    if (!e) return;
    const code = room.trim().toUpperCase() || Math.random().toString(36).slice(2, 6).toUpperCase();
    setRoom(code);
    if (role === "host") e.net.host(code, tx);
    else e.net.join(code, tx);
    setStatus(e.net.status());
  };
  const live = status && status.role !== "off";
  // Deep link under the app's base path (the VPS serves it below /crush/).
  const invite = live
    ? `${window.location.origin}${import.meta.env.BASE_URL}?net=join&room=${encodeURIComponent(status.room)}${status.tx === "bc" ? "&tx=bc" : ""}`
    : "";
  const copyInvite = () => {
    void navigator.clipboard.writeText(invite).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <div className="hud-panel pointer-events-auto absolute left-1/2 top-3 z-20 w-64 -translate-x-1/2 space-y-2 p-3 text-sm">
      <div className="flex items-baseline justify-between">
        <p className="hud-label">Multiplayer</p>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)} aria-label="Close multiplayer panel">
          ×
        </Button>
      </div>
      {live ? (
        <>
          <p className="font-display">
            {status.public ? "Public race" : status.role === "host" ? "Hosting" : "Joined"} <span className="tabular-nums">{status.room}</span> ·{" "}
            {status.tx === "rtc" ? "WebRTC" : "this browser"}
          </p>
          <p className="text-muted">
            {status.peers.length + 1}/{ROOM_MAX} players · car {status.car < 0 ? "…" : status.car + 1} · {status.snapHz.toFixed(0)} snapshots/s ·{" "}
            {(status.bytesPerSec / 1024).toFixed(1)} KB/s
          </p>
          <ul className="space-y-0.5" aria-label="Connected peers">
            {status.peers.length === 0 ? <li className="text-subtle">No peers yet</li> : null}
            {status.peers.map((p) => (
              <li key={p.id} className="flex justify-between tabular-nums">
                <span>{p.id}</span>
                <span className="text-muted">{p.rttMs == null ? "–" : `${p.rttMs} ms`}</span>
              </li>
            ))}
          </ul>
          {status.public ? null : (
            <>
              <Button size="sm" variant="secondary" onClick={copyInvite} title={invite} aria-label="Copy invite link">
                {copied ? "Link copied" : "Copy invite link"}
              </Button>
              {status.tx === "rtc" ? <InviteQr link={invite} /> : null}
            </>
          )}
          <Button size="sm" variant="secondary" onClick={() => engine.current?.net.leave()}>
            Leave
          </Button>
        </>
      ) : (
        <>
          <label className="flex items-center gap-2">
            <span className="hud-label w-12 shrink-0">Room</span>
            <input
              value={room}
              onChange={(e) => setRoom(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
              placeholder="new code"
              maxLength={12}
              aria-label="Room code"
              className="h-9 w-full rounded-md bg-surface-2 px-2 font-display uppercase"
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="hud-label w-12 shrink-0">Link</span>
            <select
              value={tx}
              onChange={(e) => setTx(e.target.value === "bc" ? "bc" : "rtc")}
              aria-label="Connection"
              className="h-9 w-full rounded-md bg-surface-2 px-2"
            >
              <option value="rtc">Internet (WebRTC)</option>
              <option value="bc">This browser (tabs)</option>
            </select>
          </label>
          <div className="flex gap-2">
            <Button size="sm" className="flex-1" onClick={() => start("host")}>
              Host
            </Button>
            <Button size="sm" variant="secondary" className="flex-1" disabled={!room.trim()} onClick={() => start("join")}>
              Join
            </Button>
          </div>
          <Button size="sm" variant="secondary" className="w-full" onClick={() => void engine.current?.net.publicRace()}>
            Public race
          </Button>
        </>
      )}
    </div>
  );
}

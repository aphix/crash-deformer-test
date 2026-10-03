import { useEffect, useMemo, useState, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import type { CrashEngine } from "@/game/engine/engine";
import type { NetStatus, NetTx } from "@/game/net/net-ports";
import { ROOM_MAX } from "@/lib/multiplayer/rooms";
import { encodeQr } from "@/lib/qr";
import { cn } from "@/lib/utils";

/** Top-right on phones (the title owns the left), top-centre from `sm`. */
const NET_SPOT = "absolute right-2 top-2 z-20 sm:left-1/2 sm:right-auto sm:top-4 sm:-translate-x-1/2";
/** Buttons and fields: 44 px tall on phones, 32 px from `sm`. */
const NET_CONTROL = "h-11 sm:h-8";
/** Generated codes: 8 of these 32 characters (no I, O, 0 or 1) from `crypto.getRandomValues`, 40 bits, unguessable. */
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

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
 * `?net=host|join&room=CODE[&tx=bc]`, the code uppercased as the Room field does; null unless the field
 * would accept it (`[A-Z0-9]`, ≤ 12: never a public `pub-…` room). Only `join` starts on load.
 */
function deepLink(search: string): { join: boolean; code: string; tx: NetTx } | null {
  const params = new URLSearchParams(search);
  const net = params.get("net");
  const code = (params.get("room") ?? "").toUpperCase();
  if ((net !== "host" && net !== "join") || !/^[A-Z0-9]{1,12}$/.test(code)) return null;
  return { join: net === "join", code, tx: params.get("tx") === "bc" ? "bc" : "rtc" };
}

/** A client's session problem as the panel words it (net-play.ts `NetStatus.problem`). */
const PROBLEM = {
  version: "Different game version: reload",
  "host-lost": "Host left: waiting for a new host…",
  "host-paused": "Host paused",
} as const;

/** Why the session is stuck, if it is: the relay's refusal ("room full", "host taken", …) or the host's state. */
function NetNotice({ status }: { status: NetStatus }) {
  const refusal = status.relayError;
  const text = refusal ? refusal[0]!.toUpperCase() + refusal.slice(1) : status.problem && PROBLEM[status.problem];
  return text ? (
    <p className="font-display text-accent" role="alert">
      {text}
    </p>
  ) : null;
}

/**
 * Multiplayer: host or join a room (docs/MULTIPLAYER.md). `?net=join&room=CODE[&tx=bc]` joins from
 * the URL; `?net=host&room=CODE` only fills in the panel, so a link alone never makes a visitor host.
 * A code the Room field would not accept is ignored. Shows peers, ping and the snapshot rate.
 */
export function NetPanel({ engine }: { engine: RefObject<CrashEngine | null> }) {
  const [open, setOpen] = useState(false);
  const [room, setRoom] = useState("");
  const [tx, setTx] = useState<NetTx>("rtc");
  const [status, setStatus] = useState<NetStatus | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const link = deepLink(window.location.search);
    if (link) {
      setOpen(true);
      setRoom(link.code);
      setTx(link.tx);
    }
    let pendingJoin = link?.join;
    const id = window.setInterval(() => {
      const e = engine.current;
      if (!e) return;
      if (pendingJoin && link) {
        e.net.join(link.code, link.tx);
        pendingJoin = false;
      }
      setStatus(e.net.status());
    }, 500);
    return () => window.clearInterval(id);
  }, [engine]);

  if (!open) {
    return (
      <div className={cn("pointer-events-auto", NET_SPOT)}>
        <Button variant="secondary" className={cn(NET_CONTROL, "px-3 text-xs")} onClick={() => setOpen(true)}>
          {status && status.role !== "off" ? `Net · ${status.role} ${status.room}` : "Net"}
        </Button>
      </div>
    );
  }

  const start = (role: "host" | "join") => {
    const e = engine.current;
    if (!e) return;
    const code = room.trim().toUpperCase() || Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => CODE_CHARS[b & 31]).join("");
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
    <div className={cn("hud-panel pointer-events-auto w-60 space-y-1.5 p-2 text-xs", NET_SPOT)}>
      <div className="flex items-center justify-between">
        <p className="hud-label">Multiplayer</p>
        <Button variant="ghost" className={cn(NET_CONTROL, "w-11 px-0 sm:w-8")} onClick={() => setOpen(false)} aria-label="Close multiplayer panel">
          ×
        </Button>
      </div>
      {live ? (
        <>
          <p className="font-display">
            {status.public ? `Public ${status.public}` : status.role === "host" ? "Hosting" : "Joined"} <span className="tabular-nums">{status.room}</span> ·{" "}
            {status.tx === "rtc" ? "WebRTC" : "this browser"}
          </p>
          <NetNotice status={status} />
          <p className="text-muted">
            {status.peers.length + 1}/{ROOM_MAX} players · car {status.car < 0 ? "…" : status.car}
            {status.role === "host" ? " (host)" : ""} · {status.snapHz.toFixed(0)} snapshots/s · {(status.bytesPerSec / 1024).toFixed(1)} KB/s
          </p>
          {status.lobby != null ? (
            <p className="font-display" role="status">
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
          {status.public ? null : (
            <>
              <Button variant="secondary" className={cn(NET_CONTROL, "w-full text-xs")} onClick={copyInvite} title={invite} aria-label="Copy invite link">
                {copied ? "Link copied" : "Copy invite link"}
              </Button>
              {status.tx === "rtc" ? <InviteQr link={invite} /> : null}
            </>
          )}
          <Button variant="secondary" className={cn(NET_CONTROL, "w-full text-xs")} onClick={() => engine.current?.net.leave()}>
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
              className={cn(NET_CONTROL, "w-full rounded-md bg-surface-2 px-2 font-display uppercase")}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="hud-label w-12 shrink-0">Link</span>
            <select
              value={tx}
              onChange={(e) => setTx(e.target.value === "bc" ? "bc" : "rtc")}
              aria-label="Connection"
              className={cn(NET_CONTROL, "w-full rounded-md bg-surface-2 px-2")}
            >
              <option value="rtc">Internet (WebRTC)</option>
              <option value="bc">This browser (tabs)</option>
            </select>
          </label>
          <div className="flex gap-1">
            <Button className={cn(NET_CONTROL, "flex-1 text-xs")} onClick={() => start("host")}>
              Host
            </Button>
            <Button variant="secondary" className={cn(NET_CONTROL, "flex-1 text-xs")} disabled={!room.trim()} onClick={() => start("join")}>
              Join
            </Button>
          </div>
          <div className="flex gap-1">
            <Button variant="secondary" className={cn(NET_CONTROL, "flex-1 text-xs")} disabled={status?.finding} onClick={() => void engine.current?.net.publicMatch("race")}>
              {status?.finding ? "Finding…" : "Public race"}
            </Button>
            <Button variant="secondary" className={cn(NET_CONTROL, "flex-1 text-xs")} disabled={status?.finding} onClick={() => void engine.current?.net.publicMatch("derby")}>
              Public derby
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

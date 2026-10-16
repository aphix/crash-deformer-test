import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, Globe, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCoarsePointer } from "@/components/use-coarse-pointer";
import { HostForm, newDraft, type HostDraft } from "@/components/online-host";
import { JoinForm } from "@/components/online-join";
import { useOnlineSlot } from "@/components/online-slot";
import { SessionDetails } from "@/components/online-session";
import { useLiveRooms, useNetStatus } from "@/components/use-live-rooms";
import type { CrashEngine } from "@/game/engine/engine";
import { leaveFollowUp } from "@/game/hud/online-leave";
import { netDeepLink } from "@/game/hud/share-url";
import { sessionText } from "@/game/net/session-text";
import type { RaceHud } from "@/game/match/types";
import { NET_TX, type NetTx } from "@/game/net/net-ports";
import { cn } from "@/lib/utils";

/** Taps stay 44 px tall on phones, 32 px from `sm`. */
const TAP = "h-11 sm:h-8";
/** What the open panel leaves free at the screen edge and between it and the pill. */
const PANEL_GAP_PX = 8;
/** The thumb pad's reach up the screen (px) on a phone held upright (the Camera view button's top edge stands 180 px above the bottom on a 390 x 844 screen): the panel ends above it. */
const THUMB_PAD_PX = 180;
const keepFocus = (e: { preventDefault: () => void }): void => e.preventDefault();

type Tab = "host" | "join";

/**
 * The one online entry (docs/MULTIPLAYER.md), under the title at the top left, or in the header corner of whichever race menu is up
 * (`online-slot.ts`: above the menu's backdrop, never over its text). Offline it is one "Online" button; its panel hosts a room (every
 * game, public or private) or joins one (the live list of every game, or a password). Once a session is on it is the session's chip
 * instead, with Leave, and its panel holds the room's password, QR, lobby gate, peers and ping. It polls the relay only while the Join
 * list is open, and its buttons never take keyboard focus from the game. `race` is null outside race mode.
 */
export function OnlineEntry({ engine, race }: { engine: RefObject<CrashEngine | null>; race: RaceHud | null }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("host");
  const [draft, setDraft] = useState<HostDraft | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [joinTx, setJoinTx] = useState<NetTx>(NET_TX.rtc);
  /** A `?net=host&room=CODE` link: fills the hosting form with a private room of that password. */
  const [seed, setSeed] = useState<{ code: string; tx: NetTx } | null>(null);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const coarse = useCoarsePointer();
  const slot = useOnlineSlot();
  const status = useNetStatus(engine);
  const online = status !== null && (status.role !== "off" || status.finding);
  const hasSession = status !== null && status.role !== "off";
  const rooms = useLiveRooms(!online && open && tab === "join", true);

  // `?net=host&room=CODE` opens the panel with the password filled in (hosting takes a click); `?net=join` joins on load (use-deep-link-join.ts).
  useEffect(() => {
    const link = netDeepLink(window.location.search);
    if (!link || link.join) return;
    setOpen(true);
    setTab("host");
    setSeed({ code: link.code, tx: link.tx });
  }, []);

  // The panel hangs from the pill, fixed to the screen (a menu's box clips anything absolute) and scrolling inside the space left below it, so it never runs off a short screen or over the thumb pad.
  useLayoutEffect(() => {
    if (!open) return;
    const fit = (): void => {
      const pill = anchor.current;
      if (!pill) return;
      const r = pill.getBoundingClientRect();
      const padReach = coarse && window.innerHeight > window.innerWidth ? THUMB_PAD_PX : 0;
      const side = slot ? { right: Math.max(PANEL_GAP_PX, window.innerWidth - r.right) } : { left: Math.max(PANEL_GAP_PX, r.left) };
      setPlace({ top: r.bottom + 4, maxHeight: Math.max(0, window.innerHeight - r.bottom - 2 * PANEL_GAP_PX - padReach), ...side });
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open, online, coarse, slot]);

  const leave = (): void => {
    const e = engine.current;
    if (!e) return;
    const followUp = leaveFollowUp(e.net.role, race !== null);
    e.net.leave();
    if (followUp === "close-race") e.toggleRace();
    else if (followUp === "quit-race") e.raceCommand({ type: "quit" });
    setOpen(false);
  };

  const menu = open && !hasSession ? engine.current?.net.courseMenu() : undefined;
  const hosting = draft ?? (menu ? { ...newDraft(menu), ...(seed ? { visibility: "private" as const, code: seed.code, tx: seed.tx } : {}) } : null);
  const tabButton = (t: Tab, label: string) => (
    <Button key={t} className={cn(TAP, "flex-1 px-2 text-xs")} variant={tab === t ? "default" : "secondary"} aria-pressed={tab === t} onMouseDown={keepFocus} onClick={() => setTab(t)}>
      {label}
    </Button>
  );

  const entry = (
    <div ref={anchor} className="pointer-events-auto relative w-fit max-w-[calc(100vw-1rem)]">
      {online ? (
        <div className="hud-panel flex items-center gap-1 py-1 pl-1 pr-1">
          <button
            type="button"
            disabled={!hasSession}
            className={cn(TAP, "flex min-w-0 items-center gap-2 rounded-md px-2 text-left")}
            onMouseDown={keepFocus}
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-label="Online session details"
          >
            <span className="size-2 shrink-0 rounded-full bg-signal-green" aria-hidden />
            <p className="min-w-0 font-display text-xs leading-tight tabular-nums sm:text-sm" aria-hidden>
              {sessionText(status)}
            </p>
            {hasSession ? open ? <ChevronUp className="shrink-0" /> : <ChevronDown className="shrink-0" /> : null}
          </button>
          <span className="sr-only" role="status" aria-live="polite">
            {sessionText(status, false)}
          </span>
          <Button variant="ghost" size="sm" className={cn(TAP, "shrink-0 px-2")} onMouseDown={keepFocus} onClick={leave} aria-label="Leave online match">
            <LogOut />
            <span className="hidden sm:inline">Leave</span>
          </Button>
        </div>
      ) : (
        <Button variant="secondary" size="sm" className={cn(TAP, "gap-1.5 px-3")} onMouseDown={keepFocus} onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Online: host or join a room">
          <Globe />
          Online
          {open ? <ChevronUp /> : <ChevronDown />}
        </Button>
      )}
      {open && (hasSession || !online) ? (
        <div
          className="hud-panel fixed z-50 w-[min(20rem,calc(100vw-1rem))] overflow-y-auto p-2 text-xs"
          style={{ background: "var(--color-surface)", ...place }}
          // The panel is a form of its own: its keys never reach the open menu's (Esc, Enter, arrows) or the game's.
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            e.nativeEvent.stopPropagation();
          }}
          onKeyUp={(e) => e.nativeEvent.stopPropagation()}
        >
          {hasSession ? (
            <SessionDetails engine={engine} status={status} />
          ) : (
            <div className="space-y-2">
              <div className="flex gap-1" role="group" aria-label="Online">
                {tabButton("host", "Host")}
                {tabButton("join", "Join")}
              </div>
              {tab === "host" && hosting ? (
                <HostForm engine={engine} draft={hosting} onDraft={setDraft} onHosted={() => setOpen(false)} />
              ) : (
                <JoinForm engine={engine} rooms={rooms} code={joinCode} onCode={setJoinCode} tx={joinTx} onTx={setJoinTx} onJoined={() => setOpen(false)} />
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
  return slot ? createPortal(entry, slot) : <div className="pointer-events-none relative z-20 mt-1">{entry}</div>;
}

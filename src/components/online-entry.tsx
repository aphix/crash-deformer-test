import { useEffect, useRef, useState, type RefObject } from "react";
import { ChevronDown, ChevronUp, Globe, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PrivateRoomForm } from "@/components/online-private-room";
import { SessionDetails } from "@/components/online-session";
import { useLiveRooms, useNetStatus } from "@/components/use-live-rooms";
import type { CrashEngine } from "@/game/engine/engine";
import { leaveFollowUp } from "@/game/hud/online-leave";
import { netDeepLink } from "@/game/hud/share-url";
import { sessionText } from "@/game/hud/session-text";
import type { RaceHud } from "@/game/match/types";
import type { OpenRoom } from "@/game/net/matchmaking";
import { NET_TX, type NetTx } from "@/game/net/net-ports";
import { ROOM_MAX } from "@/lib/multiplayer/rooms";
import { cn } from "@/lib/utils";

/** Taps stay 44 px tall on phones, 32 px from `sm`. */
const TAP = "h-11 sm:h-8";
/** What the open panel leaves free at the screen edge and between it and the pill. */
const PANEL_GAP_PX = 8;
const keepFocus = (e: { preventDefault: () => void }): void => e.preventDefault();

const STAGE: Record<string, string> = { lobby: "Starting soon", over: "Results", running: "Racing" };

/** The panel's two blocks stack, and sit side by side on a phone on its side, where there is width but no height (so it ends above the thumb pad). */
const PANEL_COLUMNS = "space-y-2 phone-landscape:grid phone-landscape:grid-cols-2 phone-landscape:gap-3 phone-landscape:space-y-0";

function RoomRow({ r, courseName, onJoin }: { r: OpenRoom; courseName: string; onJoin: () => void }) {
  return (
    <li className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <p className="truncate font-display text-sm">{courseName}</p>
        <p className="hud-label tabular-nums">
          {r.players}/{ROOM_MAX} players · {r.stage ? STAGE[r.stage] : "Open"}
        </p>
      </div>
      <Button size="sm" className={cn(TAP, "px-3")} onMouseDown={keepFocus} onClick={onJoin} aria-label={`Join ${courseName}, ${r.players} of ${ROOM_MAX} players`}>
        Join
      </Button>
    </li>
  );
}

type OnlineAct = (run: (engine: CrashEngine) => void) => void;

/** The public side of the panel: race mode's open races with Join, then Play online, Public derby and (race mode) Host race. */
function PublicMatches({ race, rooms, act }: { race: RaceHud | null; rooms: OpenRoom[] | null | undefined; act: OnlineAct }) {
  const courseName = (id: string): string => race?.courses.find((c) => c.id === id)?.name ?? (id ? id[0]!.toUpperCase() + id.slice(1) : "Race");
  return (
    <div className="space-y-2">
      {race === null ? null : (
        <>
          <p className="hud-label">Live races</p>
          {rooms === null ? <p className="text-sm text-muted">Can't reach the lobby. Play online still hosts a race.</p> : null}
          {rooms?.length === 0 ? <p className="text-sm text-muted">No open races. Play online starts one.</p> : null}
          {rooms?.length ? (
            <ul className="space-y-2" aria-label="Open races">
              {rooms.slice(0, 8).map((r) => (
                <RoomRow key={r.room} r={r} courseName={courseName(r.course)} onJoin={() => act((e) => e.net.publicJoin(r.room, "race"))} />
              ))}
            </ul>
          ) : null}
        </>
      )}
      <div className="flex flex-wrap gap-1">
        <Button className={cn(TAP, "min-w-fit flex-1 gap-1.5 px-3 text-xs")} onMouseDown={keepFocus} onClick={() => act((e) => void e.net.publicMatch("race"))}>
          <Globe />
          Play online
        </Button>
        <Button variant="secondary" className={cn(TAP, "min-w-fit flex-1 px-3 text-xs")} onMouseDown={keepFocus} onClick={() => act((e) => void e.net.publicMatch("derby"))}>
          Public derby
        </Button>
        {race === null ? null : (
          <Button variant="secondary" className={cn(TAP, "min-w-fit flex-1 px-3 text-xs")} onMouseDown={keepFocus} onClick={() => act((e) => e.net.publicHost("race"))}>
            Host race
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The one online entry (docs/MULTIPLAYER.md), under the title at the top left: race mode shows "Play online" and the open
 * races ("3 live"), every other scene one "Online" button; either opens a panel of public matches and private rooms
 * (host or join by code, link, QR). Once a session is on it is the session's chip instead, with Leave, and its panel holds
 * the room code, QR, peers and ping. It polls the relay only in race mode and outside a session, and its buttons never take
 * keyboard focus from the game. `race` is null outside race mode. In the race setup card it sits in the card's top-right corner.
 */
export function OnlineEntry({ engine, race }: { engine: RefObject<CrashEngine | null>; race: RaceHud | null }) {
  const [open, setOpen] = useState(false);
  const [room, setRoom] = useState("");
  const [tx, setTx] = useState<NetTx>(NET_TX.rtc);
  const [panelMaxHeight, setPanelMaxHeight] = useState<number | undefined>(undefined);
  const anchor = useRef<HTMLDivElement>(null);
  const status = useNetStatus(engine);
  const online = status !== null && (status.role !== "off" || status.finding);
  const rooms = useLiveRooms(race !== null && !online, open);
  const driving = race !== null && race.menu === null && (race.phase === "countdown" || race.phase === "racing");
  const setup = race?.menu === "setup";
  const live = rooms?.length ?? 0;

  // `?net=host&room=CODE` opens the panel with the code filled in (hosting takes a click); `?net=join` joins on load (use-deep-link-join.ts).
  useEffect(() => {
    const link = netDeepLink(window.location.search);
    if (!link || link.join) return;
    setOpen(true);
    setRoom(link.code);
    setTx(link.tx);
  }, []);

  // The panel hangs from the pill and scrolls inside the space left below it, so it never runs off a short screen (a phone on its side).
  useEffect(() => {
    if (!open) return;
    const fitBelowPill = (): void => {
      const pill = anchor.current;
      if (pill) setPanelMaxHeight(Math.max(0, window.innerHeight - pill.getBoundingClientRect().bottom - 2 * PANEL_GAP_PX));
    };
    fitBelowPill();
    window.addEventListener("resize", fitBelowPill);
    return () => window.removeEventListener("resize", fitBelowPill);
  }, [open, online]);

  const act = (run: (e: CrashEngine) => void): void => {
    const e = engine.current;
    if (!e) return;
    run(e);
    setOpen(false);
  };
  const leave = (): void => {
    const e = engine.current;
    if (!e) return;
    const followUp = leaveFollowUp(e.net.role, race !== null);
    e.net.leave();
    if (followUp === "close-race") e.toggleRace();
    else if (followUp === "quit-race") e.raceCommand({ type: "quit" });
    setOpen(false);
  };

  // The setup card is a centred sheet (full-screen on phones, `max-w-2xl` wide): the entry sits in its empty top-right corner, inside the card,
  // never straddling its edge, so it layers over the menu (`MenuShell` is z-30). Otherwise it hangs under the title, under any open menu.
  const spot = setup ? "fixed inset-x-3 top-5 z-40 mx-auto flex max-w-2xl justify-end pr-2 sm:inset-x-6 sm:top-8" : "relative z-20 mt-1";
  const hasSession = status !== null && status.role !== "off";

  return (
    <div className={cn("pointer-events-none", spot)}>
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
          <div className="flex items-center gap-1">
            {race === null ? (
              <Button variant="secondary" size="sm" className={cn(TAP, "gap-1.5 px-3")} onMouseDown={keepFocus} onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Online: public matches and private rooms">
                <Globe />
                Online
                {open ? <ChevronUp /> : <ChevronDown />}
              </Button>
            ) : (
              <>
                {driving ? null : (
                  <Button size="sm" className={cn(TAP, "gap-1.5 px-3")} onMouseDown={keepFocus} onClick={() => act((e) => void e.net.publicMatch("race"))} aria-label="Play online: join the best open race, or host one">
                    <Globe />
                    Play online
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  className={cn(TAP, "gap-1.5 px-3 tabular-nums")}
                  onMouseDown={keepFocus}
                  onClick={() => setOpen(!open)}
                  aria-expanded={open}
                  aria-label={rooms === undefined ? "Live races and private rooms" : `${live} live races, and private rooms`}
                >
                  <span className={cn("size-2 rounded-full", live > 0 ? "bg-signal-green" : "bg-muted")} aria-hidden />
                  {rooms === undefined ? "…" : `${live} live`}
                  {open ? <ChevronUp /> : <ChevronDown />}
                </Button>
              </>
            )}
          </div>
        )}
        {open && (hasSession || !online) ? (
          <div
            className={cn(
              "hud-panel absolute top-full mt-1 w-[min(17rem,calc(100vw-1rem))] overflow-y-auto p-2 text-xs phone-landscape:w-[min(30rem,calc(100vw-1rem))]",
              setup ? "right-0" : "left-0",
            )}
            style={{ background: "var(--color-surface)", maxHeight: panelMaxHeight }}
          >
            <div className={PANEL_COLUMNS}>
              {hasSession ? (
                <SessionDetails engine={engine} status={status} />
              ) : (
                <>
                  <PublicMatches race={race} rooms={rooms} act={act} />
                  <PrivateRoomForm engine={engine} room={room} onRoom={setRoom} tx={tx} onTx={setTx} />
                </>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

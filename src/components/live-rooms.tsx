import { useState, type RefObject } from "react";
import { ChevronDown, ChevronUp, Globe, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLiveRooms, useNetStatus } from "@/components/use-live-rooms";
import type { CrashEngine } from "@/game/engine/engine";
import type { OpenRoom } from "@/game/net/matchmaking";
import type { NetStatus } from "@/game/net/net-ports";
import type { RaceHud } from "@/game/match/types";
import { ROOM_MAX } from "@/lib/multiplayer/rooms";
import { cn } from "@/lib/utils";

/** Taps stay 44 px tall on phones, 32 px from `sm`. */
const TAP = "h-11 sm:h-8";
const keepFocus = (e: { preventDefault: () => void }): void => e.preventDefault();

const STAGE: Record<string, string> = { lobby: "Starting soon", over: "Results", running: "Racing" };

/**
 * What this session is doing, in a line (the chip's text; a stranded or refused guest says why). `seconds` false
 * leaves the lobby countdown out, so the line only changes when the state does (the screen-reader copy).
 */
function sessionText(s: NetStatus, seconds = true): string {
  if (s.finding) return "Finding a race…";
  if (s.problem === "version") return "Different game version: reload";
  if (s.relayError) return s.relayError[0]!.toUpperCase() + s.relayError.slice(1);
  const players = s.peers.length + 1;
  const where = s.public ? (s.role === "host" ? "Hosting" : "Joined") : `Room ${s.room}`;
  if (s.lobby === null) return `${where} · ${players}/${ROOM_MAX} · race on`;
  const start = seconds ? `starts in ${s.lobby} s` : "in the lobby";
  if (s.role === "host" && players === 1) return `Waiting for players · ${start}`;
  return `${where} · ${players}/${ROOM_MAX} · ${start}`;
}

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

/**
 * Race mode's online entry, top-left under the title: a small pill with a "Play online" button and the live
 * races ("3 live"), which opens into a list with Join, Play online and Host (docs/MULTIPLAYER.md "Live rooms").
 * Once a session is on it is the session's chip instead, with Leave. It polls the relay only while shown and not
 * in a session, and the pill's buttons never take keyboard focus from the game.
 */
export function LiveRooms({ engine, race }: { engine: RefObject<CrashEngine | null>; race: RaceHud }) {
  const [open, setOpen] = useState(false);
  const status = useNetStatus(engine);
  const online = status !== null && (status.role !== "off" || status.finding);
  const rooms = useLiveRooms(!online, open);
  const driving = race.menu === null && (race.phase === "countdown" || race.phase === "racing");
  const courseName = (id: string): string => race.courses.find((c) => c.id === id)?.name ?? (id ? id[0]!.toUpperCase() + id.slice(1) : "Race");
  const act = (run: (e: CrashEngine) => void): void => {
    const e = engine.current;
    if (!e) return;
    run(e);
    setOpen(false);
  };
  /** Leave (or stop searching). A guest's leave closed race mode with its host's, and a host's leaves its lobby course up with no menu: both go back to the race setup menu. */
  const leave = (): void => {
    const e = engine.current;
    if (!e) return;
    const role = e.net.role;
    e.net.leave();
    if (role === "client") e.toggleRace();
    else if (role === "host") e.raceCommand({ type: "quit" });
  };
  // The setup card is a centred sheet (full-screen on phones, `max-w-2xl` wide): the pill sits in its empty top-right corner, inside the card,
  // never straddling its edge, so it layers over the menu (`MenuShell` is z-30). Otherwise it hangs under the title, under any open menu: over
  // a phone on its side it would cover the Results or Championship card's header.
  const setup = race.menu === "setup";
  const spot = setup ? "z-40 inset-x-3 top-5 mx-auto max-w-2xl pr-2 sm:inset-x-6 sm:top-8" : cn("z-20 max-w-[calc(100vw-1rem)] left-2 sm:left-4", race.fullUi ? "top-14 sm:top-[6.5rem]" : "top-8 sm:top-11");
  const live = rooms?.length ?? 0;

  if (online) {
    return (
      <div className={cn("pointer-events-none absolute flex", spot)}>
        <div className={cn("hud-panel pointer-events-auto flex max-w-[calc(100vw-1rem)] items-center gap-1 py-1 pl-3 pr-1", setup && "ml-auto")}>
          <span className="size-2 shrink-0 rounded-full bg-signal-green" aria-hidden />
          <p className="min-w-0 truncate font-display text-xs tabular-nums sm:text-sm" aria-hidden>
            {sessionText(status)}
          </p>
          <span className="sr-only" role="status" aria-live="polite">
            {sessionText(status, false)}
          </span>
          <Button variant="ghost" size="sm" className={cn(TAP, "px-2")} onMouseDown={keepFocus} onClick={leave} aria-label="Leave online match">
            <LogOut />
            <span className="hidden sm:inline">Leave</span>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("pointer-events-none absolute flex flex-col gap-1", setup ? "items-end" : "items-start", spot)}>
      <div className="pointer-events-auto flex items-center gap-1">
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
          aria-label={rooms === undefined ? "Live races" : `${live} live races`}
        >
          <span className={cn("size-2 rounded-full", live > 0 ? "bg-signal-green" : "bg-muted")} aria-hidden />
          {rooms === undefined ? "…" : `${live} live`}
          {open ? <ChevronUp /> : <ChevronDown />}
        </Button>
      </div>
      {open ? (
        <div
          className="hud-panel pointer-events-auto w-[min(17rem,calc(100vw-1rem))] max-h-[calc(100dvh-8rem)] space-y-2 overflow-y-auto p-2 sm:max-h-[26rem]"
          style={{ background: "var(--color-surface)" }}
        >
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
          <div className="flex gap-1">
            <Button className={cn(TAP, "flex-1 gap-1.5 px-3 text-xs")} onMouseDown={keepFocus} onClick={() => act((e) => void e.net.publicMatch("race"))}>
              <Globe />
              Play online
            </Button>
            <Button variant="secondary" className={cn(TAP, "flex-1 px-3 text-xs")} onMouseDown={keepFocus} onClick={() => act((e) => e.net.publicHost("race"))}>
              Host
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

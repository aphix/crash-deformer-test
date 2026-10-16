import type { RefObject } from "react";
import { GAME_LABEL } from "@/components/game-options";
import { Button } from "@/components/ui/button";
import type { CrashEngine } from "@/game/engine/engine";
import type { OpenRoom } from "@/game/net/matchmaking";
import { NET_TX, type CourseMenu, type NetTx } from "@/game/net/net-ports";
import { ROOM_MAX } from "@/lib/multiplayer/rooms";
import { cn } from "@/lib/utils";

/** Buttons and fields: 44 px tall on phones, 32 px from `sm`. */
const CONTROL = "h-11 sm:h-8";
const keepFocus = (e: { preventDefault: () => void }): void => e.preventDefault();

const STAGE: Record<string, string> = { lobby: "Starting soon", over: "Results", running: "Racing" };

/** What a listed room's host says it plays, in words: its course, or how many courses a campaign has. */
function courseLine(r: OpenRoom, menu: CourseMenu): string {
  if (r.kind === "campaign") return r.course ? `${r.course} course${r.course === "1" ? "" : "s"}` : "";
  const list = r.kind === "survival" ? menu.survival : menu.courses;
  return list.find((c) => c.id === r.course)?.name ?? "";
}

type JoinFormProps = {
  engine: RefObject<CrashEngine | null>;
  /** The relay's open public rooms of every game; undefined until the first answer, null when it cannot be reached. */
  rooms: OpenRoom[] | null | undefined;
  code: string;
  onCode: (code: string) => void;
  tx: NetTx;
  onTx: (tx: NetTx) => void;
  onJoined: () => void;
};

/** The one way to join, for every game: a public room from the live list, or a private room by its password (the room code) or link. */
export function JoinForm({ engine, rooms, code, onCode, tx, onTx, onJoined }: JoinFormProps) {
  const net = engine.current?.net;
  if (!net) return null;
  const menu = net.courseMenu();
  const joinCode = (): void => {
    net.join(code.trim().toUpperCase(), tx);
    onJoined();
  };
  return (
    <div className="space-y-2">
      <p className="hud-label">Open rooms</p>
      {rooms === null ? <p className="text-sm text-muted">Can't reach the room list. A password still joins a private room.</p> : null}
      {rooms?.length === 0 ? <p className="text-sm text-muted">No public rooms are open. Host one.</p> : null}
      {rooms?.length ? (
        <ul className="space-y-2" aria-label="Open rooms">
          {rooms.slice(0, 8).map((r) => {
            const line = courseLine(r, menu);
            const title = `${GAME_LABEL[r.kind]}${line ? ` · ${line}` : ""}`;
            return (
              <li key={r.room} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-display text-sm">{title}</p>
                  <p className="hud-label tabular-nums">
                    {r.players}/{ROOM_MAX} players · {r.stage ? STAGE[r.stage] : "Open"}
                  </p>
                </div>
                <Button
                  size="sm"
                  className={cn(CONTROL, "px-3")}
                  onMouseDown={keepFocus}
                  onClick={() => {
                    net.publicJoin(r.room, r.kind);
                    onJoined();
                  }}
                  aria-label={`Join ${title}, ${r.players} of ${ROOM_MAX} players`}
                >
                  Join
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className="hud-label">Private room</p>
      <label className="flex items-center gap-2">
        <span className="hud-label w-12 shrink-0">Password</span>
        <input
          value={code}
          onChange={(e) => onCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
          placeholder="room password"
          maxLength={12}
          aria-label="Room password to join"
          className={cn(CONTROL, "w-full rounded-md bg-surface-2 px-2 font-display uppercase")}
        />
      </label>
      <label className="flex items-center gap-2">
        <span className="hud-label w-12 shrink-0">Link</span>
        <select value={tx} onChange={(e) => onTx(e.target.value === NET_TX.bc ? NET_TX.bc : NET_TX.rtc)} aria-label="Connection to join over" className={cn(CONTROL, "w-full rounded-md bg-surface-2 px-2")}>
          <option value={NET_TX.rtc}>Internet (WebRTC)</option>
          <option value={NET_TX.bc}>This browser (tabs)</option>
        </select>
      </label>
      <Button className={cn(CONTROL, "w-full text-xs")} disabled={!code.trim()} onClick={joinCode}>
        Join room
      </Button>
    </div>
  );
}

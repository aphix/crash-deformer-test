import type { RefObject } from "react";
import { GameOptions } from "@/components/game-options";
import { useAutoNext } from "@/components/auto-next";
import { PlayersStepper } from "@/components/players-stepper";
import { Button } from "@/components/ui/button";
import type { CrashEngine } from "@/game/engine/engine";
import type { GameKind } from "@/game/net/codec";
import { NET_TX, type CourseMenu, type NetTx } from "@/game/net/net-ports";
import { DEFAULT_MIN_PLAYERS } from "@/game/net/net-constants";
import { ROOM_MAX } from "@/lib/multiplayer/rooms";
import { cn } from "@/lib/utils";

/** Buttons and fields: 44 px tall on phones, 32 px from `sm`. */
const CONTROL = "h-11 sm:h-8";
const keepFocus = (e: { preventDefault: () => void }): void => e.preventDefault();
/** Generated passwords: 8 of these 32 characters (no I, O, 0 or 1) from `crypto.getRandomValues`, 40 bits, unguessable. */
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** What the hosting panel holds between openings: the host's picks before the room exists. */
export interface HostDraft {
  kind: GameKind;
  /** Public: listed for anyone. Private: unlisted, joined by the password (the room code). */
  visibility: "public" | "private";
  /** The private room's password; empty makes one up. */
  code: string;
  tx: NetTx;
  minPlayers: number;
  raceCourse: string;
  survivalCourse: string;
  playlist: readonly string[];
}

/** A first draft: a public race on the menu's first course, the campaign over every course, Survival on the first Survival course. */
export function newDraft(menu: CourseMenu): HostDraft {
  return {
    kind: "race",
    visibility: "public",
    code: "",
    tx: NET_TX.rtc,
    minPlayers: DEFAULT_MIN_PLAYERS,
    raceCourse: menu.courses[0]?.id ?? "",
    survivalCourse: menu.survival[0]?.id ?? "",
    playlist: menu.courses.map((c) => c.id),
  };
}

/** The one hosting form, for every game (docs/MULTIPLAYER.md "Rooms, joining, migration"): the game and its options, who may join, how many players Go waits for. */
export function HostForm({ engine, draft, onDraft, onHosted }: { engine: RefObject<CrashEngine | null>; draft: HostDraft; onDraft: (draft: HostDraft) => void; onHosted: () => void }) {
  const [autoNext] = useAutoNext();
  const net = engine.current?.net;
  if (!net) return null;
  const menu = net.courseMenu();
  const set = (patch: Partial<HostDraft>): void => onDraft({ ...draft, ...patch });
  const isPublic = draft.visibility === "public";
  const host = (): void => {
    const code = isPublic ? null : draft.code.trim().toUpperCase() || Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => CODE_CHARS[b & 31]).join("");
    net.hostRoom({
      kind: draft.kind,
      code,
      tx: isPublic ? NET_TX.rtc : draft.tx,
      minPlayers: draft.minPlayers,
      course: draft.kind === "survival" ? draft.survivalCourse : draft.raceCourse,
      playlist: draft.playlist,
      autoNext,
    });
    onHosted();
  };
  return (
    <div className="space-y-2">
      <GameOptions
        kind={draft.kind}
        onKind={(kind) => set({ kind })}
        course={draft.kind === "survival" ? draft.survivalCourse : draft.raceCourse}
        onCourse={(id) => set(draft.kind === "survival" ? { survivalCourse: id } : { raceCourse: id })}
        playlist={draft.playlist}
        onPlaylist={(playlist) => set({ playlist })}
        menu={menu}
      />
      <div className="flex gap-1" role="group" aria-label="Who can join">
        {(["public", "private"] as const).map((v) => (
          <Button key={v} className={cn(CONTROL, "flex-1 px-2 text-xs")} variant={draft.visibility === v ? "default" : "secondary"} aria-pressed={draft.visibility === v} onMouseDown={keepFocus} onClick={() => set({ visibility: v })}>
            {v === "public" ? "Public" : "Private"}
          </Button>
        ))}
      </div>
      {isPublic ? (
        <p className="text-subtle">Listed for anyone to join.</p>
      ) : (
        <>
          <label className="flex items-center gap-2">
            <span className="hud-label w-12 shrink-0">Password</span>
            <input
              value={draft.code}
              onChange={(e) => set({ code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })}
              placeholder="new password"
              maxLength={12}
              aria-label="Room password"
              className={cn(CONTROL, "w-full rounded-md bg-surface-2 px-2 font-display uppercase")}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="hud-label w-12 shrink-0">Link</span>
            <select value={draft.tx} onChange={(e) => set({ tx: e.target.value === NET_TX.bc ? NET_TX.bc : NET_TX.rtc })} aria-label="Connection" className={cn(CONTROL, "w-full rounded-md bg-surface-2 px-2")}>
              <option value={NET_TX.rtc}>Internet (WebRTC)</option>
              <option value={NET_TX.bc}>This browser (tabs)</option>
            </select>
          </label>
          <p className="text-subtle">Not listed: players join with this password or your link.</p>
        </>
      )}
      <PlayersStepper value={draft.minPlayers} onStep={(by) => set({ minPlayers: Math.min(ROOM_MAX, Math.max(1, draft.minPlayers + by)) })} />
      <Button className={cn(CONTROL, "w-full text-xs")} disabled={draft.kind === "campaign" && draft.playlist.length === 0} onClick={host}>
        Host {isPublic ? "public" : "private"} room
      </Button>
    </div>
  );
}

import type { RefObject } from "react";
import { Play, RotateCcw } from "lucide-react";
import { GAME_LABEL, GameOptions } from "@/components/game-options";
import { PlayersStepper } from "@/components/players-stepper";
import { Button } from "@/components/ui/button";
import type { CrashEngine } from "@/game/engine/engine";
import type { NetStatus } from "@/game/net/net-ports";
import { cn } from "@/lib/utils";

/** Taps stay 44 px tall on phones, 32 px from `sm`. */
const TAP = "h-11 sm:h-8";
const keepFocus = (e: { preventDefault: () => void }): void => e.preventDefault();

/**
 * The Havana lobby's start gate (docs/MULTIPLAYER.md "Lobby"). Everyone reads how many more players the room waits for and what Go starts;
 * the host also sets the players needed (1 to the room size), the game's course or campaign playlist with the same `GameOptions` the
 * hosting panel has (the game itself only in a private room: a public room is named after its game), resets the scene, and presses Go,
 * which works once enough players are in.
 */
export function LobbyGate({ engine, status }: { engine: RefObject<CrashEngine | null>; status: NetStatus & { gate: NonNullable<NetStatus["gate"]> } }) {
  const { gate } = status;
  const host = status.role === "host";
  const need = gate.min - gate.players;
  const net = engine.current?.net;
  const menu = net?.courseMenu();
  /** Steps the wanted players from what the host holds now, not from the panel's last redraw. */
  const step = (by: number): void => net?.setMinPlayers((net.status().gate?.min ?? gate.min) + by);
  const waiting = need > 0 ? `Waiting for ${need} more player${need === 1 ? "" : "s"}…` : host ? "Ready: press Go to start." : "Waiting for the host to press Go…";
  const list = gate.kind === "survival" ? menu?.survival : menu?.courses;
  const nameOf = (id: string): string => list?.find((c) => c.id === id)?.name ?? id;
  const detail =
    gate.kind === "campaign"
      ? ` over ${gate.playlist.map(nameOf).join(" → ") || "no courses yet"}`
      : (gate.kind === "race" || gate.kind === "survival") && gate.course
        ? ` on ${nameOf(gate.course)}`
        : "";
  const canGo = need <= 0 && (gate.kind !== "campaign" || gate.playlist.length > 0);
  return (
    <div className="space-y-1.5" data-testid="lobby-gate">
      <p className="font-display" role="status">
        {waiting}
        {need <= 0 && status.lobby != null ? ` Starts in ${status.lobby} s.` : ""}
      </p>
      <p className="text-subtle">
        {gate.players} here · {GAME_LABEL[gate.kind]}
        {detail} starts
      </p>
      {host && net && menu ? (
        <>
          <PlayersStepper value={gate.min} onStep={step} />
          <GameOptions
            kind={gate.kind}
            onKind={status.public ? null : (kind) => net.setLobbyKind(kind)}
            course={gate.course}
            onCourse={(id) => (gate.kind === "survival" ? net.setLobbyCourse(id) : net.setRaceCourse(id))}
            playlist={gate.playlist}
            onPlaylist={(ids) => net.setPlaylist(ids)}
            menu={menu}
          />
          <div className="flex gap-1">
            <Button className={cn(TAP, "flex-1 gap-1.5 px-3 text-xs")} disabled={!canGo} onMouseDown={keepFocus} onClick={() => net.go()}>
              <Play />
              Go
            </Button>
            <Button className={cn(TAP, "flex-1 gap-1.5 px-3 text-xs")} variant="secondary" onMouseDown={keepFocus} onClick={() => net.resetScene()}>
              <RotateCcw />
              Reset scene
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

import type { RefObject } from "react";
import { Minus, Play, Plus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CrashEngine } from "@/game/engine/engine";
import { GAME_KINDS, type GameKind } from "@/game/net/codec";
import type { NetStatus } from "@/game/net/net-ports";
import { ROOM_MAX } from "@/lib/multiplayer/rooms";
import { cn } from "@/lib/utils";

/** Taps stay 44 px tall on phones, 32 px from `sm`. */
const TAP = "h-11 sm:h-8";
const keepFocus = (e: { preventDefault: () => void }): void => e.preventDefault();

const GAME_LABEL: Record<GameKind, string> = { race: "Race", survival: "Survival", derby: "Derby" };

/**
 * The Havana lobby's start gate (docs/MULTIPLAYER.md "Lobby"). Everyone reads how many more players the room waits for; the host
 * also sets that number (1 to the room size), picks the game in a private room, resets the scene, and presses Go, which works once
 * enough players are in.
 */
export function LobbyGate({ engine, status }: { engine: RefObject<CrashEngine | null>; status: NetStatus & { gate: NonNullable<NetStatus["gate"]> } }) {
  const { gate } = status;
  const host = status.role === "host";
  const need = gate.min - gate.players;
  const net = engine.current?.net;
  /** Steps the wanted players from what the host holds now, not from the panel's last redraw. */
  const step = (by: number): void => net?.setMinPlayers((net.status().gate?.min ?? gate.min) + by);
  const waiting = need > 0 ? `Waiting for ${need} more player${need === 1 ? "" : "s"}…` : host ? "Ready: press Go to start." : "Waiting for the host to press Go…";
  return (
    <div className="space-y-1.5" data-testid="lobby-gate">
      <p className="font-display" role="status">
        {waiting}
        {need <= 0 && status.lobby != null ? ` Starts in ${status.lobby} s.` : ""}
      </p>
      <p className="text-subtle">
        {gate.players} here · {GAME_LABEL[gate.kind]} starts
      </p>
      {host ? (
        <>
          <div className="flex items-center gap-1" role="group" aria-label="Players needed before Go">
            <Button className={cn(TAP, "px-2")} variant="secondary" disabled={gate.min <= 1} aria-label="Fewer players needed" onMouseDown={keepFocus} onClick={() => step(-1)}>
              <Minus />
            </Button>
            <span className="min-w-6 text-center font-display tabular-nums" aria-live="polite">
              {gate.min}
            </span>
            <Button className={cn(TAP, "px-2")} variant="secondary" disabled={gate.min >= ROOM_MAX} aria-label="More players needed" onMouseDown={keepFocus} onClick={() => step(1)}>
              <Plus />
            </Button>
            <span className="text-muted">players to start</span>
          </div>
          {status.public ? null : (
            <div className="flex gap-1" role="group" aria-label="Game Go starts">
              {GAME_KINDS.map((kind) => (
                <Button key={kind} className={cn(TAP, "flex-1 px-2 text-xs")} variant={gate.kind === kind ? "default" : "secondary"} aria-pressed={gate.kind === kind} onMouseDown={keepFocus} onClick={() => net?.setLobbyKind(kind)}>
                  {GAME_LABEL[kind]}
                </Button>
              ))}
            </div>
          )}
          <div className="flex gap-1">
            <Button className={cn(TAP, "flex-1 gap-1.5 px-3 text-xs")} disabled={need > 0} onMouseDown={keepFocus} onClick={() => net?.go()}>
              <Play />
              Go
            </Button>
            <Button className={cn(TAP, "flex-1 gap-1.5 px-3 text-xs")} variant="secondary" onMouseDown={keepFocus} onClick={() => net?.resetScene()}>
              <RotateCcw />
              Reset scene
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

import { ROOM_MAX } from "../../lib/multiplayer/rooms.ts";
import type { NetStatus } from "./net-ports.ts";

/** A client's session problem as the online entry words it (net-play.ts `NetStatus.problem`). */
const PROBLEM = {
  version: "Different game version: reload",
  "host-lost": "Host left: waiting for a new host…",
  "host-paused": "Host paused",
  "no-host": "Nobody is hosting this room: it may be closed",
} as const;

/** Why the session is stuck, if it is: the relay's refusal ("room full", "host taken", …) or the host's state. */
function sessionProblem(status: NetStatus): string | null {
  const refusal = status.relayError;
  if (refusal) return refusal[0]!.toUpperCase() + refusal.slice(1);
  return status.problem && PROBLEM[status.problem];
}

/**
 * What this session is doing, in a line (the chip's text; a stranded or refused guest says why). `seconds` false
 * leaves the lobby countdown out, so the line only changes when the state does (the screen-reader copy).
 */
export function sessionText(status: NetStatus, seconds = true): string {
  if (status.finding) return "Finding a race…";
  const problem = sessionProblem(status);
  if (problem) return problem;
  const players = status.peers.length + 1;
  const where = status.public ? (status.role === "host" ? "Hosting" : "Joined") : `Room ${status.room}`;
  const gate = status.gate;
  if (gate) {
    const need = gate.min - gate.players;
    const more = `${need} more${status.role === "host" && players === 1 ? (need === 1 ? " player" : " players") : ""}`;
    if (need > 0) return status.role === "host" && players === 1 ? `Waiting for ${more}` : `${where} · ${players}/${ROOM_MAX} · waiting for ${more}`;
    const lobby = status.lobby === null ? null : seconds ? `starts in ${status.lobby} s` : "in the lobby";
    return `${where} · ${players}/${ROOM_MAX} · ${lobby ?? (status.role === "host" ? "ready to go" : "waiting for the host")}`;
  }
  if (status.lobby === null) return `${where} · ${players}/${ROOM_MAX} · race on`;
  const start = seconds ? `starts in ${status.lobby} s` : "in the lobby";
  if (status.role === "host" && players === 1) return `Waiting for players · ${start}`;
  return `${where} · ${players}/${ROOM_MAX} · ${start}`;
}

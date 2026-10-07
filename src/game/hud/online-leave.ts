import type { NetRole } from "../net/net-ports.ts";

/** What the scene does after this browser leaves its session. */
type LeaveFollowUp = "none" | "close-race" | "quit-race";

/**
 * Leaving in race mode: a guest's race mode ran on its host's, so it closes; a host's leaves its lobby course up with no menu, so it
 * quits to the race setup menu. Outside race mode the scene stays as it is (a private room's guest in the Fleet must not be switched into a race).
 */
export function leaveFollowUp(role: NetRole, inRace: boolean): LeaveFollowUp {
  if (!inRace) return "none";
  if (role === "client") return "close-race";
  if (role === "host") return "quit-race";
  return "none";
}

import { useEffect, type RefObject } from "react";
import { useStoredString } from "@/components/use-stored-string";
import type { CrashEngine } from "@/game/engine/engine";
import { BETWEEN_ROUNDS_S } from "@/game/net/net-constants";

/** The host's choice is kept in this browser (`use-stored-string.ts`) and applies to every campaign it hosts later. */
const AUTO_NEXT_KEY = "crush.net.autonext";

/** Whether a hosted campaign moves on by itself after its between-rounds minute: saved in this browser, on until the host switches it off. */
export function useAutoNext(): [boolean, (on: boolean) => void] {
  const [value, setValue] = useStoredString(AUTO_NEXT_KEY, "on", "on");
  return [value !== "off", (on) => setValue(on ? "on" : "off")];
}

/**
 * "Auto next after 1 minute": the host's switch for a campaign's between-rounds stretch (results, highlights, standings). On, the next
 * course loads once the minute is up; off, the room stays on the results until the host presses Next, which always works at once.
 */
export function AutoNextToggle({ engine }: { engine: RefObject<CrashEngine | null> }) {
  const [on, setOn] = useAutoNext();
  const net = engine.current?.net;
  // The saved choice reaches a room hosted by another path (a retried link) too.
  useEffect(() => net?.setAutoNext(on), [net, on]);
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} className="size-4" />
      <span>Auto next after {BETWEEN_ROUNDS_S / 60} minute</span>
    </label>
  );
}

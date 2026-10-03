import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { CrashEngine } from "@/game/engine/engine";
import { fetchRooms, openRooms, RoomPoller, type LobbyRoom, type OpenRoom } from "@/game/net/matchmaking";
import type { NetStatus } from "@/game/net/net-ports";

/**
 * The open public races, kept fresh while `active` (docs/MULTIPLAYER.md "Live rooms"): every 10 s, every 4 s
 * while the list is `expanded`, none while the tab is hidden, slower after a failure. `undefined` until the first
 * answer, null when the relay cannot be reached.
 */
export function useLiveRooms(active: boolean, expanded: boolean): OpenRoom[] | null | undefined {
  const [list, setList] = useState<LobbyRoom[] | null | undefined>(undefined);
  const poller = useRef<RoomPoller | null>(null);
  const wasExpanded = useRef(expanded);
  wasExpanded.current = expanded;

  useEffect(() => {
    if (!active) return;
    const p = new RoomPoller(
      {
        fetch: () => fetchRooms("race"),
        setTimer: (fn, ms) => window.setTimeout(fn, ms),
        clearTimer: (handle) => window.clearTimeout(handle as number),
        visible: () => !document.hidden,
      },
      setList,
    );
    p.setExpanded(wasExpanded.current);
    p.start();
    poller.current = p;
    return () => {
      p.stop();
      poller.current = null;
    };
  }, [active]);

  useEffect(() => poller.current?.setExpanded(expanded), [expanded]);

  return useMemo(() => (list ? openRooms(list, "race") : list), [list]);
}

/** This browser's netplay session, re-read twice a second (the Net panel's cadence). */
export function useNetStatus(engine: RefObject<CrashEngine | null>): NetStatus | null {
  const [status, setStatus] = useState<NetStatus | null>(null);
  useEffect(() => {
    const id = window.setInterval(() => {
      const e = engine.current;
      if (e) setStatus(e.net.status());
    }, 500);
    return () => window.clearInterval(id);
  }, [engine]);
  return status;
}

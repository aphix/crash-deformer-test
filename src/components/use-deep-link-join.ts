import { useEffect, type RefObject } from "react";
import type { CrashEngine } from "@/game/engine/engine";
import { netDeepLink } from "@/game/hud/share-url";

/** `?net=join&room=CODE[&tx=bc]` joins that room once, when the engine is up. Lives with the page, not with the online entry, which comes and goes with the HUD. */
export function useDeepLinkJoin(engine: RefObject<CrashEngine | null>): void {
  useEffect(() => {
    const link = netDeepLink(window.location.search);
    if (!link?.join) return;
    const id = window.setInterval(() => {
      const current = engine.current;
      if (!current) return;
      current.net.join(link.code, link.tx);
      window.clearInterval(id);
    }, 500);
    return () => window.clearInterval(id);
  }, [engine]);
}

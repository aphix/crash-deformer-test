import { type RefObject, useEffect, useRef } from "react";
import type { RaceCommand, ReelCoverId } from "@/game/match/types";

/**
 * A panel open over the results reel: while `send` is set, `root`'s box on the page goes to the engine as `reelCover`
 * `id` (again on every size change of the panel or the page, null once it closes or `send` goes), so the reel frames its
 * shots in the part of the view the open panels leave free.
 */
export function useReelCover(root: RefObject<HTMLElement | null>, id: ReelCoverId, send: ((cmd: RaceCommand) => void) | null): void {
  const latest = useRef(send);
  useEffect(() => {
    latest.current = send;
  });
  const on = send !== null;
  useEffect(() => {
    const el = root.current;
    if (!on || !el) return;
    const report = (): void => latest.current?.({ type: "reelCover", id, cover: el.getBoundingClientRect() });
    // A size change of the panel, or of the page (a right-hand panel moves without resizing).
    const obs = new ResizeObserver(report);
    obs.observe(el);
    window.addEventListener("resize", report);
    return () => {
      obs.disconnect();
      window.removeEventListener("resize", report);
      latest.current?.({ type: "reelCover", id, cover: null });
    };
  }, [root, id, on]);
}

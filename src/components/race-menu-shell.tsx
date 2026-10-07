import { type ReactNode, useEffect, useRef } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { usePadMenu } from "@/components/use-pad-menu";
import { FOCUS } from "@/components/race-menu-styles";
import type { RaceCommand } from "@/game/match/types";
import { cn } from "@/lib/utils";

/** Opaque card for centre-screen moments and menus (the translucent `hud-panel` lets panels behind bleed through). */
export const CARD = "rounded-2xl bg-surface shadow-[var(--shadow-border)]";

export function NavButton({ className, ...props }: ButtonProps) {
  return <Button data-nav className={cn("w-full sm:h-8", FOCUS, className)} {...props} />;
}

export function MenuShell({
  id,
  eyebrow,
  title,
  pad,
  wide,
  sheet,
  adjust,
  onBack,
  onStart,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  pad: boolean;
  wide?: boolean;
  /**
   * Leave the view visible (the results reel plays behind): a right-side panel on wide screens, a bottom sheet on phones, no
   * backdrop. Its box on the page goes to the engine through this as `reelCover` (null once it closes), so the reel frames
   * its shots in the part of the view it leaves free.
   */
  sheet?: ((cmd: RaceCommand) => void) | null;
  /** The menu has ←/→ adjustable rows (hint only). */
  adjust?: boolean;
  onBack: (() => void) | null;
  onStart: (() => void) | null;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  usePadMenu(ref, id, { onBack, onStart });
  const send = useRef(sheet);
  useEffect(() => {
    send.current = sheet;
  });
  const covers = !!sheet;
  useEffect(() => {
    const el = ref.current;
    if (!covers || !el) return;
    const report = (): void => send.current?.({ type: "reelCover", cover: el.getBoundingClientRect() });
    // A size change of the sheet, or of the page (a right-hand panel moves without resizing).
    const obs = new ResizeObserver(report);
    obs.observe(el);
    window.addEventListener("resize", report);
    return () => {
      obs.disconnect();
      window.removeEventListener("resize", report);
      send.current?.({ type: "reelCover", cover: null });
    };
  }, [covers]);
  const chip = "rounded bg-surface-2 px-1.5 py-0.5 font-display text-xs text-fg shadow-[var(--shadow-border)]";
  const glyph = "inline-flex size-5 items-center justify-center rounded-full bg-surface-2 font-display text-xs font-semibold text-fg shadow-[var(--shadow-border)]";
  return (
    <div
      className={cn(
        "absolute inset-0 z-30 flex",
        sheet ? "pointer-events-none items-end p-2 sm:items-start sm:justify-end sm:p-4" : "pointer-events-auto items-center justify-center bg-bg/60 p-3 sm:p-6",
      )}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal={!sheet}
        aria-labelledby={`race-menu-${id}`}
        className={cn(
          CARD,
          "w-full overflow-y-auto p-3 sm:p-4",
          sheet ? "pointer-events-auto max-h-[45dvh] sm:max-h-full sm:max-w-md" : cn("max-h-full", wide ? "max-w-2xl" : "max-w-sm"),
        )}
      >
        <p className="hud-label">{eyebrow}</p>
        <h2 id={`race-menu-${id}`} className="mt-0.5 font-display text-2xl font-semibold leading-none tracking-tight">
          {title}
        </h2>
        <div className="mt-3">{children}</div>
        <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          {pad ? (
            <>
              <span className="flex items-center gap-1.5">
                <span className={glyph}>A</span>Select
              </span>
              {onBack ? (
                <span className="flex items-center gap-1.5">
                  <span className={glyph}>B</span>Back
                </span>
              ) : null}
              {onStart ? (
                <span className="flex items-center gap-1.5">
                  <span className={chip}>Start</span>Resume
                </span>
              ) : null}
              <span>D-pad / stick move{adjust ? " · ←/→ adjust" : ""}</span>
            </>
          ) : (
            <>
              <span className="flex items-center gap-1.5">
                <kbd className={chip}>Enter</kbd>Select
              </span>
              {onBack ? (
                <span className="flex items-center gap-1.5">
                  <kbd className={chip}>Esc</kbd>Back
                </span>
              ) : null}
              <span>Arrows move{adjust ? " · ←/→ adjust" : ""}</span>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

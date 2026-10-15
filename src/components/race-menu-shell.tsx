import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { activateIn, usePadMenu } from "@/components/use-pad-menu";
import { useReelCover } from "@/components/use-reel-cover";
import { FOCUS } from "@/components/race-menu-styles";
import type { RaceCommand } from "@/game/match/types";
import { cn } from "@/lib/utils";

/** The sheet's slide (`duration-200`) and a margin: how long after it starts sliding back in its box has settled. */
const SLIDE_MS = 240;

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
   * backdrop. Its box on the page goes to the engine through this (`useReelCover`), so the reel frames its shots in the
   * part of the view it leaves free.
   */
  sheet?: ((cmd: RaceCommand) => void) | null;
  /** The menu has ←/→ adjustable rows (hint only). */
  adjust?: boolean;
  onBack: (() => void) | null;
  onStart: (() => void) | null;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(false);
  // The panel's box moves while it slides back in: report it as the cover only once it has settled.
  const [settled, setSettled] = useState(true);
  useEffect(() => {
    if (hidden) return setSettled(false);
    const t = setTimeout(() => setSettled(true), SLIDE_MS);
    return () => clearTimeout(t);
  }, [hidden]);
  const toggle = sheet ? () => setHidden((h) => !h) : null;
  usePadMenu(ref, id, { onBack, onStart, onToggle: toggle, hidden });
  useReelCover(ref, "sheet", sheet && !hidden && settled ? sheet : null);
  const chip = "rounded bg-surface-2 px-1.5 py-0.5 font-display text-xs text-fg shadow-[var(--shadow-border)]";
  const glyph = "inline-flex size-5 items-center justify-center rounded-full bg-surface-2 font-display text-xs font-semibold text-fg shadow-[var(--shadow-border)]";
  const hint = cn("flex cursor-pointer items-center gap-1.5 hover:text-fg", FOCUS);
  const keep = (e: { preventDefault(): void }) => e.preventDefault();
  const select = () => ref.current && activateIn(ref.current);
  return (
    <div className={cn("absolute inset-0 z-30 flex", sheet ? "pointer-events-none items-end p-2 sm:items-start sm:justify-end sm:p-4" : "pointer-events-auto items-center justify-center bg-bg/60 p-3 sm:p-6")}>
      <div
        className={cn(
          "relative flex w-full flex-col transition-transform duration-200 ease-out motion-reduce:transition-none",
          sheet
            ? cn("pointer-events-none max-h-[45dvh] sm:max-h-full sm:max-w-md", hidden && "translate-y-[calc(100%+0.5rem)] sm:translate-x-[calc(100%+1rem)] sm:translate-y-0")
            : cn("max-h-full", wide ? "max-w-2xl" : "max-w-sm"),
        )}
      >
        {toggle ? (
          <button
            type="button"
            onClick={toggle}
            aria-label={hidden ? "Show menu" : "Hide menu"}
            aria-expanded={!hidden}
            className={cn(
              CARD,
              FOCUS,
              "pointer-events-auto absolute bottom-full left-1/2 flex h-7 w-16 -translate-x-1/2 items-center justify-center rounded-b-none text-muted",
              "sm:bottom-auto sm:left-auto sm:right-full sm:top-3 sm:h-16 sm:w-7 sm:translate-x-0 sm:rounded-b-2xl sm:rounded-r-none",
            )}
          >
            <ChevronRight className={cn("size-5 transition-transform duration-200", hidden ? "-rotate-90 sm:rotate-180" : "rotate-90 sm:rotate-0")} aria-hidden />
          </button>
        ) : null}
        <div ref={ref} role="dialog" aria-modal={!sheet} aria-labelledby={`race-menu-${id}`} inert={hidden} className={cn(CARD, "flex min-h-0 w-full flex-col overflow-hidden", sheet && "pointer-events-auto")}>
          <div className="shrink-0 px-3 pb-2 pt-3 sm:px-4 sm:pt-4">
            <p className="hud-label">{eyebrow}</p>
            <h2 id={`race-menu-${id}`} className="mt-0.5 font-display text-2xl font-semibold leading-none tracking-tight">
              {title}
            </h2>
          </div>
          {/* The header stays put; the rest scrolls (a short phone screen scrolls the focused button into view, its focus
            ring's 4 px kept in view by the scroll padding). */}
          <div className="min-h-0 scroll-py-1 overflow-y-auto px-3 pb-3 pt-1 sm:px-4 sm:pb-4">
            <div>{children}</div>
            <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              {pad ? (
                <>
                  <button type="button" aria-label="Select" onMouseDown={keep} onClick={select} className={hint}>
                    <span className={glyph}>A</span>Select
                  </button>
                  {onBack ? (
                    <button type="button" aria-label="Back" onMouseDown={keep} onClick={onBack} className={hint}>
                      <span className={glyph}>B</span>Back
                    </button>
                  ) : null}
                  {onStart ? (
                    <button type="button" aria-label="Resume" onMouseDown={keep} onClick={onStart} className={hint}>
                      <span className={chip}>Start</span>Resume
                    </button>
                  ) : null}
                  {toggle ? (
                    <button type="button" aria-label="Hide menu" onMouseDown={keep} onClick={toggle} className={hint}>
                      <span className={glyph}>Y</span>Hide
                    </button>
                  ) : null}
                  <span>D-pad / stick move{adjust ? " · ←/→ adjust" : ""}</span>
                </>
              ) : (
                <>
                  <button type="button" aria-label="Select" onMouseDown={keep} onClick={select} className={hint}>
                    <kbd className={chip}>Enter</kbd>Select
                  </button>
                  {onBack ? (
                    <button type="button" aria-label="Back" onMouseDown={keep} onClick={onBack} className={hint}>
                      <kbd className={chip}>Esc</kbd>Back
                    </button>
                  ) : null}
                  {toggle ? (
                    <button type="button" aria-label="Hide menu" onMouseDown={keep} onClick={toggle} className={hint}>
                      <kbd className={chip}>Backspace</kbd>Hide
                    </button>
                  ) : null}
                  <span>Arrows move{adjust ? " · ←/→ adjust" : ""}</span>
                </>
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

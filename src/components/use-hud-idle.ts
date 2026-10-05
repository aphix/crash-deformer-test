import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { watchHudIdle } from "@/game/hud/hud-collapse";

/** A slide up of this many px on the collapsed bar expands the HUD. */
const SWIPE_PX = 24;

export interface HudMenu {
  /** Collapsed: the short bar. */
  idle: boolean;
  expand: () => void;
  collapse: () => void;
  /** Handlers for the bottom bar. */
  barGestures: { onClick: (e: MouseEvent) => void; onPointerDown: (e: PointerEvent) => void; onPointerMove: (e: PointerEvent) => void };
}

/**
 * Touch HUD collapse state. Collapsed (`idle`, the `idle:` variant) is the short bar that leaves the view clear; expanded is the full menu.
 * It collapses by `collapse()` (the hide button) or after a quiet spell. It expands by `expand()`: a click (not a pointerdown) on the
 * collapsed bar or a slide up on it (`barGestures`), or a menu opening. A bare pointerdown never expands it: that would re-lay the HUD
 * out under the finger and the same tap's click would land on whatever control now sits there.
 */
export function useHudIdle(touch: boolean, menuOpen: boolean): HudMenu {
  const [collapsed, setCollapsed] = useState(false);
  const watching = touch && !menuOpen && !collapsed;
  useEffect(() => (watching ? watchHudIdle(window, () => setCollapsed(true)) : undefined), [watching]);
  useEffect(() => {
    if (menuOpen) setCollapsed(false);
  }, [menuOpen]);
  const idle = collapsed && touch;
  const slideFrom = useRef<number | null>(null);
  const expand = () => setCollapsed(false);
  /** Buttons on the collapsed bar (play, reset, settings, fullscreen) keep acting as they are; the empty bar expands (the scene chip does too, in hud.tsx). */
  const barGestures = {
    onClick: (e: MouseEvent) => {
      if (idle && (e.target as Element).closest("button") === null) expand();
    },
    onPointerDown: (e: PointerEvent) => {
      slideFrom.current = e.clientY;
    },
    onPointerMove: (e: PointerEvent) => {
      if (idle && slideFrom.current !== null && slideFrom.current - e.clientY > SWIPE_PX) {
        slideFrom.current = null;
        expand();
      }
    },
  };
  return { idle, expand, collapse: () => setCollapsed(true), barGestures };
}

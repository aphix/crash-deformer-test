import { type RefObject, useEffect, useRef } from "react";
import { GamepadInput, PAD_BUTTON } from "@/game/vehicle/gamepad";
import { NavRepeat, navTarget, nearestNav, stickDir, textKeepsKey, type NavDir } from "@/game/hud/menu-nav";

type PadMenuActions = {
  /** B / Esc. */
  onBack: (() => void) | null;
  /** Start / Menu button. */
  onStart: (() => void) | null;
  /** Y / Backspace, and whatever wakes a `hidden` menu: slide the menu away or back (a sheet over the reel). */
  onToggle?: (() => void) | null;
  /** The menu is slid out of view: no focus, no navigation. */
  hidden?: boolean;
};

const ARROWS: Record<string, NavDir> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};
/** The keys that bring a hidden menu back: the ones that would have acted on it. */
const WAKE: Record<string, true> = {
  ArrowUp: true,
  ArrowDown: true,
  ArrowLeft: true,
  ArrowRight: true,
  Enter: true,
  " ": true,
  Escape: true,
  Tab: true,
  Backspace: true,
};
const bit = (button: number): number => 1 << button;

function navItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>("[data-nav]")).filter((el) => !el.matches(":disabled") && el.getClientRects().length > 0);
}

/** Click the focused `[data-nav]` item inside `menu`; with none focused, focus the first. */
export function activateIn(menu: HTMLElement): void {
  const active = document.activeElement;
  const cur = active instanceof HTMLElement && menu.contains(active) ? active.closest<HTMLElement>("[data-nav]") : null;
  if (cur) return cur.click();
  const first = navItems(menu)[0];
  if (!first) return;
  first.focus({ preventScroll: true });
  first.scrollIntoView({ block: "nearest" });
}

/**
 * Drives one open menu rooted at `root`: focuses its first `[data-nav]` item whenever `id`
 * changes, and the item nearest the old one's spot (no scrolling, so a long list keeps its place) when focus leaves the
 * menu, then D-pad / left stick / arrows move focus spatially (with
 * repeat), left/right on a `[data-adjust]` item clicks its `[data-step="-1"|"1"]` control
 * instead, A / Enter / Space click the focused item, B / Esc call `onBack`, Start calls
 * `onStart`, Y / Backspace call `onToggle`, Tab cycles inside the menu. While `hidden` the menu is slid away: no
 * focus or navigation acts on it, and any menu key or pad button that would have acted calls `onToggle` instead.
 * The gamepad is polled only while mounted; buttons already held when it mounts are ignored.
 */
export function usePadMenu(root: RefObject<HTMLElement | null>, id: string, actions: PadMenuActions): void {
  const latest = useRef(actions);
  const wasHidden = useRef(false);
  const hidden = actions.hidden === true;
  useEffect(() => {
    latest.current = actions;
  });
  useEffect(() => {
    const menu = root.current;
    if (!menu) return;
    const items = (): HTMLElement[] => navItems(menu);
    const current = (): HTMLElement | null => {
      const active = document.activeElement;
      return active instanceof HTMLElement && menu.contains(active) ? active.closest<HTMLElement>("[data-nav]") : null;
    };
    const focus = (el: HTMLElement | undefined, scroll = true): void => {
      if (!el) return;
      el.focus({ preventScroll: true });
      if (scroll) el.scrollIntoView({ block: "nearest" });
    };
    const move = (dir: NavDir): void => {
      const cur = current();
      if (!cur) return focus(items()[0]);
      if ((dir === "left" || dir === "right") && cur.hasAttribute("data-adjust")) {
        cur.querySelector<HTMLElement>(`[data-step="${dir === "left" ? -1 : 1}"]`)?.click();
        return;
      }
      const list = items();
      const from = list.indexOf(cur);
      const to = navTarget(
        list.map((el) => el.getBoundingClientRect()),
        from,
        dir,
      );
      if (to !== from) focus(list[to]);
    };
    const activate = (): void => activateIn(menu);

    // Where the focused item sits on the page, kept as it is focused and as the menu scrolls: its unmounting (the item
    // is gone before the next frame) leaves this as the only record of where focus was.
    let anchor: { x: number; y: number } | null = null;
    const note = (el: Element | null): void => {
      if (!el || !menu.contains(el)) return;
      const r = el.getBoundingClientRect();
      anchor = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const onFocusIn = (e: FocusEvent): void => note(e.target instanceof Element ? e.target : null);
    const onScroll = (): void => note(document.activeElement);
    const listeners = new AbortController();
    menu.addEventListener("focusin", onFocusIn, { signal: listeners.signal });
    menu.addEventListener("scroll", onScroll, { capture: true, signal: listeners.signal });
    const recover = (): void => {
      const list = items();
      const near = anchor
        ? nearestNav(
            list.map((el) => el.getBoundingClientRect()),
            anchor.x,
            anchor.y,
          )
        : -1;
      if (near >= 0) focus(list[near], false);
      else focus(list[0]);
    };

    // Back from hidden: focus the first item where it stands (the panel is still sliding in).
    if (!hidden) focus(items()[0], !wasHidden.current);
    wasHidden.current = hidden;

    const onKeyDown = (e: KeyboardEvent): void => {
      // A text field (the race setup's name) keeps typing, deleting and caret ←/→; ↑/↓, Tab, Enter and Esc still drive the menu.
      if (e.target instanceof HTMLInputElement && e.target.type === "text" && textKeepsKey(e.key)) return;
      // Hidden: a menu key brings the menu back and nothing else acts on it.
      if (hidden) {
        if (!WAKE[e.key]) return;
        if (!e.repeat) latest.current.onToggle?.();
        e.preventDefault();
        return;
      }
      const dir = ARROWS[e.key];
      if (dir) move(dir);
      else if (e.key === "Enter" || e.key === " ") {
        if (!e.repeat) activate();
      } else if (e.key === "Escape") {
        // A held Esc auto-repeats: the press that opened this menu (pause) must not close it again.
        if (!e.repeat) latest.current.onBack?.();
      } else if (e.key === "Tab") {
        const list = items();
        const n = list.length;
        if (n > 0) {
          const at = list.indexOf(current() ?? list[0]!);
          focus(list[(at + (e.shiftKey ? n - 1 : 1)) % n]);
        }
      } else if (e.key === "Backspace" && latest.current.onToggle) {
        if (!e.repeat) latest.current.onToggle();
      } else return;
      e.preventDefault();
    };
    // Space clicks a focused button on keyup; keydown already activated it.
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === " ") e.preventDefault();
    };

    const pad = new GamepadInput();
    const repeat = new NavRepeat();
    let primed = false;
    let raf = 0;
    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame);
      // The focused item can unmount under us (a deleted row, menu content swapped): focus the item now where it was,
      // without scrolling, so the list keeps its place. A hidden menu has nothing to focus.
      if (!hidden && !menu.contains(document.activeElement)) recover();
      const s = pad.poll();
      const held = s.held;
      const dir: NavDir | null = held & bit(PAD_BUTTON.up) ? "up" : held & bit(PAD_BUTTON.down) ? "down" : held & bit(PAD_BUTTON.left) ? "left" : held & bit(PAD_BUTTON.right) ? "right" : stickDir(s.lx, s.ly);
      const fire = repeat.step(dir, now);
      if (!primed) {
        primed = true;
        return;
      }
      // Hidden: a direction or any of A / B / Start / Y brings the menu back, and nothing else acts on it.
      if (hidden) {
        if (fire || s.pressed & (bit(PAD_BUTTON.south) | bit(PAD_BUTTON.east) | bit(PAD_BUTTON.start) | bit(PAD_BUTTON.north))) latest.current.onToggle?.();
        return;
      }
      if (fire && dir) move(dir);
      if (s.pressed & bit(PAD_BUTTON.south)) activate();
      else if (s.pressed & bit(PAD_BUTTON.east)) latest.current.onBack?.();
      else if (s.pressed & bit(PAD_BUTTON.start)) latest.current.onStart?.();
      else if (s.pressed & bit(PAD_BUTTON.north)) latest.current.onToggle?.();
    };
    raf = requestAnimationFrame(frame);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      listeners.abort();
    };
  }, [root, id, hidden]);
}

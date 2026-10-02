import { type RefObject, useEffect, useRef } from "react";
import { GamepadInput, PAD_BUTTON } from "@/game/gamepad";
import { NavRepeat, navTarget, stickDir, type NavDir } from "@/game/race/menu-nav";

type PadMenuActions = {
  /** B / Esc. */
  onBack: (() => void) | null;
  /** Start / Menu button. */
  onStart: (() => void) | null;
};

const ARROWS: Record<string, NavDir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
const bit = (button: number): number => 1 << button;

/**
 * Drives one open menu rooted at `root`: focuses its first `[data-nav]` item whenever `id`
 * changes or focus leaves the menu, then D-pad / left stick / arrows move focus spatially (with
 * repeat), left/right on a `[data-adjust]` item clicks its `[data-step="-1"|"1"]` control
 * instead, A / Enter / Space click the focused item, B / Esc call `onBack`, Start calls
 * `onStart`, Tab cycles inside the menu. The gamepad is polled only while mounted; buttons
 * already held when it mounts are ignored.
 */
export function usePadMenu(root: RefObject<HTMLElement | null>, id: string, actions: PadMenuActions): void {
  const latest = useRef(actions);
  useEffect(() => {
    latest.current = actions;
  });

  useEffect(() => {
    const menu = root.current;
    if (!menu) return;
    const items = (): HTMLElement[] =>
      Array.from(menu.querySelectorAll<HTMLElement>("[data-nav]")).filter((el) => !el.matches(":disabled") && el.getClientRects().length > 0);
    const current = (): HTMLElement | null => {
      const active = document.activeElement;
      return active instanceof HTMLElement && menu.contains(active) ? active.closest<HTMLElement>("[data-nav]") : null;
    };
    const focus = (el: HTMLElement | undefined): void => {
      if (!el) return;
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "nearest" });
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
    const activate = (): void => {
      const cur = current();
      if (cur) cur.click();
      else focus(items()[0]);
    };

    focus(items()[0]);

    const onKeyDown = (e: KeyboardEvent): void => {
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
      // The focused item can unmount under us (menu content swapped, button hidden): refocus the first.
      if (!menu.contains(document.activeElement)) focus(items()[0]);
      const s = pad.poll();
      const held = s.held;
      const dir: NavDir | null =
        held & bit(PAD_BUTTON.up)
          ? "up"
          : held & bit(PAD_BUTTON.down)
            ? "down"
            : held & bit(PAD_BUTTON.left)
              ? "left"
              : held & bit(PAD_BUTTON.right)
                ? "right"
                : stickDir(s.lx, s.ly);
      const fire = repeat.step(dir, now);
      if (!primed) {
        primed = true;
        return;
      }
      if (fire && dir) move(dir);
      if (s.pressed & bit(PAD_BUTTON.south)) activate();
      else if (s.pressed & bit(PAD_BUTTON.east)) latest.current.onBack?.();
      else if (s.pressed & bit(PAD_BUTTON.start)) latest.current.onStart?.();
    };
    raf = requestAnimationFrame(frame);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [root, id]);
}

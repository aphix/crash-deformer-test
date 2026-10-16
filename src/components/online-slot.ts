import { useSyncExternalStore } from "react";

/**
 * Where the online entry sits while a race menu is up: the open menu's header (`MenuShell`) registers its corner here and the entry
 * renders into it, inside the menu's own box. That keeps its pill and panel above the menu's backdrop, clear of the menu's header text,
 * and inside the menu's keyboard and focus handling (a field outside the dialog would lose its focus to the menu every frame).
 * Without a menu the entry stays under the title.
 */
const slot: { el: HTMLElement | null } = { el: null };
const listeners = new Set<() => void>();

export function setOnlineSlot(el: HTMLElement | null): void {
  if (el === slot.el) return;
  slot.el = el;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The open menu's corner for the online entry, null with no menu up. */
export function useOnlineSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slot.el, () => null);
}

export const BOOT_LOADER_ID = "boot-loader";

/** Fade the cover out, then drop it from the DOM. Idempotent; React never re-touches this static node. */
export function dismissBootLoader() {
  const el = document.getElementById(BOOT_LOADER_ID);
  if (!el || el.classList.contains("boot-done")) return;
  el.classList.add("boot-done");
  window.setTimeout(() => el.remove(), 600);
}

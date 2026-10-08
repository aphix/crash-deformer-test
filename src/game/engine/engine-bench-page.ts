import { PAGE_PHASES, type PageEvent } from "./engine-bench-report.ts";

/** Entries a run keeps: far above the handful of tab switches a run sees. Past it changes are dropped; each phase's opening entry always fits. */
const PAGE_CAP = 64;
const PAGE_VISIBLE = 1;
const PAGE_FOCUSED = 2;
const PAGE_FULLSCREEN = 4;
/** The page events that change what `watchPage` records: shown/hidden and fullscreen on the document, focus on the window. */
const PAGE_DOC_EVENTS = ["visibilitychange", "fullscreenchange"] as const;
const PAGE_WIN_EVENTS = ["focus", "blur"] as const;

/** Safari on iPad still ships the prefixed element (same fallback as the HUD's fullscreen button). */
type FsDocument = Document & { webkitFullscreenElement?: Element | null };

/** Fullscreen by the API (`fullscreenElement`) or as an installed app launched `display: fullscreen`, where that element stays null. */
function isFullscreen(): boolean {
  const d: FsDocument = document;
  return (d.fullscreenElement ?? d.webkitFullscreenElement ?? null) !== null || window.matchMedia("(display-mode: fullscreen)").matches;
}

/**
 * The page's state (shown, focused, fullscreen: the API or the installed app's display mode) from the first `phase` until `stop`: one entry as each phase begins and one at every
 * change (`BenchResult.pageEvents`). Listeners, not per-frame reads: a hidden page draws no frames, so only its events see it go and
 * come back. The listener writes into preallocated arrays (nothing allocates while the bench measures); `stop` builds the entries.
 */
export function watchPage(): { phase(index: number): void; stop(): PageEvent[] } {
  const phaseAtS = new Float64Array(PAGE_CAP);
  const phaseOf = new Uint8Array(PAGE_CAP);
  const flags = new Uint8Array(PAGE_CAP);
  let n = 0;
  let phase = 0;
  let phaseStart = performance.now();
  const record = (): void => {
    phaseAtS[n] = (performance.now() - phaseStart) / 1000;
    phaseOf[n] = phase;
    flags[n++] = (document.hidden ? 0 : PAGE_VISIBLE) | (document.hasFocus() ? PAGE_FOCUSED : 0) | (isFullscreen() ? PAGE_FULLSCREEN : 0);
  };
  const note = (): void => {
    if (n < PAGE_CAP - PAGE_PHASES.length) record();
  };
  for (const e of PAGE_DOC_EVENTS) document.addEventListener(e, note);
  for (const e of PAGE_WIN_EVENTS) window.addEventListener(e, note);
  return {
    phase: (index) => {
      phase = index;
      phaseStart = performance.now();
      record();
    },
    stop: () => {
      for (const e of PAGE_DOC_EVENTS) document.removeEventListener(e, note);
      for (const e of PAGE_WIN_EVENTS) window.removeEventListener(e, note);
      const events: PageEvent[] = new Array(n);
      for (let i = 0; i < n; i++) {
        events[i] = { phase: PAGE_PHASES[phaseOf[i]!]!, atS: phaseAtS[i]!, visible: (flags[i]! & PAGE_VISIBLE) !== 0, focused: (flags[i]! & PAGE_FOCUSED) !== 0, fullscreen: (flags[i]! & PAGE_FULLSCREEN) !== 0 };
      }
      return events;
    },
  };
}

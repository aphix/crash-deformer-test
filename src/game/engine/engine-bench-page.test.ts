import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { PAGE_PHASES, PHASE_AB_FX, PHASE_AB_PACE, PHASE_WARM, PHASE_WINDOW } from "./engine-bench-report.ts";
import { watchPage } from "./engine-bench-page.ts";

type Listener = () => void;

/** What the stub page shows and the clock it keeps (ms); the test moves both. */
interface PageState {
  hidden: boolean;
  focused: boolean;
  fullscreen: boolean;
  /** The page runs as an installed app launched with `display: fullscreen`: no `fullscreenElement`, but the display-mode media query matches. */
  installedFullscreen: boolean;
  clockMs: number;
}

interface StubPage {
  page: PageState;
  /** Delivers `type` to the listeners the bench added. */
  fire(type: string): void;
  /** How many listeners are on the document and window now. */
  listening(): number;
}

/** A page with no browser: the document and window the bench listens on, and a clock the test moves. */
function stubPage(): StubPage {
  const listeners = new Map<string, Set<Listener>>();
  const target = {
    addEventListener: (type: string, listener: Listener) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(listener),
    removeEventListener: (type: string, listener: Listener) => void listeners.get(type)?.delete(listener),
  };
  const page: PageState = { hidden: false, focused: true, fullscreen: false, installedFullscreen: false, clockMs: 1000 };
  Object.defineProperty(globalThis, "document", { value: { ...target, get hidden() { return page.hidden; }, hasFocus: () => page.focused, get fullscreenElement() { return page.fullscreen ? {} : null; } }, configurable: true });
  Object.defineProperty(globalThis, "window", { value: { ...target, matchMedia: (query: string) => ({ matches: query === "(display-mode: fullscreen)" && page.installedFullscreen }) }, configurable: true });
  mock.method(performance, "now", () => page.clockMs);
  return {
    page,
    fire: (type) => {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    listening: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

describe("given the bench page with a stub document and window (watchPage records the page's state over a run)", () => {
  let stub: StubPage;
  beforeEach(() => {
    stub = stubPage();
  });
  afterEach(() => {
    mock.restoreAll();
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "window");
  });

  test("when each phase begins, then it gets an entry named for the phase, at 0 s into it, with the page's state then", () => {
    const watch = watchPage();
    watch.phase(PHASE_WARM);
    stub.page.clockMs += 5000;
    stub.page.focused = false;
    watch.phase(PHASE_WINDOW);
    assert.deepEqual(watch.stop(), [
      { phase: "warm", atS: 0, visible: true, focused: true, fullscreen: false },
      { phase: "window", atS: 0, visible: true, focused: false, fullscreen: false },
    ]);
  });

  test("when the page runs as an installed fullscreen app, then its entries say fullscreen though the document has no fullscreen element", () => {
    stub.page.installedFullscreen = true;
    const watch = watchPage();
    watch.phase(PHASE_WARM);
    assert.deepEqual(watch.stop(), [{ phase: "warm", atS: 0, visible: true, focused: true, fullscreen: true }]);
  });

  test("when the page is hidden and fullscreened during a phase, then each change is an entry in that phase, at the seconds into it", () => {
    const watch = watchPage();
    watch.phase(PHASE_WARM);
    stub.page.clockMs += 2000;
    watch.phase(PHASE_AB_PACE);
    stub.page.clockMs += 1500;
    stub.page.hidden = true;
    stub.fire("visibilitychange");
    stub.page.clockMs += 250;
    stub.page.hidden = false;
    stub.page.fullscreen = true;
    stub.fire("fullscreenchange");
    stub.page.focused = false;
    stub.fire("blur");
    assert.deepEqual(watch.stop(), [
      { phase: "warm", atS: 0, visible: true, focused: true, fullscreen: false },
      { phase: "ab-pace", atS: 0, visible: true, focused: true, fullscreen: false },
      { phase: "ab-pace", atS: 1.5, visible: false, focused: true, fullscreen: false },
      { phase: "ab-pace", atS: 1.75, visible: true, focused: true, fullscreen: true },
      { phase: "ab-pace", atS: 1.75, visible: true, focused: false, fullscreen: true },
    ]);
  });

  test("when the run is over, then the listeners are gone and later changes add nothing", () => {
    const watch = watchPage();
    watch.phase(PHASE_WARM);
    assert.equal(stub.listening(), 4);
    const events = watch.stop();
    assert.equal(stub.listening(), 0);
    stub.fire("blur");
    assert.equal(events.length, 1);
  });

  test("when a tab flickers more often than the log holds, then the changes are dropped but every phase still gets its entry", () => {
    const watch = watchPage();
    watch.phase(PHASE_WARM);
    stub.page.clockMs += 1000;
    for (let i = 0; i < 500; i++) stub.fire("focus");
    watch.phase(PHASE_WINDOW);
    stub.page.clockMs += 1000;
    for (let i = 0; i < 500; i++) stub.fire("focus");
    watch.phase(PHASE_AB_FX);
    const events = watch.stop();
    assert.deepEqual(events.filter((e) => e.atS === 0).map((e) => e.phase), ["warm", "window", "ab-fx"]);
    assert.ok(events.length < 500);
  });

  test("when the phases are named by their index constants, then the names run in the order of a run", () => {
    assert.deepEqual([PHASE_WARM, PHASE_WINDOW, PHASE_AB_PACE, PHASE_AB_FX].map((i) => PAGE_PHASES[i]), ["warm", "window", "ab-pace", "ab-fx"]);
  });
});

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { HUD_IDLE_MS, watchHudIdle } from "./hud-collapse.ts";

/** A page stand-in: `closest` answers like an element (null: not inside the thumb pad). */
const page = (inPad = false) => Object.assign(new EventTarget(), { closest: () => (inPad ? {} : null) });
const tap = (p: EventTarget) => p.dispatchEvent(new Event("pointerdown"));

describe("given the touch HUD's idle watcher (it collapses the expanded menu once the page has gone untouched)", () => {
  it("when the page stays untouched for the idle time, then the menu collapses exactly when the idle time is up, not before", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const p = page();
    let collapsed = 0;
    const stop = watchHudIdle(p, () => collapsed++);
    mock.timers.tick(HUD_IDLE_MS - 1);
    assert.equal(collapsed, 0);
    mock.timers.tick(1);
    assert.equal(collapsed, 1);
    stop();
    mock.timers.reset();
  });

  it("when a tap lands anywhere on the page before the idle time is up, then the countdown restarts, so the menu never collapses under a finger in use", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const p = page();
    let collapsed = 0;
    const stop = watchHudIdle(p, () => collapsed++);
    mock.timers.tick(HUD_IDLE_MS - 1);
    tap(p);
    mock.timers.tick(HUD_IDLE_MS - 1);
    assert.equal(collapsed, 0);
    mock.timers.tick(1);
    assert.equal(collapsed, 1);
    stop();
    mock.timers.reset();
  });

  it("when the tap lands on the thumb pad (the driving controls), then the countdown is not restarted, so driving does not hold the menu open", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const p = page(true);
    let collapsed = 0;
    const stop = watchHudIdle(p, () => collapsed++);
    mock.timers.tick(HUD_IDLE_MS - 1);
    tap(p);
    mock.timers.tick(1);
    assert.equal(collapsed, 1);
    stop();
    mock.timers.reset();
  });

  it("when taps land on the page and the idle time passes, then the watcher only ever collapses (one call, no arguments): no tap, on the page or off it, can expand the menu under a finger", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const p = page();
    const calls: unknown[][] = [];
    const stop = watchHudIdle(p, (...a) => calls.push(a));
    tap(p);
    mock.timers.tick(HUD_IDLE_MS);
    tap(p);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], []);
    stop();
    mock.timers.reset();
  });

  it("when the watcher is stopped, then its countdown and its listener are cancelled and the menu never collapses", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const p = page();
    let collapsed = 0;
    const stop = watchHudIdle(p, () => collapsed++);
    stop();
    tap(p);
    mock.timers.tick(HUD_IDLE_MS * 2);
    assert.equal(collapsed, 0);
    mock.timers.reset();
  });
});

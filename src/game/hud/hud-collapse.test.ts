import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { HUD_IDLE_MS, watchHudIdle } from "./hud-collapse.ts";

/** A page stand-in: `closest` answers like an element (null: not inside the thumb pad). */
const page = (inPad = false) => Object.assign(new EventTarget(), { closest: () => (inPad ? {} : null) });
const tap = (p: EventTarget) => p.dispatchEvent(new Event("pointerdown"));

describe("touch HUD auto-collapse", () => {
  it("good: it collapses once the page has been untouched for the idle time", () => {
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

  it("good: a tap anywhere restarts the countdown, so the menu never collapses under a finger in use", () => {
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

  it("good: driving on the thumb pad does not hold the menu open", () => {
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

  it("good: the watcher only ever collapses: no tap, on the page or off it, can expand the menu under a finger", () => {
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

  it("good: stopping it cancels the countdown and the listener", () => {
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

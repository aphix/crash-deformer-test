import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MouseLook, type LockCanvas, type LockDoc } from "./mouse-look.ts";

/** A document whose pointer lock the test drives: the browser grants it, or takes it away (Esc, tab hide, alt-tab). */
function stage(refuse: "none" | "reject" | "error" = "none") {
  const doc: LockDoc = Object.assign(new EventTarget(), {
    pointerLockElement: null as unknown,
    exitPointerLock() {
      doc.pointerLockElement = null;
      doc.dispatchEvent(new Event("pointerlockchange"));
    },
  });
  const canvas: LockCanvas = {
    ownerDocument: doc,
    requestPointerLock() {
      if (refuse === "reject") return Promise.reject(new Error("exited lock recently"));
      if (refuse === "error") doc.dispatchEvent(new Event("pointerlockerror"));
      else {
        doc.pointerLockElement = canvas;
        doc.dispatchEvent(new Event("pointerlockchange"));
      }
      return Promise.resolve();
    },
  };
  const calls = { lost: 0, changed: 0, moves: [] as [number, number][] };
  const look = new MouseLook({ move: (dx, dy) => calls.moves.push([dx, dy]), changed: () => calls.changed++, lost: () => calls.lost++ });
  const browserDrops = (): void => {
    doc.pointerLockElement = null;
    doc.dispatchEvent(new Event("pointerlockchange"));
  };
  const mouse = (dx: number, dy: number): void => void doc.dispatchEvent(Object.assign(new Event("mousemove"), { movementX: dx, movementY: dy }));
  return { doc, canvas, calls, look, browserDrops, mouse };
}

describe("given mouse look (the pointer-lock camera control), where losing the lock by the browser's doing pauses the game once", () => {
  it("when the browser grants the lock, then the mode turns on and raw mouse movement reaches the camera", async () => {
    const s = stage();
    s.look.request(s.canvas);
    await Promise.resolve();
    assert.equal(s.look.on, true);
    s.mouse(3, -2);
    assert.deepEqual(s.calls.moves, [[3, -2]]);
  });

  it("when the browser drops the lock (Esc, tab hide, alt-tab), then the lock-lost report fires exactly once, the mode turns off, and later movement and stray repeat events do nothing", () => {
    const s = stage();
    s.look.request(s.canvas);
    s.browserDrops();
    assert.equal(s.calls.lost, 1);
    assert.equal(s.look.on, false);
    s.browserDrops(); // a stray repeat of the event: nothing listens any more
    assert.equal(s.calls.lost, 1);
    s.mouse(5, 5);
    assert.equal(s.calls.moves.length, 0, "movement after the drop does not look round");
  });

  it("when the player leaves on purpose (toggle, menu, scene change), then no lock-lost report fires, so the game never pauses, the mode is off and the lock is released", () => {
    const s = stage();
    s.look.request(s.canvas);
    s.look.exit();
    assert.equal(s.calls.lost, 0);
    assert.equal(s.look.on, false);
    assert.equal(s.doc.pointerLockElement, null);
  });

  it("when the player exits with Esc and the mode asks again and the lock is dropped again, then each drop gives its own lock-lost report (one Esc, one report)", () => {
    const s = stage();
    for (let i = 1; i <= 2; i++) {
      s.look.request(s.canvas);
      s.browserDrops();
      assert.equal(s.calls.lost, i);
    }
  });

  it("when Chrome refuses the lock after a recent exit (a rejected promise or a pointer-lock error), then the mode stays off with no lock-lost report and no throw, and asking again is allowed", async () => {
    for (const how of ["reject", "error"] as const) {
      const s = stage(how);
      s.look.request(s.canvas);
      for (let i = 0; i < 5; i++) await Promise.resolve(); // the rejected promise's catch runs on a microtask
      assert.equal(s.look.on, false, how);
      assert.equal(s.calls.lost, 0, how);
      s.look.request(s.canvas); // asking again after the refusal is allowed
    }
  });

  it("when a second request is made while one is pending or held, then it does nothing, so one drop gives one lock-lost report", () => {
    const s = stage();
    s.look.request(s.canvas);
    s.look.request(s.canvas);
    s.browserDrops();
    assert.equal(s.calls.lost, 1);
  });
});

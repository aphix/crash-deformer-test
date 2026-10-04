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

describe("mouse look: the lock state rule behind pause-once", () => {
  it("good: a granted lock turns the mode on and raw movement reaches the camera", async () => {
    const s = stage();
    s.look.request(s.canvas);
    await Promise.resolve();
    assert.equal(s.look.on, true);
    s.mouse(3, -2);
    assert.deepEqual(s.calls.moves, [[3, -2]]);
  });

  it("good: the browser dropping the lock (Esc, tab hide, alt-tab) reports `lost` exactly once and turns the mode off", () => {
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

  it("good: leaving on purpose (toggle, menu, scene change) is no `lost`, so it never pauses", () => {
    const s = stage();
    s.look.request(s.canvas);
    s.look.exit();
    assert.equal(s.calls.lost, 0);
    assert.equal(s.look.on, false);
    assert.equal(s.doc.pointerLockElement, null);
  });

  it("good: after an Esc exit the mode asks again and the next drop pauses again (one Esc, one `lost`)", () => {
    const s = stage();
    for (let i = 1; i <= 2; i++) {
      s.look.request(s.canvas);
      s.browserDrops();
      assert.equal(s.calls.lost, i);
    }
  });

  it("good: Chrome's cooldown refusal (rejected promise or pointerlockerror) leaves the mode off, no `lost`, no throw", async () => {
    for (const how of ["reject", "error"] as const) {
      const s = stage(how);
      s.look.request(s.canvas);
      for (let i = 0; i < 5; i++) await Promise.resolve(); // the rejected promise's catch runs on a microtask
      assert.equal(s.look.on, false, how);
      assert.equal(s.calls.lost, 0, how);
      s.look.request(s.canvas); // asking again after the refusal is allowed
    }
  });

  it("bad: a second request while one is pending or held does nothing", () => {
    const s = stage();
    s.look.request(s.canvas);
    s.look.request(s.canvas);
    s.browserDrops();
    assert.equal(s.calls.lost, 1);
  });
});

/** The slice of the document the lock needs (the real `Document` fits; a test stubs it). */
export interface LockDoc extends EventTarget {
  pointerLockElement: unknown;
  exitPointerLock(): void;
}

/** The slice of the canvas the lock needs. */
export interface LockCanvas {
  ownerDocument: LockDoc;
  requestPointerLock(): void | Promise<void>;
}

interface LockHooks {
  /** Raw mouse movement (px) while locked. */
  move(dx: number, dy: number): void;
  /** `on` flipped. */
  changed(): void;
  /** The browser took the lock away (Esc, tab hide, alt-tab, focus loss): not our own `exit()`. */
  lost(): void;
}

/**
 * Pointer-lock mouse look. `request` must run inside the key press or click that asks (the user gesture)
 * and locks the canvas, never the page, so the HUD overlay can't take it. `on` is true only while the browser
 * holds the lock. A browser refusal (Chrome's ~1-2 s cooldown after an Esc exit) leaves it off.
 * Listeners exist only while a lock is requested or held.
 */
export class MouseLook {
  on = false;
  private doc: LockDoc | null = null;
  private canvas: LockCanvas | null = null;
  private readonly hooks: LockHooks;

  constructor(hooks: LockHooks) {
    this.hooks = hooks;
  }

  request(canvas: LockCanvas): void {
    if (this.on || this.doc) return;
    this.doc = canvas.ownerDocument;
    this.canvas = canvas;
    this.doc.addEventListener("pointerlockchange", this.onChange);
    this.doc.addEventListener("pointerlockerror", this.refused);
    this.doc.addEventListener("mousemove", this.onMove);
    Promise.resolve(canvas.requestPointerLock()).catch(this.refused);
  }

  /** Leave the mode on purpose (toggle, scene change, a menu): no `lost`. */
  exit(): void {
    const doc = this.doc;
    if (!doc) return;
    const was = this.on;
    this.release();
    doc.exitPointerLock(); // also cancels a request still in flight
    if (was) this.hooks.changed();
  }

  private release(): void {
    this.doc?.removeEventListener("pointerlockchange", this.onChange);
    this.doc?.removeEventListener("pointerlockerror", this.refused);
    this.doc?.removeEventListener("mousemove", this.onMove);
    this.on = false;
    this.doc = null;
    this.canvas = null;
  }

  private readonly onChange = (): void => {
    const locked = this.doc !== null && this.doc.pointerLockElement === this.canvas;
    if (locked === this.on) return;
    if (locked) {
      this.on = true;
      this.hooks.changed();
      return;
    }
    this.release();
    this.hooks.lost();
    this.hooks.changed();
  };

  private readonly refused = (): void => {
    if (!this.doc || this.on) return;
    this.release();
    console.info("Crush Stream mouse look: the browser refused the pointer lock (try again in a moment)");
  };

  private readonly onMove = (e: Event): void => {
    // A real MouseEvent in the browser; the test's stub carries the same two numbers.
    const m = e as Partial<MouseEvent>;
    if (this.on) this.hooks.move(m.movementX ?? 0, m.movementY ?? 0);
  };
}

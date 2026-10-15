/** The Konami code as `KeyboardEvent.code`s: up, up, down, down, left, right, left, right, then B, A, B, A (the owner's variant). */
export const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "KeyB", "KeyA", "KeyB", "KeyA"] as const;

/**
 * Watches key presses (no repeats) for `KONAMI`: `press` is true on the key that completes it. The last presses are kept as long as
 * the code, so a stray key anywhere before the run (or extra ups at its start) never spoils it.
 */
export class KonamiCode {
  private readonly last: string[] = [];

  press(code: string): boolean {
    this.last.push(code);
    if (this.last.length > KONAMI.length) this.last.shift();
    if (this.last.length < KONAMI.length || !KONAMI.every((k, i) => this.last[i] === k)) return false;
    this.last.length = 0;
    return true;
  }
}

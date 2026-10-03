// Reel FX boost: a hardware desktop renders the results reel at the "high" post-FX tier and drops
// back to the user's tier when frames run long.

const SOFTWARE_GPU = /swiftshader|llvmpipe|softpipe|basic render/i;

/** True only on a fine-pointer device whose GPU is known and is not a software rasterizer. */
export function hardwareDesktop(renderer: string | null, pointerFine: boolean): boolean {
  return pointerFine && renderer !== null && !SOFTWARE_GPU.test(renderer);
}

const WINDOW = 120;
const MIN_SAMPLES = 30;
const FPS60_MS = 1000 / 60;
const STREAK = 10;

export class FrameGuard {
  private readonly ring = new Float64Array(WINDOW);
  private readonly sorted = new Float64Array(WINDOW);
  private count = 0;
  private next = 0;
  private refreshMs = FPS60_MS;
  private streak = 0;

  /** Every rendered frame's rAF interval (ms), boosted or not. */
  sample(ms: number): void {
    this.ring[this.next] = ms;
    this.next = (this.next + 1) % WINDOW;
    if (this.count < WINDOW) this.count++;
  }

  /** Boost starts: the refresh interval is the median of the pre-boost frames (1000/60 if too few). */
  arm(): void {
    this.streak = 0;
    if (this.count < MIN_SAMPLES) {
      this.refreshMs = FPS60_MS;
      return;
    }
    const s = this.sorted.subarray(0, this.count);
    s.set(this.ring.subarray(0, this.count));
    s.sort();
    const mid = this.count >> 1;
    this.refreshMs = this.count & 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // Drop back once MORE than 10 consecutive frames each miss the display's refresh (> 1.1x the
  // armed interval) AND run below 60 fps (> 1000/60 ms); a frame failing either resets the streak,
  // so a 144 Hz screen at 90 fps keeps the boost and one hitch never drops it.
  /** While boosted: true means drop back to the user's tier now. */
  feed(ms: number): boolean {
    this.streak = ms > this.refreshMs * 1.1 && ms > FPS60_MS ? this.streak + 1 : 0;
    return this.streak > STREAK;
  }
}

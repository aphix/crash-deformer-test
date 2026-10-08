/**
 * What the two quality governors (`AutoFx`, `DetailGovernor`) read: frame-WORK time against the frame budget, not the frame rate.
 * Under vsync the frame rate is pinned at the display's refresh whatever the headroom (a 60 Hz screen shows 60 fps at 3 ms of work
 * and at 16 ms), so a window counts, per frame, the main thread's own time (sim + draw submit, `Engine.workMs`) and, where the
 * browser has a GPU timer, the draw's GPU time; a window's medians against `FRAME_BUDGET_MS` say how full the frame is. Without
 * a GPU reading (Firefox, some phones) a window's wall rate still counts as evidence of a slow frame, and a median wall interval
 * on the 60 Hz vsync as evidence of a free one; the GPU-bound frames only the timer would show stay unseen.
 */

/** 60 fps whatever the display's refresh: a faster screen is not asked for more, a slower one is no excuse for less. */
const FRAME_BUDGET_MS = 1000 / 60;
/** Frames ignored after boot, a match start or a switch (ms): shader links and the first allocations land here. */
const SETTLE_MS = 1500;
const WINDOW_MS = 1000;
/** Frames a window keeps samples of (a 240 Hz screen makes 240). */
const MAX_SAMPLES = 512;
/** A window's GPU readings count only if this share of its frames brought one (a draw is timed only while the ring has room): a timer that exists but stays silent never counts. */
const GPU_SHARE = 0.1;
/** A window is slow when its busier side (CPU or GPU) is over this much of the budget: the frame cannot hold 60 fps. */
const DROP_BUSY = 1;
/**
 * A window has room to spend (a costlier tier or rung) when its busier side is under this much of the budget: measured, the top
 * tier costs at most 0.2 of the budget more than minimal (CPU and GPU, desktop and the 4x phone proxy), so it still sits under `DROP_BUSY`.
 */
const ROOM_BUSY = 0.75;
/** Without a GPU reading the typical frame must be this short (ms) to count as room: 60 fps with 5 % for timer noise. */
const ROOM_WALL_MS = 1000 / 57;

function median(samples: Float32Array, n: number): number {
  return samples.subarray(0, n).sort()[n >> 1]!;
}

export class FrameWork {
  /** The last finished window: frames per wall second. */
  fps = 0;
  /** Its wall time (ms). */
  wallMs = 0;
  /** Its median wall interval per frame (ms). */
  wallMedMs = 0;
  /** Its median main-thread ms per frame. */
  workMs = 0;
  /** Its median GPU ms per frame; -1 when too few frames brought a reading. */
  gpuMs = -1;
  /** The busier of the two medians, as a share of `FRAME_BUDGET_MS`. */
  busy = 0;
  private settle = SETTLE_MS;
  private winMs = 0;
  private frames = 0;
  private gpuN = 0;
  private readonly work = new Float32Array(MAX_SAMPLES);
  private readonly gpu = new Float32Array(MAX_SAMPLES);
  private readonly wall = new Float32Array(MAX_SAMPLES);

  /** The frames now are still inside the settle: `add` ignores them. */
  get settling(): boolean {
    return this.settle > 0;
  }

  /** Drop the window under way; the next `settleMs` of frames are not counted. */
  restart(settleMs = SETTLE_MS): void {
    this.settle = settleMs;
    this.winMs = this.frames = this.gpuN = 0;
  }

  /**
   * One frame: its wall interval, the main thread's ms for the last frame, and the newest GPU ms (-1: none this frame).
   * True when this frame ends a window, whose figures are then the fields above.
   */
  add(wallMs: number, workMs: number, gpuMs: number): boolean {
    if (this.settle > 0) {
      this.settle -= wallMs;
      return false;
    }
    this.winMs += wallMs;
    if (this.frames < MAX_SAMPLES) {
      this.work[this.frames] = workMs;
      this.wall[this.frames] = wallMs;
      if (gpuMs >= 0) this.gpu[this.gpuN++] = gpuMs;
    }
    this.frames++;
    if (this.winMs < WINDOW_MS) return false;
    const n = Math.min(this.frames, MAX_SAMPLES);
    this.fps = (this.frames * 1000) / this.winMs;
    this.wallMs = this.winMs;
    this.workMs = median(this.work, n);
    this.wallMedMs = median(this.wall, n);
    this.gpuMs = this.gpuN >= GPU_SHARE * n ? median(this.gpu, this.gpuN) : -1;
    this.busy = Math.max(this.workMs, this.gpuMs) / FRAME_BUDGET_MS;
    this.winMs = this.frames = this.gpuN = 0;
    return true;
  }

  /**
   * The finished window cannot hold the budget: over `DROP_BUSY`, or, with no GPU reading to say the frame is cheap, a wall
   * rate under `minFps` (a GPU-bound frame shows only there).
   */
  slow(minFps: number): boolean {
    return this.busy > DROP_BUSY || (this.gpuMs < 0 && this.fps < minFps);
  }

  /**
   * The finished window has room for a costlier tier or rung. Without a GPU reading the typical frame must also land on a 60 Hz
   * vsync (the median wall interval, so one missed vsync or one hitch does not veto it, as it did the mean rate).
   */
  roomy(): boolean {
    return this.busy < ROOM_BUSY && (this.gpuMs >= 0 || this.wallMedMs <= ROOM_WALL_MS);
  }
}

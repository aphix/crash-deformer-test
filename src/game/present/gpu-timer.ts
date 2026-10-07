/** Timer queries in flight: a result lands a few frames after its draw. */
const RING = 8;

interface TimerExt {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

/**
 * GPU time of the frame's draw (`EXT_disjoint_timer_query_webgl2`), where the browser has the extension (not Firefox, not every
 * phone): `begin` / `end` bracket the draw, `take` returns the newest finished one. A draw is skipped, not queued, when the ring is
 * full or another query is already open (the bench card's own wraps the same draw), and a disjoint result (a GPU reset, a clock
 * change) is dropped.
 */
export class GpuTimer {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: TimerExt;
  private readonly queries: WebGLQuery[] = [];
  private head = 0;
  private tail = 0;
  private pending = 0;
  private open = false;

  private constructor(gl: WebGL2RenderingContext, ext: TimerExt) {
    this.gl = gl;
    this.ext = ext;
    for (let i = 0; i < RING; i++) this.queries.push(gl.createQuery());
  }

  /** Null where the extension is missing. */
  static create(gl: WebGL2RenderingContext): GpuTimer | null {
    const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExt | null;
    return ext ? new GpuTimer(gl, ext) : null;
  }

  begin(): void {
    if (this.open) this.end();
    if (this.pending === RING || this.gl.getQuery(this.ext.TIME_ELAPSED_EXT, this.gl.CURRENT_QUERY)) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.queries[this.head]!);
    this.open = true;
  }

  end(): void {
    if (!this.open) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.open = false;
    this.head = (this.head + 1) % RING;
    this.pending++;
  }

  /** ms of the newest draw that finished since the last call; -1 when none did (or only disjoint ones). */
  take(): number {
    const gl = this.gl;
    let ms = -1;
    while (this.pending > 0) {
      const q = this.queries[this.tail]!;
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      if (!gl.getParameter(this.ext.GPU_DISJOINT_EXT)) ms = ns / 1e6;
      this.tail = (this.tail + 1) % RING;
      this.pending--;
    }
    return ms;
  }

  dispose(): void {
    if (this.open) this.end();
    for (const q of this.queries) this.gl.deleteQuery(q);
  }
}

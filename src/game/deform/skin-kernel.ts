/**
 * The skin and normals loops of `StreamedDeformation.skin` in Rust -> WASM (`kernels/skin`, built by
 * `npm run build:kernel` into the committed `skin-kernel.wasm`). It runs on the main thread, no worker and no
 * `SharedArrayBuffer`, and produces the JS skin's exact bits (same operations in the same order, V8's own
 * `Math.sin` / `Math.exp` imported), so a car skinned by either leaves the same positions and normals. The JS
 * skin stays the reference and the fallback: until `loadSkinKernel` resolves, or when it fails, `skinKernel()` is
 * null and every car skins in JS.
 *
 * The module has no allocator: this file carves each style's tables out of pages it grows. They are static per rig,
 * so cars of one style share one set (content-keyed: `skinKey`), a handful of 0.5 MB blocks for the page's life.
 */

/** What `skin_shape` and `normals` read that never changes after a car is built. Copied into WASM memory once. */
export interface SkinStatic {
  rest: Float32Array;
  rC: Float64Array;
  sN: Uint8Array;
  sXf: Int32Array;
  sW: Float64Array;
  rJ: Int32Array;
  rW: Float64Array;
  iN: Uint8Array;
  iCo: Int32Array;
  iUvw: Float64Array;
  hub: Int32Array;
  seed: Float64Array;
  /** Triangle indices. */
  idx: Uint32Array;
}

/** What a skin rewrites before each run (copied in). `hubs`: 5 per mass, `params`: 9 (see `kernels/skin/src/lib.rs`). */
export interface SkinDynamic {
  X: Float64Array;
  co: Float64Array;
  pos: Float64Array;
  hubs: Float64Array;
  params: Float64Array;
}

type Exports = {
  memory: WebAssembly.Memory;
  skin_shape: (...args: number[]) => void;
  normals: (...args: number[]) => void;
};

function isExports(e: WebAssembly.Exports): e is Exports {
  return e.memory instanceof WebAssembly.Memory && typeof e.skin_shape === "function" && typeof e.normals === "function";
}

/** WebAssembly page size (bytes): the memory grows in whole pages. */
const PAGE = 65536;

/** Byte addresses in WASM memory of one placed style's blocks (`skin_shape`'s arguments, then `idx` and `nor`). */
type Addresses = Record<"rest" | "rC" | "sN" | "sXf" | "sW" | "rJ" | "rW" | "X" | "pos" | "iN" | "iCo" | "iUvw" | "co" | "hub" | "hubs" | "seed" | "params" | "out" | "idx" | "nor", number>;

/** One placed style: its addresses, and views over them (rebuilt when the memory grows and detaches its buffer). */
export class SkinTables {
  /** The memory buffer the views below are over. */
  buf: ArrayBuffer | null = null;
  X!: Float64Array;
  co!: Float64Array;
  pos!: Float64Array;
  hubs!: Float64Array;
  params!: Float64Array;
  out!: Float32Array;
  nor!: Float32Array;
  readonly nverts: number;
  readonly triIndices: number;
  readonly at: Readonly<Addresses>;
  /** Lengths of `SkinDynamic`'s arrays (every car of the style has the same). */
  private readonly lens: Readonly<Record<keyof SkinDynamic, number>>;

  constructor(nverts: number, triIndices: number, at: Readonly<Addresses>, lens: Readonly<Record<keyof SkinDynamic, number>>) {
    this.nverts = nverts;
    this.triIndices = triIndices;
    this.at = at;
    this.lens = lens;
  }

  /** Views over `buffer` (the memory's current one). */
  bind(buffer: ArrayBuffer): void {
    const { at, lens, nverts } = this;
    this.X = new Float64Array(buffer, at.X, lens.X);
    this.co = new Float64Array(buffer, at.co, lens.co);
    this.pos = new Float64Array(buffer, at.pos, lens.pos);
    this.hubs = new Float64Array(buffer, at.hubs, lens.hubs);
    this.params = new Float64Array(buffer, at.params, lens.params);
    this.out = new Float32Array(buffer, at.out, nverts * 3);
    this.nor = new Float32Array(buffer, at.nor, nverts * 3);
    this.buf = buffer;
  }
}

export class SkinKernel {
  private readonly sets = new Map<string, SkinTables>();
  private readonly ex: Exports;

  constructor(ex: Exports) {
    this.ex = ex;
  }

  /** The style's tables, placed on first use; `build` runs only then. */
  tables(key: string, build: () => SkinStatic, d: SkinDynamic): SkinTables {
    const hit = this.sets.get(key);
    if (hit) return hit;
    const s = build();
    const nverts = s.rest.length / 3;
    const mem = this.ex.memory;
    const base = mem.buffer.byteLength;
    let end = base;
    // 8-byte aligned blocks, in `skin_shape`'s argument order.
    const place = (bytes: number): number => {
      const at = end;
      end += (bytes + 7) & ~7;
      return at;
    };
    const at = {
      rest: place(s.rest.byteLength),
      rC: place(s.rC.byteLength),
      sN: place(s.sN.byteLength),
      sXf: place(s.sXf.byteLength),
      sW: place(s.sW.byteLength),
      rJ: place(s.rJ.byteLength),
      rW: place(s.rW.byteLength),
      X: place(d.X.byteLength),
      pos: place(d.pos.byteLength),
      iN: place(s.iN.byteLength),
      iCo: place(s.iCo.byteLength),
      iUvw: place(s.iUvw.byteLength),
      co: place(d.co.byteLength),
      hub: place(s.hub.byteLength),
      hubs: place(d.hubs.byteLength),
      seed: place(s.seed.byteLength),
      params: place(d.params.byteLength),
      out: place(nverts * 12),
      idx: place(s.idx.byteLength),
      nor: place(nverts * 12),
    };
    mem.grow(Math.ceil((end - base) / PAGE));
    const bytes = new Uint8Array(mem.buffer);
    const put = (a: Float32Array | Float64Array | Int32Array | Uint8Array | Uint32Array, to: number): void =>
      bytes.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), to);
    put(s.rest, at.rest);
    put(s.rC, at.rC);
    put(s.sN, at.sN);
    put(s.sXf, at.sXf);
    put(s.sW, at.sW);
    put(s.rJ, at.rJ);
    put(s.rW, at.rW);
    put(s.iN, at.iN);
    put(s.iCo, at.iCo);
    put(s.iUvw, at.iUvw);
    put(s.hub, at.hub);
    put(s.seed, at.seed);
    put(s.idx, at.idx);
    const t = new SkinTables(nverts, s.idx.length, at, { X: d.X.length, co: d.co.length, pos: d.pos.length, hubs: d.hubs.length, params: d.params.length });
    t.bind(mem.buffer);
    this.sets.set(key, t);
    return t;
  }

  /** Skin and normals of one car: its dynamic inputs in, `outPos` and `outNor` (the geometry's own arrays) out. */
  run(t: SkinTables, d: SkinDynamic, outPos: Float32Array, outNor: Float32Array): void {
    const mem = this.ex.memory;
    if (t.buf !== mem.buffer) t.bind(mem.buffer);
    t.X.set(d.X);
    t.co.set(d.co);
    t.pos.set(d.pos);
    t.hubs.set(d.hubs);
    t.params.set(d.params);
    const a = t.at;
    this.ex.skin_shape(t.nverts, a.rest, a.rC, a.sN, a.sXf, a.sW, a.rJ, a.rW, a.X, a.pos, a.iN, a.iCo, a.iUvw, a.co, a.hub, a.hubs, a.seed, a.params, a.out);
    this.ex.normals(a.out, a.idx, t.triIndices, a.nor, t.nverts * 3);
    outPos.set(t.out);
    outNor.set(t.nor);
  }
}

/**
 * The one loaded kernel, null until `loadSkinKernel` resolves. Once set it never changes: a compiled module and its
 * content-keyed tables, which a second engine, a test or a replay inherits without effect (as `once` constants do).
 */
const loaded: { kernel: SkinKernel | null } = { kernel: null };

/** The loaded kernel, or null (not loaded yet, or it failed): skin in JS. */
export function skinKernel(): SkinKernel | null {
  return loaded.kernel;
}

/**
 * Instantiate the kernel from the `.wasm` bytes, or a `fetch` of it (streamed, with the bytes as the fallback for a
 * server that does not send `application/wasm`). Rejects if it cannot be fetched or compiled. A second call after a
 * success does nothing.
 */
export async function loadSkinKernel(src: BufferSource | Response | PromiseLike<Response>): Promise<void> {
  if (loaded.kernel) return;
  const imports = { m: { sin: Math.sin, exp: Math.exp } };
  let instance: WebAssembly.Instance;
  if (src instanceof ArrayBuffer || ArrayBuffer.isView(src)) {
    instance = (await WebAssembly.instantiate(src, imports)).instance;
  } else {
    const res = await src;
    if (!res.ok) throw new Error(`skin kernel: HTTP ${res.status}`);
    try {
      instance = (await WebAssembly.instantiateStreaming(res.clone(), imports)).instance;
    } catch {
      instance = (await WebAssembly.instantiate(await res.arrayBuffer(), imports)).instance;
    }
  }
  if (!isExports(instance.exports)) throw new Error("skin kernel: unexpected exports");
  loaded.kernel ??= new SkinKernel(instance.exports);
}

/** 32-bit FNV-1a over `a`'s bytes (whole words, then the tail). */
function fnv(h: number, a: Float32Array | Float64Array | Int32Array | Uint8Array | Uint32Array): number {
  const w = new Uint32Array(a.buffer, a.byteOffset, a.byteLength >>> 2);
  for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w[i]!, 16777619);
  const tail = new Uint8Array(a.buffer, a.byteOffset + (w.length << 2), a.byteLength & 3);
  for (let i = 0; i < tail.length; i++) h = Math.imul(h ^ tail[i]!, 16777619);
  return h >>> 0;
}

/**
 * A style's table key: the vertex count, the dynamic sizes and a hash of every static table. Cars built from one rig
 * and mesh have the same key, so they share one placed set; any difference in the tables is a different key.
 */
export function skinKey(s: SkinStatic, d: SkinDynamic): string {
  let h = 2166136261;
  for (const a of [s.rest, s.rC, s.sN, s.sXf, s.sW, s.rJ, s.rW, s.iN, s.iCo, s.iUvw, s.hub, s.seed, s.idx] as const) h = fnv(h, a);
  return `${s.rest.length / 3}:${s.idx.length}:${d.X.length}:${d.co.length}:${d.pos.length}:${h}`;
}

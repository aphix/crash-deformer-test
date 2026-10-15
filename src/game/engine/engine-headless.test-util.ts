import type * as THREE from "three";
import type { CrashEngine } from "./engine.ts";

/**
 * What the real `CrashEngine` needs to run headless in node: its canvas, WebGL context, 2d contexts, `window` and `document` are
 * inert stand-ins (every call answers, nothing draws); the sim, the scene and the loop rules are the engine's own. `getParameter`
 * answers a string that also reads as the number 16, so three's version check and its numeric limits both take it.
 */
const ctx2d: object = new Proxy(function () {}, { get: () => () => ctx2d, apply: () => ctx2d });
const GL_ANSWERS: Record<string, () => unknown> = {
  getParameter: () => Object.assign(new String("WebGL 2.0"), { valueOf: () => 16 }),
  getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
  getContextAttributes: () => ({ alpha: false, antialias: false }),
  getSupportedExtensions: () => [],
  getExtension: () => null,
  getShaderInfoLog: () => "",
  getProgramInfoLog: () => "",
  getProgramParameter: () => 0,
};
const GL_CONSTANTS = new Map<string, number>();
const gl: object = new Proxy(function () {}, {
  get: (_t, k) => {
    if (typeof k !== "string") return undefined;
    // Upper-case names are GL constants: each its own number (three compares them to pick a draw mode, a format).
    if (k === k.toUpperCase()) return GL_CONSTANTS.get(k) ?? (GL_CONSTANTS.set(k, GL_CONSTANTS.size + 1), GL_CONSTANTS.size);
    return GL_ANSWERS[k] ?? (k.startsWith("create") ? () => ({}) : () => 1);
  },
  apply: () => 1,
});
export const element = (): HTMLCanvasElement & HTMLElement =>
  ({
    style: {},
    width: 0,
    height: 0,
    clientWidth: 800,
    clientHeight: 600,
    getContext: (kind: string) => (kind === "2d" ? ctx2d : gl),
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    appendChild() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    parentElement: null,
  }) as unknown as HTMLCanvasElement & HTMLElement;

export function stubBrowser(): void {
  Object.assign(globalThis, {
    devicePixelRatio: 1,
    innerWidth: 800,
    innerHeight: 600,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    location: { search: "", hash: "", href: "http://x/", origin: "http://x" },
    history: { state: null, replaceState() {} },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { createElement: element, addEventListener() {}, removeEventListener() {}, body: element(), documentElement: element() },
  });
  (globalThis as { window?: unknown }).window = globalThis;
}

/**
 * The derby's opening shot (`ChaseCamera.frameReset`), pulled back (at most 4x) until every live car shows, matrices current: the picture a
 * test aims its presses at. The stand-in canvas has no size, so the view offset is cleared and the aspect set to `w` : `h` by hand.
 */
export function frameField(engine: CrashEngine, w: number, h: number): void {
  const camera = engine["camera"];
  const look = engine["view"].look;
  engine["view"].frameReset(false, engine["live"]());
  camera.clearViewOffset();
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const home = camera.position.clone();
  const shows = (p: THREE.Vector3): boolean => {
    const s = p.clone();
    s.y += 0.5;
    s.project(camera);
    return s.z <= 1 && Math.abs(s.x) <= 0.95 && Math.abs(s.y) <= 0.95;
  };
  for (const scale of [1, 1.4, 2, 2.8, 4]) {
    camera.position.copy(home).sub(look).multiplyScalar(scale).add(look);
    camera.lookAt(look);
    engine["scene"].updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    if (engine["live"]().every((c) => shows(c.group.position))) return;
  }
}

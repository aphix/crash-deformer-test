import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

/*
 * Import this before `loadRapier` runs under Node. `@dimforge/rapier3d-simd` is written for bundlers: no `exports`/`main`,
 * and extensionless relative imports (`./exports`, `./dynamics` for `dynamics/index.js`). This resolves them as Vite
 * does; Node 24 itself instantiates the package's ESM `.wasm` import.
 */
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "@dimforge/rapier3d-simd") return next("@dimforge/rapier3d-simd/rapier.js", ctx);
    if (ctx.parentURL?.includes("/@dimforge/rapier3d-simd/") && spec.startsWith(".") && !/\.(js|wasm)$/.test(spec)) {
      return next(existsSync(new URL(`${spec}.js`, ctx.parentURL)) ? `${spec}.js` : `${spec}/index.js`, ctx);
    }
    return next(spec, ctx);
  },
});

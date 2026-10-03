#!/usr/bin/env node
/**
 * Build `kernels/skin` (Rust) into `src/game/deform/skin-kernel.wasm`, the file the game loads and the repo commits.
 *
 *   npm run build:kernel
 *
 * The deploy box has no cargo: it serves the committed binary, so rebuild and commit it whenever `lib.rs` changes.
 * Needs cargo and the `wasm32-unknown-unknown` target. Scalar code (no SIMD, threads or shared memory); the one
 * non-MVP instruction is std's `memset` (`memory.fill`, bulk memory: Chrome 75, Firefox 79, Safari 15). The build
 * paths are mapped to `/src`, so the binary carries nothing of the build machine.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CRATE = join(ROOT, "kernels/skin");
const OUT = join(ROOT, "src/game/deform/skin-kernel.wasm");

const env = { ...process.env, RUSTFLAGS: `--remap-path-prefix=${ROOT}=/src` };
execFileSync("cargo", ["build", "--release", "--locked", "--target", "wasm32-unknown-unknown", "--manifest-path", join(CRATE, "Cargo.toml")], {
  env,
  stdio: "inherit",
});
copyFileSync(join(CRATE, "target/wasm32-unknown-unknown/release/skin_kernel.wasm"), OUT);
console.log(`wrote ${OUT}`);

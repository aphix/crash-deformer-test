import { readFileSync } from "node:fs";
import { loadSkinKernel } from "./skin-kernel.ts";

/** Load the committed `skin-kernel.wasm` under Node (the browser fetches it). Not a test file itself. */
export function loadSkinKernelForTest(): Promise<void> {
  return loadSkinKernel(readFileSync(new URL("./skin-kernel.wasm", import.meta.url)));
}

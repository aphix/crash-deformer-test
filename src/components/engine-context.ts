import { createContext, useContext, type RefObject } from "react";
import type { CrashEngine } from "@/game/engine/engine";

/** The running engine, for buttons deep in the HUD that act on it without the props reaching them (the [!] flag); `CrashLab` provides it. */
export const EngineContext = createContext<RefObject<CrashEngine | null> | null>(null);

export function useEngine(): RefObject<CrashEngine | null> {
  const engine = useContext(EngineContext);
  if (!engine) throw new Error("useEngine outside CrashLab");
  return engine;
}

import { useSyncExternalStore } from "react";
import { speedUnitFor, type SpeedUnit } from "@/game/hud/speed-units";

function subscribe(onChange: () => void): () => void {
  addEventListener("languagechange", onChange);
  return () => removeEventListener("languagechange", onChange);
}

/** This viewer's speed unit from the browser's languages; km/h in the server render, so hydration matches it first. */
export function useSpeedUnit(): SpeedUnit {
  return useSyncExternalStore(
    subscribe,
    () => speedUnitFor([...navigator.languages, navigator.language]),
    () => "km/h",
  );
}

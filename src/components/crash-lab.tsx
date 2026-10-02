import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Hud } from "@/components/hud";
import { NetPanel } from "@/components/net-panel";
import type { CrashEngine } from "@/game/engine";
import { HudStore } from "@/game/hud-store";

export function CrashLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<CrashEngine | null>(null);
  const [hudStore] = useState(() => new HudStore());
  const hud = useSyncExternalStore(hudStore.subscribe, hudStore.get, hudStore.get);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let engine: CrashEngine | null = null;

    void import("@/game/engine")
      .then(({ CrashEngine }) => {
        if (cancelled || !canvasRef.current) return;
        try {
          engine = new CrashEngine(canvasRef.current, hudStore);
          engineRef.current = engine;
          engine.start();
        } catch (err) {
          const message = err instanceof Error ? err.stack ?? err.message : String(err);
          console.error("Crush Stream failed to start", err);
          if (!cancelled) setBootError(message);
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        console.error("Crush Stream failed to start", err);
        if (!cancelled) setBootError(message);
      });

    return () => {
      cancelled = true;
      engine?.dispose();
      engineRef.current = null;
    };
  }, [hudStore]);

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-bg text-fg">
      <canvas
        ref={canvasRef}
        className="block h-full w-full touch-none"
        aria-label="Crash simulation canvas"
      />
      {bootError ? (
        <p className="absolute inset-x-4 top-1/2 z-50 -translate-y-1/2 rounded-lg bg-black/80 px-4 py-3 text-center text-sm text-red-200">
          {bootError}
        </p>
      ) : null}
      {/* The race focus view shows race panels only; the Net button stays mounted (its room keeps running) but hidden. */}
      <div className={hud.race && !hud.race.fullUi ? "hidden" : "contents"}>
        <NetPanel engine={engineRef} />
      </div>
      <Hud state={hud} engine={engineRef} />
    </main>
  );
}

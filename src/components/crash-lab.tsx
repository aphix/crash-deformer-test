import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Hud } from "@/components/hud";
import type { CrashEngine } from "@/game/engine";
import { getHudSnapshot, subscribeHud } from "@/game/hud-store";

export function CrashLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<CrashEngine | null>(null);
  const hud = useSyncExternalStore(subscribeHud, getHudSnapshot, getHudSnapshot);
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
          engine = new CrashEngine(canvasRef.current);
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
  }, []);

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
      <Hud
        state={hud}
        onReset={() => engineRef.current?.reset()}
        onTogglePlay={() => engineRef.current?.togglePlay()}
        onToggleLoop={() => engineRef.current?.toggleLoop()}
        onToggleRig={() => engineRef.current?.toggleRig()}
        onToggleBarrier={() => engineRef.current?.toggleBarrier()}
        onToggleBalls={() => engineRef.current?.toggleBalls()}
        onToggleCompactor={() => engineRef.current?.toggleCompactor()}
        onToggleOrbit={() => engineRef.current?.toggleOrbit()}
        onToggleSlomo={() => engineRef.current?.toggleSlomo()}
        onToggleAudio={() => engineRef.current?.toggleAudio()}
        onToggleDeformMode={() => engineRef.current?.toggleDeformMode()}
        onSquash={(v) => engineRef.current?.setSquash(v)}
        onBuckle={(v) => engineRef.current?.setBuckle(v)}
        onFxDensity={(v) => engineRef.current?.setFxDensity(v)}
        onCarCount={(n) => engineRef.current?.setCarCount(n)}
        onSpeedRange={(min, max) => engineRef.current?.setSpeedRange(min, max)}
        onTimeScale={(v) => engineRef.current?.setTimeScale(v)}
        onToggleCapture={() => engineRef.current?.toggleCapture()}
        onDefaults={() => engineRef.current?.resetDefaults()}
        onCopyTrace={async () => {
          const json = engineRef.current?.copyTraceJson();
          if (!json) return false;
          try {
            await navigator.clipboard.writeText(json);
            return true;
          } catch {
            const ta = document.createElement("textarea");
            ta.value = json;
            ta.style.position = "fixed";
            ta.style.left = "-9999px";
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand("copy");
            ta.remove();
            return ok;
          }
        }}
      />
    </main>
  );
}

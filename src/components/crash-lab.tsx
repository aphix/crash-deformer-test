import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { dismissBootLoader } from "@/lib/boot-loader";
import { Hud } from "@/components/hud";
import { useDriver } from "@/components/use-driver";
import { NetPanel } from "@/components/net-panel";
import { LiveRooms } from "@/components/live-rooms";
import type { CrashEngine } from "@/game/engine/engine";
import type { runBench } from "@/game/engine/engine-bench";
import { HudStore } from "@/game/hud/hud-store";

export function CrashLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const veilRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<CrashEngine | null>(null);
  const [hudStore] = useState(() => new HudStore());
  const hud = useSyncExternalStore(hudStore.subscribe, hudStore.get, hudStore.get);
  const [bootError, setBootError] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);
  const driver = useDriver();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let engine: CrashEngine | null = null;
    // If `ready` never comes, let the page (and the error UI) show.
    const bootTimeout = window.setTimeout(dismissBootLoader, 20_000);

    void import("@/game/engine/engine")
      .then(({ CrashEngine }) => {
        if (cancelled || !canvasRef.current || !veilRef.current) return;
        try {
          engine = new CrashEngine(canvasRef.current, hudStore, veilRef.current);
          engineRef.current = engine;
          engine.start();
          setBooted(true);
          engine.ready.finally(dismissBootLoader);
          // `?bench=city` / `?bench=strip&…`: the phone-timing pages (engine-bench.ts), fetched only when asked for.
          if (new URLSearchParams(window.location.search).has("bench")) void (import("@/game/engine/engine-bench") as Promise<{ runBench: typeof runBench }>).then((m) => m.runBench(engine!, hudStore.get, window.location.search));
        } catch (err) {
          const message = err instanceof Error ? err.stack ?? err.message : String(err);
          console.error("Crush Stream failed to start", err);
          dismissBootLoader();
          if (!cancelled) setBootError(message);
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        console.error("Crush Stream failed to start", err);
        dismissBootLoader();
        if (!cancelled) setBootError(message);
      });

    return () => {
      cancelled = true;
      window.clearTimeout(bootTimeout);
      engine?.dispose();
      engineRef.current = null;
    };
  }, [hudStore]);

  // The player's stored name and car reach the engine at boot and on every change (race setup, netplay hello).
  useEffect(() => {
    if (booted) engineRef.current?.setDriver(driver.name, driver.car);
  }, [booted, driver.name, driver.car]);

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
      {/* The race focus view and the solo highlight view hide the Net button; it stays mounted (its room keeps running). */}
      <div className={hud.race && (!hud.race.fullUi || hud.race.solo !== null) ? "hidden" : "contents"}>
        <NetPanel engine={engineRef} />
      </div>
      <Hud state={hud} engine={engineRef} />
      {/* Race mode's online entry: live races and Play online (hidden in the solo clip view and while the results reel plays). */}
      {hud.race && hud.race.solo === null && hud.race.reel === null ? <LiveRooms engine={engineRef} race={hud.race} /> : null}
      {/* The scene switch's fade to black (`SceneFade`): the engine drives its opacity; it covers the HUD and takes no input. */}
      <div ref={veilRef} aria-hidden className="pointer-events-none fixed inset-0 z-[100] bg-black opacity-0" />
    </main>
  );
}

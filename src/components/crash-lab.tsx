import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { dismissBootLoader } from "@/lib/boot-loader";
import { Hud } from "@/components/hud";
import { useDriver } from "@/components/use-driver";
import { NetPanel } from "@/components/net-panel";
import { LiveRooms } from "@/components/live-rooms";
import type { CrashEngine } from "@/game/engine/engine";
import { BENCH_QUERY } from "@/game/engine/constants";
import { BenchLoopBar } from "@/components/bench-controls";
import { PREF_KEYS, runBenchPage } from "@/components/bench-run";
import { EngineContext } from "@/components/engine-context";
import { SubmissionToast } from "@/components/submission-toast";
import { BuildLabel, UpdateNotice } from "@/components/update-notice";
import { useStoredString } from "@/components/use-stored-string";
import { useUpdateCheck } from "@/components/use-update-check";
import { settleOnLoad, reloadOntoUpdate } from "@/lib/deploy/update-check";
import { updateNoticeShown } from "@/game/hud/submit-rules";
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
  const newer = useUpdateCheck();
  const [autoReload] = useStoredString(PREF_KEYS.auto, "0", "0");
  const deployed = updateNoticeShown(newer, hud.race) ? newer : null;

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
          if (new URLSearchParams(window.location.search).has(BENCH_QUERY)) void runBenchPage(engine, hudStore.get);
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

  // A reload that landed on the new build is done with; the `?v=` it carried goes from the address.
  useEffect(() => settleOnLoad(__BUILD_SHA__), []);

  // Auto-reload (ticked beside the Benchmark entry): onto a newly deployed build as soon as no race is under way. A bench page waits for its
  // bench to end (the loop's next page is the reload, `bench-run.ts`); a reload the backoff holds back is tried again each minute.
  useEffect(() => {
    if (autoReload !== "1" || deployed === null || new URLSearchParams(window.location.search).has(BENCH_QUERY)) return;
    let timer = 0;
    const attempt = (): void => {
      if (!reloadOntoUpdate(deployed)) timer = window.setTimeout(attempt, 60_000);
    };
    attempt();
    return () => window.clearTimeout(timer);
  }, [autoReload, deployed]);

  return (
    <EngineContext.Provider value={engineRef}>
      <main className="relative h-dvh w-full overflow-hidden bg-bg text-fg">
        <canvas ref={canvasRef} className="block h-full w-full touch-none" aria-label="Crash simulation canvas" />
        {bootError ? (
          <p className="absolute inset-x-4 top-1/2 z-50 -translate-y-1/2 rounded-lg bg-black/80 px-4 py-3 text-center text-sm text-red-200">{bootError}</p>
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
        <BuildLabel />
        <UpdateNotice newer={deployed} />
        <SubmissionToast />
        <BenchLoopBar />
      </main>
    </EngineContext.Provider>
  );
}

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { dismissBootLoader } from "@/lib/boot-loader";
import { Hud } from "@/components/hud";
import { useDriver } from "@/components/use-driver";
import { useDeepLinkJoin } from "@/components/use-deep-link-join";
import type { CrashEngine } from "@/game/engine/engine";
import { runBenchPage } from "@/components/bench-run";
import { EngineContext } from "@/components/engine-context";
import { SubmissionToast } from "@/components/submission-toast";
import { BuildLabel, UpdateNotice } from "@/components/update-notice";
import { autoReloadAsked, isBenchPage } from "@/game/engine/bench-loop";
import { useUpdateCheck } from "@/components/use-update-check";
import { settleOnLoad, reloadOntoUpdate } from "@/lib/deploy/update-check";
import { updateNoticeShown } from "@/game/hud/submit-rules";
import { HudStore } from "@/game/hud/hud-store";

/** The page's address never changes under the page (every bench step is a page load), so there is nothing to subscribe to. */
function subscribeNever(): () => void {
  return () => {};
}

export function CrashLab() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const veilRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<CrashEngine | null>(null);
  const [hudStore] = useState(() => new HudStore());
  const hud = useSyncExternalStore(hudStore.subscribe, hudStore.get, hudStore.get);
  const [bootError, setBootError] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);
  const driver = useDriver();
  useDeepLinkJoin(engineRef);
  const newer = useUpdateCheck();
  const benchPage = useSyncExternalStore(subscribeNever, () => isBenchPage(window.location.search), () => false);
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
          if (isBenchPage(window.location.search)) void runBenchPage(engine, hudStore.get);
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

  // Auto-reload (`?auto=1`): onto a newly deployed build as soon as no race is under way. A bench page waits for its
  // bench to end (the loop's next page is the reload, `bench-run.ts`); a reload the backoff holds back is tried again each minute.
  useEffect(() => {
    if (deployed === null || !autoReloadAsked(window.location.search) || isBenchPage(window.location.search)) return;
    let timer = 0;
    const attempt = (): void => {
      if (!reloadOntoUpdate(deployed)) timer = window.setTimeout(attempt, 60_000);
    };
    attempt();
    return () => window.clearTimeout(timer);
  }, [deployed]);

  return (
    <EngineContext.Provider value={engineRef}>
      <main className="relative h-dvh w-full overflow-hidden bg-bg text-fg">
        <canvas ref={canvasRef} className="block h-full w-full touch-none" aria-label="Crash simulation canvas" />
        {bootError ? (
          <p className="absolute inset-x-4 top-1/2 z-50 -translate-y-1/2 rounded-lg bg-black/80 px-4 py-3 text-center text-sm text-red-200">{bootError}</p>
        ) : null}
        <Hud state={hud} engine={engineRef} onlineShown={!benchPage} />
        {/* The scene switch's fade to black (`SceneFade`): the engine drives its opacity; it covers the HUD and takes no input. */}
        <div ref={veilRef} aria-hidden className="pointer-events-none fixed inset-0 z-[100] bg-black opacity-0" />
        <BuildLabel />
        <UpdateNotice newer={deployed} />
        <SubmissionToast />
      </main>
    </EngineContext.Provider>
  );
}

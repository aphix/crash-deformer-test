import { useEffect, useState } from "react";
import { fetchDeployedSha, newerBuild, POLL_MS, REFOCUS_MS } from "@/lib/deploy/update-check";

/** Shortly after load: a page served from a stale cache learns of the newer build before the first poll. */
const FIRST_CHECK_MS = 5_000;

/**
 * The sha of a newer deployed build, once the server's `version.json` names one (null until then). It asks a few seconds after
 * load, every `POLL_MS` while the tab is visible, and when the tab or window comes back after `REFOCUS_MS` away. The dev server
 * has no version file, so it never asks.
 */
export function useUpdateCheck(): string | null {
  const [newer, setNewer] = useState<string | null>(null);
  useEffect(() => {
    if (import.meta.env.DEV) return;
    let live = true;
    let last = 0;
    const check = async (): Promise<void> => {
      last = Date.now();
      const found = newerBuild(__BUILD_SHA__, await fetchDeployedSha());
      if (live && found !== null) setNewer(found);
    };
    const visible = (): boolean => document.visibilityState === "visible";
    const back = (): void => {
      if (visible() && Date.now() - last >= REFOCUS_MS) void check();
    };
    const first = window.setTimeout(() => void check(), FIRST_CHECK_MS);
    const poll = window.setInterval(() => {
      if (visible()) void check();
    }, POLL_MS);
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      live = false;
      window.clearTimeout(first);
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
    };
  }, []);
  return newer;
}

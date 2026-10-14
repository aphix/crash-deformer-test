import { useEffect, useRef, useState } from "react";
import { driftPay, type DriftView } from "@/game/vehicle/car-drive";
import { cn } from "@/lib/utils";

/** How long the payout flash holds at full before it fades (the fade itself is the overlay's `duration-500`). */
const FLASH_HOLD_MS = 120;

/** True for `FLASH_HOLD_MS` after `paid` rises (a clean slide paid out); never on mount, and a fall (a new run's seat) clears it. */
function usePayoutFlash(paid: number): boolean {
  const last = useRef(paid);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (paid === last.current) return;
    const rose = paid > last.current;
    last.current = paid;
    setOn(rose);
    if (!rose) return;
    const t = setTimeout(() => setOn(false), FLASH_HOLD_MS);
    return () => clearTimeout(t);
  }, [paid]);
  return on;
}

/**
 * Inside a boost track (`relative overflow-hidden`): the share the slide in progress would pay, drawn on from the meter's level up (green while it
 * would pay, amber while a contact is fresh), and a flash over the whole track when a payout lands. `vertical` for the bottle, else a bar filling rightward.
 */
export function DriftOverlay({ drift, boost, vertical }: { drift: DriftView; boost: number; vertical: boolean }) {
  const flash = usePayoutFlash(drift.paid);
  const pending = drift.s > 0 ? Math.min(driftPay(drift.s), 1 - boost) : 0;
  const from = `${boost * 100}%`;
  const size = `${pending * 100}%`;
  return (
    <>
      {pending > 0 ? (
        <div
          aria-hidden
          data-drift={drift.clean ? "clean" : "dirty"}
          className={cn("absolute transition-[height,width] duration-150 ease-linear", vertical ? "inset-x-0" : "inset-y-0", drift.clean ? "bg-signal-green" : "bg-signal-amber")}
          style={vertical ? { bottom: from, height: size } : { left: from, width: size }}
        />
      ) : null}
      <div aria-hidden data-drift-flash={flash ? "on" : undefined} className={cn("pointer-events-none absolute inset-0 bg-signal-green transition-opacity", flash ? "opacity-80 duration-75" : "opacity-0 duration-500")} />
    </>
  );
}

/** The slide's caption while one charges ("Drift +24%": what it would pay), else nothing. Amber after a contact: keep clear to be paid. */
export function DriftLabel({ drift, className }: { drift: DriftView; className?: string }) {
  if (drift.s <= 0) return null;
  return (
    <span data-drift-label={drift.clean ? "clean" : "dirty"} className={cn("hud-ink text-[10px] font-semibold uppercase tracking-[0.12em]", drift.clean ? "text-signal-green" : "text-signal-amber", className)}>
      Drift +{Math.round(driftPay(drift.s) * 100)}%
    </span>
  );
}

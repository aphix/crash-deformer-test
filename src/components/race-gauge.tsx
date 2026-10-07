import { memo, type ReactNode } from "react";
import { Wrench } from "lucide-react";
import { useEngine } from "@/components/engine-context";
import { RESET_GLOW } from "@/components/reset-prompt";
import { usePadHold } from "@/components/use-pad-hold";
import { useSpeedUnit } from "@/components/use-speed-unit";
import { needsReset } from "@/game/hud/reset-prompt";
import { formatSpeed } from "@/game/hud/speed-units";
import { PAD_BUTTON } from "@/game/vehicle/gamepad";
import { KPH_PER_MS } from "@/game/kernel/constants";
import type { RaceView } from "@/game/match/types";
import { cn } from "@/lib/utils";

/** The dial's viewBox is 220 × 250 user units, its centre (110, 110). */
const C = 110;
/** The dial sweeps ±135° from straight up: 270° from the lower left to the lower right. */
const HALF_SWEEP = 135;
/** Share of the sweep where the redline starts. */
const REDLINE = 0.85;
/** Numbered ticks 0-8 (× 1000 rpm); half-ticks between. */
const MAJORS = 8;
/** Damage arc: lower left up to the upper left, outside the dial. */
const DMG_FROM = -150;
const DMG_TO = -30;
/** Damage at which the arc turns amber / red: the drivetrain's `DENT` and `LIMP` health bands (vehicle-classes.ts). */
const DMG_AMBER = 0.6;
const DMG_RED = 0.25;
/** Boost level above which the bottle glows: a burst of more than a quarter second is in it. */
const NITRO_USABLE = 0.15;

const NITRO_GLOW_CLASSES = {
  bottle: { soft: "shadow-[0_0_0.9em_0_var(--color-scene-race)]", bright: "shadow-[0_0_1.4em_0.25em_var(--color-scene-race)]" },
  bar: { soft: "drop-shadow-[0_0_4px_var(--color-accent)]", bright: "drop-shadow-[0_0_8px_var(--color-accent)]" },
};

/** How a boost meter glows, for the bottle and the compact bar alike: softly while a burst is in it, bright while burning, not at all for a car with no nitrous. */
export function nitroGlowClass(shape: keyof typeof NITRO_GLOW_CLASSES, boost: number | null, boosting: boolean): string | undefined {
  if (boost === null) return undefined;
  if (boosting) return NITRO_GLOW_CLASSES[shape].bright;
  return boost > NITRO_USABLE ? NITRO_GLOW_CLASSES[shape].soft : undefined;
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const px = (r: number, deg: number) => (C + r * Math.sin(rad(deg))).toFixed(1);
const py = (r: number, deg: number) => (C - r * Math.cos(rad(deg))).toFixed(1);
/** Clockwise arc of radius `r` from `from` to `to` degrees off straight up. */
const arc = (r: number, from: number, to: number) => `M${px(r, from)} ${py(r, from)}A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${px(r, to)} ${py(r, to)}`;

/** The dial's fixed parts: ring, redline, ticks and numerals. Memoised: nothing in it ever changes. */
const DialFace = memo(function DialFace() {
  const ticks = [];
  for (let i = 0; i <= MAJORS * 2; i++) {
    const deg = -HALF_SWEEP + (i * 2 * HALF_SWEEP) / (MAJORS * 2);
    const major = i % 2 === 0;
    ticks.push(
      <line key={i} x1={px(major ? 66 : 70, deg)} y1={py(major ? 66 : 70, deg)} x2={px(76, deg)} y2={py(76, deg)} className={cn("stroke-fg", major ? "" : "opacity-50")} strokeWidth={major ? 2 : 1} />,
    );
    if (major) {
      ticks.push(
        <text key={`n${i}`} x={px(55, deg)} y={py(55, deg)} textAnchor="middle" dominantBaseline="central" fontSize="11" className="fill-fg/80 font-display font-semibold">
          {i / 2}
        </text>,
      );
    }
  }
  return (
    <>
      <circle cx={C} cy={C} r="88" className="fill-surface/55" />
      <path d={arc(82, -HALF_SWEEP, HALF_SWEEP)} className="stroke-fg/25" strokeWidth="3" fill="none" />
      <path d={arc(82, -HALF_SWEEP + REDLINE * 2 * HALF_SWEEP, HALF_SWEEP)} className="stroke-signal-red" strokeWidth="5" fill="none" />
      {ticks}
      <text x={C} y="76" textAnchor="middle" fontSize="7" letterSpacing="1.5" className="fill-fg/60 font-display uppercase">
        rpm ×1000
      </text>
    </>
  );
});

/**
 * The nitrous bottle: its fill is the boost meter; it glows while there is a burst in it, and brighter while burning. A car with no nitrous
 * (police, traffic, a car nobody drives: `boost` null) shows it empty and greyed, so the cluster always carries the bottle.
 */
function Nitro({ boost, boosting, drafting }: { boost: number | null; boosting: boolean; drafting: boolean }) {
  if (boost === null) {
    return (
      <div className="relative flex flex-col items-center opacity-30" role="img" aria-label="No boost">
        <div className="h-[0.5em] w-[0.9em] rounded-t-sm bg-fg/55" />
        <div className="h-[0.5em] w-[0.5em] bg-fg/30" />
        <div className="h-[2.6em] w-[1.5em] rounded-[0.4em] bg-fg/20 shadow-[var(--shadow-border)]" />
      </div>
    );
  }
  return (
    <div className="relative flex flex-col items-center" role="meter" aria-label="Boost" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(boost * 100)}>
      {drafting ? <span className="hud-ink absolute bottom-full mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-accent">Draft</span> : null}
      <div className="h-[0.5em] w-[0.9em] rounded-t-sm bg-fg/55" />
      <div className="h-[0.5em] w-[0.5em] bg-fg/30" />
      <div
        className={cn(
          "relative h-[2.6em] w-[1.5em] overflow-hidden rounded-[0.4em] bg-fg/20 shadow-[var(--shadow-border)] transition-shadow duration-[var(--motion-fast)]",
          nitroGlowClass("bottle", boost, boosting),
        )}
      >
        <div
          className={cn("absolute inset-0 origin-bottom transition-transform duration-150 ease-linear will-change-transform", boosting ? "bg-fg" : "bg-scene-race")}
          style={{ transform: `scaleY(${boost})` }}
        />
      </div>
    </div>
  );
}

/** The bottle as a button, on a touch screen only: holding it holds the thumb pad's Boost button (`usePadHold`), padded out to a finger's size around the small bottle. */
function BoostHold({ children }: { children: ReactNode }) {
  return (
    <button type="button" tabIndex={-1} aria-label="Nitrous bottle (hold to boost)" className="pointer-events-none -m-4 block touch-none select-none p-4 phone-landscape:pointer-events-auto" {...usePadHold(useEngine(), PAD_BUTTON.west)}>
      {children}
    </button>
  );
}

/**
 * The race's drive cluster, bottom right on a big screen: an arc rev dial with the redline, the speed in the centre and the
 * gear under it (the revs are faked from the speed inside the gear's bucket: `carRpm`); the damage arc on its left
 * (`RaceView.damage`) over a wrench that is lit while the game would accept a reset (`canReset`: dim in a no-reset race or while
 * spectating) and glows like every reset control once the car needs one (`needsReset`); the nitrous bottle, the boost meter.
 * The needle and the bottle's fill move by `transform` transitions (the compositor, not a repaint) between the HUD's snapshots.
 */
export function DriveCluster({ view, boostable }: { view: RaceView; boostable: boolean }) {
  const unit = useSpeedUnit();
  const needle = -HALF_SWEEP + view.rpm * 2 * HALF_SWEEP;
  const dmgTo = DMG_FROM + (DMG_TO - DMG_FROM) * view.damage;
  const dmgTone = view.damage > DMG_AMBER ? "stroke-fg" : view.damage > DMG_RED ? "stroke-signal-amber" : "stroke-signal-red";
  return (
    <div className="drive-cluster hud-ink relative font-display tabular-nums select-none">
      <svg viewBox="0 0 220 250" className="block w-full">
        <DialFace />
        <path d={arc(100, DMG_FROM, DMG_TO)} className="stroke-fg/20" strokeWidth="6" strokeLinecap="round" fill="none" />
        {view.damage > 0.01 ? <path d={arc(100, DMG_FROM, dmgTo)} className={dmgTone} strokeWidth="6" strokeLinecap="round" fill="none" /> : null}
        <text x={C} y="112" textAnchor="middle" fontSize="46" className="fill-fg font-semibold" aria-label="Speed">
          {formatSpeed(view.speedKph / KPH_PER_MS, unit)}
        </text>
        <text x={C} y="127" textAnchor="middle" fontSize="10" letterSpacing="1.5" className="fill-fg/70 uppercase">
          {unit}
        </text>
        <rect x="96" y="143" width="28" height="28" rx="6" className="fill-surface/60 stroke-fg/40" strokeWidth="1.5" />
        <text x={C} y="158" textAnchor="middle" dominantBaseline="central" fontSize="20" className="fill-fg font-semibold" aria-label="Gear">
          {view.gear === 0 ? "R" : view.gear}
        </text>
      </svg>
      <div
        className="pointer-events-none absolute left-0 top-0 aspect-square w-full will-change-transform transition-transform duration-150 ease-linear"
        style={{ transform: `rotate(${needle.toFixed(1)}deg)` }}
        role="meter"
        aria-label="Revs"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(view.rpm * 100)}
      >
        <div className="absolute left-1/2 top-[13.5%] h-[17.5%] w-[1.6%] -translate-x-1/2 rounded-full bg-signal-red shadow-[0_0_6px_var(--color-signal-red)]" />
      </div>
      <div
        className={cn(
          "absolute left-[14%] top-[83%] grid size-[16%] place-items-center rounded-full transition-colors duration-[var(--motion-fast)]",
          needsReset(view) ? cn("bg-fg text-accent-fg", RESET_GLOW) : view.canReset ? "text-fg" : "text-fg/25",
        )}
        role="img"
        aria-label={view.canReset ? "Repair available" : "Repair unavailable"}
      >
        <Wrench className="size-3/5" />
      </div>
      <div className="absolute left-[56%] top-[80%] text-[length:var(--g-em)]">
        {boostable && view.boost !== null ? (
          <BoostHold>
            <Nitro boost={view.boost} boosting={view.boosting} drafting={view.racer?.drafting ?? false} />
          </BoostHold>
        ) : (
          <Nitro boost={view.boost} boosting={view.boosting} drafting={view.racer?.drafting ?? false} />
        )}
      </div>
    </div>
  );
}

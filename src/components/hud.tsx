import { useEffect, useState } from "react";
import {
  BrickWall,
  Braces,
  CircleDot,
  ClipboardCopy,
  FoldHorizontal,
  Gauge,
  Orbit,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  Spline,
  Undo2,
  Waypoints,
  Timer,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CrashHudState } from "@/game/hud-store";
import { cn } from "@/lib/utils";

type Props = {
  state: CrashHudState;
  onReset: () => void;
  onTogglePlay: () => void;
  onToggleLoop: () => void;
  onToggleRig: () => void;
  onToggleBarrier: () => void;
  onToggleBalls: () => void;
  onToggleCompactor: () => void;
  onToggleOrbit: () => void;
  onToggleSlomo: () => void;
  onToggleAudio: () => void;
  onToggleDeformMode: () => void;
  onSquash: (value: number) => void;
  onBuckle: (value: number) => void;
  onFxDensity: (value: number) => void;
  onCarCount: (value: number) => void;
  onSpeedRange: (min: number, max: number) => void;
  onTimeScale: (value: number | null) => void;
  onToggleCapture: () => void;
  onDefaults: () => void;
  onCopyTrace: () => Promise<boolean> | boolean;
};

const PHASE: Record<CrashHudState["phase"], string> = {
  approach: "Approach",
  impact: "Impact",
  slowmo: "Slow-mo",
  aftermath: "Aftermath",
};

export function Hud({
  state,
  onReset,
  onTogglePlay,
  onToggleLoop,
  onToggleRig,
  onToggleBarrier,
  onToggleBalls,
  onToggleCompactor,
  onToggleOrbit,
  onToggleSlomo,
  onToggleAudio,
  onToggleDeformMode,
  onSquash,
  onBuckle,
  onFxDensity,
  onCarCount,
  onSpeedRange,
  onTimeScale,
  onToggleCapture,
  onDefaults,
  onCopyTrace,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [scaleText, setScaleText] = useState("");

  useEffect(() => {
    setScaleText(state.userTimeScale == null ? "" : String(state.userTimeScale));
  }, [state.userTimeScale]);

  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-4 text-fg sm:p-6">
      <header className="flex items-start justify-between gap-3">
        <div className="max-w-[16rem] sm:max-w-sm">
          <p className="font-display text-xs font-medium uppercase tracking-[0.22em] text-muted">
            Streamed deformation
          </p>
          <h1 className="mt-1 font-display text-3xl font-semibold leading-none tracking-tight text-balance sm:text-4xl">
            Crush Stream
          </h1>
          <p className="mt-2 hidden max-w-xs text-pretty text-sm leading-snug text-muted sm:block">
            {state.showCompactor
              ? "One car, two steel plates. They close square to the chassis — bumper, wheel-well, then the cage."
              : state.carCount <= 2
                ? "Cars lock onto the pad. Control particles shape-match the mesh — Müller 2005, with the lattice still a toggle."
                : `${state.carCount} cars on the pad. Same crumple rules, now a pile-up.`}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="rounded-xl bg-surface/90 px-3 py-2 shadow-[var(--shadow-border)]">
            <p className="font-display text-[0.65rem] uppercase tracking-[0.18em] text-subtle">Time scale</p>
            <p className="font-display text-2xl font-semibold tabular-nums leading-none">
              {state.timeScale.toFixed(2)}
              <span className="ml-0.5 text-sm font-medium text-muted">×</span>
            </p>
            <input
              type="text"
              inputMode="decimal"
              value={scaleText}
              placeholder="auto"
              onChange={(e) => {
                const raw = e.target.value;
                setScaleText(raw);
                if (raw.trim() === "") onTimeScale(null);
              }}
              onBlur={() => {
                if (scaleText.trim() === "") {
                  onTimeScale(null);
                  return;
                }
                const n = Number(scaleText);
                if (Number.isFinite(n)) onTimeScale(n);
                else setScaleText(state.userTimeScale == null ? "" : String(state.userTimeScale));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              aria-label="Typed time scale, clear for normal"
              className="mt-1 h-8 w-full rounded-md bg-surface-2 px-1.5 text-right font-display text-xs tabular-nums text-fg shadow-[var(--shadow-border)]"
            />
          </div>
          <div className="rounded-xl bg-surface/90 px-3 py-2 shadow-[var(--shadow-border)]">
            <p className="font-display text-[0.65rem] uppercase tracking-[0.18em] text-subtle">FPS</p>
            <p className="font-display text-2xl font-semibold tabular-nums leading-none">
              {Math.round(state.fps)}
            </p>
          </div>
          <div className="rounded-xl bg-surface/90 px-3 py-2 shadow-[var(--shadow-border)]">
            <p className="font-display text-[0.65rem] uppercase tracking-[0.18em] text-subtle">T+</p>
            <p className="font-display text-2xl font-semibold tabular-nums leading-none">
              {state.elapsed.toFixed(2)}
              <span className="ml-0.5 text-sm font-medium text-muted">s</span>
            </p>
          </div>
          <span
            className={cn(
              "rounded-full px-3 py-1 font-display text-[0.7rem] uppercase tracking-[0.16em] shadow-[var(--shadow-border)]",
              state.phase === "slowmo" || state.phase === "impact"
                ? "bg-accent text-accent-fg"
                : "bg-surface-2 text-muted",
            )}
          >
            {PHASE[state.phase]}
          </span>
        </div>
      </header>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <Stat
            label={state.showCompactor ? "Press gap" : state.carCount === 1 ? "Car" : "Lead"}
            value={state.showCompactor ? `${state.wallGap.toFixed(2)} m` : `${(state.speedA * 3.6).toFixed(0)} km/h`}
          />
          <div className="hidden text-center sm:block">
            {state.showCompactor ? (
              <p className="font-display text-sm text-muted">
                Stage{" "}
                <span className="tabular-nums text-fg">
                  {state.compactStage === "open"
                    ? "open"
                    : state.compactStage === "contact"
                      ? "crush zone"
                      : state.compactStage === "wells"
                        ? "wheel wells"
                        : state.compactStage === "mid"
                          ? "past hubs"
                          : "max crush"}
                </span>
              </p>
            ) : state.impactKph != null ? (
              <p className="font-display text-sm text-muted">
                Closing impact{" "}
                <span className="tabular-nums text-fg">{state.impactKph.toFixed(0)} km/h</span>
              </p>
            ) : (
              <p className="font-display text-sm text-muted">
                Closing{" "}
                <span className="tabular-nums text-fg">{state.closingKph.toFixed(0)} km/h</span>
                {state.eta > 0 && state.eta < 8 ? (
                  <span className="tabular-nums"> · {state.eta.toFixed(1)}s</span>
                ) : null}
              </p>
            )}
            <p className="mt-1 text-[0.7rem] uppercase tracking-[0.14em] text-subtle">
              {state.sensorCount} sensors · {state.cageCount} cages
            </p>
          </div>
          <Stat
            label={
              state.showCompactor
                ? "Plate speed"
                : state.carCount === 1
                  ? "Solo"
                  : state.carCount > 2
                    ? "Fleet"
                    : state.phase === "approach"
                      ? "Second"
                      : "Second wreck"
            }
            value={
              state.showCompactor
                ? `${state.closingKph.toFixed(0)} km/h close`
                : state.carCount !== 2
                  ? `${state.carCount} car${state.carCount === 1 ? "" : "s"}`
                  : `${(state.speedB * 3.6).toFixed(0)} km/h`
            }
            align="right"
          />
        </div>

        <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-2xl bg-surface/90 p-2 shadow-[var(--shadow-border)]">
          <Button onClick={onReset} variant="secondary" aria-label="Reset crash">
            <RotateCcw />
            Reset
          </Button>
          <Button onClick={onDefaults} variant="secondary" aria-label="Reset all settings to defaults">
            <Undo2 />
            Defaults
          </Button>
          <Button onClick={onTogglePlay} aria-label={state.playing ? "Pause" : "Play"}>
            {state.playing ? (
              <>
                <Pause />
                Pause
              </>
            ) : (
              <>
                <Play className="ml-0.5" />
                Play
              </>
            )}
          </Button>
          <Button
            onClick={onToggleLoop}
            variant={state.looping ? "default" : "secondary"}
            aria-pressed={state.looping}
            aria-label="Toggle loop"
          >
            <Repeat />
            Loop {state.looping ? "on" : "off"}
          </Button>
          <Button
            onClick={onToggleBarrier}
            variant={state.showBarrier ? "default" : "ghost"}
            aria-pressed={state.showBarrier}
            aria-label="Toggle jersey barrier"
          >
            <BrickWall />
            <span className="hidden sm:inline">Wall {state.showBarrier ? "on" : "off"}</span>
          </Button>
          <Button
            onClick={onToggleBalls}
            variant={state.showBalls ? "default" : "ghost"}
            aria-pressed={state.showBalls}
            aria-label="Toggle ramp balls"
          >
            <CircleDot />
            <span className="hidden sm:inline">Balls {state.showBalls ? "on" : "off"}</span>
          </Button>
          <Button
            onClick={onToggleCompactor}
            variant={state.showCompactor ? "default" : "ghost"}
            aria-pressed={state.showCompactor}
            aria-label="Toggle car compactor"
          >
            <FoldHorizontal />
            <span className="hidden sm:inline">Press {state.showCompactor ? "on" : "off"}</span>
          </Button>
          <Button
            onClick={onToggleRig}
            variant={state.showRig ? "default" : "ghost"}
            aria-pressed={state.showRig}
            aria-label="Toggle deformation rig"
          >
            <Spline />
            <span className="hidden sm:inline">Rig</span>
          </Button>
          <Button
            onClick={onToggleOrbit}
            variant={state.autoRotate ? "default" : "ghost"}
            aria-pressed={state.autoRotate}
            aria-label="Toggle camera auto-rotate"
          >
            <Orbit />
            <span className="hidden sm:inline">Orbit {state.autoRotate ? "on" : "off"}</span>
          </Button>
          <Button
            onClick={onToggleSlomo}
            variant={state.autoSlomo ? "default" : "ghost"}
            aria-pressed={state.autoSlomo}
            aria-label="Toggle impact slow-motion"
          >
            <Timer />
            <span className="hidden sm:inline">Slomo {state.autoSlomo ? "on" : "off"}</span>
          </Button>
          <Button
            onClick={onToggleDeformMode}
            variant={state.deformMode === "shape" ? "default" : "ghost"}
            aria-pressed={state.deformMode === "shape"}
            aria-label="Toggle shape-matching deformer"
          >
            <Waypoints />
            <span className="hidden sm:inline">{state.deformMode === "shape" ? "Shape" : "Lattice"}</span>
          </Button>
          <Button
            onClick={onToggleAudio}
            variant={state.audioOn ? "default" : "ghost"}
            aria-pressed={state.audioOn}
            aria-label="Toggle crash audio"
          >
            {state.audioOn ? <Volume2 /> : <VolumeX />}
            <span className="hidden sm:inline">Audio {state.audioOn ? "on" : "off"}</span>
          </Button>
          <label className="flex min-w-[11rem] flex-1 items-center gap-2 px-2">
            <span className="shrink-0 font-display text-[0.65rem] uppercase tracking-[0.14em] text-subtle">
              Squash
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={state.squash}
              onChange={(e) => onSquash(Number(e.target.value))}
              aria-label="Crumple squash"
              className="h-1.5 w-full cursor-pointer accent-current"
            />
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={state.squash.toFixed(2)}
              onChange={(e) => onSquash(Number(e.target.value))}
              aria-label="Crumple squash value"
              className="h-8 w-14 rounded-md bg-surface-2 px-1.5 text-right font-display text-xs tabular-nums text-fg shadow-[var(--shadow-border)]"
            />
          </label>
          <label className="flex min-w-[11rem] flex-1 items-center gap-2 px-2">
            <span className="shrink-0 font-display text-[0.65rem] uppercase tracking-[0.14em] text-subtle">
              Buckle
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={state.buckle}
              onChange={(e) => onBuckle(Number(e.target.value))}
              aria-label="Panel buckle"
              className="h-1.5 w-full cursor-pointer accent-current"
            />
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={state.buckle.toFixed(2)}
              onChange={(e) => onBuckle(Number(e.target.value))}
              aria-label="Panel buckle value"
              className="h-8 w-14 rounded-md bg-surface-2 px-1.5 text-right font-display text-xs tabular-nums text-fg shadow-[var(--shadow-border)]"
            />
          </label>
          <label className="flex min-w-[11rem] flex-1 items-center gap-2 px-2">
            <span className="shrink-0 font-display text-[0.65rem] uppercase tracking-[0.14em] text-subtle">
              FX
            </span>
            <input
              type="range"
              min={0}
              max={1.2}
              step={0.01}
              value={state.fxDensity}
              onChange={(e) => onFxDensity(Number(e.target.value))}
              aria-label="Particle density"
              className="h-1.5 w-full cursor-pointer accent-current"
            />
            <input
              type="number"
              min={0}
              max={1.2}
              step={0.01}
              value={state.fxDensity.toFixed(2)}
              onChange={(e) => onFxDensity(Number(e.target.value))}
              aria-label="Particle density value"
              className="h-8 w-14 rounded-md bg-surface-2 px-1.5 text-right font-display text-xs tabular-nums text-fg shadow-[var(--shadow-border)]"
            />
          </label>
          <label className="flex min-w-[10rem] flex-1 items-center gap-2 px-2">
            <span className="shrink-0 font-display text-[0.65rem] uppercase tracking-[0.14em] text-subtle">
              Cars
            </span>
            <input
              type="range"
              min={1}
              max={32}
              step={1}
              value={state.carCount}
              onChange={(e) => onCarCount(Number(e.target.value))}
              aria-label="Number of cars"
              className="h-1.5 w-full cursor-pointer accent-current"
            />
            <input
              type="number"
              min={1}
              max={32}
              step={1}
              value={state.carCount}
              onChange={(e) => onCarCount(Number(e.target.value))}
              aria-label="Number of cars value"
              className="h-8 w-12 rounded-md bg-surface-2 px-1.5 text-right font-display text-xs tabular-nums text-fg shadow-[var(--shadow-border)]"
            />
          </label>
          <label className="flex min-w-[7.5rem] items-center gap-1 px-2">
            <span className="shrink-0 font-display text-[0.65rem] uppercase tracking-[0.14em] text-subtle">
              Min m/s
            </span>
            <input
              type="number"
              min={0}
              max={48}
              step={0.5}
              value={state.speedMin}
              onChange={(e) => onSpeedRange(Number(e.target.value), state.speedMax)}
              aria-label="Minimum spawn speed"
              className="h-8 w-14 rounded-md bg-surface-2 px-1.5 text-right font-display text-xs tabular-nums text-fg shadow-[var(--shadow-border)]"
            />
          </label>
          <label className="flex min-w-[7.5rem] items-center gap-1 px-2">
            <span className="shrink-0 font-display text-[0.65rem] uppercase tracking-[0.14em] text-subtle">
              Max m/s
            </span>
            <input
              type="number"
              min={0}
              max={48}
              step={0.5}
              value={state.speedMax}
              onChange={(e) => onSpeedRange(state.speedMin, Number(e.target.value))}
              aria-label="Maximum spawn speed"
              className="h-8 w-14 rounded-md bg-surface-2 px-1.5 text-right font-display text-xs tabular-nums text-fg shadow-[var(--shadow-border)]"
            />
          </label>
          <Button
            onClick={onToggleCapture}
            variant={state.captureTrace ? "default" : "ghost"}
            aria-pressed={state.captureTrace}
            aria-label="Toggle JSON trace capture"
          >
            <Braces />
            <span className="hidden sm:inline">{state.captureTrace ? "JSON on" : "JSON off"}</span>
          </Button>
          <Button
            onClick={() => {
              void Promise.resolve(onCopyTrace()).then((ok) => {
                if (!ok) return;
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1600);
              });
            }}
            variant="secondary"
            aria-label="Copy spawn JSON"
          >
            <ClipboardCopy />
            {copied ? "Copied" : `JSON ${state.traceSamples}`}
          </Button>
          <p className="ml-auto hidden items-center gap-1 pr-2 text-xs text-subtle md:flex">
            <Gauge className="size-3.5" />
            Space pause · R reset · L loop · B wall · K balls · G rig · O orbit · M slomo · U audio · Y shape · J json
          </p>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  align = "left",
}: {
  label: string;
  value: string;
  align?: "left" | "right";
}) {
  return (
    <div className={cn("rounded-xl bg-surface/80 px-3 py-2 shadow-[var(--shadow-border)]", align === "right" && "text-right")}>
      <p className="font-display text-[0.65rem] uppercase tracking-[0.16em] text-subtle">{label}</p>
      <p className="font-display text-lg font-semibold tabular-nums leading-none sm:text-xl">{value}</p>
    </div>
  );
}
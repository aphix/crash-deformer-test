import { useEffect, useState, type ReactNode } from "react";
import * as Accordion from "@radix-ui/react-accordion";
import {
  Braces,
  ChevronDown,
  CircleDashed,
  ClipboardCopy,
  CloudRain,
  Moon,
  Orbit,
  Repeat,
  Spline,
  Timer,
  Undo2,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { HudProps } from "@/components/hud";
import { CLASSES, VEHICLE_CLASS_IDS } from "@/game/vehicle-classes";
import { Button } from "@/components/ui/button";
import { FX_TIERS } from "@/game/engine-post";
import { INITIAL_HUD, KNOB_RANGES, STROKE_RANGE_M, squashForStroke, strokeAt56 } from "@/game/hud-store";
import { useStoredString } from "@/components/use-stored-string";
import { cn } from "@/lib/utils";

type SectionId = "playback" | "driving" | "tuning" | "debug";

/** Number boxes and the time-scale field: 44 px tall on phones, 32 px from `sm`. */
const FIELD =
  "h-11 w-14 shrink-0 rounded-md bg-surface-2 px-1.5 text-right font-display text-xs tabular-nums text-fg shadow-[var(--shadow-border)] sm:h-8";
/** Option buttons inside a segmented track. */
const SEGMENT = "h-10 px-1 text-xs sm:h-7";
const TRACK = "grid flex-1 gap-0.5 rounded-md bg-surface-2 p-0.5";

export function HudSections(props: HudProps) {
  // Every section starts closed: the 3D view comes first, settings are a click away.
  const [open, setOpen] = useStoredString("crush.hud.sections", "", "");
  return (
    <Accordion.Root
      type="multiple"
      value={open.split(",").filter(Boolean)}
      onValueChange={(v) => setOpen(v.join(","))}
      className="hud-panel hud-settings pointer-events-auto divide-y divide-border self-end overflow-y-auto"
      style={{ gridArea: "settings" }}
    >
      <Section id="playback" title="Playback">
        <PlaybackSection {...props} />
      </Section>
      <Section id="driving" title="Driving">
        <DrivingSection {...props} />
      </Section>
      <Section id="tuning" title="Cars & crash">
        <TuningSection {...props} />
      </Section>
      <Section id="debug" title="Debug views">
        <DebugSection {...props} />
      </Section>
    </Accordion.Root>
  );
}

function Section({ id, title, children }: { id: SectionId; title: string; children: ReactNode }) {
  return (
    <Accordion.Item value={id}>
      <Accordion.Header>
        <Accordion.Trigger
          data-hud-section={id}
          className="group flex h-11 w-full items-center justify-between rounded-lg px-2 font-display text-xs font-medium uppercase tracking-[0.16em] text-muted transition-colors duration-[var(--motion-quick)] hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:text-fg sm:h-8"
        >
          {title}
          <ChevronDown className="size-4 transition-transform duration-[var(--motion-fast)] ease-[var(--ease-out)] group-data-[state=open]:rotate-180" />
        </Accordion.Trigger>
      </Accordion.Header>
      <Accordion.Content className="space-y-1.5 px-2 pb-2">{children}</Accordion.Content>
    </Accordion.Item>
  );
}

/** On/off chip: filled when on, like every other toggle in the HUD. */
function Toggle({ on, label, onClick, children }: { on: boolean; label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Button
      onClick={onClick}
      variant={on ? "default" : "ghost"}
      aria-pressed={on}
      aria-label={label}
      className="h-11 justify-start gap-1.5 px-1.5 text-xs sm:h-8"
    >
      {children}
    </Button>
  );
}

function SliderField({
  label,
  name,
  title,
  value,
  min,
  max,
  step,
  digits,
  onValue,
}: {
  label: string;
  name: string;
  /** Hover help for the whole row. */
  title?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  digits: number;
  onValue: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-2" title={title}>
      <span className="hud-label w-12 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onValue(Number(e.target.value))}
        aria-label={name}
        className="h-11 w-full min-w-0 cursor-pointer accent-current sm:h-6"
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value.toFixed(digits)}
        onChange={(e) => onValue(Number(e.target.value))}
        aria-label={`${name} value`}
        className={FIELD}
      />
    </label>
  );
}

function PlaybackSection({
  state,
  onToggleLoop,
  onToggleSlomo,
  onToggleOrbit,
  onToggleAudio,
  onTimeScale,
  onFxTier,
  onToggleNight,
  onToggleWet,
}: HudProps) {
  const [scaleText, setScaleText] = useState("");

  useEffect(() => {
    setScaleText(state.userTimeScale == null ? "" : String(state.userTimeScale));
  }, [state.userTimeScale]);

  return (
    <>
      <div className="grid grid-cols-3 gap-1">
        <Toggle on={state.looping} label="Toggle loop" onClick={onToggleLoop}>
          <Repeat />
          Loop
        </Toggle>
        <Toggle on={state.autoSlomo} label="Toggle impact slow-motion" onClick={onToggleSlomo}>
          <Timer />
          Slow-mo
        </Toggle>
        <Toggle on={state.autoRotate} label="Toggle camera auto-rotate" onClick={onToggleOrbit}>
          <Orbit />
          Orbit
        </Toggle>
        <Toggle on={state.audioOn} label="Toggle crash audio" onClick={onToggleAudio}>
          {state.audioOn ? <Volume2 /> : <VolumeX />}
          Audio
        </Toggle>
        <Toggle on={state.night} label="Toggle night lighting" onClick={onToggleNight}>
          <Moon />
          Night
        </Toggle>
        <Toggle on={state.wet} label="Toggle wet asphalt" onClick={onToggleWet}>
          <CloudRain />
          Wet
        </Toggle>
      </div>
      <div className="flex items-center gap-2">
        <span className="hud-label w-12 shrink-0">FX</span>
        <div
          className={TRACK}
          style={{ gridTemplateColumns: `repeat(${FX_TIERS.length}, minmax(0, 1fr))` }}
          role="group"
          aria-label="Cinematic FX quality"
        >
          {FX_TIERS.map((tier) => (
            <Button
              key={tier}
              className={cn(SEGMENT, "capitalize")}
              variant={state.fxTier === tier ? "default" : "ghost"}
              aria-pressed={state.fxTier === tier}
              aria-label={`Cinematic FX ${tier}`}
              onClick={() => onFxTier(tier)}
            >
              {tier}
            </Button>
          ))}
        </div>
      </div>
      <label className="flex items-center gap-2">
        <span className="hud-label w-12 shrink-0">Time</span>
        <span className="flex-1 text-xs text-muted">Fixed scale; clear for auto</span>
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
          className={FIELD}
        />
      </label>
    </>
  );
}

function TuningSection({
  state,
  onCarCount,
  onSpeedRange,
  onSquash,
  onBuckle,
  onFxDensity,
  onToggleDeformMode,
  onDefaults,
}: HudProps) {
  return (
    <>
      <SliderField label="Cars" name="Number of cars" value={state.carCount} min={1} max={32} step={1} digits={0} onValue={onCarCount} />
      <div className="flex items-center gap-2">
        <span className="hud-label w-12 shrink-0">Spawn</span>
        <span className="flex-1 text-xs text-muted">m/s</span>
        <input
          type="number"
          min={0}
          max={48}
          step={0.5}
          value={state.speedMin}
          onChange={(e) => onSpeedRange(Number(e.target.value), state.speedMax)}
          aria-label="Minimum spawn speed"
          className={FIELD}
        />
        <span className="text-xs text-muted">to</span>
        <input
          type="number"
          min={0}
          max={48}
          step={0.5}
          value={state.speedMax}
          onChange={(e) => onSpeedRange(state.speedMin, Number(e.target.value))}
          aria-label="Maximum spawn speed"
          className={FIELD}
        />
      </div>
      <SliderField
        label="Stroke"
        name="Crush stroke @56 km/h (m)"
        title={`Crush stroke @56 km/h: how far a full-width 56 km/h barrier hit pushes the nose in, in metres. Real cars take 0.35–0.55 m; 0.45–0.55 m here keeps every scored crash in its measured real band. Default ${strokeAt56(INITIAL_HUD.squash).toFixed(2)} m.`}
        value={strokeAt56(state.squash)}
        min={STROKE_RANGE_M.min}
        max={STROKE_RANGE_M.max}
        step={0.01}
        digits={2}
        onValue={(m) => onSquash(squashForStroke(m))}
      />
      <SliderField
        label="Wrinkle"
        name="Panel wrinkle"
        title="Panel wrinkle: size of the sheet-metal folds drawn around a dent. Visual only — crush depth changes by under 3 cm across the range."
        value={state.buckle}
        min={KNOB_RANGES.buckle.min}
        max={KNOB_RANGES.buckle.max}
        step={0.01}
        digits={2}
        onValue={onBuckle}
      />
      <SliderField label="FX" name="Particle density" value={state.fxDensity} min={0} max={1.2} step={0.01} digits={2} onValue={onFxDensity} />
      <div className="flex items-center gap-2">
        <span className="hud-label w-12 shrink-0">Solver</span>
        <div className={cn(TRACK, "grid-cols-2")} role="group" aria-label="Deformer">
          {(["shape", "lattice"] as const).map((mode) => (
            <Button
              key={mode}
              className={SEGMENT}
              variant={state.deformMode === mode ? "default" : "ghost"}
              aria-pressed={state.deformMode === mode}
              aria-label={mode === "shape" ? "Shape-matching deformer" : "Lattice deformer"}
              onClick={() => {
                if (state.deformMode !== mode) onToggleDeformMode();
              }}
            >
              {mode === "shape" ? "Shape" : "Lattice"}
            </Button>
          ))}
        </div>
      </div>
      <Button
        onClick={onDefaults}
        variant="secondary"
        className="h-11 w-full text-xs sm:h-8"
        aria-label="Reset all settings to defaults"
      >
        <Undo2 />
        Defaults
      </Button>
    </>
  );
}

function DebugSection({ state, onToggleRig, onToggleParticles, onToggleCapture, onCopyTrace }: HudProps) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <p className="hud-label">
        {state.sensorCount} sensors · {state.cageCount} cages
      </p>
      <div className="grid grid-cols-2 gap-1">
        <Toggle on={state.showRig} label="Toggle deformation rig" onClick={onToggleRig}>
          <Spline />
          Rig
        </Toggle>
        <Toggle on={state.showParticles} label="Toggle control particles" onClick={onToggleParticles}>
          <CircleDashed />
          Particles
        </Toggle>
        <Toggle on={state.captureTrace} label="Toggle JSON trace capture" onClick={onToggleCapture}>
          <Braces />
          Capture
        </Toggle>
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
          className="h-11 justify-start gap-1.5 px-1.5 text-xs sm:h-8"
        >
          <ClipboardCopy />
          {copied ? "Copied" : `JSON ${state.traceSamples}`}
        </Button>
      </div>
    </>
  );
}

/** Class of the player's car and the one arcade ↔ realistic axis (assists, grip, when damage kills). */
function DrivingSection({ state, onPlayerClass, onRealism }: HudProps) {
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="hud-label w-12 shrink-0">Car</span>
        <div className={cn(TRACK, "grid-cols-4")} role="group" aria-label="Your car's class">
          {VEHICLE_CLASS_IDS.map((id) => (
            <Button
              key={id}
              className={SEGMENT}
              variant={state.playerClass === id ? "default" : "ghost"}
              aria-pressed={state.playerClass === id}
              onClick={() => onPlayerClass(id)}
            >
              {CLASSES[id].label}
            </Button>
          ))}
        </div>
      </div>
      <SliderField
        label="Realism"
        name="Arcade to realistic handling and damage"
        value={state.realism}
        min={KNOB_RANGES.realism.min}
        max={KNOB_RANGES.realism.max}
        step={0.05}
        digits={2}
        onValue={onRealism}
      />
      <div className="flex justify-between pl-14 pr-16 text-xs text-muted" aria-hidden>
        <span>Arcade</span>
        <span>Realistic</span>
      </div>
    </>
  );
}

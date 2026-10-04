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
import { FIELD, NumberField, RangeRow } from "@/components/hud-controls";
import type { CrashEngine } from "@/game/engine/engine";
import { CLASSES, VEHICLE_CLASS_IDS } from "@/game/vehicle/vehicle-classes";
import { Button } from "@/components/ui/button";
import { FX_TIERS } from "@/game/present/engine-post";
import { INITIAL_HUD, KNOB_RANGES, STROKE_RANGE_M, squashForStroke, strokeAt56 } from "@/game/hud/hud-store";
import { useStoredString } from "@/components/use-stored-string";
import { cn } from "@/lib/utils";

type SectionId = "playback" | "driving" | "tuning" | "debug";

/** Option buttons inside a segmented track. Five-option tracks wrap at three per row: one row of five overflows the panel. */
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
      className="hud-panel hud-settings pointer-events-auto divide-y divide-border self-end overflow-y-auto idle:hidden"
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

function PlaybackSection({ state, engine }: HudProps) {
  const [scaleText, setScaleText] = useState("");

  useEffect(() => {
    setScaleText(state.userTimeScale == null ? "" : String(state.userTimeScale));
  }, [state.userTimeScale]);

  return (
    <>
      <div className="grid grid-cols-3 gap-1">
        <Toggle on={state.looping} label="Toggle loop" onClick={() => engine.current?.toggleLoop()}>
          <Repeat />
          Loop
        </Toggle>
        <Toggle on={state.autoSlomo} label="Toggle impact slow-motion" onClick={() => engine.current?.toggleSlomo()}>
          <Timer />
          Slow-mo
        </Toggle>
        <Toggle on={state.autoRotate} label="Toggle camera auto-rotate" onClick={() => engine.current?.toggleOrbit()}>
          <Orbit />
          Orbit
        </Toggle>
        <Toggle on={state.audioOn} label="Toggle crash audio" onClick={() => engine.current?.toggleAudio()}>
          {state.audioOn ? <Volume2 /> : <VolumeX />}
          Audio
        </Toggle>
        <Toggle on={state.night} label="Toggle night lighting" onClick={() => engine.current?.setNight(!state.night)}>
          <Moon />
          Night
        </Toggle>
        <Toggle on={state.wet} label="Toggle wet asphalt" onClick={() => engine.current?.setWet(!state.wet)}>
          <CloudRain />
          Wet
        </Toggle>
      </div>
      <div className="flex items-center gap-2">
        <span className="hud-label w-12 shrink-0">FX</span>
        <div className={cn(TRACK, "grid-cols-3")} role="group" aria-label="Cinematic FX quality">
          {FX_TIERS.map((tier) => (
            <Button
              key={tier}
              className={cn(SEGMENT, "capitalize")}
              variant={state.fxTier === tier ? "default" : "ghost"}
              aria-pressed={state.fxTier === tier}
              aria-label={`Cinematic FX ${tier}`}
              onClick={() => engine.current?.setFxTier(tier)}
            >
              {tier}
            </Button>
          ))}
          <Button
            className={SEGMENT}
            variant={state.fxAuto ? "default" : "ghost"}
            aria-pressed={state.fxAuto}
            aria-label="Cinematic FX automatic"
            title="Picks the tier from the frame rate; a race runs minimal"
            onClick={() => engine.current?.setFxAuto()}
          >
            Auto
          </Button>
        </div>
      </div>
      {/* The cel look is part of the post chain: low / high only (minimal and off draw straight to the canvas). */}
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <RangeRow
            label="Cel"
            name="Cel look strength"
            title="Cel look held on at this strength; the scene-switch pulse still plays over it"
            value={state.celLook ?? 0}
            min={KNOB_RANGES.cel.min}
            max={KNOB_RANGES.cel.max}
            step={0.01}
            shown={state.celLook === null ? "auto" : `${Math.round(state.celLook * 100)}%`}
            disabled={state.fxTier === "off" || state.fxTier === "minimal"}
            onValue={(v) => engine.current?.setCelLook(v)}
          />
        </div>
        <Button
          className="h-11 shrink-0 px-2 text-xs sm:h-8"
          variant={state.celLook === null ? "default" : "ghost"}
          aria-pressed={state.celLook === null}
          aria-label="Cel look automatic"
          title="Cel look only during the scene-switch pulse"
          onClick={() => engine.current?.setCelLook(null)}
        >
          Auto
        </Button>
      </div>
      {state.fxTier === "off" || state.fxTier === "minimal" ? <p className="hud-label">Cel look needs FX low or high (a race runs minimal on Auto)</p> : null}
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
            if (raw.trim() === "") engine.current?.setTimeScale(null);
          }}
          onBlur={() => {
            if (scaleText.trim() === "") {
              engine.current?.setTimeScale(null);
              return;
            }
            const n = Number(scaleText);
            if (Number.isFinite(n)) engine.current?.setTimeScale(n);
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

function TuningSection({ state, engine }: HudProps) {
  // Only the fleet and the corkscrew launch their cars at a spawn speed; every other scene places its own.
  const launched = !state.race && !state.derby && !state.showCompactor && !state.showPistons && !state.showDoors && !state.range;
  return (
    <>
      <RangeRow label="Cars" name="Number of cars" value={state.carCount} min={1} max={32} step={1} digits={0} onValue={(n) => engine.current?.setCarCount(n)} />
      {launched ? (
        <div className="flex items-center gap-2">
          <span className="hud-label w-12 shrink-0">Spawn</span>
          <span className="flex-1 text-xs text-muted">m/s</span>
          {/* Each box live-commits only inside the other's bound, so typing never re-sorts the pair under the user. */}
          <NumberField
            value={state.speedMin}
            digits={1}
            min={0}
            max={state.speedMax}
            step={0.5}
            label="Minimum spawn speed"
            onValue={(n) => engine.current?.setSpeedRange(n, state.speedMax)}
          />
          <span className="text-xs text-muted">to</span>
          <NumberField
            value={state.speedMax}
            digits={1}
            min={state.speedMin}
            max={KNOB_RANGES.speed.max}
            step={0.5}
            label="Maximum spawn speed"
            onValue={(n) => engine.current?.setSpeedRange(state.speedMin, n)}
          />
        </div>
      ) : null}
      <RangeRow
        label="Stroke"
        name="Crush stroke @56 km/h (m)"
        title={`Crush stroke @56 km/h: how far a full-width 56 km/h barrier hit pushes the nose in, in metres. Real cars take 0.35–0.55 m; 0.45–0.55 m here keeps every scored crash in its measured real band. Default ${strokeAt56(INITIAL_HUD.squash).toFixed(2)} m.`}
        value={strokeAt56(state.squash)}
        min={STROKE_RANGE_M.min}
        max={STROKE_RANGE_M.max}
        step={0.01}
        digits={2}
        onValue={(m) => engine.current?.setSquash(squashForStroke(m))}
      />
      <RangeRow
        label="Wrinkle"
        name="Panel wrinkle"
        title="Panel wrinkle: size of the sheet-metal folds drawn around a dent. Visual only — crush depth changes by under 3 cm across the range."
        value={state.buckle}
        min={KNOB_RANGES.buckle.min}
        max={KNOB_RANGES.buckle.max}
        step={0.01}
        digits={2}
        onValue={(v) => engine.current?.setBuckle(v)}
      />
      <RangeRow label="FX" name="Particle density" value={state.fxDensity} min={KNOB_RANGES.fxDensity.min} max={KNOB_RANGES.fxDensity.max} step={0.01} digits={2} onValue={(v) => engine.current?.setFxDensity(v)} />
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
                if (state.deformMode !== mode) engine.current?.toggleDeformMode();
              }}
            >
              {mode === "shape" ? "Shape" : "Lattice"}
            </Button>
          ))}
        </div>
      </div>
      <Button
        onClick={() => engine.current?.resetDefaults()}
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

/** Spawn JSON to the clipboard; a hidden textarea and `execCommand` where the async clipboard is refused. */
async function copyTrace(engine: CrashEngine | null): Promise<boolean> {
  const json = engine?.copyTraceJson();
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
}

function DebugSection({ state, engine }: HudProps) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <p className="hud-label">
        {state.sensorCount} sensors · {state.cageCount} cages
      </p>
      <div className="grid grid-cols-2 gap-1">
        <Toggle on={state.showRig} label="Toggle deformation rig" onClick={() => engine.current?.toggleRig()}>
          <Spline />
          Rig
        </Toggle>
        <Toggle on={state.showParticles} label="Toggle control particles" onClick={() => engine.current?.toggleParticles()}>
          <CircleDashed />
          Particles
        </Toggle>
        <Toggle on={state.captureTrace} label="Toggle JSON trace capture" onClick={() => engine.current?.toggleCapture()}>
          <Braces />
          Capture
        </Toggle>
        <Button
          onClick={() => {
            void copyTrace(engine.current).then((ok) => {
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
function DrivingSection({ state, engine }: HudProps) {
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="hud-label w-12 shrink-0">Car</span>
        <div className={cn(TRACK, "grid-cols-3")} role="group" aria-label="Your car's class">
          {VEHICLE_CLASS_IDS.map((id) => (
            <Button
              key={id}
              className={SEGMENT}
              variant={state.playerClass === id ? "default" : "ghost"}
              aria-pressed={state.playerClass === id}
              onClick={() => engine.current?.setPlayerClass(id)}
            >
              {CLASSES[id].label}
            </Button>
          ))}
        </div>
      </div>
      <RangeRow
        label="Realism"
        name="Arcade to realistic handling and damage"
        value={state.realism}
        min={KNOB_RANGES.realism.min}
        max={KNOB_RANGES.realism.max}
        step={0.05}
        digits={2}
        onValue={(v) => engine.current?.setRealism(v)}
      />
      <div className="flex justify-between pl-14 pr-16 text-xs text-muted" aria-hidden>
        <span>Arcade</span>
        <span>Realistic</span>
      </div>
    </>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import * as Accordion from "@radix-ui/react-accordion";
import {
  Braces,
  ChevronDown,
  CircleDashed,
  ClipboardCopy,
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

type SectionId = "playback" | "driving" | "tuning" | "debug";
const SECTIONS_KEY = "crush.hud.sections";
const FIELD = "h-10 w-16 shrink-0 rounded-md bg-surface-2 px-2 text-right font-display text-xs tabular-nums text-fg shadow-[var(--shadow-border)]";

/** Open sections survive reloads; first visit opens tuning on wide screens, nothing on phones. */
function useOpenSections(): [SectionId[], (next: SectionId[]) => void] {
  const [open, setOpen] = useState<SectionId[]>([]);
  useEffect(() => {
    const saved = window.localStorage.getItem(SECTIONS_KEY);
    if (saved != null) setOpen(saved.split(",").filter(Boolean) as SectionId[]);
    else if (window.matchMedia("(min-width: 768px)").matches) setOpen(["tuning"]);
  }, []);
  return [
    open,
    (next) => {
      setOpen(next);
      window.localStorage.setItem(SECTIONS_KEY, next.join(","));
    },
  ];
}

export function HudSections(props: HudProps) {
  const [open, setOpen] = useOpenSections();
  return (
    <Accordion.Root
      type="multiple"
      value={open}
      onValueChange={(v) => setOpen(v as SectionId[])}
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
          className="group flex h-11 w-full items-center justify-between rounded-xl px-3 font-display text-xs font-medium uppercase tracking-[0.16em] text-muted transition-colors duration-[var(--motion-quick)] hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:text-fg"
        >
          {title}
          <ChevronDown className="size-4 transition-transform duration-[var(--motion-fast)] ease-[var(--ease-out)] group-data-[state=open]:rotate-180" />
        </Accordion.Trigger>
      </Accordion.Header>
      <Accordion.Content className="space-y-2 px-3 pb-3">{children}</Accordion.Content>
    </Accordion.Item>
  );
}

/** On/off chip: filled when on, like every other toggle in the HUD. */
function Toggle({ on, label, onClick, children }: { on: boolean; label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Button onClick={onClick} variant={on ? "default" : "ghost"} aria-pressed={on} aria-label={label} className="justify-start">
      {children}
    </Button>
  );
}

function SliderField({
  label,
  name,
  value,
  min,
  max,
  step,
  digits,
  onValue,
}: {
  label: string;
  name: string;
  value: number;
  min: number;
  max: number;
  step: number;
  digits: number;
  onValue: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="hud-label w-14 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onValue(Number(e.target.value))}
        aria-label={name}
        className="h-10 w-full min-w-0 cursor-pointer accent-current"
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

function PlaybackSection({ state, onToggleLoop, onToggleSlomo, onToggleOrbit, onToggleAudio, onTimeScale }: HudProps) {
  const [scaleText, setScaleText] = useState("");

  useEffect(() => {
    setScaleText(state.userTimeScale == null ? "" : String(state.userTimeScale));
  }, [state.userTimeScale]);

  return (
    <>
      <div className="grid grid-cols-2 gap-2">
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
      </div>
      <label className="flex items-center gap-2">
        <span className="hud-label w-14 shrink-0">Time</span>
        <span className="flex-1 text-xs text-subtle">Fixed scale; clear for auto</span>
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
        <span className="hud-label w-14 shrink-0">Spawn</span>
        <span className="flex-1 text-xs text-subtle">m/s</span>
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
        <span className="text-xs text-subtle">to</span>
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
      <SliderField label="Squash" name="Crumple squash" value={state.squash} min={0} max={1} step={0.01} digits={2} onValue={onSquash} />
      <SliderField label="Buckle" name="Panel buckle" value={state.buckle} min={0} max={1} step={0.01} digits={2} onValue={onBuckle} />
      <SliderField label="FX" name="Particle density" value={state.fxDensity} min={0} max={1.2} step={0.01} digits={2} onValue={onFxDensity} />
      <div className="flex items-center gap-2">
        <span className="hud-label w-14 shrink-0">Solver</span>
        <div className="grid flex-1 grid-cols-2 gap-1 rounded-lg bg-surface-2 p-1" role="group" aria-label="Deformer">
          {(["shape", "lattice"] as const).map((mode) => (
            <Button
              key={mode}
              size="sm"
              className="h-10"
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
      <Button onClick={onDefaults} variant="secondary" className="w-full" aria-label="Reset all settings to defaults">
        <Undo2 />
        Defaults
      </Button>
    </>
  );
}

function DebugSection({ state, onToggleRig, onToggleParticles, onToggleCapture, onCopyTrace }: HudProps) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid grid-cols-2 gap-2">
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
        className="justify-start"
      >
        <ClipboardCopy />
        {copied ? "Copied" : `JSON ${state.traceSamples}`}
      </Button>
    </div>
  );
}

/** Class of the player's car and the one arcade ↔ realistic axis (assists, grip, when damage kills). */
function DrivingSection({ state, onPlayerClass, onRealism }: HudProps) {
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="hud-label w-14 shrink-0">Car</span>
        <div className="grid flex-1 grid-cols-4 gap-1 rounded-lg bg-surface-2 p-1" role="group" aria-label="Your car's class">
          {VEHICLE_CLASS_IDS.map((id) => (
            <Button
              key={id}
              size="sm"
              className="h-10 px-1"
              variant={state.playerClass === id ? "default" : "ghost"}
              aria-pressed={state.playerClass === id}
              onClick={() => onPlayerClass(id)}
            >
              {CLASSES[id].label}
            </Button>
          ))}
        </div>
      </div>
      <SliderField label="Realism" name="Arcade to realistic handling and damage" value={state.realism} min={0} max={1} step={0.05} digits={2} onValue={onRealism} />
      <div className="flex justify-between pl-16 text-xs text-subtle" aria-hidden>
        <span>Arcade: assists, takes hits</span>
        <span>Real: sourced kill band</span>
      </div>
    </>
  );
}

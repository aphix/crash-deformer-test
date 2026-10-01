import * as Popover from "@radix-ui/react-popover";
import {
  BrickWall,
  CarFront,
  CircleDot,
  CircleHelp,
  Crosshair,
  DoorOpen,
  FoldHorizontal,
  Pause,
  Play,
  RotateCcw,
  Trophy,
} from "lucide-react";
import { DerbyBoard, DoorPanel, PistonPanel } from "@/components/hud-panels";
import { HudSections } from "@/components/hud-sections";
import { Button } from "@/components/ui/button";
import type { DoorScenario } from "@/game/door-rig";
import type { CrashHudState, DoorHud } from "@/game/hud-store";
import type { PistonConfig } from "@/game/piston-rig";
import { cn } from "@/lib/utils";

export type HudProps = {
  state: CrashHudState;
  onReset: () => void;
  onTogglePlay: () => void;
  onToggleLoop: () => void;
  onToggleRig: () => void;
  onToggleParticles: () => void;
  onToggleBarrier: () => void;
  onToggleBalls: () => void;
  onToggleCompactor: () => void;
  onTogglePistons: () => void;
  /** 0–7 one ram (key order), 8 all. */
  onFirePiston: (index: number) => void;
  onPistonConfig: (patch: Partial<PistonConfig>) => void;
  onToggleDoors: () => void;
  onFireDoor: (scenario: DoorScenario) => void;
  onDoorConfig: (patch: Partial<Pick<DoorHud, "kph" | "kg" | "side">>) => void;
  onToggleDoorOpen: () => void;
  onToggleDerby: () => void;
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

const STAGE: Record<CrashHudState["compactStage"], string> = {
  open: "open",
  contact: "crush zone",
  wells: "wheel wells",
  mid: "past hubs",
  max: "max crush",
};

const VIEW: Record<CrashHudState["view"], string> = { third: "Chase cam", far: "Far chase", first: "Hood cam" };

/** Fleet is "none of the others": the engine keeps derby, press, pistons and doors mutually exclusive. */
type Scene = "fleet" | "derby" | "press" | "pistons" | "doors";
const SCENES = [
  { id: "fleet", label: "Fleet", aria: "Fleet scene", Icon: CarFront },
  { id: "derby", label: "Derby", aria: "Demolition derby scene", Icon: Trophy },
  { id: "press", label: "Press", aria: "Car compactor scene", Icon: FoldHorizontal },
  { id: "pistons", label: "Pistons", aria: "Piston rig scene", Icon: Crosshair },
  { id: "doors", label: "Doors", aria: "Door and mirror knock scene", Icon: DoorOpen },
] as const;

const SCENE_KEYS: [string, string][] = [
  ["Space", "Pause / play"],
  ["R", "Reset"],
  ["L", "Loop"],
  ["D", "Derby"],
  ["C", "Press"],
  ["I", "Pistons"],
  ["1–8 · 0", "Fire ram · all"],
  ["N", "Doors"],
  ["1–3 · 4 · 5", "Door ram A–C · open · side"],
  ["B", "Wall"],
  ["K", "Balls"],
  ["M", "Slow-mo"],
  ["O", "Orbit"],
  ["U", "Audio"],
  ["Y", "Shape / lattice"],
  ["G", "Rig"],
  ["P", "Particles"],
  ["J", "JSON capture"],
];

const CAMERA_KEYS: [string, string][] = [
  ["Click · Q / E", "Follow a car"],
  ["W A S D", "Take the wheel"],
  ["Esc", "Step back out"],
  ["Drag · scroll", "Orbit camera"],
];

function seatHint(state: CrashHudState): { title: string; keys: string } {
  if (state.seat === "drive") {
    return {
      title: `Driving · ${VIEW[state.view]}`,
      keys: state.pad
        ? "RT gas · LT brake, then reverse · left stick steer · A handbrake · X boost · Y view · right stick look · LB/RB car · D-pad ↓ recover · Back watch"
        : "W gas · S brake, then reverse · A/D steer · Space handbrake · Shift boost · drag look · V view · R recover · Esc watch",
    };
  }
  if (state.seat === "follow") {
    return {
      title: "Watching",
      keys: state.pad ? "RT, LT or left stick to drive · LB/RB switch car · Back exit" : "W/A/S/D to drive · Q/E switch car · Esc back",
    };
  }
  return { title: "Whole field", keys: "LB/RB to pick a car" };
}

export function Hud(props: HudProps) {
  const { state } = props;
  return (
    <div className="hud-grid pointer-events-none absolute inset-0 p-3 text-fg sm:p-6">
      <header className="min-w-0" style={{ gridArea: "title" }}>
        <p className="font-display text-xs font-medium uppercase tracking-[0.22em] text-muted">Streamed deformation</p>
        <h1 className="mt-1 font-display text-3xl font-semibold leading-none tracking-tight text-balance sm:text-4xl">
          Crush Stream
        </h1>
        <p className="mt-2 hidden max-w-xs text-pretty text-sm leading-snug text-muted sm:block">
          {state.derby
            ? "Demolition derby. Engine kill is a disable. Last car with a living block wins."
            : state.showCompactor
              ? "One car, two steel plates. They close square to the chassis — bumper, wheel-well, then the cage."
              : state.showPistons
                ? "One parked car, eight rams: corners at 45°, mids square to each side. 1–8 fire one, 0 fires all."
                : state.showDoors
                  ? "One parked car, one ram down its side. A clips the mirror, B forces the open door past its stop, C swings it shut."
                  : state.carCount <= 2
                    ? "Cars lock onto the pad. Control particles shape-match the mesh — Müller 2005, with the lattice still a toggle."
                    : `${state.carCount} cars on the pad. Same crumple rules, now a pile-up.`}
        </p>
      </header>

      <Readouts state={state} />

      <div className="flex min-h-0 flex-col items-start" style={{ gridArea: "context" }}>
        {state.showPistons ? (
          <PistonPanel pistons={state.pistons} onFire={props.onFirePiston} onConfig={props.onPistonConfig} />
        ) : null}
        {state.showDoors ? (
          <DoorPanel
            doors={state.doors}
            onFire={props.onFireDoor}
            onConfig={props.onDoorConfig}
            onToggleOpen={props.onToggleDoorOpen}
          />
        ) : null}
        {state.derby && state.derbyBoard.length > 0 ? <DerbyBoard board={state.derbyBoard} /> : null}
      </div>

      <HudSections {...props} />

      <div className="flex min-w-0 flex-col items-start gap-3 self-end" style={{ gridArea: "dock" }}>
        {state.seat !== "global" || state.pad ? <DriveHint state={state} /> : null}
        <Dock {...props} />
      </div>

      {state.derbyWinner ? (
        <div className="pointer-events-none absolute inset-x-0 top-[38%] z-10 flex justify-center">
          <div className="rounded-2xl bg-surface/95 px-8 py-5 text-center shadow-[var(--shadow-border)]">
            <p className="font-display text-[0.7rem] uppercase tracking-[0.28em] text-muted">Winner</p>
            <p className="mt-1 font-display text-5xl font-semibold tracking-tight text-fg">{state.derbyWinner}</p>
            <p className="mt-2 text-sm text-muted">Last engine still running</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Every number the sim reports, in one corner. */
function Readouts({ state }: { state: CrashHudState }) {
  const press = state.showCompactor;
  const etaNote = state.eta > 0 && state.eta < 8 ? ` · ${state.eta.toFixed(1)}s` : "";
  return (
    <div className="hud-panel self-start p-3" style={{ gridArea: "readouts" }}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-3">
        <Readout
          label={press ? "Press gap" : state.carCount === 1 ? "Car" : "Lead"}
          value={press ? state.wallGap.toFixed(2) : (state.speedA * 3.6).toFixed(0)}
          unit={press ? "m" : "km/h"}
        />
        {press ? (
          <Readout label="Plate speed" value={state.closingKph.toFixed(0)} unit="km/h" />
        ) : state.carCount !== 2 ? (
          <Readout label={state.carCount === 1 ? "Solo" : "Fleet"} value={String(state.carCount)} unit={state.carCount === 1 ? "car" : "cars"} />
        ) : (
          <Readout label={state.phase === "approach" ? "Second" : "Second wreck"} value={(state.speedB * 3.6).toFixed(0)} unit="km/h" />
        )}
        {press ? (
          <Readout label="Stage" value={STAGE[state.compactStage]} />
        ) : state.impactKph != null ? (
          <Readout label="Impact" value={state.impactKph.toFixed(0)} unit="km/h" />
        ) : (
          <Readout label={`Closing${etaNote}`} value={state.closingKph.toFixed(0)} unit="km/h" />
        )}
        <Readout label="Time scale" value={state.timeScale.toFixed(2)} unit="×" />
        <Readout label="T+" value={state.elapsed.toFixed(2)} unit="s" />
        <Readout label="FPS" value={String(Math.round(state.fps))} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span
          className={cn(
            "rounded-full px-3 py-1 font-display text-[0.7rem] uppercase tracking-[0.16em] shadow-[var(--shadow-border)]",
            state.phase === "slowmo" || state.phase === "impact" ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted",
          )}
        >
          {state.derby ? (state.derbyWinner ? "Winner" : "Derby") : PHASE[state.phase]}
        </span>
        <span className="hud-label hidden tracking-[0.14em] sm:inline">
          {state.sensorCount} sensors · {state.cageCount} cages
        </span>
      </div>
    </div>
  );
}

function Readout({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="min-w-0">
      <p className="hud-label truncate">{label}</p>
      <p className="truncate font-display text-lg font-semibold leading-tight tabular-nums">
        {value}
        {unit ? <span className="ml-0.5 text-xs font-medium text-muted">{unit}</span> : null}
      </p>
    </div>
  );
}

/** Seat keys and the controller pill, stacked above the dock so it can never cover a control. */
function DriveHint({ state }: { state: CrashHudState }) {
  const { title, keys } = seatHint(state);
  return (
    <div className="hud-panel w-full max-w-xl px-4 py-2.5" role="status">
      <div className="flex items-center justify-between gap-3">
        <p className="font-display text-sm font-semibold uppercase tracking-[0.12em]">{title}</p>
        {state.pad ? (
          <span className="rounded-full bg-surface-2 px-3 py-1 font-display text-[0.7rem] uppercase tracking-[0.16em] text-muted shadow-[var(--shadow-border)]">
            {state.pad} connected
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted">{keys}</p>
      {state.seat === "drive" ? (
        <>
          <p className="mt-1 text-xs text-subtle">Reversing steers like a real car: left swings the tail left.</p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-label="Boost">
            <div className="h-full bg-accent" style={{ width: `${Math.round(state.boost * 100)}%` }} />
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Always-visible bar: play, reset, scene, the two fleet props, key help. */
function Dock(props: HudProps) {
  const { state, onTogglePlay, onReset, onToggleBarrier, onToggleBalls } = props;
  const scene: Scene = state.derby
    ? "derby"
    : state.showCompactor
      ? "press"
      : state.showPistons
        ? "pistons"
        : state.showDoors
          ? "doors"
          : "fleet";
  const toggleScene = {
    derby: props.onToggleDerby,
    press: props.onToggleCompactor,
    pistons: props.onTogglePistons,
    doors: props.onToggleDoors,
  };
  // Barrier and balls are fleet props; the engine ignores them while the press or a rig owns the pad.
  const propsLocked = state.showCompactor || state.showPistons || state.showDoors;
  return (
    <div className="hud-panel pointer-events-auto flex w-full flex-wrap items-center gap-2 p-2 md:w-auto">
      <Button onClick={onTogglePlay} aria-label={state.playing ? "Pause" : "Play"}>
        {state.playing ? <Pause /> : <Play className="ml-0.5" />}
        <span className="hidden sm:inline">{state.playing ? "Pause" : "Play"}</span>
      </Button>
      <Button onClick={onReset} variant="secondary" aria-label="Reset crash">
        <RotateCcw />
        <span className="hidden sm:inline">Reset</span>
      </Button>
      <div className="order-last grid w-full grid-cols-5 gap-1 sm:order-none sm:flex sm:w-auto" role="group" aria-label="Scene">
        {SCENES.map(({ id, label, aria, Icon }) => (
          <Button
            key={id}
            variant={scene === id ? "default" : "ghost"}
            aria-pressed={scene === id}
            aria-label={aria}
            className="max-sm:px-2"
            onClick={() => {
              if (id === scene) return;
              if (id === "fleet") toggleScene[scene as Exclude<Scene, "fleet">]();
              else toggleScene[id]();
            }}
          >
            <Icon className="max-sm:hidden" />
            {label}
          </Button>
        ))}
      </div>
      <Button
        onClick={onToggleBarrier}
        disabled={propsLocked}
        variant={state.showBarrier ? "default" : "ghost"}
        aria-pressed={state.showBarrier}
        aria-label="Toggle jersey barrier"
      >
        <BrickWall />
        <span className="hidden sm:inline">Wall</span>
      </Button>
      <Button
        onClick={onToggleBalls}
        disabled={propsLocked}
        variant={state.showBalls ? "default" : "ghost"}
        aria-pressed={state.showBalls}
        aria-label="Toggle ramp balls"
      >
        <CircleDot />
        <span className="hidden sm:inline">Balls</span>
      </Button>
      <KeyHelp />
    </div>
  );
}

function KeyHelp() {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="ghost" size="icon" className="ml-auto" aria-label="Keyboard shortcuts">
          <CircleHelp />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={12}
          collisionPadding={12}
          className="z-50 w-80 max-w-[calc(100vw-1.5rem)] rounded-xl bg-surface p-4 text-fg shadow-[var(--shadow-border)]"
        >
          <KeyList title="Scene" keys={SCENE_KEYS} />
          <KeyList title="Cars & camera" keys={CAMERA_KEYS} className="mt-4" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function KeyList({ title, keys, className }: { title: string; keys: [string, string][]; className?: string }) {
  return (
    <div className={className}>
      <p className="hud-label">{title}</p>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
        {keys.map(([key, action]) => (
          <div key={key} className="flex items-baseline gap-2 text-xs">
            <dt>
              <kbd className="rounded bg-surface-2 px-1.5 py-0.5 font-display text-[0.7rem] text-fg shadow-[var(--shadow-border)]">
                {key}
              </kbd>
            </dt>
            <dd className="text-muted">{action}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

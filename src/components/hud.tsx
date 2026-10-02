import type { RefObject } from "react";
import * as Popover from "@radix-ui/react-popover";
import { BrickWall, CircleDot, CircleHelp, Pause, Play, RotateCcw, SlidersHorizontal } from "lucide-react";
import { DerbyBoard, DoorPanel, PistonPanel } from "@/components/hud-panels";
import { HudSections } from "@/components/hud-sections";
import { RaceOverlay, RaceReadouts, RaceStandings, RaceViewToggle, SpectateBar } from "@/components/race-hud";
import { useStoredString } from "@/components/use-stored-string";
import { Button } from "@/components/ui/button";
import type { CrashEngine } from "@/game/engine";
import type { CrashHudState } from "@/game/hud-store";
import type { RaceCommand } from "@/game/race/types";
import { cn } from "@/lib/utils";

export type HudProps = {
  state: CrashHudState;
  /** The engine once booted (null before): controls call it directly. */
  engine: RefObject<CrashEngine | null>;
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

/** Fleet is "none of the others": the engine keeps derby, race, press, pistons and doors mutually exclusive. */
type Scene = "fleet" | "derby" | "race" | "press" | "pistons" | "doors";
const SCENES = [
  { id: "fleet", label: "Fleet", aria: "Fleet scene" },
  { id: "derby", label: "Derby", aria: "Demolition derby scene" },
  { id: "race", label: "Race", aria: "Race scene" },
  { id: "press", label: "Press", aria: "Car compactor scene" },
  { id: "pistons", label: "Pistons", aria: "Piston rig scene" },
  { id: "doors", label: "Doors", aria: "Door and mirror knock scene" },
] as const;

const SCENE_KEYS: [string, string][] = [
  ["Space", "Pause / play"],
  ["R", "Reset"],
  ["L", "Loop"],
  ["D", "Derby"],
  ["Z", "Race"],
  ["H", "In a race: race view · full menu"],
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
  if (state.race && state.seat === "drive") {
    return {
      title: `Racing · ${VIEW[state.view]}`,
      keys: state.pad
        ? "RT gas · LT brake, then reverse · left stick steer · A handbrake · X boost · Y view · D-pad ↓ respawn · Start pause"
        : "W gas · S brake, then reverse · A/D steer · Space handbrake · Shift boost · V view · R respawn · Esc pause",
    };
  }
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
  const { state, engine } = props;
  const raceCommand = (cmd: RaceCommand) => engine.current?.raceCommand(cmd);
  // Race focus view: race panels only; the sandbox HUD comes back with the Full menu toggle (H).
  const focus = state.race !== null && !state.race.fullUi;
  // Phones start with the settings tucked away; wide screens show the (collapsed) sections.
  const [settings, setSettings] = useStoredString("crush.hud.settings", "hidden", "shown");
  const settingsShown = settings === "shown";
  return (
    <div className="hud-grid pointer-events-none absolute inset-0 p-2 text-fg sm:p-4" data-focus={focus || undefined}>
      {focus && state.race ? (
        <header className="hud-ink min-w-0 font-display" style={{ gridArea: "title" }}>
          <p className="truncate text-sm font-semibold uppercase leading-tight tracking-[0.12em] text-fg/80">
            {state.race.mode === "campaign" ? "Campaign" : "Race"} · <span className="text-fg">{state.race.trackName || "Pick a course"}</span>
          </p>
        </header>
      ) : (
        <header className="hud-ink min-w-0" style={{ gridArea: "title" }}>
          <p className="hud-label">Streamed deformation</p>
          <h1 className="font-display text-2xl font-semibold leading-tight tracking-tight">Crush Stream</h1>
          <p className="mt-0.5 hidden max-w-xs text-xs leading-snug text-fg/80 sm:block">
            {state.race
              ? `Circuit race${state.race.trackName ? ` on ${state.race.trackName}` : ""}. ${state.race.noReset ? "No resets: a wreck is out, the last car running wins." : "Wrecks respawn on the racing line after 3 s."}`
              : state.derby
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
      )}

      {state.race ? <RaceReadouts race={state.race} boost={state.seat === "drive" ? state.boost : null} /> : <Readouts state={state} />}

      <div className="flex min-h-0 flex-col items-start" style={{ gridArea: "context" }}>
        {state.showPistons ? <PistonPanel pistons={state.pistons} engine={engine} /> : null}
        {state.showDoors ? <DoorPanel doors={state.doors} engine={engine} /> : null}
        {state.derby && state.derbyBoard.length > 0 ? <DerbyBoard board={state.derbyBoard} engine={engine} /> : null}
        {state.race ? <RaceStandings race={state.race} onCommand={raceCommand} /> : null}
      </div>

      {focus || !settingsShown ? null : <HudSections {...props} />}

      <div className="flex min-w-0 flex-col items-start gap-2 self-end" style={{ gridArea: "dock" }}>
        {state.race ? <SpectateBar race={state.race} pad={state.pad !== null} onCommand={raceCommand} /> : null}
        {!focus && (state.seat !== "global" || state.pad) && !state.race?.spectating ? <DriveHint state={state} /> : null}
        {focus && state.race ? (
          <RaceViewToggle race={state.race} onCommand={raceCommand} bare />
        ) : (
          <Dock {...props} raceCommand={raceCommand} settingsShown={settingsShown} onToggleSettings={() => setSettings(settingsShown ? "hidden" : "shown")} />
        )}
      </div>

      {state.derbyWinner ? (
        <div className="pointer-events-none absolute inset-x-0 top-[38%] z-10 flex justify-center">
          <div className="hud-panel px-6 py-3 text-center">
            <p className="hud-label">{state.derbyDecided === "time" ? "Time!" : "Winner"}</p>
            <p className="font-display text-4xl font-semibold tracking-tight text-fg">{state.derbyWinner}</p>
            <p className="mt-1 text-xs text-muted">
              {state.derbyDecided === "time" ? "Winner on points" : state.derbyDecided === "countout" ? "Last car in the fight; the rest counted out" : "Last engine still running"}
            </p>
          </div>
        </div>
      ) : null}
      {state.race ? <RaceOverlay race={state.race} pad={state.pad !== null} onCommand={raceCommand} /> : null}
    </div>
  );
}

/** Every number the sim reports, in one compact card. */
function Readouts({ state }: { state: CrashHudState }) {
  const press = state.showCompactor;
  const hot = state.phase === "slowmo" || state.phase === "impact";
  return (
    <div className="hud-panel self-start px-2 py-1.5 md:justify-self-end" style={{ gridArea: "readouts" }}>
      <dl className="grid grid-cols-4 gap-x-3 gap-y-1">
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
          <Readout
            label={state.eta > 0 && state.eta < 8 ? `Closing ${state.eta.toFixed(1)}s` : "Closing"}
            value={state.closingKph.toFixed(0)}
            unit="km/h"
          />
        )}
        <div className="min-w-0">
          <dt className="hud-label">Phase</dt>
          <dd className="truncate font-display text-sm font-semibold leading-5">
            <span className={cn("rounded px-1", hot ? "bg-accent text-accent-fg" : "-mx-1 text-fg")}>
              {state.derby ? (state.derbyWinner ? "Winner" : "Derby") : PHASE[state.phase]}
            </span>
          </dd>
        </div>
        <Readout label="Time scale" value={state.timeScale.toFixed(2)} unit="×" />
        <Readout label="T+" value={state.elapsed.toFixed(2)} unit="s" />
        <Readout label="FPS" value={String(Math.round(state.fps))} />
      </dl>
    </div>
  );
}

function Readout({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="min-w-0">
      <dt className="hud-label truncate">{label}</dt>
      <dd className="truncate font-display text-sm font-semibold leading-5 tabular-nums">
        {value}
        {unit ? <span className="ml-0.5 text-xs font-medium text-muted">{unit}</span> : null}
      </dd>
    </div>
  );
}

/** Seat keys and the controller label, inked straight onto the view above the dock so it never covers a control. */
function DriveHint({ state }: { state: CrashHudState }) {
  const { title, keys } = seatHint(state);
  return (
    <div className="hud-ink w-full max-w-md" role="status">
      <p className="font-display text-xs font-semibold uppercase tracking-[0.12em] text-fg">
        {title}
        {state.pad ? <span className="hud-label ml-2 text-fg/80">{state.pad} connected</span> : null}
      </p>
      <p className="text-xs leading-snug text-fg/80">{keys}</p>
      {state.seat === "drive" ? (
        <div className="mt-1 h-1 w-40 overflow-hidden rounded-full bg-surface-2/80" aria-label="Boost">
          <div className="h-full bg-accent" style={{ width: `${Math.round(state.boost * 100)}%` }} />
        </div>
      ) : null}
    </div>
  );
}

const BAR_BUTTON = "h-11 min-w-11 px-2.5 text-xs sm:h-8 sm:min-w-8";

/** Always-visible bar (full view): race view toggle in a race, play, reset, scene, the two fleet props, settings and key help. */
function Dock(props: HudProps & { raceCommand: (cmd: RaceCommand) => void; settingsShown: boolean; onToggleSettings: () => void }) {
  const { state, engine, raceCommand, settingsShown, onToggleSettings } = props;
  const scene: Scene = state.race
    ? "race"
    : state.derby
      ? "derby"
      : state.showCompactor
        ? "press"
        : state.showPistons
          ? "pistons"
          : state.showDoors
            ? "doors"
            : "fleet";
  const toggleScene = {
    derby: () => engine.current?.toggleDerby(),
    race: () => engine.current?.toggleRace(),
    press: () => engine.current?.toggleCompactor(),
    pistons: () => engine.current?.togglePistons(),
    doors: () => engine.current?.toggleDoors(),
  };
  // Barrier and balls are fleet props; the engine ignores them while the press, a rig or the race owns the pad.
  const propsLocked = state.showCompactor || state.showPistons || state.showDoors || state.race !== null;
  return (
    <div className="hud-panel pointer-events-auto flex w-full flex-wrap items-center gap-1 p-1 sm:w-auto">
      {state.race ? <RaceViewToggle race={state.race} onCommand={raceCommand} compact /> : null}
      <Button
        onClick={() => engine.current?.togglePlay()}
        className={BAR_BUTTON}
        aria-label={state.playing ? "Pause" : "Play"}
        title={state.playing ? "Pause (Space)" : "Play (Space)"}
      >
        {state.playing ? <Pause /> : <Play className="ml-0.5" />}
      </Button>
      <Button onClick={() => engine.current?.reset()} variant="secondary" className={BAR_BUTTON} aria-label="Reset crash" title="Reset (R)">
        <RotateCcw />
      </Button>
      <div
        className="order-last grid w-full grid-cols-6 gap-0.5 rounded-md bg-surface-2/70 p-0.5 sm:order-none sm:flex sm:w-auto"
        role="group"
        aria-label="Scene"
      >
        {SCENES.map(({ id, label, aria }) => (
          <Button
            key={id}
            variant={scene === id ? "default" : "ghost"}
            aria-pressed={scene === id}
            aria-label={aria}
            className="h-10 px-1 text-xs sm:h-7 sm:px-2.5"
            onClick={() => {
              if (id === scene) return;
              if (id === "fleet") toggleScene[scene as Exclude<Scene, "fleet">]();
              else toggleScene[id]();
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      <Button
        onClick={() => engine.current?.toggleBarrier()}
        disabled={propsLocked}
        variant={state.showBarrier ? "default" : "ghost"}
        className={BAR_BUTTON}
        aria-pressed={state.showBarrier}
        aria-label="Toggle jersey barrier"
        title="Jersey barrier (B)"
      >
        <BrickWall />
      </Button>
      <Button
        onClick={() => engine.current?.toggleBalls()}
        disabled={propsLocked}
        variant={state.showBalls ? "default" : "ghost"}
        className={BAR_BUTTON}
        aria-pressed={state.showBalls}
        aria-label="Toggle ramp balls"
        title="Ramp balls (K)"
      >
        <CircleDot />
      </Button>
      <Button
        onClick={onToggleSettings}
        variant={settingsShown ? "secondary" : "ghost"}
        className={cn(BAR_BUTTON, "ml-auto sm:ml-0")}
        aria-pressed={settingsShown}
        aria-label="Show settings"
        title="Settings"
      >
        <SlidersHorizontal />
      </Button>
      <KeyHelp />
    </div>
  );
}

function KeyHelp() {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="ghost" className={BAR_BUTTON} aria-label="Keyboard shortcuts" title="Keys">
          <CircleHelp />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          className="z-50 w-80 max-w-[calc(100vw-1rem)] rounded-lg bg-surface p-3 text-fg shadow-[var(--shadow-border)]"
        >
          <KeyList title="Scene" keys={SCENE_KEYS} />
          <KeyList title="Cars & camera" keys={CAMERA_KEYS} className="mt-3" />
          <p className="mt-2 text-xs text-muted">Reversing steers like a real car: left swings the tail left.</p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function KeyList({ title, keys, className }: { title: string; keys: [string, string][]; className?: string }) {
  return (
    <div className={className}>
      <p className="hud-label">{title}</p>
      <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1">
        {keys.map(([key, action]) => (
          <div key={key} className="flex items-baseline gap-2 text-xs">
            <dt>
              <kbd className="rounded bg-surface-2 px-1.5 py-0.5 font-display text-xs text-fg shadow-[var(--shadow-border)]">{key}</kbd>
            </dt>
            <dd className="text-muted">{action}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

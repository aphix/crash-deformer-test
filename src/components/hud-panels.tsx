import { Fragment, type RefObject } from "react";
import { STACK_RANGES } from "@/game/scenes/stack-rig";
import { RangeRow } from "@/components/hud-controls";
import { Button } from "@/components/ui/button";
import { useSpeedUnit } from "@/components/use-speed-unit";
import type { DoorScenario } from "@/game/scenes/door-rig";
import type { CrashEngine } from "@/game/engine/engine";
import type { CrashHudState, DoorHud, LabHud, PistonHud, StackHud } from "@/game/hud/hud-store";
import { LAB_PRESETS, type LabPresetId } from "@/game/scenes/lab";
import { formatSpeed } from "@/game/hud/speed-units";

/** Derby standings: name, score and seconds to a count-out; struck through once out. A name click follows that car. A phone on its side shows the three best scores and the watched car. */
export function DerbyBoard({ board, engine }: { board: CrashHudState["derbyBoard"]; engine: RefObject<CrashEngine | null> }) {
  const best = new Set([...board].sort((a, b) => b.score - a.score || a.id - b.id).slice(0, 3).map((r) => r.id));
  return (
    <div className="hud-panel pointer-events-auto flex min-h-0 w-44 flex-col p-2 idle:w-auto idle:opacity-70">
      <p className="hud-label">Board</p>
      <ul aria-label="Board" className="-mx-1.5 mt-2 min-h-0 space-y-0.5 overflow-y-auto overflow-x-hidden overscroll-contain idle:hidden">
        {board.map((row) => (
          <li key={row.id} className={!best.has(row.id) && !row.watched ? "phone-landscape:hidden" : undefined}>
            <button
              type="button"
              onClick={() => engine.current?.watchCar(row.id)}
              aria-pressed={row.watched}
              aria-label={`Follow ${row.name}`}
              className={`flex h-11 w-full items-center justify-between gap-2 rounded px-1.5 text-left font-display text-sm hover:bg-surface-2 sm:h-6 pointer-coarse:h-11 ${row.watched ? "bg-surface-2" : ""}`}
            >
              <span className={`min-w-0 truncate ${row.alive ? "text-fg" : "text-subtle line-through"}`}>{row.name}</span>
              <span className="flex shrink-0 gap-2 tabular-nums">
                {row.alive ? <span className={row.clock <= 15 ? "text-accent" : "text-subtle"}>{Math.ceil(row.clock)}s</span> : row.out ? <span className="text-subtle">out</span> : null}
                <span className="text-muted">{row.score}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Rig fire pads and toggles: 44 px tall on phones, 28 px from `sm`. */
const RIG_BUTTON = "h-11 px-2 text-xs sm:h-7";

/** Compass order on screen (front at the top): index into the rig's key order, 8 = all. */
const PISTON_GRID = [0, 1, 2, 7, 8, 3, 6, 5, 4] as const;
const PISTON_NAMES = ["Front-left", "Front", "Front-right", "Right", "Rear-right", "Rear", "Rear-left", "Left"] as const;

/** Piston scene controls: fire pad plus the shot config, one movable block. */
export function PistonPanel({ pistons, engine }: { pistons: PistonHud; engine: RefObject<CrashEngine | null> }) {
  const unit = useSpeedUnit();
  return (
    <div className="hud-panel pointer-events-auto max-h-full w-56 space-y-1 overflow-y-auto p-2 idle:w-auto idle:opacity-70 idle:[&>:not(:first-child)]:hidden">
      <div className="flex items-baseline justify-between gap-2">
        <p className="hud-label">Pistons</p>
        <p className="font-display text-xs tabular-nums text-muted">
          {pistons.energyKj.toFixed(1)} kJ · EBS {formatSpeed(pistons.ebsKph / 3.6, unit)} {unit}
        </p>
      </div>
      <div className="grid grid-cols-3 gap-1" role="group" aria-label="Fire a piston">
        {PISTON_GRID.map((i) => (
          <Button
            key={i}
            className={RIG_BUTTON}
            variant={i === pistons.selected ? "default" : "secondary"}
            disabled={pistons.busy}
            onClick={() => engine.current?.firePiston(i)}
            aria-label={i === 8 ? "Fire all pistons" : `Fire ${PISTON_NAMES[i]} piston`}
            title={i === 8 ? "All (0)" : `${PISTON_NAMES[i]} (${i + 1})`}
          >
            {i === 8 ? "All" : i + 1}
          </Button>
        ))}
      </div>
      <RangeRow
        label="Speed"
        value={pistons.speedKph}
        min={5}
        max={120}
        step={1}
        shown={`${formatSpeed(pistons.speedKph / 3.6, unit)} ${unit}`}
        onValue={(v) => engine.current?.setPistonConfig({ speedKph: v })}
      />
      <RangeRow
        label="Mass"
        value={pistons.massKg}
        min={200}
        max={3000}
        step={50}
        shown={`${pistons.massKg.toFixed(0)} kg`}
        onValue={(v) => engine.current?.setPistonConfig({ massKg: v })}
      />
      <RangeRow
        label="Face"
        value={pistons.hardness}
        min={0.2}
        max={1}
        step={0.05}
        shown={pistons.hardness >= 1 ? "steel" : `${Math.round(pistons.hardness * 100)}% car`}
        onValue={(v) => engine.current?.setPistonConfig({ hardness: v })}
      />
      <RangeRow
        label="Hop"
        value={pistons.hopSeconds}
        min={1.5}
        max={15}
        step={0.5}
        shown={pistons.hopSynced ? "orbit" : `${pistons.hopSeconds.toFixed(1)} s`}
        onValue={(v) => engine.current?.setPistonConfig({ hopSeconds: v })}
      />
      <Button
        className={`${RIG_BUTTON} w-full`}
        variant={pistons.holdCar ? "default" : "ghost"}
        aria-pressed={pistons.holdCar}
        onClick={() => engine.current?.setPistonConfig({ holdCar: !pistons.holdCar })}
      >
        Hold car {pistons.holdCar ? "on" : "off"}
      </Button>
    </div>
  );
}

const DOOR_SHOTS: { id: DoorScenario; label: string; title: string }[] = [
  { id: "mirror", label: "A", title: "A · shut door, ram grazes the mirror (1)" },
  { id: "overOpen", label: "B", title: "B · open door, ram from behind past the stop (2)" },
  { id: "shut", label: "C", title: "C · open door, ram from the front toward shut (3)" },
  { id: "panelPush", label: "D", title: "D · stretched quarter panel, ram from behind pushes it back onto the body (6)" },
  { id: "panelPull", label: "E", title: "E · stretched quarter panel, ram from the front pulls it out (7)" },
];

/** Doors scene controls: A–E fire pad (door and mirror, quarter panel), side and door toggles, the ram config and the last shot. */
export function DoorPanel({ doors, engine }: { doors: DoorHud; engine: RefObject<CrashEngine | null> }) {
  const shot = doors.shot;
  const unit = useSpeedUnit();
  return (
    <div className="hud-panel pointer-events-auto max-h-full w-56 space-y-1 overflow-y-auto p-2 idle:w-auto idle:opacity-70 idle:[&>:not(:first-child)]:hidden">
      <div className="flex items-baseline justify-between gap-2">
        <p className="hud-label">Doors</p>
        <p className="font-display text-xs tabular-nums text-muted">{doors.energyJ.toFixed(0)} J</p>
      </div>
      <div className="grid grid-cols-3 gap-1" role="group" aria-label="Fire the door ram">
        {DOOR_SHOTS.map(({ id, label, title }) => (
          <Button key={id} className={RIG_BUTTON} disabled={doors.busy} onClick={() => engine.current?.fireDoorRam(id)} aria-label={title} title={title}>
            {label}
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-1">
        <Button
          className={RIG_BUTTON}
          variant="secondary"
          disabled={doors.busy}
          onClick={() => engine.current?.setDoorConfig({ side: doors.side < 0 ? 1 : -1 })}
          title="Side (5)"
        >
          {doors.side < 0 ? "Left door" : "Right door"}
        </Button>
        <Button
          className={RIG_BUTTON}
          variant={doors.open ? "default" : "ghost"}
          aria-pressed={doors.open}
          disabled={doors.busy}
          onClick={() => engine.current?.toggleDoorOpen()}
          title="Door open (4)"
        >
          Door {doors.open ? "open" : "shut"}
        </Button>
      </div>
      <RangeRow
        label="Speed"
        value={doors.kph}
        min={1}
        max={60}
        step={1}
        shown={`${formatSpeed(doors.kph / 3.6, unit)} ${unit}`}
        onValue={(v) => engine.current?.setDoorConfig({ kph: v })}
      />
      <RangeRow
        label="Mass"
        value={doors.kg}
        min={10}
        max={1500}
        step={10}
        shown={`${doors.kg.toFixed(0)} kg`}
        onValue={(v) => engine.current?.setDoorConfig({ kg: v })}
      />
      {shot ? (
        <p className="font-display text-xs leading-snug tabular-nums text-muted">
          Off: {shot.detached.length > 0 ? shot.detached.join(", ") : "nothing"} · door {shot.doorDeg.toFixed(0)}°
          {shot.latched ? " latched" : ""} · panel {(shot.panelHinge * 100).toFixed(0)}% · body Δ {shot.bodyMm.toFixed(1)} mm
        </p>
      ) : null}
    </div>
  );
}

/** Stack scene: the three settings (a change restarts the stack) and, top car first as it stands, each car's load (kN of the cars on it) and roof crush (mm). */
export function StackPanel({ stack, engine }: { stack: StackHud; engine: RefObject<CrashEngine | null> }) {
  const rows = Array.from({ length: stack.dropped }, (_, i) => stack.dropped - 1 - i);
  return (
    <div className="hud-panel pointer-events-auto max-h-full w-56 space-y-1 overflow-y-auto p-2 idle:w-auto idle:opacity-70">
      <div className="flex items-baseline justify-between gap-2">
        <p className="hud-label">Stack</p>
        <p className="font-display text-xs tabular-nums text-muted">
          {stack.dropped} / {stack.cars} cars
        </p>
      </div>
      <div className="space-y-1 idle:hidden">
        <RangeRow label="Cars" name="Cars in the stack" value={stack.cars} min={STACK_RANGES.cars.min} max={STACK_RANGES.cars.max} step={1} digits={0} onValue={(v) => engine.current?.setStackConfig({ cars: v })} />
        <RangeRow
          label="Drop"
          name="Drop height over the stack"
          value={stack.drop}
          min={STACK_RANGES.drop.min}
          max={STACK_RANGES.drop.max}
          step={0.01}
          shown={`${stack.drop.toFixed(2)} m`}
          onValue={(v) => engine.current?.setStackConfig({ drop: v })}
        />
        <RangeRow
          label="Gap"
          name="Seconds between drops"
          value={stack.gap}
          min={STACK_RANGES.gap.min}
          max={STACK_RANGES.gap.max}
          step={0.5}
          shown={`${stack.gap.toFixed(1)} s`}
          onValue={(v) => engine.current?.setStackConfig({ gap: v })}
        />
      </div>
      <dl className="grid grid-cols-[1.5rem_1fr_1fr] gap-x-2 font-display text-xs tabular-nums" aria-label="Load and roof crush per car">
        <dt className="hud-label">#</dt>
        <dt className="hud-label text-right">Load</dt>
        <dt className="hud-label text-right">Roof</dt>
        {rows.map((i) => (
          <Fragment key={i}>
            <dd className="text-muted">{i + 1}</dd>
            <dd className="text-right">{stack.loadKn[i] === null ? "—" : `${stack.loadKn[i]!.toFixed(1)} kN`}</dd>
            <dd className="text-right">{stack.crushMm[i]!.toFixed(0)} mm</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

/** Ejection range readout: the thrown driver's metres past the wall, live in flight, final once he lands. */
export function RangePanel({ range }: { range: NonNullable<CrashHudState["range"]> }) {
  return (
    <div className="hud-panel w-44 p-2">
      <p className="hud-label">{range.distance === null ? "Run-up" : range.landed ? "Landed" : "Flying"}</p>
      <p className="mt-1 font-display text-3xl font-semibold leading-none tabular-nums">
        {range.distance === null ? "–" : range.distance.toFixed(1)}
        {range.distance === null ? null : <span className="ml-1 text-sm font-medium text-muted">m</span>}
      </p>
    </div>
  );
}

const LAB_SET_LABEL: Record<LabPresetId, string> = { pad: "Pad", wall: "Wall", cards: "Cards", glass: "Glass" };

/**
 * The Lab: its set (a pick puts it up afresh) and the last throw's readout; the throw is a swipe from a car. An upright phone
 * holds it at the top, where the Lab hides the readouts: low in the view it sat over the thrower; wider screens keep it low.
 */
export function LabPanel({ lab, engine }: { lab: LabHud; engine: RefObject<CrashEngine | null> }) {
  const unit = useSpeedUnit();
  const shot = lab.shot;
  return (
    <div className="hud-panel pointer-events-auto w-full max-w-xs space-y-1 p-1 sm:mt-auto idle:opacity-70">
      <div className="grid grid-cols-4 gap-0.5 rounded-md bg-surface-2/70 p-0.5" role="group" aria-label="Lab set">
        {LAB_PRESETS.map((id) => (
          <Button
            key={id}
            variant={lab.preset === id ? "default" : "ghost"}
            aria-pressed={lab.preset === id}
            className="h-11 px-1 text-xs sm:h-8"
            onClick={() => engine.current?.setLabPreset(id)}
          >
            {LAB_SET_LABEL[id]}
          </Button>
        ))}
      </div>
      <p className="truncate px-1 font-display text-xs tabular-nums text-muted idle:hidden" role="status">
        {shot === null
          ? "Swipe from a car to flick it"
          : shot.hit === null
            ? `Flying at ${formatSpeed(shot.speed, unit)} ${unit}`
            : `Hit the ${shot.hit} at ${formatSpeed(shot.speed, unit)} ${unit} · ${shot.fell} moved`}
      </p>
    </div>
  );
}

import type { RefObject } from "react";
import { RangeRow } from "@/components/hud-controls";
import { Button } from "@/components/ui/button";
import { useSpeedUnit } from "@/components/use-speed-unit";
import type { DoorScenario } from "@/game/scenes/door-rig";
import type { CrashEngine } from "@/game/engine/engine";
import type { CrashHudState, DoorHud, PistonHud } from "@/game/hud/hud-store";
import { formatSpeed } from "@/game/hud/speed-units";

/** Derby standings: name, score and seconds to a count-out; struck through once out. A name click follows that car. */
export function DerbyBoard({ board, engine }: { board: CrashHudState["derbyBoard"]; engine: RefObject<CrashEngine | null> }) {
  return (
    <div className="hud-panel pointer-events-auto flex min-h-0 w-44 flex-col p-2">
      <p className="hud-label">Board</p>
      <ul className="-mx-1.5 mt-2 min-h-0 space-y-0.5 overflow-y-auto overflow-x-hidden overscroll-contain">
        {board.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => engine.current?.watchCar(row.id)}
              aria-pressed={row.watched}
              aria-label={`Follow ${row.name}`}
              className={`flex h-11 w-full items-center justify-between gap-2 rounded px-1.5 text-left font-display text-sm hover:bg-surface-2 sm:h-6 ${row.watched ? "bg-surface-2" : ""}`}
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
    <div className="hud-panel pointer-events-auto max-h-full w-56 space-y-1 overflow-y-auto p-2">
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
];

/** Doors scene controls: A/B/C fire pad, side and door toggles, the ram config and the last shot. */
export function DoorPanel({ doors, engine }: { doors: DoorHud; engine: RefObject<CrashEngine | null> }) {
  const shot = doors.shot;
  const unit = useSpeedUnit();
  return (
    <div className="hud-panel pointer-events-auto max-h-full w-56 space-y-1 overflow-y-auto p-2">
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
          {shot.latched ? " latched" : ""} · body Δ {shot.bodyMm.toFixed(1)} mm
        </p>
      ) : null}
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

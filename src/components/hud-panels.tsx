import { Button } from "@/components/ui/button";
import type { DoorScenario } from "@/game/door-rig";
import type { CrashHudState, DoorHud, PistonHud } from "@/game/hud-store";
import type { PistonConfig } from "@/game/piston-rig";

/** Derby standings: name, score, struck through once the engine dies. A name click follows that car. */
export function DerbyBoard({ board, onWatch }: { board: CrashHudState["derbyBoard"]; onWatch: (id: number) => void }) {
  return (
    <div className="hud-panel pointer-events-auto flex min-h-0 w-44 flex-col p-3">
      <p className="hud-label">Board</p>
      <ul className="-mx-1.5 mt-2 min-h-0 space-y-0.5 overflow-y-auto overflow-x-hidden overscroll-contain">
        {board.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => onWatch(row.id)}
              aria-pressed={row.watched}
              aria-label={`Follow ${row.name}`}
              className={`flex w-full items-baseline justify-between gap-2 rounded px-1.5 py-0.5 text-left font-display text-sm hover:bg-surface-2 ${row.watched ? "bg-surface-2" : ""}`}
            >
              <span className={row.alive ? "text-fg" : "text-subtle line-through"}>{row.name}</span>
              <span className="tabular-nums text-muted">{row.score}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Compass order on screen (front at the top): index into the rig's key order, 8 = all. */
const PISTON_GRID = [0, 1, 2, 7, 8, 3, 6, 5, 4] as const;
const PISTON_NAMES = ["Front-left", "Front", "Front-right", "Right", "Rear-right", "Rear", "Rear-left", "Left"] as const;

/** Piston scene controls: fire pad plus the shot config, one movable block. */
export function PistonPanel({
  pistons,
  onFire,
  onConfig,
}: {
  pistons: PistonHud;
  onFire: (index: number) => void;
  onConfig: (patch: Partial<PistonConfig>) => void;
}) {
  const slider = (label: string, value: number, min: number, max: number, step: number, shown: string, set: (v: number) => void) => (
    <label className="flex items-center gap-2">
      <span className="hud-label w-12 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => set(Number(e.target.value))}
        aria-label={label}
        className="h-10 w-full cursor-pointer accent-current"
      />
      <span className="w-16 shrink-0 text-right font-display text-xs tabular-nums text-fg">{shown}</span>
    </label>
  );
  return (
    <div className="hud-panel pointer-events-auto max-h-full w-64 space-y-1 overflow-y-auto p-3">
      <div className="flex items-baseline justify-between">
        <p className="hud-label">Pistons</p>
        <p className="font-display text-xs tabular-nums text-muted">
          {pistons.energyKj.toFixed(1)} kJ · EBS {pistons.ebsKph.toFixed(0)} km/h
        </p>
      </div>
      <div className="grid grid-cols-3 gap-1 pb-1" role="group" aria-label="Fire a piston">
        {PISTON_GRID.map((i) => (
          <Button
            key={i}
            size="sm"
            className="h-10"
            variant={i === pistons.selected ? "default" : "secondary"}
            disabled={pistons.busy}
            onClick={() => onFire(i)}
            aria-label={i === 8 ? "Fire all pistons" : `Fire ${PISTON_NAMES[i]} piston`}
            title={i === 8 ? "All (0)" : `${PISTON_NAMES[i]} (${i + 1})`}
          >
            {i === 8 ? "All" : i + 1}
          </Button>
        ))}
      </div>
      {slider("Speed", pistons.speedKph, 5, 120, 1, `${pistons.speedKph.toFixed(0)} km/h`, (v) => onConfig({ speedKph: v }))}
      {slider("Mass", pistons.massKg, 200, 3000, 50, `${pistons.massKg.toFixed(0)} kg`, (v) => onConfig({ massKg: v }))}
      {slider(
        "Face",
        pistons.hardness,
        0.2,
        1,
        0.05,
        pistons.hardness >= 1 ? "steel" : `${Math.round(pistons.hardness * 100)}% car`,
        (v) => onConfig({ hardness: v }),
      )}
      {slider(
        "Hop",
        pistons.hopSeconds,
        1.5,
        15,
        0.5,
        pistons.hopSynced ? "orbit" : `${pistons.hopSeconds.toFixed(1)} s`,
        (v) => onConfig({ hopSeconds: v }),
      )}
      <Button
        size="sm"
        className="h-10 w-full"
        variant={pistons.holdCar ? "default" : "ghost"}
        aria-pressed={pistons.holdCar}
        onClick={() => onConfig({ holdCar: !pistons.holdCar })}
      >
        Hold car {pistons.holdCar ? "on" : "off"}
      </Button>
    </div>
  );
}

function doorSlider(label: string, value: number, min: number, max: number, step: number, shown: string, set: (v: number) => void) {
  return (
    <label className="flex items-center gap-2">
      <span className="hud-label w-12 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => set(Number(e.target.value))}
        aria-label={label}
        className="h-10 w-full cursor-pointer accent-current"
      />
      <span className="w-16 shrink-0 text-right font-display text-xs tabular-nums text-fg">{shown}</span>
    </label>
  );
}

const DOOR_SHOTS: { id: DoorScenario; label: string; title: string }[] = [
  { id: "mirror", label: "A", title: "A · shut door, ram grazes the mirror (1)" },
  { id: "overOpen", label: "B", title: "B · open door, ram from behind past the stop (2)" },
  { id: "shut", label: "C", title: "C · open door, ram from the front toward shut (3)" },
];

/** Doors scene controls: A/B/C fire pad, side and door toggles, the ram config and the last shot. */
export function DoorPanel({
  doors,
  onFire,
  onConfig,
  onToggleOpen,
}: {
  doors: DoorHud;
  onFire: (scenario: DoorScenario) => void;
  onConfig: (patch: Partial<Pick<DoorHud, "kph" | "kg" | "side">>) => void;
  onToggleOpen: () => void;
}) {
  const shot = doors.shot;
  return (
    <div className="hud-panel pointer-events-auto max-h-full w-64 space-y-1 overflow-y-auto p-3">
      <div className="flex items-baseline justify-between">
        <p className="hud-label">Doors</p>
        <p className="font-display text-xs tabular-nums text-muted">{doors.energyJ.toFixed(0)} J</p>
      </div>
      <div className="grid grid-cols-3 gap-1 pb-1" role="group" aria-label="Fire the door ram">
        {DOOR_SHOTS.map(({ id, label, title }) => (
          <Button key={id} size="sm" className="h-10" disabled={doors.busy} onClick={() => onFire(id)} aria-label={title} title={title}>
            {label}
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-1 pb-1">
        <Button size="sm" className="h-10" variant="secondary" disabled={doors.busy} onClick={() => onConfig({ side: doors.side < 0 ? 1 : -1 })} title="Side (5)">
          {doors.side < 0 ? "Left door" : "Right door"}
        </Button>
        <Button
          size="sm"
          className="h-10"
          variant={doors.open ? "default" : "ghost"}
          aria-pressed={doors.open}
          disabled={doors.busy}
          onClick={onToggleOpen}
          title="Door open (4)"
        >
          Door {doors.open ? "open" : "shut"}
        </Button>
      </div>
      {doorSlider("Speed", doors.kph, 1, 60, 1, `${doors.kph.toFixed(0)} km/h`, (v) => onConfig({ kph: v }))}
      {doorSlider("Mass", doors.kg, 10, 1500, 10, `${doors.kg.toFixed(0)} kg`, (v) => onConfig({ kg: v }))}
      {shot ? (
        <p className="font-display text-xs tabular-nums text-muted">
          Off: {shot.detached.length > 0 ? shot.detached.join(", ") : "nothing"} · door {shot.doorDeg.toFixed(0)}°
          {shot.latched ? " latched" : ""} · body Δ {shot.bodyMm.toFixed(1)} mm
        </p>
      ) : null}
    </div>
  );
}

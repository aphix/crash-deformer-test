import { Button } from "@/components/ui/button";
import type { DoorScenario } from "@/game/door-rig";
import type { CrashHudState, DoorHud, PistonHud } from "@/game/hud-store";
import type { PistonConfig } from "@/game/piston-rig";

/** Derby standings: name, score and seconds to a count-out; struck through once out. A name click follows that car. */
export function DerbyBoard({ board, onWatch }: { board: CrashHudState["derbyBoard"]; onWatch: (id: number) => void }) {
  return (
    <div className="hud-panel pointer-events-auto flex min-h-0 w-44 flex-col p-2">
      <p className="hud-label">Board</p>
      <ul className="-mx-1.5 mt-2 min-h-0 space-y-0.5 overflow-y-auto overflow-x-hidden overscroll-contain">
        {board.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => onWatch(row.id)}
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

/** Rig panel row: label, slider, read-out. 44 px tall on phones, 24 px from `sm`. */
function RigSlider({
  label,
  value,
  min,
  max,
  step,
  shown,
  set,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  shown: string;
  set: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="hud-label w-10 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => set(Number(e.target.value))}
        aria-label={label}
        className="h-11 w-full min-w-0 cursor-pointer accent-current sm:h-6"
      />
      <span className="w-14 shrink-0 text-right font-display text-xs tabular-nums text-fg">{shown}</span>
    </label>
  );
}

/** Rig fire pads and toggles: 44 px tall on phones, 28 px from `sm`. */
const RIG_BUTTON = "h-11 px-2 text-xs sm:h-7";

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
  return (
    <div className="hud-panel pointer-events-auto max-h-full w-56 space-y-1 overflow-y-auto p-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="hud-label">Pistons</p>
        <p className="font-display text-xs tabular-nums text-muted">
          {pistons.energyKj.toFixed(1)} kJ · EBS {pistons.ebsKph.toFixed(0)} km/h
        </p>
      </div>
      <div className="grid grid-cols-3 gap-1" role="group" aria-label="Fire a piston">
        {PISTON_GRID.map((i) => (
          <Button
            key={i}
            className={RIG_BUTTON}
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
      <RigSlider label="Speed" value={pistons.speedKph} min={5} max={120} step={1} shown={`${pistons.speedKph.toFixed(0)} km/h`} set={(v) => onConfig({ speedKph: v })} />
      <RigSlider label="Mass" value={pistons.massKg} min={200} max={3000} step={50} shown={`${pistons.massKg.toFixed(0)} kg`} set={(v) => onConfig({ massKg: v })} />
      <RigSlider
        label="Face"
        value={pistons.hardness}
        min={0.2}
        max={1}
        step={0.05}
        shown={pistons.hardness >= 1 ? "steel" : `${Math.round(pistons.hardness * 100)}% car`}
        set={(v) => onConfig({ hardness: v })}
      />
      <RigSlider
        label="Hop"
        value={pistons.hopSeconds}
        min={1.5}
        max={15}
        step={0.5}
        shown={pistons.hopSynced ? "orbit" : `${pistons.hopSeconds.toFixed(1)} s`}
        set={(v) => onConfig({ hopSeconds: v })}
      />
      <Button
        className={`${RIG_BUTTON} w-full`}
        variant={pistons.holdCar ? "default" : "ghost"}
        aria-pressed={pistons.holdCar}
        onClick={() => onConfig({ holdCar: !pistons.holdCar })}
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
    <div className="hud-panel pointer-events-auto max-h-full w-56 space-y-1 overflow-y-auto p-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="hud-label">Doors</p>
        <p className="font-display text-xs tabular-nums text-muted">{doors.energyJ.toFixed(0)} J</p>
      </div>
      <div className="grid grid-cols-3 gap-1" role="group" aria-label="Fire the door ram">
        {DOOR_SHOTS.map(({ id, label, title }) => (
          <Button key={id} className={RIG_BUTTON} disabled={doors.busy} onClick={() => onFire(id)} aria-label={title} title={title}>
            {label}
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-1">
        <Button
          className={RIG_BUTTON}
          variant="secondary"
          disabled={doors.busy}
          onClick={() => onConfig({ side: doors.side < 0 ? 1 : -1 })}
          title="Side (5)"
        >
          {doors.side < 0 ? "Left door" : "Right door"}
        </Button>
        <Button
          className={RIG_BUTTON}
          variant={doors.open ? "default" : "ghost"}
          aria-pressed={doors.open}
          disabled={doors.busy}
          onClick={onToggleOpen}
          title="Door open (4)"
        >
          Door {doors.open ? "open" : "shut"}
        </Button>
      </div>
      <RigSlider label="Speed" value={doors.kph} min={1} max={60} step={1} shown={`${doors.kph.toFixed(0)} km/h`} set={(v) => onConfig({ kph: v })} />
      <RigSlider label="Mass" value={doors.kg} min={10} max={1500} step={10} shown={`${doors.kg.toFixed(0)} kg`} set={(v) => onConfig({ kg: v })} />
      {shot ? (
        <p className="font-display text-xs leading-snug tabular-nums text-muted">
          Off: {shot.detached.length > 0 ? shot.detached.join(", ") : "nothing"} · door {shot.doorDeg.toFixed(0)}°
          {shot.latched ? " latched" : ""} · body Δ {shot.bodyMm.toFixed(1)} mm
        </p>
      ) : null}
    </div>
  );
}

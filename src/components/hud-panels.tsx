import { Button } from "@/components/ui/button";
import type { CrashHudState, PistonHud } from "@/game/hud-store";
import type { PistonConfig } from "@/game/piston-rig";

/** Derby standings: name, score, struck through once the engine dies. */
export function DerbyBoard({ board }: { board: CrashHudState["derbyBoard"] }) {
  return (
    <div className="hud-panel w-44 p-3">
      <p className="hud-label">Board</p>
      <ul className="mt-2 space-y-1">
        {board.map((row, i) => (
          <li key={`${i}-${row.name}`} className="flex items-baseline justify-between gap-2 font-display text-sm">
            <span className={row.alive ? "text-fg" : "text-subtle line-through"}>{row.name}</span>
            <span className="tabular-nums text-muted">{row.score}</span>
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

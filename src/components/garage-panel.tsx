import { useState, type RefObject } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RangeRow } from "@/components/hud-controls";
import { CarTypeButtons } from "@/components/hud-sections";
import type { CrashEngine } from "@/game/engine/engine";
import { SPRAY_RADIUS } from "@/game/engine/garage";
import type { GarageHud } from "@/game/hud/hud-store";
import { CAR_PARTS, hexOf, SPRAY_PALETTE, type CarPart } from "@/game/match/look-data";
import { cn } from "@/lib/utils";

const PART_LABEL: Record<CarPart, string> = { body: "Body", doors: "Doors", hood: "Hood", trunk: "Trunk", bumpers: "Bumpers", rims: "Rims", glass: "Glass tint" };
const SEGMENT = "h-11 px-1 text-xs sm:h-8";
const ROW = "flex items-center justify-between gap-2 px-1";

/** A native colour picker for `value` (sRGB) under `label`, live while it is dragged. */
function ColourRow({ label, value, onColour }: { label: string; value: number; onColour: (c: number) => void }) {
  return (
    <label className={ROW}>
      <span className="text-xs text-muted">{label}</span>
      <input
        type="color"
        aria-label={label}
        className="h-8 w-12 cursor-pointer rounded border border-border bg-transparent pointer-coarse:h-10"
        value={`#${hexOf(value)}`}
        onChange={(e) => onColour(parseInt(e.target.value.slice(1), 16))}
      />
    </label>
  );
}

/** Two or more buttons, one pressed. */
function Segments<T extends string>({ label, value, options, onPick }: { label: string; value: T; options: readonly (readonly [T, string])[]; onPick: (v: T) => void }) {
  return (
    <div className={cn("grid gap-0.5 rounded-md bg-surface-2/70 p-0.5", options.length === 2 ? "grid-cols-2" : "grid-cols-3")} role="group" aria-label={label}>
      {options.map(([id, text]) => (
        <Button key={id} variant={value === id ? "default" : "ghost"} aria-pressed={value === id} className={SEGMENT} onClick={() => onPick(id)}>
          {text}
        </Button>
      ))}
    </div>
  );
}

/**
 * The garage's editor: the car's type and part colours or the driver's build and clothes (a native colour picker each, live),
 * and the spray can (on, size, colour; a press on the car or the driver sprays). Picks ride the page URL; the spray stays in
 * this browser and goes to the other players when they join.
 */
export function GaragePanel({ garage, playerCar, engine }: { garage: GarageHud; playerCar: string; engine: RefObject<CrashEngine | null> }) {
  const [target, setTarget] = useState<"car" | "person">("car");
  // Collapsed, the panel is one row (what to paint, look or spray, the can's size), leaving a phone's view to the paint.
  const [collapsed, setCollapsed] = useState(false);
  const { person, picked, spray } = garage;
  const edit = <Segments label="Edit" value={target} options={[["car", "Car"], ["person", "Driver"]]} onPick={setTarget} />;
  const can = <Segments label="Spray can" value={spray.on ? "on" : "off"} options={[["off", "Look"], ["on", "Spray"]]} onPick={(v) => engine.current?.setSprayTool({ on: v === "on" })} />;
  const size = (
    <RangeRow
      label="Size"
      value={spray.radius}
      min={SPRAY_RADIUS.min}
      max={SPRAY_RADIUS.max}
      step={0.01}
      shown={`${Math.round(spray.radius * 100)} cm`}
      onValue={(radius) => engine.current?.setSprayTool({ radius })}
    />
  );
  const toggle = (
    <Button variant="ghost" className={SEGMENT} aria-expanded={!collapsed} aria-label={collapsed ? "Show the garage editor" : "Hide the garage editor"} onClick={() => setCollapsed(!collapsed)}>
      {collapsed ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
    </Button>
  );
  if (collapsed) {
    return (
      <div className="hud-panel pointer-events-auto flex w-full max-w-sm items-center gap-1 p-1 sm:mt-auto">
        {edit}
        {can}
        <div className="min-w-0 flex-1">{size}</div>
        {toggle}
      </div>
    );
  }
  return (
    <div className="hud-panel pointer-events-auto w-full max-w-xs space-y-1 overflow-y-auto overscroll-contain p-1 max-h-[46vh] sm:max-h-[70vh] sm:mt-auto">
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">{edit}</div>
        {toggle}
      </div>
      {target === "car" ? (
        <>
          <CarTypeButtons playerCar={playerCar} engine={engine} className="grid-cols-4" />
          {CAR_PARTS.map((part) => (
            <ColourRow key={part} label={PART_LABEL[part]} value={garage.car[part]} onColour={(c) => engine.current?.setCarColour(part, c)} />
          ))}
        </>
      ) : (
        <>
          <Segments label="Build" value={person.woman ? "w" : "m"} options={[["m", "Man"], ["w", "Woman"]]} onPick={(b) => engine.current?.setPersonPick({ woman: b === "w" })} />
          <ColourRow label="Shirt" value={person.shirt} onColour={(c) => engine.current?.setPersonPick({ shirt: c })} />
          <ColourRow label="Trousers" value={person.pants} onColour={(c) => engine.current?.setPersonPick({ pants: c })} />
          <ColourRow label="Hair" value={person.hair} onColour={(c) => engine.current?.setPersonPick({ hair: c })} />
          <div className="grid grid-cols-2 gap-0.5 rounded-md bg-surface-2/70 p-0.5" role="group" aria-label="Cap and moustache">
            <Button variant={picked.hat !== null ? "default" : "ghost"} aria-pressed={picked.hat !== null} className={SEGMENT} onClick={() => engine.current?.setPersonPick({ hat: picked.hat !== null ? null : person.shirt })}>
              Cap
            </Button>
            <Button variant={picked.mustache ? "default" : "ghost"} aria-pressed={picked.mustache} className={SEGMENT} onClick={() => engine.current?.setPersonPick({ mustache: !picked.mustache })}>
              Moustache
            </Button>
          </div>
          {picked.hat !== null ? <ColourRow label="Cap" value={picked.hat} onColour={(c) => engine.current?.setPersonPick({ hat: c })} /> : null}
        </>
      )}
      <div className="space-y-1 border-t border-border pt-1">
        {can}
        {size}
        <div className="grid grid-cols-8 gap-0.5 px-1" role="group" aria-label="Spray colour">
          {SPRAY_PALETTE.slice(1).map((c, k) => (
            <button
              key={c}
              type="button"
              aria-label={`Spray colour #${hexOf(c)}`}
              aria-pressed={spray.colour === k + 1}
              className={cn("h-7 rounded border pointer-coarse:h-9", spray.colour === k + 1 ? "border-fg ring-2 ring-fg" : "border-border")}
              style={{ background: `#${hexOf(c)}` }}
              onClick={() => engine.current?.setSprayTool({ colour: k + 1, on: true })}
            />
          ))}
        </div>
        <Button variant="ghost" className={cn(SEGMENT, "w-full")} onClick={() => engine.current?.clearSpray(target)}>
          Clear the {target === "car" ? "car's" : "driver's"} paint
        </Button>
        <p className="px-1 text-xs text-muted idle:hidden" role="status">
          {spray.on ? "Drag on the car or the driver to spray" : "Drag to look around"}
        </p>
      </div>
    </div>
  );
}

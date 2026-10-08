import { useEffect, useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, CircleParking, LockOpen, LogOut, Maximize, Minimize, Mouse, Pause, SwitchCamera, Video, Wrench, Zap } from "lucide-react";
import type { HudProps } from "@/components/hud";
import { RESET_GLOW } from "@/components/reset-prompt";
import { showsDriveReadouts } from "@/components/race-readouts";
import { Button } from "@/components/ui/button";
import { usePadHold } from "@/components/use-pad-hold";
import { PAD_BUTTON } from "@/game/vehicle/gamepad";
import { useCoarsePointer } from "@/components/use-coarse-pointer";
import { resetGlow } from "@/game/hud/reset-prompt";
import { cn } from "@/lib/utils";

/** The webkit prefixes Safari on iPad still ships (iPhone Safari has neither, so the button hides there). */
type FsDocument = Document & { webkitFullscreenEnabled?: boolean; webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
type FsRoot = HTMLElement & { webkitRequestFullscreen?: () => void };

function subscribeFullscreen(onChange: () => void): () => void {
  document.addEventListener("fullscreenchange", onChange);
  document.addEventListener("webkitfullscreenchange", onChange);
  return () => {
    document.removeEventListener("fullscreenchange", onChange);
    document.removeEventListener("webkitfullscreenchange", onChange);
  };
}

function inFullscreen(): boolean {
  const d: FsDocument = document;
  return (d.fullscreenElement ?? d.webkitFullscreenElement ?? null) !== null;
}

function fullscreenEnabled(): boolean {
  const d: FsDocument = document;
  return d.fullscreenEnabled === true || d.webkitFullscreenEnabled === true;
}

function warnFullscreen(err: unknown): void {
  console.warn("Fullscreen refused", err);
}

function toggleFullscreen(): void {
  const d: FsDocument = document;
  const root: FsRoot = document.documentElement;
  if (inFullscreen()) {
    if (typeof d.exitFullscreen === "function") d.exitFullscreen().catch(warnFullscreen);
    else d.webkitExitFullscreen?.();
  } else if (typeof root.requestFullscreen === "function") root.requestFullscreen().catch(warnFullscreen);
  else root.webkitRequestFullscreen?.();
}

/** The whole page fullscreen (standard API, webkit fallback); absent where the browser can't. */
export function FullscreenButton({ className }: { className?: string }) {
  const enabled = useSyncExternalStore(subscribeFullscreen, fullscreenEnabled, () => false);
  const on = useSyncExternalStore(subscribeFullscreen, inFullscreen, () => false);
  if (!enabled) return null;
  const label = on ? "Exit fullscreen" : "Fullscreen";
  return (
    <Button variant="ghost" className={className} aria-label={label} aria-pressed={on} title={label} onClick={toggleFullscreen}>
      {on ? <Minimize /> : <Maximize />}
    </Button>
  );
}

/** Mouse look (pointer lock): the pointer hides and mouse movement looks round, no drag. A fine pointer only; Esc or this button ends it. */
export function MouseLookButton({ engine, on, className }: Pick<HudProps, "engine"> & { on: boolean; className?: string }) {
  const coarse = useCoarsePointer();
  if (coarse) return null;
  const label = on ? "Release the mouse" : "Mouse look";
  return (
    <Button variant={on ? "default" : "ghost"} className={cn(className, on && "bg-accent text-accent-fg hover:bg-accent hover:text-accent-fg")} aria-label={label} aria-pressed={on} title={`${label} (;)`} onClick={() => engine.current?.toggleMouseLook()}>
      <Mouse />
    </Button>
  );
}

/** Knob travel (px) at full throw: the 56 px knob just reaches the 128 px base's rim. */
const STICK_TRAVEL = 36;

/** Left thumb: x steers (left = LEFT), up is gas, down brakes then reverses, through the pad's left stick and triggers. */
function Stick({ engine }: Pick<HudProps, "engine">) {
  const knob = useRef<HTMLDivElement>(null);
  /** The finger on the stick and the base centre it is measured from. */
  const finger = useRef({ id: -1, x: 0, y: 0 });
  const put = (x: number, y: number): void => {
    const t = engine.current?.touch;
    if (t) {
      t.x = x;
      t.y = y;
    }
    if (knob.current) knob.current.style.transform = `translate(${x * STICK_TRAVEL}px, ${y * STICK_TRAVEL}px)`;
  };
  useEffect(
    () => () => {
      const t = engine.current?.touch;
      if (t) t.x = t.y = 0;
    },
    [engine],
  );
  const move = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const f = finger.current;
    if (e.pointerId !== f.id) return;
    let x = (e.clientX - f.x) / STICK_TRAVEL;
    let y = (e.clientY - f.y) / STICK_TRAVEL;
    const m = Math.hypot(x, y);
    if (m > 1) {
      x /= m;
      y /= m;
    }
    put(x, y);
  };
  const release = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.pointerId !== finger.current.id) return;
    finger.current.id = -1;
    put(0, 0);
  };
  return (
    <div
      role="group"
      aria-label="Drive stick"
      className="pointer-events-auto grid size-32 shrink-0 touch-none select-none place-items-center rounded-full bg-surface/60 shadow-[var(--shadow-border)]"
      onPointerDown={(e) => {
        const f = finger.current;
        if (f.id !== -1) return;
        const r = e.currentTarget.getBoundingClientRect();
        f.id = e.pointerId;
        f.x = r.left + r.width / 2;
        f.y = r.top + r.height / 2;
        e.currentTarget.setPointerCapture(e.pointerId);
        move(e);
      }}
      onPointerMove={move}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
    >
      <div ref={knob} className="pointer-events-none size-14 rounded-full bg-accent/70 shadow-[var(--shadow-border)]" />
    </div>
  );
}

/** One pad button (`PAD_BUTTON` index): held while a finger is on it, and a tap shorter than a frame still presses. */
function PadButton({ engine, button, label, caption, className, children }: Pick<HudProps, "engine"> & { button: number; label: string; caption: string; className: string; children: ReactNode }) {
  return (
    <Button
      variant="secondary"
      aria-label={label}
      title={label}
      className={cn("pointer-events-auto h-14 min-w-14 touch-none select-none flex-col gap-0.5 bg-surface/60 px-1 data-[held]:bg-accent data-[held]:text-accent-fg [&_svg]:size-5", className)}
      {...usePadHold(engine, button)}
    >
      {children}
      <span className="font-display text-xs leading-none">{caption}</span>
    </Button>
  );
}

/**
 * Thumb pad for touch screens, above the dock: the stick lower left, buttons lower right. Both write the engine's
 * pad (`engine.touch`), so the pad bindings run them: sandbox and race edges, the race's pause and respawn, look back.
 */
export function TouchControls({ state, engine }: HudProps) {
  const race = state.race;
  if (race && race.menu !== null) return null;
  const driving = state.seat === "drive";
  const watching = state.seat !== "global";
  // A spectated race car is never this player's to drive.
  const canDrive = driving || (state.seat === "follow" && !race?.spectating);
  // Whole field, no stick: the Prev / Next pair is the only thing here. Landscape puts it in the stick's corner, not mid-screen over the action.
  const pair = !watching && !race;
  // The drive cluster sits bottom right on a phone on its side: the buttons go above it, each still 40 px tall.
  const aboveCluster = race ? showsDriveReadouts(race) : state.derbyView !== null;
  return (
    <div data-keep-idle className={cn("pointer-events-none flex w-full items-end justify-between gap-2", pair && "landscape:flex-row-reverse")}>
      {canDrive ? <Stick engine={engine} /> : <span />}
      <div className={cn("grid grid-cols-3 gap-2", aboveCluster && "pad-above-cluster")}>
        {race ? null : (
          <>
            <PadButton engine={engine} button={PAD_BUTTON.lb} label="Previous car" caption="Prev" className="col-start-1 row-start-1">
              <ChevronLeft />
            </PadButton>
            <PadButton engine={engine} button={PAD_BUTTON.rb} label="Next car" caption="Next" className="col-start-2 row-start-1">
              <ChevronRight />
            </PadButton>
          </>
        )}
        {race || watching ? (
          <PadButton
            engine={engine}
            button={PAD_BUTTON.back}
            label={race ? "Pause race" : driving ? "Step out of the car" : "Free camera"}
            caption={race ? "Pause" : driving ? "Exit" : "Free"}
            className="col-start-3 row-start-1"
          >
            {race ? <Pause /> : driving ? <LogOut /> : <LockOpen />}
          </PadButton>
        ) : null}
        {/* Following: View cycles the spectator cam; a spectated race car has it on the Spectating bar. */}
        {watching && !race?.spectating ? (
          <PadButton engine={engine} button={PAD_BUTTON.north} label="Camera view" caption="View" className="col-start-1 row-start-2">
            <Video />
          </PadButton>
        ) : null}
        {driving ? (
          <PadButton engine={engine} button={PAD_BUTTON.down} label={race ? "Respawn" : "Recover car"} caption={race ? "Respawn" : "Recover"} className={cn("col-start-2 row-start-2", resetGlow(state) && RESET_GLOW)}>
            <Wrench />
          </PadButton>
        ) : null}
        {watching ? (
          <PadButton engine={engine} button={PAD_BUTTON.r3} label="Look back (hold)" caption="Rear" className="col-start-3 row-start-2">
            <SwitchCamera />
          </PadButton>
        ) : null}
        {driving ? (
          <>
            <PadButton engine={engine} button={PAD_BUTTON.west} label="Boost (hold)" caption="Boost" className="col-start-1 row-start-3">
              <Zap />
            </PadButton>
            <PadButton engine={engine} button={PAD_BUTTON.south} label="Handbrake (hold)" caption="Handbrake" className="col-span-2 col-start-2 row-start-3">
              <CircleParking />
            </PadButton>
          </>
        ) : null}
      </div>
    </div>
  );
}

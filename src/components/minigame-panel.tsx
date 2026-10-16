import { Button } from "@/components/ui/button";
import type { MinigameMode } from "@/game/scenes/minigame-constants";
import type { MinigameHudState } from "@/game/scenes/minigame-session";
import { minigamePanelView } from "@/components/minigame-panel-view";

const RIG_BUTTON = "h-11 px-2 text-xs sm:h-7";

/** The Range minigame card: the mode's reading, score, bests and the retry / reset / switch / exit buttons. The engine's commands arrive as props. */
export function MinigamePanel({
  state,
  onRetry,
  onResetRun,
  onPickMode,
  onSetThrowsPerSet,
  onExit,
}: {
  state: MinigameHudState;
  onRetry: () => void;
  onResetRun: () => void;
  onPickMode: (mode: MinigameMode) => void;
  onSetThrowsPerSet: (count: number) => void;
  onExit: () => void;
}) {
  const view = minigamePanelView(state);
  const stepper = view.stepper;
  return (
    <div className="hud-panel w-48 space-y-1 p-2" role="group" aria-label={view.title}>
      <p className="hud-label">{view.title}</p>
      {view.throwCounter === null ? null : <p className="font-display text-xs tabular-nums text-muted">{view.throwCounter}</p>}
      <p className="font-display text-3xl font-semibold leading-none tabular-nums" role="status">
        {view.live ?? "–"}
      </p>
      {view.score === null ? null : (
        <p className="font-display text-xl font-semibold tabular-nums">
          Score <span className="text-2xl">{view.score}</span>
        </p>
      )}
      {view.total === null ? null : (
        <p className="font-display text-xs tabular-nums text-muted">
          {view.setScores === "" ? null : <span className="block truncate">{view.setScores}</span>}
          {view.totalLabel}: {view.total}
        </p>
      )}
      <p className="font-display text-xs tabular-nums text-muted">
        Best (this car) {view.bestThisCar} · Best (all) {view.bestOverall}
      </p>
      <div className="grid grid-cols-2 gap-1">
        <Button className={RIG_BUTTON} disabled={!view.retryEnabled} onClick={onRetry}>
          {view.retryLabel}
        </Button>
        <Button className={RIG_BUTTON} variant="secondary" disabled={!view.resetEnabled} onClick={onResetRun}>
          Reset run
        </Button>
        {view.otherModes.map(({ mode, label }) => (
          <Button key={mode} className={RIG_BUTTON} variant="ghost" onClick={() => onPickMode(mode)}>
            {label}
          </Button>
        ))}
      </div>
      {stepper === null ? null : (
        <div className="flex items-center justify-between gap-1">
          <span className="hud-label">Throws per set</span>
          <Button className={RIG_BUTTON} variant="secondary" disabled={!stepper.canDecrease} aria-label="Fewer throws per set" onClick={() => onSetThrowsPerSet(stepper.value - 1)}>
            -
          </Button>
          <span className="font-display text-sm tabular-nums">{stepper.value}</span>
          <Button className={RIG_BUTTON} variant="secondary" disabled={!stepper.canIncrease} aria-label="More throws per set" onClick={() => onSetThrowsPerSet(stepper.value + 1)}>
            +
          </Button>
        </div>
      )}
      <Button className={`${RIG_BUTTON} w-full`} variant="ghost" onClick={onExit}>
        Exit
      </Button>
    </div>
  );
}

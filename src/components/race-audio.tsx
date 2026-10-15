import { Choice, Stepper } from "@/components/race-rows";
import type { AudioLevels } from "@/game/hud/audio-levels";
import { KNOB_RANGES } from "@/game/hud/hud-store";

/** One pad or arrow press moves a volume by this much (the settings panel's sliders step 0.01). */
const VOLUME_STEP = 0.05;

const percent = (value: number): string => `${Math.round(value * 100)}%`;

/** Audio on/off and the music and engine volumes as rows of a race menu: the modal covers the settings panel, so the sound is set here. */
export function AudioRows({ audio }: { audio: AudioLevels }) {
  return (
    <>
      <Choice label="Sound" off="Off" on="On" value={audio.on} onSet={audio.onToggle} />
      <Stepper label="Music" value={audio.music} min={KNOB_RANGES.musicVolume.min} max={KNOB_RANGES.musicVolume.max} step={VOLUME_STEP} shown={percent(audio.music)} slider onSet={audio.onMusic} />
      <Stepper label="Engines" value={audio.engines} min={KNOB_RANGES.engineVolume.min} max={KNOB_RANGES.engineVolume.max} step={VOLUME_STEP} shown={percent(audio.engines)} slider onSet={audio.onEngines} />
    </>
  );
}

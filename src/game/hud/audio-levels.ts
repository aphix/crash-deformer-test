import type { CrashHudState } from "./hud-store.ts";

/** The engine's sound setters: the one place audio on/off and the two volumes are written, whichever menu asks. */
export interface AudioSetters {
  toggleAudio(): void;
  setMusicVolume(value: number): void;
  setEngineVolume(value: number): void;
}

/** The sound settings a menu shows: the HUD's values, and the calls that change them. */
export interface AudioLevels {
  on: boolean;
  music: number;
  engines: number;
  onToggle: () => void;
  onMusic: (value: number) => void;
  onEngines: (value: number) => void;
}

/** The sound settings as the race menus and the settings panel's Audio section both read and write them. */
export function audioLevels(state: Pick<CrashHudState, "audioOn" | "musicVolume" | "engineVolume">, engine: { current: AudioSetters | null }): AudioLevels {
  return {
    on: state.audioOn,
    music: state.musicVolume,
    engines: state.engineVolume,
    onToggle: () => engine.current?.toggleAudio(),
    onMusic: (value) => engine.current?.setMusicVolume(value),
    onEngines: (value) => engine.current?.setEngineVolume(value),
  };
}

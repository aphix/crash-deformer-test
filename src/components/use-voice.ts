import { useCallback, useEffect, useState, useSyncExternalStore, type RefObject } from "react";
import type { CrashEngine } from "@/game/engine/engine";
import type { Voice, VoiceStatus } from "@/game/net/voice";
import { useStoredString } from "@/components/use-stored-string";

/** This session's proximity voice (`NetPlay.voice`) and what it reports, re-read as it changes. */
export function useVoice(engine: RefObject<CrashEngine | null>): { voice: Voice | null; status: VoiceStatus | null } {
  const voice = engine.current?.net.voice ?? null;
  const subscribe = useCallback((listener: () => void) => voice?.subscribe(listener) ?? (() => {}), [voice]);
  const status = useSyncExternalStore(
    subscribe,
    () => voice?.snapshot() ?? null,
    () => null,
  );
  return { voice, status };
}

const INPUT_KEY = "crush.voice.input";
const OUTPUT_KEY = "crush.voice.output";
const DEVICE_CHANGE = "devicechange";

/** The microphone and output device the player picked ("" the browser's default), kept across visits. */
export function useVoiceDeviceChoice() {
  const [input, setInput] = useStoredString(INPUT_KEY, "", "");
  const [output, setOutput] = useStoredString(OUTPUT_KEY, "", "");
  return { input, setInput, output, setOutput };
}

/** The microphones and output devices the browser lists, refreshed when one is plugged in or out and when `refreshOn` changes (labels appear once the microphone is allowed). */
export function useAudioDevices(refreshOn: unknown): { inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] } {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices) return;
    const refresh = async () => {
      try {
        setDevices(await mediaDevices.enumerateDevices());
      } catch (err) {
        console.warn("[voice] enumerateDevices failed:", err);
      }
    };
    void refresh();
    mediaDevices.addEventListener(DEVICE_CHANGE, refresh);
    return () => mediaDevices.removeEventListener(DEVICE_CHANGE, refresh);
  }, [refreshOn]);
  return { inputs: devices.filter((d) => d.kind === "audioinput"), outputs: devices.filter((d) => d.kind === "audiooutput") };
}

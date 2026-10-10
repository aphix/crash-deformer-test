import type { RefObject } from "react";
import type { CrashEngine } from "@/game/engine/engine";
import { outputChoiceSupported } from "@/game/net/voice";
import { useAudioDevices, useVoice, useVoiceDeviceChoice } from "@/components/use-voice";

const SELECT = "h-11 min-w-0 flex-1 rounded-md bg-surface-2 px-1.5 text-xs text-fg shadow-[var(--shadow-border)] sm:h-8";

function DevicePicker({ label, devices, value, fallbackName, onPick }: { label: string; devices: MediaDeviceInfo[]; value: string; fallbackName: string; onPick: (deviceId: string) => void }) {
  return (
    <label className="flex items-center gap-2">
      <span className="hud-label w-12 shrink-0">{label}</span>
      <select className={SELECT} value={devices.some((d) => d.deviceId === value) ? value : ""} onChange={(e) => onPick(e.target.value)} aria-label={`Voice chat ${fallbackName.toLowerCase()}`}>
        <option value="">Default</option>
        {devices.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `${fallbackName} ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The voice chat's microphone and (where the browser can route to one, `setSinkId`) output device, in the settings' audio
 * section. The choice is kept across visits and takes over at once while voice is on. Shown once the browser lists any device.
 */
export function VoiceDevicePickers({ engine }: { engine: RefObject<CrashEngine | null> }) {
  const { status } = useVoice(engine);
  const choice = useVoiceDeviceChoice();
  const { inputs, outputs } = useAudioDevices(status?.on);
  if (inputs.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="hud-label">Voice chat devices</p>
      <DevicePicker
        label="Mic"
        devices={inputs}
        value={choice.input}
        fallbackName="Microphone"
        onPick={(deviceId) => {
          choice.setInput(deviceId);
          void engine.current?.net.voice.setInputDevice(deviceId);
        }}
      />
      {outputChoiceSupported() ? (
        <DevicePicker
          label="Output"
          devices={outputs}
          value={choice.output}
          fallbackName="Speaker"
          onPick={(deviceId) => {
            choice.setOutput(deviceId);
            void engine.current?.net.voice.setOutputDevice(deviceId);
          }}
        />
      ) : null}
    </div>
  );
}

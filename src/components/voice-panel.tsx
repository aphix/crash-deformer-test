import type { RefObject } from "react";
import { Mic, MicOff, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useVoice, useVoiceDeviceChoice } from "@/components/use-voice";
import type { CrashEngine } from "@/game/engine/engine";
import type { Voice, VoicePeerStatus } from "@/game/net/voice";
import { VOICE_MAX_RANGE_M } from "@/game/net/voice-range";
import { cn } from "@/lib/utils";

/** Taps stay 44 px tall on phones, 32 px from `sm`. */
const TAP = "h-11 sm:h-8";
const keepFocus = (e: { preventDefault: () => void }): void => e.preventDefault();

function SpeakingDot({ speaking, label }: { speaking: boolean; label: string }) {
  return <span className={cn("size-2 shrink-0 rounded-full", speaking ? "bg-signal-green" : "bg-fg/25")} role="img" aria-label={speaking ? `${label} speaking` : `${label} quiet`} />;
}

/**
 * The online panel's voice block (docs/MULTIPLAYER.md "Voice"): the opt-in (the microphone is asked for on this click only),
 * then mute and leave with this player's own speaking indicator. Players farther than `VOICE_MAX_RANGE_M` neither hear nor are sent the microphone.
 */
export function VoicePanel({ engine }: { engine: RefObject<CrashEngine | null> }) {
  const { voice, status } = useVoice(engine);
  const choice = useVoiceDeviceChoice();
  if (!voice || !status) return null;
  return (
    <div className="space-y-1">
      <p className="hud-label">Voice chat</p>
      {!status.supported ? <p className="text-subtle">Voice chat needs a secure (https) page and a browser with a microphone.</p> : null}
      {status.supported && !status.on ? (
        <>
          <Button className={cn(TAP, "w-full gap-1.5 px-3 text-xs")} variant="secondary" disabled={status.starting} onMouseDown={keepFocus} onClick={() => void voice.start({ input: choice.input, output: choice.output })}>
            <Mic />
            {status.starting ? "Asking for the microphone…" : "Join voice chat"}
          </Button>
          <p className="text-subtle">Players within {VOICE_MAX_RANGE_M} m hear you, fading with distance; nobody farther does. Headphones avoid echo.</p>
        </>
      ) : null}
      {status.on ? (
        <div className="flex items-center gap-1">
          <SpeakingDot speaking={status.speaking} label="You" />
          <Button className={cn(TAP, "flex-1 gap-1.5 px-3 text-xs")} variant={status.muted ? "default" : "secondary"} aria-pressed={status.muted} onMouseDown={keepFocus} onClick={() => voice.setMuted(!status.muted)}>
            {status.muted ? <MicOff /> : <Mic />}
            {status.muted ? "Unmute" : "Mute"}
          </Button>
          <Button className={cn(TAP, "flex-1 px-3 text-xs")} variant="secondary" onMouseDown={keepFocus} onClick={() => voice.stop()}>
            Leave voice
          </Button>
        </div>
      ) : null}
      {status.error ? (
        <p className="text-signal-red" role="alert">
          {status.error}
        </p>
      ) : null}
    </div>
  );
}

/** What a player is called in the lists: its roster name, else its car, else its peer id. */
const whoOf = (peer: VoicePeerStatus): string => peer.name || (peer.car >= 0 ? `car ${peer.car}` : peer.id);

/**
 * A peer's name in the peer list, and its mute: clicking the name silences that player for this listener only (nothing is sent), clicking again lets
 * it through. A muted name is struck through with a muted-speaker glyph and the button says what the next click does.
 */
export function PeerName({ voice, peer }: { voice: Voice; peer: VoicePeerStatus }) {
  const who = whoOf(peer);
  return (
    <button
      type="button"
      className={cn("inline-flex min-h-11 min-w-11 items-center gap-1 rounded px-0.5 text-left hover:bg-fg/10 sm:min-h-0 sm:min-w-0 sm:items-baseline", peer.muted ? "text-muted line-through" : "font-display")}
      aria-pressed={peer.muted}
      aria-label={peer.muted ? `Unmute ${who}` : `Mute ${who}`}
      title={peer.muted ? `${who} is muted for you. Click to unmute.` : `Click to mute ${who} for you.`}
      onMouseDown={keepFocus}
      onClick={() => voice.setPeerMuted(peer.id, !peer.muted)}
    >
      <span className="truncate">{who}</span>
      {peer.muted ? <VolumeX className="size-3 shrink-0 self-center no-underline" aria-hidden /> : null}
    </button>
  );
}

/** One peer's voice controls in the peer list: whether it is speaking, its volume and mute here, and "far" while it is out of range. */
export function VoicePeerControls({ voice, peer }: { voice: Voice; peer: VoicePeerStatus }) {
  const who = whoOf(peer);
  return (
    <span className="flex basis-full items-center gap-1.5">
      <SpeakingDot speaking={peer.speaking} label={who} />
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={peer.volume}
        onChange={(e) => voice.setPeerVolume(peer.id, Number(e.target.value))}
        className="min-w-0 flex-1"
        aria-label={`Voice volume of ${who}`}
      />
      <Button className={cn(TAP, "shrink-0 px-2")} variant={peer.muted ? "default" : "ghost"} aria-pressed={peer.muted} aria-label={peer.muted ? `Unmute ${who}'s voice` : `Mute ${who}'s voice`} onMouseDown={keepFocus} onClick={() => voice.setPeerMuted(peer.id, !peer.muted)}>
        {peer.muted ? <VolumeX /> : <Volume2 />}
      </Button>
      {peer.inRange ? null : <span className="text-subtle">far</span>}
    </span>
  );
}

/** A speaker is heard at full strength out to this distance (m), then the voice fades linearly. */
export const VOICE_FULL_RANGE_M = 12;
/** No voice past this distance (m): the listener's gain is 0 and the speaker's browser stops sending to that listener. */
export const VOICE_MAX_RANGE_M = 30;
/** A speaker silenced at `VOICE_MAX_RANGE_M` is sent to again once the listener is this close (m or less). */
export const VOICE_RESUME_RANGE_M = 29;

/** The listener's gain on a speaker `distance` metres away: 1 inside the full range, 0 at the maximum, linear between. */
export function voiceGain(distance: number): number {
  if (distance <= VOICE_FULL_RANGE_M) return 1;
  if (distance >= VOICE_MAX_RANGE_M) return 0;
  return (VOICE_MAX_RANGE_M - distance) / (VOICE_MAX_RANGE_M - VOICE_FULL_RANGE_M);
}

/** Whether to send a speaker's voice to a listener `distance` metres away, given whether it was being sent a moment ago. */
export function voiceSendOpen(distance: number, wasOpen: boolean): boolean {
  return wasOpen ? distance < VOICE_MAX_RANGE_M : distance <= VOICE_RESUME_RANGE_M;
}

/** Netplay's rates, windows and limits (`NetPlay` in net-play.ts): host-authoritative snapshots out, inputs in, public rooms around them. */

export const SEND_HZ = 30;
export const KEYFRAME_EVERY = 30;
/** A changed wreck section rides along this many snapshots (cover for lost packets). */
export const REDUNDANT = 3;
/** Clients draw this far (s) behind the host's newest snapshot. */
export const INTERP_DELAY = 0.1;
export const RING = 8;
/**
 * A public-race client whose host stays silent for this long (ms) of its own frame time hosts a fresh room.
 * Frame time, not wall time: the client's own stalls (the engine's boot warm-up runs no netplay frames, a
 * hidden tab, a course loading) would otherwise read as a dead host, and it would leave a live room to host a
 * duplicate (measured: 3 of 10 public rejoins after a reload).
 */
export const HOST_WAIT_MS = 5000;
/** A guest that finds this many public rooms dead in a row (none ever answered) stops looking and hosts its own. */
export const MAX_DEAD_ROOMS = 3;
/** A public host waits this long (s) for players before the AI fills the empty seats and the race starts. */
export const LOBBY_S = 15;
/** Seconds a finished public race shows its results before the next one starts (late joiners race then). */
export const RESULTS_HOLD = 12;
/** The race state rides along every this many snapshots (5 Hz), and with every keyframe. */
export const RACE_EVERY = 6;
/** A client in race mode with no race message from its host this long (ms) leaves race mode. */
export const RACE_GONE_MS = 2000;
/** A public derby's field: peers plus AI up to this many cars. */
export const PUBLIC_DERBY_FIELD = 6;
/** A client asks the host for a car this often (s) until it has one. */
export const HELLO_EVERY = 0.5;
/** Host: a peer that dropped off the transport keeps its car this long (ms), so a connection blip doesn't cost its seat. */
export const SLOT_GRACE_MS = 10_000;
/** Host: a peer's car idles once its input is this old (ms): a stalled or hidden tab must not hold full throttle. */
export const INPUT_STALE_MS = 500;
/** Client: no word from its host this long (ms), and the host isn't merely paused, means the host is gone: ask any host for a car again. */
export const HOST_LOST_MS = 3000;
/** A hidden host's heartbeat (ms): its tab draws no frames, so this is all its guests hear. */
export const HOLD_EVERY_MS = 1000;
/** `MSG.assign` car: the host refuses this peer (another build). */
export const REFUSED = 255;

/** Room rules shared by the signaling relay (server) and the game's online entry (client). */

/** Peers per room: a full mesh, and a P2P host's upload, top out here (docs/MULTIPLAYER.md). */
export const ROOM_MAX = 8;
/** Public rooms are named `pub-…`; private codes are plain `[A-Z0-9]`, so they never collide. */
export const PUBLIC_PREFIX = "pub-";
/** Request header carrying the token a peer's first relay poll was issued (signaling.server.ts). */
export const TOKEN_HEADER = "x-rtc-token";

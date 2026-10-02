-- Relay peer tokens and seats (src/lib/multiplayer/signaling.server.ts).
-- secret_hash: the SHA-256 of the token a peer's first poll was issued; every later poll, signal and
-- leave must present the token, so nobody can read another peer's inbox, speak as it or remove it.
-- seat: one of the room's ROOM_MAX (8) seats. The unique (room, seat) index is what keeps joins that
-- race from overfilling a room, and the partial unique index gives a room at most one host.
-- Peer rows live 30 s and pre-date tokens: clearing them lets the NOT NULL columns and the unique
-- indexes apply to any existing store. A page left open across the deploy reloads to rejoin.
DELETE FROM webrtc_peers;
ALTER TABLE webrtc_peers ADD COLUMN IF NOT EXISTS secret_hash TEXT NOT NULL;
ALTER TABLE webrtc_peers ADD COLUMN IF NOT EXISTS seat SMALLINT NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS webrtc_peers_seat ON webrtc_peers (room, seat);
CREATE UNIQUE INDEX IF NOT EXISTS webrtc_peers_host ON webrtc_peers (room) WHERE name = 'host';

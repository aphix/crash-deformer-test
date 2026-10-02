-- Public-room ranking (src/lib/multiplayer/signaling.server.ts `listPublic`): each peer row carries a
-- hash of its caller's address salted by a secret that lives only in the server process, so the relay
-- can rank rooms by distinct addresses and cap the public rooms one address hosts without storing it.
ALTER TABLE webrtc_peers ADD COLUMN IF NOT EXISTS ip_tag TEXT NOT NULL DEFAULT '';

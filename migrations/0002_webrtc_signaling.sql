-- WebRTC signaling relay (src/lib/multiplayer/signaling.server.ts, docs/MULTIPLAYER.md).
-- Rendezvous rows only: a random peer id, its role tag and SDP/ICE, pruned within 60 s.
-- Shipping this file is also what gets the deployed app a shared database: serverless instances
-- with a per-instance PGLite never see each other's peers, so rooms would never form.
-- IF NOT EXISTS: a PGLite data dir created by the relay's former inline create applies this cleanly.
CREATE TABLE IF NOT EXISTS webrtc_peers (
  room TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room, peer_id)
);

CREATE TABLE IF NOT EXISTS webrtc_signals (
  id BIGSERIAL PRIMARY KEY,
  room TEXT NOT NULL,
  to_peer TEXT NOT NULL,
  from_peer TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webrtc_signals_inbox ON webrtc_signals (room, to_peer, id);

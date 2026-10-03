-- Public-room list (src/lib/multiplayer/signaling.server.ts `listPublic`): a host's poll carries a short tag,
-- `<stage>.<course>` (game/net/matchmaking.ts `publicMeta`), that the list shows beside the room, so the
-- game can prefer a match that has not started and name its course. Cleared with the row; nothing identifying.
ALTER TABLE webrtc_peers ADD COLUMN IF NOT EXISTS meta TEXT NOT NULL DEFAULT '';

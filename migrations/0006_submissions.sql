-- Player submissions (src/lib/submissions/submissions.server.ts): bench cards, JSON trace captures and
-- flagged replay clips, each stored as the one JSON envelope the client sent, gzipped and as base64 text
-- (a capture is megabytes of repetitive numbers: 8-20 x smaller; base64 because the two database drivers
-- differ in how they pass bytes). `id` is the receipt the player sees; `size` is the stored text's length,
-- so the store's cap needs no scan of the bodies. Written by the public endpoint under per-address limits;
-- read only with the owner token.
CREATE TABLE IF NOT EXISTS submissions (
  seq BIGSERIAL PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  sha TEXT NOT NULL,
  size INTEGER NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS submissions_kind_seq ON submissions (kind, seq DESC);

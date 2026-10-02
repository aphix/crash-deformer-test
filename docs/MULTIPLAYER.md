# Multiplayer

Owner's target (2026-10-01): deformation need not be identical on every machine, but the **final mesh
and the collision touchpoints must be**. So one machine simulates, everyone else draws what it says.

## Transport

| Option | Runs locally | Runs on Vercel | Cost / limits | Verdict |
|---|---|---|---|---|
| WebSocket server in a Vercel Function | yes | only with Fluid compute; each socket is pinned to one instance and closes at the function's max duration (300 s Hobby, 800 s Pro); no shared memory across instances [1][2][4] | reconnect churn every few minutes, no room state | no |
| WebRTC DataChannels, signaling over `/api/rtc` (Vercel Function + Neon; PGLite locally) | yes | yes: signaling is short polls, game data never touches Vercel | free; STUN only, so some strict NATs fail without TURN (Cloudflare Calls TURN, Twilio, metered.ca) [10] | **chosen** |
| PeerJS cloud broker | yes | yes | third-party broker, same NAT caveat | no: the template already ships the same thing |
| PartyKit / Cloudflare Durable Objects | `partykit dev` | separate deploy | one stateful object per room, WebSocket hibernation | the upgrade path for 16-player rooms or a server-side host |
| Ably / Pusher / Liveblocks / Supabase Realtime | yes | yes | per-message quotas, built for pub/sub and presence rather than 30 Hz binary snapshots | no |
| BroadcastChannel (same origin, same browser) | yes | n/a | none | **local smoke tests only** |

Sources: research note `.extraResearch/perplexity/90-vercel-realtime-transports.md`;
[1] https://vercel.com/docs/functions/websockets · [2] https://vercel.com/docs/functions/limitations ·
[4] https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections ·
[10] https://developers.cloudflare.com/api/resources/calls/ · Gaffer On Games, *Snapshot Interpolation* /
*Snapshot Compression* (https://gafferongames.com/post/snapshot_interpolation/,
https://gafferongames.com/post/snapshot_compression/), summarized in `.extraResearch/perplexity/91-snapshot-netcode.md`.

The pick is the template's own P2P kit: `src/lib/multiplayer/p2p.ts` (`P2PRoom`: full-mesh WebRTC,
perfect negotiation, an unreliable `state` channel and a reliable channel, ping RTT), signaled by
`src/routes/api/rtc.ts` → `src/lib/multiplayer/signaling.server.ts` (the reference relay from
`.grok/skills/multiplayer-p2p`). Its two tables are `migrations/0002_webrtc_signaling.sql`. Shipping
a top-level migration is what gets a deploy its Neon database (the `neon` skill): without one the
deploy has no `DATABASE_URL`, every serverless instance runs its own throwaway PGLite, and peers
whose polls land on different instances never see each other. Measured with two instances of one
node-server build and no shared database: each roster holds only its own peer, and a signal across
instances gets 403. `db:migrate` applies the file on deploy; the PGLite fallback (`vite dev`, the
VPS node server) applies it before its first query. The game code only sees
`NetTransport` (`src/game/net/transport.ts`):

```ts
interface NetTransport {
  readonly selfId: string;
  onMessage: ((from: string, data: Uint8Array) => void) | null;
  send(data: Uint8Array<ArrayBuffer>, to?: string): void; // unreliable, unordered; to = one peer, else all
  peers(): readonly { id: string; rttMs: number | null }[];
  close(): void;
}
```

Implementations: `BroadcastTransport` (two tabs of one browser) and `RtcTransport` (wraps `P2PRoom`;
binary frames go over its unreliable `state` channel). A PartyKit transport would be a third class.

## Authority

Host-authoritative. The host's engine runs everything it runs today: physics, crush, breakage, FX.
Each peer owns one car through a **controller slot** (`player` on its own machine, `remote` on the
host). Clients:

- never step physics, crush, breakage or `followGroup` on any car (`engine.net.client` skips the
  fixed-step loop and `updateDeform`);
- sample their own `DriverSeat` as today and send the shaped `DriveInput` (throttle, steer, brake,
  ebrake, boost) to the host at frame rate, capped at 30 Hz;
- render host snapshots ~100 ms in the past, interpolating between the two that bracket render time.

The host applies the latest input per remote car in the fixed step, right after its own seat
(`net.drive(cars, dt)`), so a remote car is driven by the same `applyDrive` call as the local one.

Not in the prototype: client-side prediction of the client's own car. It costs a second
simulation of that car plus reconciliation on every snapshot, and the round trip (one frame on a
LAN, ~50-100 ms on the internet, plus the 100 ms buffer) is tolerable for an arcade crash toy. Add
it after measuring how the delay feels: predict pose only while the car is kinematic (no crush),
snap to the host once it is `crashed`.

## What a snapshot carries

The mesh and the colliders are functions of a small state; everything else is either derived or
host-only.

| State | Why | Encoding | Bytes |
|---|---|---|---|
| Pose: `group.position`, yaw / pitch / roll, `velocity`, `angular.y`, `crashed`, `vaporized`, `falling`, body style + vehicle class | rigid placement; velocity for wheels; the Fleet disc edge's fake fall and smoke; the body the client must build (a host's class pick rebuilds car 0) | u8 flags (1 crashed, 2 wreck follows, 4 vaporized, 8 falling), u8 style/class, f32×3, i16×3 (1e-4 rad), i16×3 (0.01 m/s), i16 (1e-3 rad/s) | 28 |
| **Body**: the 20 control particles' current body-frame positions (`MassNode.local`), popped masses, `massActive`, `drivetrainAlive`, `engineTravel`, `killTravel` | the live hulls (`liveHulls` / `liveCrushHulls`) read only `local`, so these are the collision touchpoints; engine travel over kill travel (class × realism) is the graded damage | i16×60 (0.5 mm), u32, u8, i16×2 | 129 |
| **Skin**, as of the last skin bake: the particles (`massPos`), each shape cluster's skin map (`skinM`, 16 × 3×3), popped hubs, `deepCrush` / `bidirectional` / lattice; plus the 20 sensor compressions, impact point + inward axis, wrinkle amplitude, buckle, squash | `skin()` writes every vertex from exactly these. After the crush window closes the host mesh stays frozen at the last bake while `local` drifts and the shape-rest rebase resets every `skinM`, so the bake keeps its own copy (`bakeLocalSkin`) and the client re-skins from that | i16×60, i16×144 (1/8192), u32, i16×20, i16×9 | 470 |
| **Parts**: per detachable part (bumpers, bonnet, boot, doors, mirrors: 8) detached / folding / latched, `hingeT`, door `theta`, `mirrorFold`; each loose part's world pose; lamp intact bits; glass pane states; loose-wheel bits and each loose wheel's world pose | part transforms and the panels' visibility | u8 + i16×3 per part, + f32×3 + i16×4 per loose part or wheel, u8, u16, u8 | 60 + 20 per loose part or wheel |

Body + skin + parts form one **wreck section** (659 bytes + 20 per loose part or wheel), sent only for
`crashed` cars. Header: type u8, keyframe u8, seq u16, host time f64 (s), car count u8, realism u8
(the host's `HANDLING.realism`, which the client adopts), crash phase u8, time scale u16 = 17 bytes. Input (client → host): type,
throttle i8, steer i8, brake u8, ebrake/boost bits = 5 bytes.

Host-only (never sent): masses' velocities and `world` (client sets `world = group · local`),
cluster plastic `Sp` and shape rests, beams, contact timers (`contactAt`, `lastContact`, `prevYaw`,
`rateYaw`), the squeeze fields (`endAgo/endReach/endSqueeze`), door `omega` / `load`, loose-part
velocities. A client that becomes host (migration) needs these; see below.

A wreck section rides along when its quantized bytes changed within the last 3 snapshots
(redundancy for lost packets), and in every **keyframe** (1 Hz, and right after a join). A car the
snapshot says is not crashed gets `resetVisual()` on the client. Proper acked-baseline delta
compression (Gaffer) is the upgrade if crash bursts saturate links.

Interpolation: the client renders 100 ms behind its estimate of the host clock (smallest seen
local − host time, relaxing 1 ms per snapshot). Position, angles (shortest arc) and velocity lerp
between the two snapshots around render time; the wreck section snaps, applied once from the
newest snapshot at or before render time, and is re-skinned on arrival (never deferred by LoD).
Loose parts therefore move at the snapshot rate. Once snapshots stop changing the client sits
exactly on the host's last state, which is what the consistency target needs.

### Bandwidth (estimate, per client, host → client)

Payload per snapshot = 17 + 28 × cars while nobody is crushing; a car inside a crush window adds
659 bytes (+20 per loose part or wheel). WebRTC adds ~60 bytes per packet (IP/UDP/DTLS/SCTP).

| Cars | Steady payload | Steady @ 30 Hz incl. overhead | Steady @ 20 Hz | One car crushing @ 30 Hz | Keyframe, all crashed |
|---|---|---|---|---|---|
| 2 | 73 B | 4.0 KB/s | 2.7 KB/s | +19.8 KB/s | 1.4 KB |
| 8 | 241 B | 9.0 KB/s | 6.0 KB/s | +19.8 KB/s | 5.5 KB |
| 16 | 465 B | 15.8 KB/s | 10.5 KB/s | +19.8 KB/s | 11.0 KB |
| 32 | 913 B | 29.2 KB/s | 19.5 KB/s | +19.8 KB/s | 22.0 KB |

The host uploads that once per client: 16 players at 30 Hz is ~235 KB/s (≈ 1.9 Mbit/s) steady and
spikes past 1 MB/s when several cars crush at once. So P2P hosting is for ≤ 8 players (the
template's own guidance); 16 needs 20 Hz plus a relay that fans out one upload (PartyKit room).
A keyframe is one message on the unreliable `state` channel (`hostFrame` writes every crashed car's
wreck into it; there is no split). Encoded with the shipping layout, it passes the 16 KiB safe
DataChannel size at 24 crashed cars with nothing loose (16 505 B), at 20 with every panel loose and at
18 with every panel and wheel loose; the field allows 32 (`MAX_CARS`). Above 16 KiB the message still
goes (SCTP fragments it) but a lost fragment loses the whole keyframe, so the client waits for the
next one (1 s). Splitting per car is the fix if large crashed fields show that. Inputs cost 150 B/s per client. The host sends at
most one snapshot per rendered frame, so a host below 30 fps sends at its frame rate.

## Rooms, joining, migration

- **Private room**: a 4-character code, typed or generated by the Net panel (top centre: Host /
  Join, link "Internet (WebRTC)" or "This browser (tabs)"). "Copy invite link" copies
  `origin + BASE_URL + ?net=join&room=CODE` (plus `&tx=bc` for tabs); the URL form `?net=host|join
  &room=CODE[&tx=bc]` starts it on load. Every net URL is built from `import.meta.env.BASE_URL`, so
  the app works under a base path (`APP_BASE=/crush/` on the VPS). Under WebRTC the panel also
  shows the link as a QR code (`src/lib/qr.ts`: ~200-line dependency-free encoder, byte mode, level
  M, versions 1–10). Verified: 49 strings of 1–210 bytes across versions 1–10 decode with jsQR, and
  the on-screen QR decodes to the copied link, including under `vite dev --base /crush/`.
- **Public race**: the button asks the relay for open public rooms (`GET api/rtc?list=public`:
  rooms named `pub-…` with a free seat whose `host`-tagged peer polled in the last 5 s, fullest
  first) and joins the first, or hosts a new `pub-XXXXXX` room on the race course when none is open.
  - **Lobby**: the public host is car 0 on the course with no menu; the Net panel says "Waiting for
    players… starts in N s; AI drives the empty seats". After `LOBBY_S` = 15 s (or at once when the
    room fills) the race starts with every peer seated as a `remote` slot and AI in the rest. A
    finished race shows its results for 12 s, then the next one starts, seating whoever joined.
  - **Dead rooms**: a host that closes its tab sends `leave` on `pagehide`; one that crashes stops
    polling and drops off the list within 5 s. A client that joined a room whose host has gone
    (no snapshot within 5 s) hosts a fresh public room itself. Measured: host tab closed, second page
    presses Public race 0.5 s later. Before: it joined the dead room and sat at 0 snapshots/s for the
    whole 10 s probe. Now, normal close: a fresh room at once. `leave` dropped (a crashed tab):
    two runs, one joined the dead room and hosted a fresh one after 5.0 s, the other got a fresh room at once.
- **Room size**: 8 peers (`ROOM_MAX`, `src/lib/multiplayer/rooms.ts`); the relay answers 409 past it.
- **Join**: the client sends `hello` every 0.5 s until the host answers `assign` (its car index: the
  lowest free index ≥ 1; the host grows the field if needed) and makes its next snapshot a
  keyframe. The client adopts the snapshot's car count, each car's body style and class
  (`CrashEngine.matchCar`) and the host's realism, then follows its car; a pedal takes the wheel.
  Join mid-session works the same: the keyframe carries every wreck.
- **Leave**: a peer missing from the transport roster frees its slot and the car stops taking
  input (it coasts in Fleet).
- **Host migration (spec only)**: the host already knows every client; the lowest remaining peer id
  becomes host. Its last snapshot gives poses, particles and parts but not the physics-only state
  above, so the new host re-arms each wreck from the snapshot (masses at `world = group · local`,
  velocities from the pose, `Sp` from `skinM` with the rotation removed) and accepts a visible
  hiccup. Exact migration needs those fields added to the keyframe (~1 KB more per crashed car).

### Relay hardening (`signaling.server.ts`; the repo and server are public)

- zod on every input: ids `[A-Za-z0-9_-]{1,64}`, the peer tag `[a-z]{0,12}` (the game sends only
  `host` / `client`, never a name), signal kind enum, payload ≤ 32 KB, POST body ≤ 40 KB.
- Peer tokens: a peer's first poll seats it and returns a random token; the relay stores only its
  SHA-256 (`migrations/0003_webrtc_peer_tokens.sql`). Every later poll, signal and leave must send
  the token in `x-rtc-token` (403 otherwise), so nobody can read another peer's inbox (its SDP and
  ICE), signal as it, retag it or remove it. The role tag is fixed when the peer joins, and a room
  holds one `host` (409 "host taken").
- Seats: a room has `ROOM_MAX` seats, unique per `(room, seat)`, and one insert takes the lowest
  free one, so joins that race can never overfill a room or push out a seated peer (409 "room
  full"). A peer that stops polling for 30 s loses its seat and joins afresh.
- Token buckets, in process (`src/lib/multiplayer/rate-limit.ts`; exact on the VPS's single node
  process, per instance on serverless), 429 past any of them:
  - per peer id, keyed by client IP + peer id: 10 req/s, burst 100. One peer polls every 0.4 s while
    connecting and posts an offer or answer plus a few ICE candidates per pair, ~30 requests in an
    8-peer handshake;
  - per client IP (`x-forwarded-for` first hop, which the VPS nginx overwrites; Vercel sets it):
    a full room's worth, 80 req/s, burst 800, because friends share one NAT;
  - the public-room list: one peer's budget per IP. No bucket is shared across addresses (a former
    per-room bucket let one outsider rotating peer ids 429 a room's members).
  - The table holds 20 000 buckets and evicts the least recently used one when full (O(1)): minted
    keys can no longer lock every new caller out, and an evicted caller restarts from a full bucket.
- Only a seated peer may signal another seated peer of its room (403). One sender may have at most
  60 live signals waiting for one peer (429), so no member can fill another's inbox.
- Peers expire 30 s after their last poll and signals after 60 s; joins and ~2 % of polls prune, so
  an empty room disappears within 30 s. Stored: a random peer id, its role tag and seat, a token
  hash, SDP/ICE, nothing past those TTLs. Works on PGLite in one long-lived node process.
- Errors are logged by name only (driver messages can carry connection strings or hosts).
- Measured on `vite dev`: invalid room or tag → 400; ninth peer → 409; signal from a non-member →
  403. Eight pages from one IP (no `x-forwarded-for`: one shared address) pressing Public race:
  with the old per-IP-only limit (15/s, burst 60) 130 × 429, a split into two rooms and no full
  mesh; now one room, all 8 peers with 7 connected each in 4.9–6.1 s, ~30 requests per peer,
  0 × 429 (three runs). One peer id posting 400 leaves at once: 316 × 200, 84 × 429 (the dev
  server serialises requests at ~11/s, so most of the flood arrives slower than the burst drains).
  With peer tokens and seats (`signaling.test.ts` against PGLite): a tab without the token gets 403
  on poll, signal and leave and reads no signals; eight fake ids rushing a room of two at once seat
  6 and leave both members seated (before: all 8 seated and the host got 409). ReviewA's limiter
  probe (3 IPs at 80 req/s, a fresh peer and room per request, 70 s) refused the next new caller
  before and admits it now. Eight pages from one IP pressing Public race: one room, 7/7 connected
  in 4.9 s, 0 × 429, ~30 requests per peer; two-page public race over WebRTC: B lands in A's room
  and drives car 1.

## Race mode

Race multiplayer runs through race mode's controller slots (`SlotKind = "player" | "ai" | "remote"`)
and the deterministic `RaceSession` (agreed with RaceLead):

- Host: `RaceDirector.setSeats(peerCars)` makes peers `remote` slots in the next field (named
  "Player N"); the AI fills the rest. Each input packet goes to `setRemoteInput(car, input)` (a
  seat with no input yet holds still on the grid, never AI-driven); an input's respawn bit calls
  `requestRespawn(car)` (the host's own menu or spectating never blocks a peer's request).
- Host → clients: the `RaceSnapshot` JSON (or, between races, the lobby countdown and course) as
  a `MSG.race` frame every 6th snapshot (5 Hz) and with each keyframe, ~1.2 KB for 4 cars.
- Client: `applySnapshot(snap, self)` restores the session and rebuilds the entrants: its own car
  becomes "You" (`player`), the host's "Host"; a new race seats it in drive mode, a peer not in the
  field (joined mid-race) spectates the leader until the next race. Clients never step the session,
  and only viewing commands reach the director (start, pause, end, options are the host's).
  Cars still come from the 30 Hz pose/wreck snapshots, as in Fleet.
- Measured (`.bench/net/race2.mjs`, two pages over WebRTC, oval, 1 lap, 3 AI): B lands in A's public
  room as car 1, the lobby ends, B's input drives car 1 on the host (168 m covered). The standings
  (order and laps of all 4 cars) agree on both pages in 21/21 samples every 2 s, and the final results
  are identical (place, laps, status).

## Derby mode

Derby multiplayer runs through the same controller-slot path as race (agreed with DerbyAI2):

- **Seats (host):** `NetGame.setSeats(peerCars)` stores the peers' cars. When a match begins,
  `spawnDerby` grows the field to hold them, seats them (`derbySeated`, named "Player N") and bumps
  the round. The AI loop in `fixedStep` skips `i === driven || derbySeated.has(i)`, and `net.drive`
  applies a peer's input only to a seated car the match has not counted out (`remoteDrivable`). A
  peer who leaves mid-match hands its car back to the AI. A peer who joins mid-match is not added
  to the running field: it watches until the next match.
- **Arena:** the host's `derbyRadius(field)`; the radius rides in the derby message, so the client
  scales the same bowl even while the field changes size in a lobby.
- **Match state (host → clients):** `MSG.derby` (`writeDerby` / `readDerby` in `codec.ts`) every 6th
  snapshot (5 Hz) and with each keyframe: 22 bytes plus 9 + name length per car (110–120 bytes for the
  6-car smoke field, computed from the layout). It carries:
  - round, active, match time, winner hold, radius;
  - the seats bitmask;
  - winner id, winner name and how it was decided;
  - the public lobby countdown;
  - each board row: id, name, score, hits, disables, alive, out, count-out clock (0.1 s).
- **Client:** never steps `DerbyMatch`. It copies the state onto its own match (board, result,
  clock), labelling its row "You" and the host's car "Host". A new round puts it in drive mode in its
  seat, or spectating if the host did not seat it. The cars themselves come from the 30 Hz
  pose/wreck snapshots, as in Fleet.
- **Public derby:** the Net panel's "Public derby" button lists `pub-derby-…` rooms
  (`?list=public&kind=derby`) or hosts one. The lone host waits `LOBBY_S` = 15 s with a 6-car field
  parked and no match, then the match starts with peers seated and AI in the other seats. A decided
  match is followed by the next one (engine loop at 4.4 s, or 12 s after the result at the latest).
- **Measured** (`.bench/net/derby2.mjs`, two pages over WebRTC): B lands in A's public derby as
  car 1, spectates the lobby, and is seated in drive mode when the match starts. Every 2 s, B's board
  was compared with A's taken 0.4 s before or after (B renders up to ~0.3 s behind); per car the
  score, alive, out and the standings order agreed in 93/93 samples over the 197 s match. Both pages
  report the same winner (car 4, decided at the time limit). B held W and weaved; its car moved up
  to 11 m from its spawn on the host. Unit test: `net.test.ts` "netplay derby state" round-trips a
  running board, a decided match and a lobby through the codec.

## State APIs

Additive, allocation-free, at the end of each class; the caller preallocates the buffers.

`StreamedDeformation`:
```ts
interface DeformNetState {
  local; skinPos; skinXf; sensor; impact: Float32Array;
  popped: number; skinPopped: number; flags: number; engineTravel: number; killTravel: number;
}
netSizes(): { masses: number; clusters: number; sensors: number }
readNetState(out: DeformNetState): void   // skin inputs from the last bake, current particles
writeNetState(src: DeformNetState, group: THREE.Object3D, geometry: THREE.BufferGeometry): void
```
`bakeLocalSkin` now runs in both modes (lattice copies only the particle positions) and keeps the
bake's `skinM`, impact, wrinkle, popped hubs and flags for `readNetState`.

`DeformableCar`:
```ts
interface PartNetState { flags: Uint8Array; hinge: Float32Array; pose: Float32Array; lamps: number; glass: number }
partNetSizes(): { parts: number; lamps: number; glass: number }
readPartNetState(out: PartNetState): void
writeNetState(deform: DeformNetState, parts: PartNetState): void // reparent without launch, FX or glass burst
netFrame(dt: number): void                                       // wheels, as afterContacts does
```
`CrashEngine`: `net` (`NetPlay`: `host(room, tx)`, `join(room, tx)`, `leave()`, `status()`),
`matchCar(i, style, cls)`; `fixedStep` calls `net.drive` after the local seat, `tickInner` skips
the fixed steps and `updateDeform` on a client and calls `net.frame` after them.
`P2PRoom`: `sendBinary(data, peerId?)` and `onBinary` (raw frames on the unreliable channel).

Loose wheels: `PartNetState.wheelLoose` (bit per wheel) and `wheels` (world pose per loose wheel)
ride in the wreck section; a client's `netFrame` never throws a wheel itself (`nudgeWheels(dt,
false)`). Clients never step contacts, so `partContactPair` never runs on net cars.

Fleet disc edge (EdgeFall): a car past the rim falls as a frozen fake 2 m down and vaporizes 20 m
down. Clients follow the host's pose of a falling car (roll is interpolated the short way round),
set `falling` so their `stepEdge` shrinks it, and take no wreck or wheel updates for it. A change
of `vaporized` calls `CrashEngine.setVaporized`, so each page plays the smoke burst itself. The host
brings back its own driven car and every network peer's car (`NetPlay.remoteCar`) 2 s after it
vaporizes. Measured (`.bench/net/edge2.mjs`, two pages over WebRTC): the host launched car 0 (its own)
and car 1 (B's) off opposite rims while B watched car 0. B saw each car fall at 2.0 s, vaporize at
3.6 s and come back at 5.6 s, 0.10–0.11 s after the host (1.9, 3.5, 5.5 s). On B, the falling car
shrank to scale 0.23 before it vanished.

## Prototype status (2026-10-01)

Code: `src/game/net/` (`transport.ts` `NetTransport` + `BroadcastTransport`, `rtc-transport.ts`,
`codec.ts`, `net-play.ts`, `net.test.ts`), `src/components/net-panel.tsx`, `src/routes/api/rtc.ts` +
`src/lib/multiplayer/signaling.server.ts` (the kit's reference relay).

Unit tests (`net.test.ts`): codec round trip within each quantization step, i16 clamping, input
round trip; a host car crashed into the wall (shape and lattice) replicated through the wire onto a
fresh car matches its skin within 2 mm, hulls within 1 mm, identical part/lamp/glass states and
graded damage; a client torn up by an earlier crash re-attaches its parts for the host's next wreck.

Smoke (`.bench/net/smoke.mjs` in the main checkout, two pages on `vite dev`, Fleet, host's car 0 a
muscle car, realism 0.6, auto-loop off, cars parked): B holds W; A sees B's car move within
100–700 ms and drive into A's car. After the wrecks settle, A vs B:

| Transport | Car | Particles max | 50 skin vertices max | Hull corners max | Parts, lamps, glass |
|---|---|---|---|---|---|
| BroadcastChannel | 0 / 1 | 0.37 / 0.41 mm | 0.30 / 0.29 mm | 0.11 / 0.28 mm | identical |
| WebRTC (two browser contexts, `/api/rtc` on PGLite) | 0 / 1 | 0.38 / 0.35 mm | 0.25 / 0.19 mm | 0.06 / 0.09 mm | identical |

Bodies (coupe, hatchback) and kill travel (0.340 / 0.310 m at realism 0.6) matched on both pages.
Measured payload, 2 cars: steady 1.96–2.07 KB/s at 28–30 Hz (estimate 70 B × 30 = 2.1 KB/s); both
cars crushing peaked at 42.3 KB/s (estimate 2.1 + 2 × 19.8 = 41.7 KB/s). Over WebRTC the host page
ran ~16 fps early on, so it sent 16–18 Hz (1.1–1.2 KB/s), peak 29.5 KB/s.

Known gaps: Fleet only (Derby AI and scene props are not synced and would double-drive remote
cars); no client prediction; host migration is spec only. Scene actions (play, reset, scenes, props,
car count, class) are no-ops on a client, and the pad's race pause goes through the client allowlist;
a client leaving the host's race or derby gets the fleet reset (disc ground, poles, props).

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
`.grok/skills/multiplayer-p2p`; two tables created on first use). It runs today on `vite dev`
against PGLite, and on Vercel against Neon once `DATABASE_URL` is set. The game code only sees
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
| Pose: `group.position`, yaw / pitch / roll, `velocity`, `angular.y`, `crashed`, body style + vehicle class | rigid placement; velocity for wheels; the body the client must build (a host's class pick rebuilds car 0) | u8 flags, u8 style/class, f32×3, i16×3 (1e-4 rad), i16×3 (0.01 m/s), i16 (1e-3 rad/s) | 28 |
| **Body**: the 20 control particles' current body-frame positions (`MassNode.local`), popped masses, `massActive`, `drivetrainAlive`, `engineTravel`, `killTravel` | the live hulls (`liveHulls` / `liveCrushHulls`) read only `local`, so these are the collision touchpoints; engine travel over kill travel (class × realism) is the graded damage | i16×60 (0.5 mm), u32, u8, i16×2 | 129 |
| **Skin**, as of the last skin bake: the particles (`massPos`), each shape cluster's skin map (`skinM`, 16 × 3×3), popped hubs, `deepCrush` / `bidirectional` / lattice; plus the 21 sensor compressions, impact point + inward axis, wrinkle amplitude, buckle, squash | `skin()` writes every vertex from exactly these. After the crush window closes the host mesh stays frozen at the last bake while `local` drifts and the shape-rest rebase resets every `skinM`, so the bake keeps its own copy (`bakeLocalSkin`) and the client re-skins from that | i16×60, i16×144 (1/8192), u32, i16×21, i16×9 | 472 |
| **Parts**: per detachable part (bumpers, bonnet, boot, doors, mirrors) detached / folding / latched, `hingeT`, door `theta`, `mirrorFold`; each loose part's world pose; lamp intact bits; glass pane states | part transforms and the panels' visibility | u8 + i16×3 per part, + f32×3 + i16×4 per loose part, u8, u16 | 59 + 20 per loose part |

Body + skin + parts form one **wreck section** (660 bytes + 20 per loose part), sent only for
`crashed` cars. Header: type u8, keyframe u8, seq u16, host time f64 (s), car count u8, realism u8
(the host's `HANDLING.realism`, which the client adopts) = 14 bytes. Input (client → host): type,
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

Payload per snapshot = 14 + 28 × cars while nobody is crushing; a car inside a crush window adds
660 bytes (+20 per loose part). WebRTC adds ~60 bytes per packet (IP/UDP/DTLS/SCTP).

| Cars | Steady payload | Steady @ 30 Hz incl. overhead | Steady @ 20 Hz | One car crushing @ 30 Hz | Keyframe, all crashed |
|---|---|---|---|---|---|
| 2 | 70 B | 3.9 KB/s | 2.6 KB/s | +19.8 KB/s | 1.4 KB |
| 8 | 238 B | 8.9 KB/s | 6.0 KB/s | +19.8 KB/s | 5.5 KB |
| 16 | 462 B | 15.7 KB/s | 10.4 KB/s | +19.8 KB/s | 11.0 KB |

The host uploads that once per client: 16 players at 30 Hz is ~235 KB/s (≈ 1.9 Mbit/s) steady and
spikes past 1 MB/s when several cars crush at once. So P2P hosting is for ≤ 8 players (the
template's own guidance); 16 needs 20 Hz plus a relay that fans out one upload (PartyKit room).
Keyframes stay under the 16 KiB safe DataChannel message size up to 16 cars (22 crashed cars with
loose parts would cross it; split per car then). Inputs cost 150 B/s per client. The host sends at
most one snapshot per rendered frame, so a host below 30 fps sends at its frame rate.

## Rooms, joining, migration

- **Room code**: 4 characters, typed or generated by the Net panel (top centre: Host / Join, link
  "Internet (WebRTC)" or "This browser (tabs)"), or from the URL: `?net=host&room=CODE`,
  `?net=join&room=CODE`, plus `&tx=bc` for the BroadcastChannel transport (default `rtc`).
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

## Race mode

Race (lane/race-mode) was built for this: every car takes one `DriveInput` per step from its slot
(`SlotKind = "player" | "ai" | "remote"`), and `RaceSession` is deterministic with
`snapshot()` / `RaceSession.restore()`. Agreed hooks with RaceLead:

- `RaceDirector.setRemoteInput(carId, input)` copies into a preallocated per-car `DriveInput`,
  applied in `drive()` for `kind === "remote"` (the Fleet prototype's `net.drive` becomes this call).
- `RaceDirector.snapshot()` / `applySnapshot(snap)`: the host sends the `RaceSnapshot` JSON on the
  reliable channel when it changes (lap, gate, event); clients render the HUD from it and never
  step the session. Track id travels in `assign`; tracks are JSON so both sides load the same course.

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

Merge notes: CR5's per-hub shove only moves `local`, which is already sent; when CR5's loose wheels
land, add their world poses next to the loose parts. Clients must not run `partContactPair` on net
cars (they never step contacts at all).

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
cars); the client's HUD phase, time scale and FX are its own (it sees the host's slow-mo in the
motion but not the readout); no client prediction; scene keys on a client act locally until the
next snapshot / keyframe; loose wheels (CR5) not yet carried; host migration is spec only.

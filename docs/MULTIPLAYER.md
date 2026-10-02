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
  onMessage: ((from: string, data: ArrayBuffer) => void) | null;
  send(data: ArrayBuffer, to?: string): void; // unreliable, unordered; to = one peer, else all
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
| Pose: `group.position`, yaw / pitch / roll, `velocity`, `angular.y`, `crashed` | rigid placement; velocity for wheels/FX | f32×3, i16×3 (1e-4 rad), i16×3 (0.01 m/s), i16 (1e-3 rad/s), u8 | 27 |
| **Body**: the 20 control particles' current body-frame positions (`MassNode.local`), popped hubs, `massActive`, `drivetrainAlive`, `deepCrush`, `bidirectional` | the live hulls (`liveHulls` / `liveCrushHulls`) read only `local`, so these are the collision touchpoints | i16×60 (0.5 mm), u32, u8 | 125 |
| **Skin**: the particles as of the last skin bake (`massPos`), each shape cluster's skin map (`skinM`, 16 × 3×3), 21 sensor compressions, impact point + inward axis, wrinkle amplitude, crush elapsed, buckle | `skin()` writes every vertex from exactly these; after the crush window closes the host mesh stays frozen at the last bake while `local` drifts a few cm, so the client must re-skin from the baked inputs, not the current particles | i16×60, i16×144 (1/8192), i16×21, i16×9 | 468 |
| **Parts**: per detachable part (bumpers, bonnet, boot, doors, mirrors) detached / folding / latched, `hingeT`, door `theta`, `mirrorFold`; each loose part's world pose; lamp intact bits; glass pane states | part transforms and the panels' visibility | u8 + i16×3 per part, + f32×3 + i16×4 per loose part, u8, u16 | 59 + 20 per loose part |

Host-only (never sent): masses' velocities and `world` (client sets `world = group · local`),
cluster plastic `Sp` and shape rests, beams, contact timers (`contactAt`, `lastContact`, `prevYaw`,
`rateYaw`), ContactParity's squeeze fields (`endAgo/endReach/endSqueeze`), door `omega` / `load`,
loose-part velocities. A client that becomes host (migration) needs these; see below.

Particles, skin and parts are sections with presence bits. A section rides along when its quantized
bytes changed within the last 3 snapshots (redundancy for lost packets), and in every **keyframe**
(1 Hz, and right after a join). In a keyframe a car that has never crashed carries pose only, and the
client restores the rest state for the omitted sections. Proper acked-baseline delta compression
(Gaffer) is the upgrade if crash bursts saturate links.

Interpolation: position, angles (shortest arc), velocity, particles, skin inputs and loose-part poses
lerp; flags and part states snap to the newer snapshot. Once snapshots stop changing the client sits
exactly on the host's last state, which is what the consistency target needs.

Packet header: type u8, flags u8 (keyframe), seq u16, host time f32 (s), car count u8 = 9 bytes.
Input packet (client → host): type, car, seq u16, throttle i8, steer i8, brake u8, bits u8 = 8 bytes.

### Bandwidth (estimate, per client, host → client)

Payload per snapshot = 9 + 29 × cars (2 bytes index/mask + 27 pose) while nobody is crushing; a car
inside a crush window adds 652 bytes (body + skin + parts). WebRTC adds ~60 bytes per packet
(IP/UDP/DTLS/SCTP).

| Cars | Steady payload | Steady @ 30 Hz incl. overhead | Steady @ 20 Hz | One car crushing @ 30 Hz | Keyframe, all crashed |
|---|---|---|---|---|---|
| 2 | 67 B | 3.8 KB/s | 2.5 KB/s | +19.6 KB/s | 1.4 KB |
| 8 | 241 B | 9.0 KB/s | 6.0 KB/s | +19.6 KB/s | 5.5 KB |
| 16 | 473 B | 16.0 KB/s | 10.7 KB/s | +19.6 KB/s | 10.9 KB |

The host uploads that once per client: 16 players at 30 Hz is ~240 KB/s (≈ 1.9 Mbit/s) steady and
spikes past 1 MB/s when several cars crush at once. So P2P hosting is for ≤ 8 players (the
template's own guidance); 16 needs 20 Hz plus a relay that fans out one upload (PartyKit room).
Keyframes stay well under the 16 KiB safe DataChannel message size up to 16 cars. Inputs cost
240 B/s per client. Measured numbers from the smoke test are below.

## Rooms, joining, migration

- **Room code**: 4-6 characters, typed or from `?room=`. Host: `?net=host&room=CODE`; join:
  `?net=join&room=CODE` (`&tx=bc` picks the BroadcastChannel transport, default `rtc`). The HUD's
  Net panel does the same with buttons.
- **Join**: client sends `hello`; host assigns the next free car index (`assign`: car, car count),
  the client sets its car count, follows and takes the wheel of that car, and the host's next
  snapshot is a keyframe. Join mid-session works the same: the keyframe carries every wreck.
- **Leave**: a peer missing from the transport roster frees its slot; the car goes back to the host
  (coasts in Fleet, AI in Derby/Race).
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

## State APIs (agreed with the owning lanes)

Additive, allocation-free, at the end of each class; the caller preallocates the buffers.

`StreamedDeformation` (CrashRealism5):
```ts
interface DeformNetState { local; skinPos; skinXf; sensor; impact: Float32Array; popped: number; flags: number }
netSizes(): { masses: number; clusters: number; sensors: number }
readNetState(out: DeformNetState): void
writeNetState(src: DeformNetState, group: THREE.Object3D, geometry: THREE.BufferGeometry): void
```
`DeformableCar` (ContactParity):
```ts
interface PartNetState { flags: Uint8Array; hinge: Float32Array; pose: Float32Array; lamps: Uint8Array; glass: Uint8Array }
partNetSizes(): { parts: number; lamps: number; glass: number }
readPartNetState(out: PartNetState): void
writePartNetState(src: PartNetState): void // reparent without impulse, FX or glass burst
applyNetDeform(): void                     // the updateDeform tail minus breakage
```

Merge notes: lane/crash-realism-5 adds `engineTravel`, per-hub shove and makes `deepCrush` a getter
over `frameCrush`; whichever lands second adds those to `DeformNetState` (impact slot + flags bit) and
reads/writes CR5's loose wheels next to the loose parts. Clients must not run ContactParity's
`partContactPair` on net cars.

## Prototype status

See the end of this file for the smoke results (filled in by the netplay lane).

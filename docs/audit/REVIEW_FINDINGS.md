# Review findings (coalesced)

Three independent read-only reviews of main 937e631 (2026-10-02): ReviewA, ReviewB, ReviewC. 61 findings, grouped by fix lane. IDs are reviewer letter + index into `agent://Review<X>/findings` (full body, evidence and line ranges). Findings raised by more than one reviewer are the strongest signal.

## NetRelay (11)

| id | P | conf | where | finding |
|---|---|---|---|---|
| A2 | 1 | 0.85 | `src/lib/multiplayer/rate-limit.ts:47` | Rate limiter fails closed for all new players once 20k buckets exist |
| A1 | 1 | 0.85 | `src/lib/multiplayer/signaling.server.ts:140` | Stop 8 low-sorting fake peer ids from locking every member out of a room |
| A3 | 1 | 0.8 | `src/lib/multiplayer/signaling.server.ts:169` | Authenticate peer ids on signal, leave and inbox poll |
| C2 | 1 | 0.85 | `src/lib/multiplayer/signaling.server.ts:172` | Authenticate relay peers: forged from/leave/GET grief any public room |
| B8 | 2 | 0.75 | `src/components/net-panel.tsx:40` | Validate ?net=host\|join&room= before auto-starting netplay |
| B7 | 2 | 0.75 | `src/lib/multiplayer/rate-limit.ts:37` | Rate limiter fails closed and lets anyone drain a room's shared bucket |
| C11 | 2 | 0.75 | `src/lib/multiplayer/rate-limit.ts:47` | Don't fail closed when the limiter's bucket map fills |
| A6 | 2 | 0.7 | `src/lib/multiplayer/signaling.server.ts:109` | Public match list can be filled with phantom rooms that outrank real ones |
| C10 | 2 | 0.6 | `src/lib/multiplayer/signaling.server.ts:143` | Make the room-capacity check atomic with the join |
| B6 | 2 | 0.75 | `src/lib/multiplayer/signaling.server.ts:172` | Signaling relay trusts client-supplied peer ids for leave, signal and the host tag |
| C17 | 3 | 0.65 | `src/components/net-panel.tsx:68` | Surface 'room full' and use a non-guessable private room code |

## NetSync (17)

| id | P | conf | where | finding |
|---|---|---|---|---|
| B3 | 1 | 0.85 | `src/game/engine.ts:1112` | Route pad Start/Back through raceCommand; netplay clients get stuck in pause |
| C3 | 1 | 0.8 | `src/game/net/net-play.ts:355` | Pin client-side assign/snapshot/race/derby to the host and validate values |
| A4 | 1 | 0.8 | `src/game/net/net-play.ts:401` | Host silently drops a guest's slot on a transient disconnect; guest never re-hellos |
| B2 | 1 | 0.8 | `src/game/net/net-play.ts:401` | A connection blip or host reload strands a guest as a spectator |
| C1 | 1 | 0.8 | `src/game/net/net-play.ts:401` | Re-assign a guest after a transient disconnect instead of orphaning it |
| B1 | 1 | 0.85 | `src/game/net/net-play.ts:561` | Netplay clients accept host messages from any peer; a 4-byte packet freezes snapshots |
| A9 | 2 | 0.7 | `src/game/engine.ts:238` | Netplay client exitRace leaves FLAT_GROUND and stale props in the sandbox |
| C8 | 2 | 0.7 | `src/game/engine.ts:1008` | Gate host-only scene actions on netplay clients |
| A8 | 2 | 0.75 | `src/game/net/net-play.ts:250` | Host Leave keeps netSeats; the next solo race/derby seats ghost 'remote' cars |
| B4 | 2 | 0.8 | `src/game/net/net-play.ts:250` | Host leave() keeps peer seats, so solo derby/race get dead 'Player N' cars |
| C5 | 2 | 0.85 | `src/game/net/net-play.ts:255` | Clear engine net seats in NetPlay.leave() |
| B5 | 2 | 0.7 | `src/game/net/net-play.ts:287` | Expire stale remote inputs on the host |
| C7 | 2 | 0.7 | `src/game/net/net-play.ts:288` | Expire stale guest input on the host and handle hidden tabs |
| A5 | 2 | 0.75 | `src/game/net/net-play.ts:355` | Client accepts assign/snapshot/race/derby from any peer, not just the host |
| A14 | 2 | 0.6 | `src/game/net/net-play.ts:564` | Snapshot gate and clock offset never recover from a restarted or odd host clock |
| C4 | 2 | 0.8 | `src/game/net/net-play.ts:580` | Recover a public-match client whose host leaves mid-session |
| B14 | 3 | 0.6 | `src/game/engine.ts:604` | Client-side scene toggles hide the host's cars permanently, contrary to docs |

## InputScene (16)

| id | P | conf | where | finding |
|---|---|---|---|---|
| A13 | 2 | 0.6 | `src/components/hud-controls.tsx:47` | RangeRow number box controlled by toFixed() mangles typed values |
| A12 | 2 | 0.75 | `src/components/use-pad-menu.ts:70` | Guard Escape with !e.repeat in usePadMenu so holding Esc doesn't close the pause menu |
| B12 | 2 | 0.75 | `src/components/use-stored-string.ts:18` | Guard localStorage in useStoredString; a throw blanks the HUD |
| A7 | 2 | 0.85 | `src/game/engine.ts:583` | B/K inside a race (full UI) or derby exits the scene without a sandbox reset |
| B11 | 2 | 0.75 | `src/game/engine.ts:583` | Barrier/Balls toggles leave derby or race without resetting the scene |
| C9 | 2 | 0.7 | `src/game/engine.ts:586` | Reset the scene when Barrier/Balls exit derby or race |
| B10 | 2 | 0.8 | `src/game/engine.ts:665` | A door ram above 15 km/h leaves the sim at 0.3× until reset |
| A11 | 2 | 0.85 | `src/game/engine.ts:972` | Ignore Ctrl/Meta/Alt-modified keys in the global hotkey handler |
| B9 | 2 | 0.85 | `src/game/engine.ts:972` | Skip game hotkeys when Ctrl, Cmd or Alt is held |
| C6 | 2 | 0.9 | `src/game/engine.ts:978` | Ignore Ctrl/Meta/Alt chords in the global hotkey handler |
| B17 | 3 | 0.55 | `src/components/race-hud.tsx:631` | Esc/B on Results or Standings silently abandons the campaign round |
| C21 | 3 | 0.6 | `src/components/use-pad-menu.ts:68` | Guard Escape against key repeat in usePadMenu |
| B16 | 3 | 0.75 | `src/game/engine.ts:710` | Entering derby permanently disables auto slow-mo |
| C15 | 3 | 0.85 | `src/game/engine.ts:713` | Restore autoSlomo when leaving derby |
| B20 | 3 | 0.6 | `src/game/engine.ts:857` | resetDefaults leaves Night, Wet and door side as they were |
| A15 | 3 | 0.7 | `src/game/engine.ts:973` | Treat SELECT (and contentEditable) as a text control in onKey |

## FxLeaks (5)

| id | P | conf | where | finding |
|---|---|---|---|---|
| A10 | 2 | 0.85 | `src/game/engine-fx.ts:142` | DebrisSystem shares one rotation/scale across all pieces and never hides dead ones |
| C14 | 3 | 0.85 | `src/game/car.ts:928` | Dispose detachable part meshes in DeformableCar.dispose() |
| C16 | 3 | 0.85 | `src/game/engine-fx.ts:123` | Allocate debris slots from a ring instead of resetting the batch |
| A16 | 3 | 0.6 | `src/game/engine.ts:475` | dispose() skips debris/props and leaves window.__crush pinning the engine |
| B15 | 3 | 0.75 | `src/game/engine.ts:1566` | Throttle puffEngine per car instead of emitting every frame |

## Owner (2)

| id | P | conf | where | finding |
|---|---|---|---|---|
| A17 | 3 | 0.7 | `.gitignore:14` | Third-party talk transcript, slides and paper PDFs tracked in a public repo |
| B21 | 3 | 0.6 | `src/lib/auth/preview.ts:19` | Public repo tracks a third-party paper PDF and a hard-coded OAuth client secret |

## TestsDocs (6)

| id | P | conf | where | finding |
|---|---|---|---|---|
| A18 | 3 | 0.85 | `docs/CODEMAPS/frontend.md:34` | Fix stale CODEMAP reference to net.publicRace() |
| C22 | 3 | 0.75 | `docs/MULTIPLAYER.md:82` | Update MULTIPLAYER.md wire sizes and HANDLING docs to match the code |
| B19 | 3 | 0.45 | `docs/MULTIPLAYER.md:118` | Keyframe size doc claim contradicts the 32-car cap and the missing split |
| C18 | 3 | 0.7 | `src/game/crash-parts.test.ts:220` | Assert that something detached before checking detached-part positions |
| C19 | 3 | 0.8 | `src/game/race/race-world.test-util.ts:210` | finishSweep's 'every seed' loop never uses the seed |
| B18 | 3 | 0.8 | `src/game/rest-mesh.test.ts:57` | rest-mesh test asserts its own write and rewrites a tracked file on every run |

## DeployHarden (4)

| id | P | conf | where | finding |
|---|---|---|---|---|
| C12 | 2 | 0.8 | `deploy/crush-deploy.sh:52` | Don't permanently blacklist a commit on a transient build failure |
| B13 | 2 | 0.7 | `deploy/crush-deploy.sh:94` | Deploy rollback is never health-checked and health() can run ~27 min |
| C13 | 2 | 0.8 | `deploy/crush-deploy.sh:111` | Gate auto-deploy on tests or a client smoke, not just server liveness |
| C20 | 3 | 0.8 | `deploy/crush-deploy.sh:88` | First deploy has no rollback and crash-loops a bad release |


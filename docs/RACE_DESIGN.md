# Race mode design

Circuit racing on top of the crash sandbox: 2–16 cars, 1–5 laps (menu 3–5), hidden checkpoint
gates, designed shortcuts, respawn or no-reset elimination, AI racers with an aggression dial,
an arcade HUD, controller-driven menus, and a campaign over every course.
Research leads: `.extraResearch/perplexity/23-race-checkpoints-laps.md` (gates, key checkpoints,
progress ranking, respawn anchors, authoritative state) and `24-racing-ai.md` (pure pursuit,
curvature speed planning, aggression).

## Module map

| Module | Owns | DOM / THREE |
|---|---|---|
| `src/game/ground.ts` | `Ground` (height, normal, grip at x,z), `FLAT_GROUND`, `activeGround()`, `setGround()` | none |
| `src/game/race/catalog.ts` | surface table (grip, top speed, colour), prefab specs (body, collider, size, mass) | none |
| `src/game/race/track-schema.ts` | zod schema of the track JSON, `parseTrack`, `TrackJson` / `TrackFile` types | none |
| `src/game/race/track.ts` | `Track`: arc-length samples, gates, start grid, projection, wall clip; `TrackGround` heightfield | THREE maths only |
| `src/game/race/tracks/*.json`, `tracks/index.ts` | the courses; `TRACKS` registry and `CAMPAIGN` order | none |
| `src/game/race/types.ts` | race contracts: entrants, options, poses, records, events, snapshot, HUD, commands | none |
| `src/game/race/session.ts` | `RaceSession`: the rules (state machine, gates, laps, ranking, wrong way, respawn, elimination, results) | none |
| `src/game/race/campaign.ts` | `Campaign`: points, standings, next grid | none |
| `src/game/race/race-ai.ts` | `RaceBrain`: racing-line driver with aggression | none |
| `src/game/race/traffic.ts` | NPC world traffic on lanes (city) | none |
| `src/game/race/track-art.ts`, `prefabs.ts`, `obstacles.ts` | road / wall / terrain meshes, prefab meshes, start gantry lights; solid + knockable obstacle colliders | THREE |
| `src/game/engine-race.ts` | `RaceDirector`: glue between `CrashEngine`, the session, brains, seat, art, HUD | THREE |
| `src/components/race-hud.tsx`, `use-pad-menu.ts` | overlays and menus; gamepad / keyboard menu navigation | DOM |

Rules, campaign, AI and traffic never import THREE scene code or the DOM, so a server or a peer
can run them headless.

## Race state machine

```
            open                 start / retry / next
 (scene) ──────► setup menu ─────────────────────────► grid ──1.5 s──► countdown ──3 s──► racing
                                                                                        │
          results menu ◄── over (all finished/out, or 30 s after the winner, or End) ◄─┘
            │ retry → same course · next → next course (campaign: standings menu first)
```
`time` is the race clock: −4.5 at grid, −3 when the countdown starts, 0 at green. Start lights
(`startLights(time)`): red over [−3, −1), yellow over [−1, 0), green from 0 for 1.5 s, else off.
Cars are held (brake, no throttle) until green.

## Per-car record (`CarRecord`)
`lap` (completed), `next` (next main gate), `armed` (crossed the line once), `route` / `routeNext`
(shortcut being driven), `progress` (m), `place`, `lapStart`, `lapTimes[]`, `bestLap`,
`finishTime`, `outTime`, `wrongWay`, `respawnAt`, `deaths`, `status`
(`racing | respawning | finished | out | dnf`).

## Checkpoints, laps, shortcuts
- Main chain: gates `0..N-1` in driving order; gate 0 is the start/finish line at node 0 (s = 0).
  A gate is a segment across the road plus runoff, crossed forward only (move · tangent > 0);
  the crossing time is interpolated inside the step.
- The grid sits behind gate 0. The first crossing only arms the car (`next` → 1); lap 1 is timed
  from green.
- Crossing gate `next` advances `next`. Crossing gate 0 with `next == 0` completes a lap. Other
  gates are ignored, so cutting across the infield gains nothing: the skipped gate is still `next`.
- Designed shortcut `{from, to, path}`: a car whose last passed gate is `from` (`next == from+1`)
  and crosses the shortcut's entry gate starts the route; its gates (one per path point) must be
  crossed in order; the exit gate sets `next = to`. Crossing main gate `from+1` instead abandons it.
- Ranking distance: `progress = lap·L + s'`, where `s'` is the projected arc length clamped
  between the last passed gate and `next` (between `from` and `to` on a shortcut), unwrapped
  across the line. Before arming, `s' = s − L` (negative).

## Positions
Order: finished cars by finish time; then racing / respawning / dnf by `progress` (desc); then
out cars by `outTime` (later = better). Ties fall to the grid order, so the order is total and
deterministic.

## Wrong way
At the car's projection, `c = heading · tangent`. While `c < −0.3` and speed > 1.5 m/s the timer
grows; otherwise it decays at twice the rate. `wrongWay` turns on at 0.7 s and off at 0.

## Death, respawn, elimination
- The host reports `alive = false` when the drivetrain is dead, or the car has been upside down or
  wedged for 3 s. A player may also ask (`R` / D-pad down) for a respawn: 1.5 s.
- Default: `status = respawning`, `respawnAt = time + 3`. When it fires the session emits
  `respawn {x, z, yaw}`: on the main centreline at the car's clamped progress, never past `next`
  (≥ 3 m short of it), facing the tangent, with a 6 m clearance from every other car (tries the
  centre, then ±¼ width, then steps back 6 m, up to 12 tries). The host repairs the car there.
- No-reset: a death is final, `status = out`, `outTime = time`. Respawn requests are refused.

## Winning and the end
- First car over the line on its last lap wins (`winBy = laps`); the others keep racing until all
  are finished or out, or 30 s after the winner; anyone still running is `dnf`.
- No-reset: when one car is left that is neither out nor finished and nobody has finished, it wins
  at once (`winBy = survival`) and the race is over. With one entrant this rule is off.
- `end()` (End button) closes the race now; running cars become `dnf`.
- Results: place, name, status, finish time, gap to the winner, best lap, laps.

## Spectate
When the local player is out (no-reset) the dead menu offers Restart, End race and Spectate.
Spectating follows the live cars (LB/RB, Q/E, ←/→, or click a standings name); the seat can never
take the wheel: `DriverSeat` drives only a car whose controller slot is this browser's player.
While the player is still racing the camera stays on their car.

## Campaign
`CAMPAIGN = ["oval", "rally", "city"]`. Points per place: 10, 8, 6, 5, 4, 3, 2, 1 (9th on, out, dnf: 0).
Standings sort by points, then wins, then the better place in the latest round, then id. Round 1's
grid is the entrant order (player at the back); each later grid is the standings order (leader on
pole). The standings menu shows after every round; the champion after the last.

## Controller slots and multiplayer
Every car is driven through one `DriveInput` per step, chosen by its slot: `player` (this
browser's `DriverSeat`), `ai` (`RaceBrain`), `remote` (inputs received from a peer, applied the
same way). The rules only see `CarPose`s and never ask who drives. Race state is a plain JSON
`RaceSnapshot`; the HUD only reads `RaceHud` and sends `RaceCommand`s. A later host-authoritative
mode runs `RaceSession` on the host, takes peers' `DriveInput`s over `src/lib/multiplayer`
`P2PRoom`, and broadcasts snapshots; nothing in the rules assumes a single local player.

## Ground
```ts
interface Ground {
  heightAt(x, z): number;
  normalAt(x, z, out): out;   // unit up-normal
  frictionAt(x, z): number;   // grip × today's μ (1 = asphalt)
}
```
`FLAT_GROUND` returns y = 0, +Y, 1: identical to the pre-race code. A race calls
`setGround(track.ground())` and restores `null` on exit. `TrackGround` bakes a 1 m heightfield over
the track bounds: the banked road plane, flat shoulders over the runoff, then a smoothstep back to
the base terrain (gaussian `hills`) over 24 m; surfaces come from the nearest corridor (road, runoff,
or terrain). Wiring into the mass clamps / friction (`streamed-deform.ts`, `followGroup`,
`bleedAfterSlide`) lands after lane/crash-realism-5 merges; until then courses stay flat.

Surface effect while driving (race glue): steer × (0.45 + 0.55·grip), top speed × `speed`.

## Track JSON
One file per course in `src/game/race/tracks/`. Validated by `parseTrack` (zod), which fills the
defaults below and reports every problem as `path: message`.

| Field | Type / default | Meaning |
|---|---|---|
| `id`, `name`, `blurb` | string | `id` is `[a-z0-9-]+` |
| `laps` | int 1–9 = 3 | default lap count |
| `road` | `{ width = 14, surface = "asphalt", runoff = [4, 4], runoffSurface = "grass", wall = [true, true], wallHeight = 1.1 }` | defaults for node 0 |
| `nodes[]` | `{ x, z, y?, width?, bank = 0, surface?, runoff?, runoffSurface?, wall? }`, ≥ 4 | closed centripetal Catmull-Rom in driving order. Omitted fields inherit the previous node; `bank` (deg, > 0 raises the right edge) does not. Flags (`wall`, surfaces) hold from a node to the next. Turn radius must exceed the inner corridor half-width |
| `checkpoints[]` | `{ node, t = 0 }`, ≥ 3 | main gates in order; checkpoint 0 must be node 0, t 0 |
| `shortcuts[]` | `{ id, from, to, width = 7, surface = "dirt", path: [{x, z, y?}] }` | designed route skipping checkpoints between `from` and `to`; open the main walls (`wall: [false, …]`) at its mouths |
| `grid` | `{ perRow = 2, spacing = 8, back = 6 }` | staggered slots behind the line |
| `props[]` | `{ prefab, x, z, yaw = 0, scale = 1, size? }` | placed prefabs (collide per catalog) |
| `along[]` | `{ prefab, every, side = "both", offset = 1.5, fromNode?, toNode?, scale = 1 }` | repeated beside the wall line |
| `scatter[]` | `{ prefab, count, near = 6, far = 60, seed = 1, scaleMin = 0.8, scaleMax = 1.25 }` | seeded scenery in a band outside the wall line |
| `traffic` | `{ count, speed = 9, lanes: [{ offset, dir: 1 | -1 }] }`? | NPC cars on lateral lanes of the main loop |
| `environment` | `{ sky = "#12141a", fog = 0.0035, terrain = "grass", hills: [{x, z, radius, height}] }` | look and base terrain |

Surfaces: `asphalt, concrete, cobble, dirt, gravel, grass, sand`. Prefabs: `cone, tyre-stack,
hay-bale, crate` (knock), `barrier-block, rock, tree, building, grandstand, billboard, lamp`
(solid), `gantry` (scenery; one is placed over the start line automatically).

## Engine integration
`RaceDirector` (`engine-race.ts`) is a scene next to derby: `setRace(on)` hides the studio floor,
lamp ring and derby arena, sets the sky, fog, far plane, sun follow and ground; spawns the field on
the grid; per physics step drives each car from its slot (held before green), clips cars to walls
and obstacles, and per frame steps the session, runs respawns, mirrors the start lights on the
gantry and publishes `hud.race`. Engine hunks: one scene branch in each toggle / reset / step /
HUD site, the `Race` picker entry, and the seat gate.

## HUD and controller menus
Countdown lights (red/yellow/green + 3-2-1-GO), position `P3/8`, lap `2/3`, current / last / best
lap, total time, speed, wrong-way banner, respawn countdown, live standings (names are buttons for
spectating), finish card with splits to the cars around, results leaderboard (Retry / Next course),
dead menu (Restart / End race / Spectate), pause menu, setup menu (course, laps 3–5, no-reset, AI
count, aggression, Start, Campaign), campaign standings. Menus take focus; D-pad / left stick move
focus spatially, ←/→ adjust a focused option, A confirms, B goes back, Start pauses.

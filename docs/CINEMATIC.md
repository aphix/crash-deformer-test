# Cinematic FX

Visual and camera effects that read sim state only. Nothing here feeds back into the physics, so the
physics tests are unchanged. The only sim-side effect is the hit-stop, which scales the sim clock
(`timeWarp`) for 0.09 s on the driven car's big hits, the same way slow-mo already does.

**Tiers.** Choose them with HUD Playback → FX `off / minimal / low / high`, the `F` key (cycles), or `?fx=off|minimal|low|high` in the URL (for bench A/B). The default is `minimal` (Defaults restores it); `low` and `high` stay selectable.
- `off`: the renderer draws straight to the canvas. There's no post chain, no mark map, no crash cam, no hit punch, and no tyre smoke from slip. Sparks and glass use the plain look.
- `minimal`: the same straight-to-canvas render as `off` (no HDR target, bloom, grade, vignette, grain or blur; flash, chromatic punch and letterbox need the composite, so they don't show), plus every effect that needs no post: tyre marks (1024² map), tyre smoke and slip sparks, shake and FOV kick, hit-stop, crash-cam cuts. Sparks and glass use the plain look (no streaks, no HDR glow). A fixed-seed capture of `minimal` is identical to `off` (max channel difference 0).
- Every tier's programs and both outputs (canvas, HDR target) are linked and drawn once at boot and when a race course loads, so a tier switch or a race never links a program (`docs/PERF_HITCH.md`).
- `prefers-reduced-motion`: no shake, flash, chromatic punch, radial blur or crash-cam moves at any tier. The crash-cam cuts still happen but hold still.

Keys: `F` FX tier · `H` night · `X` wet asphalt (also HUD Playback → Night / Wet).

| Effect | Module | Tier | Cost (see bench) |
|---|---|---|---|
| HDR scene target (half-float, MSAA when the canvas had it; allocated once, resized with the canvas) + one composite pass: ACES tone map, display-space grade (saturation, warm-high / cool-low split tone, end-preserving S-curve), vignette | `engine-post.ts` `PostFX` | low, high | one full-screen pass |
| Bloom: dual-filter (Kawase) mip chain. Threshold 1.6 linear with a narrow knee, so only values above 1.44 bloom: sparks, glass, night lamp heads | `engine-post.ts` | low (3 mips from ¼ res), high (5 mips from ½ res) | 2×mips small passes |
| Car paint highlight cap: car body, trim and parts materials roll their linear radiance off above 0.7 to at most 1.1. Lit paint (sun specular, clearcoat, other cars' headlamps up close) then never blooms, and it tone-maps to ≤ ~240/255. Before the cap, a white body reached 14 linear and a fifth of it rendered near-white | `car-mesh.ts` `capHighlights` | all | 4 ALU ops per car fragment |
| Film grain (display space) | `engine-post.ts` | high | in composite |
| Boost radial blur toward screen centre (driven car above top speed) | `engine-post.ts` + `engine-cine.ts` | high | 7 extra taps, only while boosting |
| Impact punch: FOV kick, shake (trauma), exposure flash, chromatic split + vignette squeeze, scaled by impulse (flash and chromatic split are composite effects: low, high only) | `engine-cine.ts` `kick` | minimal, low, high | uniforms only |
| Hit-stop: 0.09 s at 5 % sim rate on the driven car's hits (one-frame Δv > ~7 m/s) | `engine-cine.ts` | minimal, low, high | none |
| Crash cam: after the first impact of a fleet / barrier / balls run, three cut angles in the slow-mo (low bumper cam, rising crane, long lens) with 2.39:1 letterbox (low, high), then back to the orbit. Skipped when the user framed the shot, is driving, set a fixed time scale, or turned auto slow-mo off | `engine-cine.ts` `direct` | minimal, low, high | none |
| Tyre marks: one ground-aligned mark map (2048² high, 1024² minimal and low, RGBA8, mipmapped, created once and resized in place) stamped by one quad per slipping wheel per frame in an offscreen pass, sampled by the ground material (darkens albedo and kills the grazing specular). R rubber (asphalt, concrete, cobble), G rut (dirt, gravel, sand, bare hub scrape), B torn turf (grass), keyed by `activeGround().surfaceAt`. Slow subtractive fade (one 8-bit step per 0.6 s). Cleared on scene reset and on `setMarkBounds` | `engine-marks.ts` `SkidMarks` | minimal, low, high | constant: ≤ 1 small draw per frame with slip, 0 without |
| Slip signal: Handling's `car.drive.spin / lock / slide` per car, plus the rear wheels' measured sideways speed for driverless wrecks; thresholds scale with `frictionAt`. A boost launch also spins the rears up to ~14 m/s, eased out (a visual cheat), so it lays two tapering stripes. A wheel off its hub marks nothing; a bare hub low and moving cuts a thin groove and throws sparks | `engine-marks.ts` | minimal, low, high | 4 wheel transforms per car |
| Tyre smoke from slip (thin, wide, slow-rising puffs; dust-tinted on ruts, turf-tinted on grass), separate instanced system | `engine-cine.ts`, `engine-fx.ts` `TireSmokeSystem(…, soft)` | minimal, low, high | one instanced draw while alive |
| Spark streaks (additive line from each spark back along its velocity) and HDR spark / glass colour for bloom | `engine-fx.ts` `SparkSystem.streaked`, `glow()` | low, high | one line draw while sparks live |
| Distance detail: past 35 m from the camera a car (never the followed one) drops the small parts that cast no shadow (lamp housings, trims, grille, mirrors, door linings: 16 of its 24 draws); back within 32 m they return. Near the camera the frame is unchanged (fixed-seed capture: max channel difference 0) | `engine.ts` `cullFarDetail` | all | none; 9–32 fewer draw calls a frame in races (main low → lane minimal) |
| Limping engine smoke (thin thread at `damageStage === "limping"`; dead engines keep the heavier trail) | `engine.ts` tick | all | particle spawns only |
| Night: moonlight, dark sky, bloomed pole heads, additive fake light pools under intact poles (a toppled pole's pool goes out). Sky, ambient, sun, fill, env and smoke go `WorldStage.nightDepth` = 72 % of the way from day to full night (full night read too dark; 62–83 % is the agreed range; mean frame luminance day 0.0199, full night 0.0045, 72 % 0.0074) | `engine-world.ts` `WorldStage` | all | 6 decal quads at night |
| Wet asphalt: a satin sheen (roughness 0.38, no metalness) on the dry albedo; marks stay matte. The old mirror (roughness 0.2, env ×1.8, darker albedo) glared: ground luminance +35 % vs dry, now +16 %, car/ground contrast 2.67 (dry 2.47) | `engine-world.ts` | all | none |

## Thrown drivers (ragdolls)
A driver flies out of a car on a disabling hit: through the windshield on a head-on, or through the struck side's front window on a side hit. Nothing is thrown on a rear hit, a scrape, or a hit that leaves the car sound. The dummy is cosmetic and local: no dummy state enters the sim or the snapshots.
- **Trigger** (`ragdoll-trigger.ts` `EjectionWatch`), once per car per run, on the edge where the car is disabled: its drivetrain dies (a derby kill or wreck, a race DNF by damage), or its engine block is packed back past the kill travel of the slider's realistic end (`killTravel(class, 1, ctx)`: the sourced 0.15 m × durability, × the derby scale in a derby). The second edge is a hit that would disable a real car: at the HUD's default realism (0.25) a fleet sedan only dies at 0.45 m of travel and one head-on tops out at 0.36 m, so no single sandbox or race hit ever kills (by design; the sim is untouched). The hit must be head-on or from a side (`impactInward`), and the peak closing speed over the 0.35 s before it must be at least 6 m/s. Everything it reads (drivetrain flag, `engineTravel`, impact, poses, velocities) is replicated, so a netplay client decides the same way as the host.
- **Rate at default settings** (lane ragdoll-4's headless sweep): fleet 2 cars at 0–32 m/s, 8 of 20 resets throw both drivers (closing ≥ 31 m/s); derby 6 cars 0.36–1.47 per minute over three heats, 2 cars none in 3 × 90 s (no car is ever disabled); city race (4 AI, seed 1) 1 in 71 s.
- **Body** (`engine-ragdoll.ts` `RagdollSystem`): its own Rapier world (`rapier.ts` `loadRapier`, the game's one `@dimforge/rapier3d` 0.19.3: its own chunk plus a separate `.wasm`, 618 kB over the wire). It loads in the background once `CrashEngine.ready` resolves; boot never waits for it. A throw judged before it is in waits for it up to 1 s of sim, then is dropped.
  - 4 pooled 10-box dummies on spherical joints; a fifth throw recycles the oldest. Each lives 10 s. Drawn as one instanced mesh (`ragdoll-mesh.ts` `DummyMesh`): a rounded unit box scaled per part (capsule limbs, rounded head), instance colours for a dark tee, jeans, skin and short dark hair, plus render-only hands, shoes, hair, hips, shoulders and neck posed from their bodies. No texture, no new program.
  - Off a course, the ground (flat pad or disc) and the derby bowl wall are fixed colliders built once at a run's first throw and shared by every dummy; on a course, each throw gets a heightfield patch and the walls near it.
  - Every car (and the jersey barrier) is a kinematic box pair (bumper to bonnet line, then the cabin) that follows its pose: cars push dummies, and nothing pushes back.
  - A dummy's own parts collide with each other except jointed neighbours, and dummies collide with each other. For its first 0.35 s it ignores its own car's cabin (it starts inside it), every car's lower box (a crushed pair's rest-size noses reach past the real ones) and the other dummies; every other car's cabin it hits from the first frame.
- **Glass**: the authority (host or offline) smashes the exit pane with `smashGlass` at the hit, and clients take it from the glass bits.
- **Cosmetic**: the cars never feel a dummy; sim digests are identical with ragdolls on and off (`ragdoll-trigger.test.ts`, and the sweep's fleet, derby and race runs).
- **Sandbox only** (neither a race nor a derby): the camera rides with every dummy still moving (a head-on's two together, pulled back to fit them) unless it follows another car or the user framed the shot, until they all lie still. The hit's clock, slow-mo, letterbox and post effects run on under the ride; the ride only takes the camera's position.
- **Range scene** (`scenes/range.ts`, art in `present/range-art.ts`, HUD Range button): FlatOut's driver-flinging event. Car A runs up 40 m at 100 km/h into the jersey barrier (hood height); the hit throws its driver over it into a sand field (the flat ground's friction 0.5 wins over the dummy's 0.12) with a numbered sign every 10 m to 100 m. The camera watches him from behind until he lies still, the HUD shows the distance (live, then landed), and with Loop on the next run starts 3 s later. The art is built on first entry and warmed then, never at boot.
- The jointed body follows Matthias von Bargen's [rapierjs-ragdoll](https://github.com/mattvb91/rapierjs-ragdoll) (MIT License; the notice is in the `engine-ragdoll.ts` header).

## Race tracks
`engine-marks.ts` exports `markMapUniforms`, `applyMarkMap(material)` and `setMarkBounds(minX, minZ, maxX, maxZ)`.
- A track's road, runoff and terrain materials call `applyMarkMap` once. It samples by world xz, so it works on hilly courses.
- `RaceDirector` calls `setMarkBounds(track.bounds…)` on load, and the sandbox rect (±48 m) on exit. Either call also clears the map.

## Bench
Run the A/B on the same build with `scripts/bench-browser.mjs --url "<dev url>/?fx=off"` against the default URL (high tier).

The first A/B (2026-10-01, RTX 4080 via d3d12) ran at load average 35–70 from another project. Even the `off` tier swung from 3.6 to 14.8 fps between two back-to-back runs, so those numbers can't resolve the +1.5 ms budget.

The draw-call delta is stable:
- post chain: +11 calls (scene RT, 5 + 4 bloom passes, composite) at high;
- streaks and tyre smoke: +1 each while alive;
- mark stamp: ≤ +1 per frame with slip.

Re-measure on a quiet box.

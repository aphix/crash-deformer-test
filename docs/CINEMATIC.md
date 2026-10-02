# Cinematic FX

Visual and camera effects that read sim state only. Nothing here feeds back into the physics, so the
physics tests are unchanged. The only sim-side effect is the hit-stop, which scales the sim clock
(`timeWarp`) for 0.09 s on the driven car's big hits, the same way slow-mo already does.

**Tiers.** Choose them with HUD Playback → FX `off / low / high`, the `F` key (cycles), or `?fx=off|low|high` in the URL (for bench A/B). The default is `high`.
- `off`: the renderer draws straight to the canvas as before. There's no post chain, no mark map, no crash cam, no hit punch, and no tyre smoke from slip. Sparks and glass use the plain look.
- `prefers-reduced-motion`: no shake, flash, chromatic punch, radial blur or crash-cam moves at any tier. The crash-cam cuts still happen but hold still.

Keys: `F` FX tier · `H` night · `X` wet asphalt (also HUD Playback → Night / Wet).

| Effect | Module | Tier | Cost (see bench) |
|---|---|---|---|
| HDR scene target (half-float, MSAA when the canvas had it) + one composite pass: ACES tone map, display-space grade (saturation, warm-high / cool-low split tone, end-preserving S-curve), vignette | `engine-post.ts` `PostFX` | low, high | one full-screen pass |
| Bloom: dual-filter (Kawase) mip chain. Threshold 1.6 linear with a narrow knee, so only values above 1.44 bloom: sparks, glass, night lamp heads | `engine-post.ts` | low (3 mips from ¼ res), high (5 mips from ½ res) | 2×mips small passes |
| Car paint highlight cap: car body, trim and parts materials roll their linear radiance off above 0.7 to at most 1.1. Lit paint (sun specular, clearcoat, other cars' headlamps up close) then never blooms, and it tone-maps to ≤ ~240/255. Before the cap, a white body reached 14 linear and a fifth of it rendered near-white | `car-mesh.ts` `capHighlights` | all | 4 ALU ops per car fragment |
| Film grain (display space) | `engine-post.ts` | high | in composite |
| Boost radial blur toward screen centre (driven car above top speed) | `engine-post.ts` + `engine-cine.ts` | high | 7 extra taps, only while boosting |
| Impact punch: FOV kick, shake (trauma), exposure flash, chromatic split + vignette squeeze, scaled by impulse | `engine-cine.ts` `kick` | low, high | uniforms only |
| Hit-stop: 0.09 s at 5 % sim rate on the driven car's hits (one-frame Δv > ~7 m/s) | `engine-cine.ts` | low, high | none |
| Crash cam: after the first impact of a fleet / barrier / balls run, three cut angles in the slow-mo (low bumper cam, rising crane, long lens) with 2.39:1 letterbox, then back to the orbit. Skipped when the user framed the shot, is driving, set a fixed time scale, or turned auto slow-mo off | `engine-cine.ts` `direct` | low, high | none |
| Tyre marks: one ground-aligned mark map (2048² high, 1024² low, RGBA8, mipmapped) stamped by one quad per slipping wheel per frame in an offscreen pass, sampled by the ground material (darkens albedo and kills the grazing specular). R rubber (asphalt, concrete, cobble), G rut (dirt, gravel, sand, bare hub scrape), B torn turf (grass), keyed by `activeGround().surfaceAt`. Slow subtractive fade (one 8-bit step per 0.6 s). Cleared on scene reset and on `setMarkBounds` | `engine-marks.ts` `SkidMarks` | low, high | constant: ≤ 1 small draw per frame with slip, 0 without |
| Slip signal: Handling's `car.drive.spin / lock / slide` per car, plus the rear wheels' measured sideways speed for driverless wrecks; thresholds scale with `frictionAt`. A boost launch also spins the rears up to ~14 m/s, eased out (a visual cheat), so it lays two tapering stripes. A wheel off its hub marks nothing; a bare hub low and moving cuts a thin groove and throws sparks | `engine-marks.ts` | low, high | 4 wheel transforms per car |
| Tyre smoke from slip (thin, wide, slow-rising puffs; dust-tinted on ruts, turf-tinted on grass), separate instanced system | `engine-cine.ts`, `engine-fx.ts` `TireSmokeSystem(…, soft)` | low, high | one instanced draw while alive |
| Spark streaks (additive line from each spark back along its velocity) and HDR spark / glass colour for bloom | `engine-fx.ts` `SparkSystem.streaked`, `glow()` | low, high | one line draw while sparks live |
| Limping engine smoke (thin thread at `damageStage === "limping"`; dead engines keep the heavier trail) | `engine.ts` tick | all | particle spawns only |
| Night: moonlight, dark sky, bloomed pole heads, additive fake light pools under intact poles (a toppled pole's pool goes out) | `engine-world.ts` `WorldStage` | all | 6 decal quads at night |
| Wet asphalt: glossy, darker ground; marks stay matte | `engine-world.ts` | all | none |

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

# Research cache

Start with `SYNTHESIS.md`: the cross-paper list of verified defects, the particle
density/LoD decision, realism and perf items, each traced to its source analyses.

Saved answers so later passes don't re-query. `perplexity/` holds raw Perplexity
(`sonar`) answers with their source lists, fetched 2026-10-01 via
`~/.claude/skills/ask/perplexityWithSourcesFormattedIntoSingleResponse.cjs`.
Treat model-written prose as leads, not facts; cite the listed sources.

| File | Question |
|------|----------|
| `perplexity/01-shape-match-perf.md` | Faster/robuster shape matching: Müller 2016 rotation extraction, McAdams 3×3 SVD, FastLSM, XPBD shape constraints |
| `perplexity/02-bugbear-wreckfest.md` | Bugbear FlatOut/Wreckfest damage model, Rajala 2008, detachable parts, hinges, rigid-body coupling |
| `perplexity/03-burnout-deform.md` | Criterion Burnout deformation; BeamNG node-beam model (beam types, deform/break thresholds) |
| `perplexity/04-real-car-structure.md` | Real body-in-white crash structure: rail crush force, crush distance, cell intrusion, roof/torsional stiffness, detaching parts |
| `perplexity/05-derby-ai.md` | Demolition-derby / vehicle-combat AI: targeting, ramming angles, reverse-ram, stuck recovery, dogpile avoidance |
| `perplexity/06-plasticity.md` | Plasticity for shape matching incl. rotation; metal vs jelly; stiffness by iteration; inversion/volume guards |
| `perplexity/07-three-perf.md` | three.js perf for many CPU-deformed meshes: partial uploads, normals, shadows, instancing, workers |
| `perplexity/08-car-mesh.md` | Procedural car body lofting for hatch/sedan/pickup/van/coupe, panels, arches, vertex density |
| `perplexity/09-frontal-crush-pulse-intrusion.md` | Frontal crush pulse, crush depth and cabin intrusion targets (RigAnalysis lane) |
| `perplexity/10-side-rear-roof-intrusion.md` | Side/rear/roof intrusion and strength targets (RigAnalysis lane) |
| `perplexity/11-rear-roof-side-stiffness.md` | Rear, roof and side structure stiffness (RigAnalysis lane) |
| `perplexity/12-detach-part-thresholds.md` | Which parts detach and at what loads: bumper covers, mirrors, doors, wheels (RigAnalysis lane) |
| `perplexity/13-wheel-separation-frame-crush.md` | Wheel/suspension separation displacement, ball-joint/tie-rod loads, compactor force, cell vs rail collapse (CrashRealism5; no clean separation threshold found: ~48–56 kN ball joint, ~120 kN rail) |
| `perplexity/20-adaptive-particle-lod.md` | Adaptive/LoD shape matching (Steinemann 2008), refine/coarsen with plastic state |
| `perplexity/21-vehicle-node-counts.md` | Node counts and CPU cost of real-time vehicle soft bodies (BeamNG numbers; others unsourced) |
| `perplexity/22-hierarchical-two-tier.md` | Two-tier coarse skeleton + fine surface particle layer, HPBD, activation islands, JS/Wasm budgets |
| `perplexity/50-derby-elimination-rules.md` | Real demolition-derby elimination: aggressive-hit interval (60 s typical; 90 s / 2 min), no-movement limit (60 s), door hits, last-car-to-hit wins (CrushCalibration lane) |
| `perplexity/40-derby-driver-techniques.md` | Real derby driving: rear-first hits to protect radiator/engine, aim at front wheels/radiator, sideswipes, walls, J-turns, sandbagging, finishing weakened cars (DerbyAI2) |
| `perplexity/41-derby-rules-door-timer.md` | Derby rule books: driver's door hits DQ, hit clocks (30/60/90/120 s), head-ons banned, stalled car counted out after ~1 min (DerbyAI2) |
| `perplexity/90-vercel-realtime-transports.md` | Realtime multiplayer under Vercel: function WebSocket limits, WebRTC + polled signaling, TURN, PartyKit/Ably/Pusher/Liveblocks, PeerJS (Netplay lane) |
| `perplexity/91-snapshot-netcode.md` | Snapshot interpolation vs state sync vs lockstep, quantization, delta vs acked baseline, unreliable DataChannels, BroadcastChannel (Netplay lane) |
| `perplexity/23-race-checkpoints-laps.md` | Arcade lap counting: hidden/key checkpoint gates, designed shortcuts, spline-progress ranking, wrong way, respawn anchors, authoritative race state (RaceLead lane) |
| `perplexity/24-racing-ai.md` | Opponent AI on a spline: pure-pursuit lookahead, curvature/grip speed planning, overtaking offsets, aggression-scaled blocking/ramming, recovery (RaceLead lane) |
| `perplexity/25-stunt-track-design.md` | Stunt circuit layout: figure-8 crossovers, tunnels, kicker/tabletop jumps, wall-ride banks, readability at speed, fairness for AI, cheap browser rendering (RaceLead lane) |
| `perplexity/26-race-traffic.md` | Ambient NPC traffic: spawn/despawn bubbles out of view, lane graphs, cross traffic at junctions for T-bones, density, crash reactions, multiplayer cost (RaceLead lane) |
| `perplexity/2026-10-13-arcade-draft-zone-values.md` | Drafting zones in arcade racers (Burnout, NFS, Mario Kart, Ridge Racer, GRID…): no published geometry; Ridge Racer distance-weighted, blink-then-decay on exit (DraftCone lane) |
| `perplexity/2026-10-13-slipstream-zone-around-corners.md` | Slipstream detection around corners: rear cone 1.5–3 car lengths, 10–20° half-angle; breadcrumb trail with widening radius; ~45° alignment; NASCAR/F1 wake strength by car length (DraftCone lane) |
| `perplexity/2026-10-13-ai-difficulty-believable-mistakes.md` | Racing AI difficulty tiers that err believably: braking-point, line, reaction and look-ahead errors, mistake rates, rubber-banding, per-tier values (AI difficulty lane) |
| `perplexity/2026-10-13-ai-error-models-formulas.md` | Formulas for AI driver error: smoothed line-offset noise, corner-speed overcook factor, reaction delay buffers, steering gain, per-corner mistake odds, seeded determinism (AI difficulty lane) |
| `perplexity/2026-10-14-bmw-m5-active-sound-loudness.md` | BMW M5 Active Sound Design: loudness as a surface of load (dominant), rpm and mode; game gain table (idle −25…−18 dB, full load 0 dB), lift-off release τ 0.15–0.6 s (engine loudness law) |
| `perplexity/2026-10-14-engine-spl-vs-rpm-load.md` | Real engine SPL vs rpm and load: WOT 8–20 dB over part throttle at the same rpm, ~6 dB per rpm doubling, 25–50 dB idle-to-redline range; how racing games layer on/off-load (engine loudness law) |
| `perplexity/2026-10-14-physics-in-web-worker.md` | Car physics on a Web Worker: SharedArrayBuffer + Atomics (COOP/COEP) vs transferables, snapshot interpolation, input latency, mobile Firefox/Chrome support (perf pass) |
| `perplexity/2026-10-14-wasm-simd-soft-body.md` | WASM simd128 for shape-matching and contact queries: speedups vs scalar WASM and JS, SoA layout, per-call and copy overheads, Firefox/Chrome Android support (perf pass) |
| `perplexity/2026-10-14-spidermonkey-hot-loop-pitfalls.md` | SpiderMonkey (Firefox, Android) JIT pitfalls in hot TypedArray loops vs V8: polymorphism, closures, `Math.hypot`, huge functions, GC nursery; profiling with JIT tiers (perf pass) |
| `perplexity/2026-10-14-threejs-mobile-gpu-perf.md` | three.js on Adreno/Mali: batching, partial buffer uploads, packed normals, shadow and AA cost, pixel ratio, precision, recompiles, deformed-bounds culling (perf pass) |
| `perplexity/2026-10-14-pileup-physics-cost.md` | Cutting physics cost in 20-30 car pile-ups: island sleep and wake, speculative contacts vs substeps, warm starting, broadphase choice, contact caching, adaptive iterations, physics LOD (perf pass) |

## Papers (`papers/`)

PDFs are gitignored (large, re-downloadable). Base URL:
`https://matthias-research.github.io/pages/publications/<file>` (index:
`https://matthias-research.github.io/pages/publications/publications.html`).
Each paper has two notes next to it: `papers/<name>.md` (section-by-section rewrite in
paraphrase, equations and algorithms preserved) and `papers/<name>.analysis.md` (summary,
useful content, code anchors verified against this repo, implementation candidates,
caveats). Rajala's notes are `papers/rajala-2008*.md` (PDF in `artifacts/`).

| File | Paper |
|------|-------|
| `MeshlessDeformations_SIG05.pdf` | Müller, Heidelberger, Teschner, Gross — Meshless Deformations Based on Shape Matching (SIGGRAPH 2005) |
| `posBasedDyn.pdf`, `posBasedDynSlides.pdf` | Müller, Heidelberger, Hennix, Ratcliff — Position Based Dynamics (VRIPhys 2006) |
| `screenSpaceMeshes.pdf` | Müller, Schirm, Duthaler — Screen Space Meshes (SCA 2007) |
| `orientedParticles.pdf`, `orientedParticlesSlides.pdf` | Müller, Chentanez — Solid Simulation with Oriented Particles (SIGGRAPH 2011) |
| `strainBasedDynamics.pdf` | Müller, Chentanez, Kim, Macklin — Strain Based Dynamics (SCA 2014) |
| `stablePolarDecomp.pdf`, `stablePolarDecompSlides.pdf` | Müller, Bender, Chentanez, Macklin — A Robust Method to Extract the Rotational Part of Deformations (MIG 2016) |
| `simVisGeometry.pdf` | Müller, Chentanez, Macklin — Simulating Visual Geometry (MIG 2016) |
| `XPBD.pdf` | Macklin, Müller, Chentanez — XPBD: Position-Based Simulation of Compliant Constrained Dynamics (MIG 2016) |
| `sca2016.pdf` | Chentanez, Müller, Macklin, Kim — Real-time Simulation of Large Elasto-Plastic Deformation with Shape Matching (SCA 2016) |
| `smallsteps.pdf` | Macklin, Storey, Lu, Terdiman, Chentanez, Jeschke, Müller — Small Steps in Physics Simulation (SCA 2019) |
| `PBDBodies.pdf` | Müller, Macklin, Chentanez, Jeschke, Kim — Detailed Rigid Body Simulation with Extended Position Based Dynamics (SCA 2020) |
| `Physically_Based_Shape_Matching___SCA_2022.pdf` | Müller, Macklin, Chentanez, Jeschke — Physically Based Shape Matching (SCA 2022) |
| `Ste08b.pdf` | Steinemann, Otaduy, Gross — Fast Adaptive Shape Matching Deformations (SCA 2008); from `https://cgl.ethz.ch/Downloads/Publications/Papers/2008/Ste08b/Ste08b.pdf` |
| `hpbd.pdf` | Müller — Hierarchical Position Based Dynamics (VRIPhys 2008) |
| `FalkensteinRLP2017.pdf` | Falkenstein, Jones, Levine, Shinar, Bargteil — Reclustering for Large Plasticity in Clustered Shape Matching (MIG 2017); from `https://users.cs.utah.edu/~benjones/FalkensteinRLP2017.pdf` |

Other links: `https://github.com/SojeongCheon/MeshlessDeform` — small Python/VTK
reimplementation of Müller 2005 (bunny demo; no plasticity/clusters), reference only.

Primary sources already in the repo: `artifacts/rajala-2008.pdf`,
`attachments/Dynamic_Mesh_Deformation_for_Car_Games-[VNS-0cJlpIs].en.srt` (talk transcript),
`attachments/*.png` (talk slides).

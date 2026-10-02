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
| `perplexity/90-vercel-realtime-transports.md` | Realtime multiplayer under Vercel: function WebSocket limits, WebRTC + polled signaling, TURN, PartyKit/Ably/Pusher/Liveblocks, PeerJS (Netplay lane) |
| `perplexity/91-snapshot-netcode.md` | Snapshot interpolation vs state sync vs lockstep, quantization, delta vs acked baseline, unreliable DataChannels, BroadcastChannel (Netplay lane) |

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

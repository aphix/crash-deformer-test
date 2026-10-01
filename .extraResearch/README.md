# Research cache

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

## Papers (`papers/`)

PDFs are gitignored (large, re-downloadable). Base URL:
`https://matthias-research.github.io/pages/publications/<file>` (index:
`https://matthias-research.github.io/pages/publications/publications.html`).
Per-paper notes mapped to this codebase live next to them as `papers/<name>.md`.

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

Other links: `https://github.com/SojeongCheon/MeshlessDeform` — small Python/VTK
reimplementation of Müller 2005 (bunny demo; no plasticity/clusters), reference only.

Primary sources already in the repo: `artifacts/rajala-2008.pdf`,
`attachments/Dynamic_Mesh_Deformation_for_Car_Games-[VNS-0cJlpIs].en.srt` (talk transcript),
`attachments/*.png` (talk slides).

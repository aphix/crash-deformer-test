# References

## Carmageddon (dethrace, `~/github/dethrace`, reverse-engineered 1997 source)

Hardware: Pentium 75–90, 8–32 MB, 2 MB VGA; ~15 fps at 320×200 on recommended hardware; 1 player + 5 opponents + up to 10 cops; hundreds of pedestrians per level (frozen when far). Budget tricks found (reviewer RevDethrace, read-only; cites are dethrace `src/DETHRACE/common/` unless noted):

- Physics 25 Hz fixed step, ≤5 steps per frame, pose rewound not interpolated (`constants.h:912`, `car.c:1318-1339`).
- Only cars flagged `physics_me` step; opponents out of view > 3 s go kinematic on the path graph (`opponent.c:1808-1816`, `oppoproc.c:484-545`); rematerialise at a safe spot when back in view.
- Per car per step: 4 wheel rays + ≤14 box points against ≤50 cached faces, ≤4 contacts kept (`car.c:1403-1407`, `2986`, `3013-3020`, `3050-3052`). Face list cached per body in a swept box padded 3 steps ahead, refilled only when the body leaves it (`car.c:726-777`); one OBB-vs-faces pre-cull per step bails before any point work (`car.c:2986-3008`).
- Sleep: nearly still, ≥3 contacts, support 90–110 % of weight, no wheel on the ground → `doing_nothing_flag`; skipped before face gathering and the step; woken on contact (`car.c:3203-3219`, `1372-1376`, `6702-6703`).
- Crush never rasterises a physics shape: box Z extent rescanned from mesh vertices, mesh update deferred to draw and coalesced (`crush.c:318-340`, `3689-3749`); far AI cars skip crush (`car.c:3555`).
- Pile-up solver: dirty-pair re-test only, pinned car = infinite mass, ≤5 passes then halt (`car.c:6172-6260`).
- Pedestrians: billboard quads against the car's uncrushed box; frozen when off-screen and > 11 units away; off-screen mid-air snapped to ground (`pedestrn.c:2495-2540`).
- Props: become dynamic only when an awake car touches them; once a second, sleeping props nobody is near return to the static world (`car.c:7622-7763`); shrapnel pool of 15, no collision, 1 s life.
- AI once per render frame (`mainloop.c:633`), jittered per-entity timers instead of round-robin (LOS raycast every 6–6.9 s per opponent, `opponent.c:2252-2270`).
- User knobs cut simulation too: scenery cut-off also sets the AI "in view" distance; accessories off removes props from collision (`opponent.c:2630`, `finteray.c:819`).
- No fixed point; one 91-entry float sine LUT for AI/peds/debris only.

## Library fit review (10-12)

Nothing in the vfx/three list cuts a measured cost. Maybes: Rapier 0.21 (broadphase drops same-body pairs; measure first), WebGPU (different backend for the 28 % render CPU; unmeasured). Rejected with reasons: three-mesh-bvh (our queries are analytic heightfields, O(1) per cell; a BVH over triangle meshes would need the roofs re-meshed per step), postprocessing (owner: unrelated to current perf), gpu-io (sim needs synchronous readback 240×/s), particle libs (same model as ours). stats.js: three ships `stats.module.js`; added as an overlay (`\` key, `?stats=1`).

## Talks

- Burnout developer, 2020, "Vehicle Feel Masterclass: Balancing Arcade Accessibility with Simulation Depth": `VehicleFeelMasterClass_ArcadeFeelWithSimulationDepth.srt` (this folder). Reviewer RevMasterclass2 maps it to our code.
- "Arcade Drift Physics" talk: `ArcadeDriftPhysics.srt` (this folder). Owner: secondary to the masterclass; may help the handling side.
- Just Cause 4, Hamish Young (lead mechanics designer), "Tire Dynamics": `JustCause4_TireDynamics.srt` (this folder). Owner: the more arcadey, fun one. Friction clamps, drawn friction curves, grip × curve × wheel load × time step, pitch/roll scaling of the tyre impulse, driver-assist drift layer. Index: `talk-guidance.md` Talk 3.
- Uncharted 4, Ed Pereira (Naughty Dog), "The Science of Off-roading": `Uncharted4_ScienceOfOffroading.srt` (this folder). Owner: the more cinematic one. Per-surface friction (no speed cap), motor RPM from the fastest-spinning wheel, torque applied up to the max friction force with the rest as wheelspin, handbrake as reduced rear friction. Index: `talk-guidance.md` Talk 4.
- Already in repo: `attachments/Dynamic_Mesh_Deformation_for_Car_Games-[VNS-0cJlpIs].en.srt`.

## Session reports (agent reports from this investigation; their substance is copied into `leads.md`/`measurements.md` as it lands)

rev-RevLoadCage, rev-RevRagdoll, rev-Dethrace, threejs-vfx-fit, firefox-fleet-report, chrome-trace-report, fleet-slide-report; pending: rev-RevCageRefit, rev-RevPairSat, rev-RevReadChain, rev-RevLooseAi, rev-RevRender, rev-Masterclass.

# State of the project (end of day 2026-10-05)

`main` = `57b33e4`, pushed and live. `REPLAY_VERSION` 39, `NET_VERSION` 14. Full gate on the last staged head: 2243 tests, 0 fail, 50 todo (see "Parked tests"), tsc 0, boundaries 0 (C8 size caps are report-only), build OK.

## Shipped today (main, in order, after `b1d81be`)
adaptive SimPacer 1/120 floor; mobile menu; settings-in-URL (no hash on fresh load, per-setting reset); every picker lists every car type and the Stack drops only the picked type; settings never overwritten by programmatic setups (bench, campaign, host options, saved highlights); car hull-overlay dispose leak; test text as given/when/then with flat case tables; checkpoint sweep (0 of 437 swings fail) + reset to last on-road spot before the first owed checkpoint + hold-to-reset keeping damage + HOLD TO RESET pill; `?bench=strip`; far-car detail rungs (75 m desktop, down to 30-50 m on phones under load); exact physics speedups (near-pair loops, per-step part loops); fine-slice cut for a step that carries a closing hit (wall kill at 1/120 s = 1/240 s); size caps report-only.

## Open work, by owner priority

### Unified contact (owner: current split design is too split-brained to stay the core)
Design: `docs/UNIFIED_CONTACT.md` on branch `lane/ramp-ground` (route: our own uniform model, not Rapier; staged 0-5).
- Stage 0 (equivalence tests + rigs): branch `lane/uc0-rigs`. Failing tests stay on the branch until the stage that closes them. Door matrix 80 cells passes except two mirror-fold cells at shut/12 km/h/858 kg (0.6-0.8 deg vs 0.5 bound); the zero-grip control was found inert and replaced. No tsc/boundaries run on this branch.
- Stage 1 (per-wheel contact, one `Surface` store, derived airborne): not finished, not merged. Work is on `lane/uc1-wheels-wip` (`cd34e44`, steps 1-6 WIP: store, Ground extends Surface, track/corkscrew/fleet ramps migrated, per-wheel contact, rest plane) on top of `lane/uc1-wheels` (docs + failing-first tests: ramp-crossing 96 cells, stack-drive, ground-fit with 0 allowed). The lane stopped on an API rate limit mid-step; its last uncommitted edit was saved as the step-6 WIP commit. Its full REMAINING list is in the lane's final report. Not green.
- Stage 3 closes the owner's stuck stack top car: the physics plate drops with the crushed roof (0.54-0.56 m vs drawn 0.73-0.80) so physics tyres hang 0.23-0.25 m while the drawn tyres sit in the drawn hood. Stage 4 closes press/piston/door/car-car parity (two PENDING cases in contact-parity were un-todo'd on the lane branch and fail for real).
- Cop into a sedan's side (owner shots): square hit at 10/20/30 m/s dents both cars on today's main (overlap 0.15-0.34 m), not the ~1 m in the shots; an angled hit with an open door is still to be reproduced.
- `implements` ban: 11 non-Ground uses remain (CopBrain x2, RigLayer x5, NetTransport x2 + test Link, PartStateCar); Ground x4 goes with Stage 1. Add a boundaries rule against new `implements`.

### Performance (phone is the target; CPU-bound, GPU timer unavailable)
- Cost of the fine-slice cut near hits (`9f34747`, plus `57b33e4`'s approach marking, which runs on every step whenever a pacer is present, fine floor included). Measured 2026-10-06, box load 1.5 on 14 cores at start (the load sampler stopped after 2 samples, so mid-run load is not recorded):
  - Headless (`.bench/coarse-ab-headless`: `.bench/coarse-cut.ts`, same seeded city race, coarse pinned, cut on vs off, 4 alternating runs): 116-124 vs 103-108 ms per sim-second, about +14%.
  - Browser (`.bench/coarse-ab-browser.sh`: `?bench=city` desktop viewport, production builds, order A B B A, each server verified to serve its own build): pinned coarse arm `6832a2a` 149 / 120 vs `57b33e4` 177 / 219 ms per sim-second; pinned fine arm 243 / 190 vs 278 / 260; main window 266 / 227 vs 282 / 257. Wrecks 22.8 / 19.6 vs 24.4 / 23.0. Both arms are higher on `57b33e4` in every run, the coarse arm most.
  - Not measured yet: how much of the browser gap is the slice cut and how much is the per-step approach marking (the headless off-arm skipped both). Cheaper option if needed: mark and cut only the approaching pair. Owner's call.
- `markApproaches` shares `collectNear`'s 8 m gather; the buffer grows past 32 cars but no test or browser run goes above 32 cars through `stepWorld`. Add a 33-40 car test on the coarse step.
- Owner benches: the main window is often much slower than the pinned A/B arms in the same run (phone Firefox; desktop Firefox paste-40: 5.16 ms/step against 2.73 for the pinned coarse arm, about 1.9x, both 100% coarse). Add per-second physics ms and the build sha to the card. Lane tests share the owner's PC: use the QUIET hold for his desktop runs.
- Per-wreck sim: settled-wreck sleep does not apply (93% of crashed cars still move). Lever A (skip redundant re-poses, ~8%) is held: it changes the sim and needs a robust pile-up bound.
- Big maps: terrain chunks + frustum culling + coarser far ring (static tris 39k-293k are all submitted every frame); call merging is not worth it; pick the texture format (ASTC) with the first real texture files.
- Geometry creep 2-3 per scene cycle (textures flat): attribute or show bounded. Campaign heap +0.8 MB per round.
- SimPacer on very coarse clocks (>= 4 ms, hardened Firefox): pin 1/120 and bound frames by steps.
- Ground flicker on phone Chrome: branch `lane/mobile-flicker` fd6ecd8 (mean 1.72 -> 0.40 per mille on the sweep, bridge fixed). Remaining: the pull must be constant in view space (not a z pull that grows with distance), razor-shelf x2-near, cars-at-50-200 m A/B on a current base, check:programs, 4x frame cost. Details in the lane's final report.

### Crush and deformation (owner decision needed before any change)
- Full-speed kills have 1-30 mm of margin: engine travel saturates at 0.45-0.55 m for every hit >= 30 m/s against a 0.45 m kill, so higher speed does not mean more crush. Cause: crush leans on clampLocal's position-only caps. Fixing it is the crush recalibration project (breaks 53 calibration tests until retuned).
- Deform gaps (ParkedTodos report): arming sag (HUB_FLOOR 0.28 vs hub rest 0.32, goes through Stage 1's wheel seat rule); the skin cage fit amplifies particle motion by ~6 cm and looks fine only because the skin is stale; piston locality lives in the 20-particle beam skeleton; derby pops at the default knobs (branch `lane/parked-todos-pops`, a plain failing test that merges with its fix).
- Slow-mo replay shows cars halfway through hoods: skin lag first suspect; finer slow-mo steps only if the sim is the cause. Unassigned.

### Parked tests
50 `todo` tests remain: ~46 piston locality/tap/kill-energy cases, the two contact-parity cases, the stack-column monster (bodyless, replace with a real fall-along-length test). Nothing is to be parked from now on (owner rule); all of these close with the stages above or the deform lane. Pooled outcome/pacing bars over random runs are allowed; physics rules allow zero failures.

### Paperwork
- Split over-cap files (engine-race.ts ~810, track.ts ~825 plus whatever lanes add) and reset the C8 cap to 0.
- Sweeps after lanes settle: no `.forEach` (~66 src files, enforce with oxlint), no `.push` / `this`-bound methods / deep equality in runtime hot paths, `implements` conversions.
- Smoke probes: controls reads `playerClass` (now `playerCar.id`); scene-launch headon misses its approach rows (use launch-adv); `wall-sweep` still calls `setPlayerClass`.
- Template test `scripts/grok-pwa-plugin.test.mjs`: 8 failures, platform file, report only.
- Quiet-box items: ragdoll boot re-measure, corkscrew allocation, pair-solve lever, ramp residual perf, final 2-32 car bench.

## Owner questions still open
Razor Shelf inside cut skips 65% of the lap (intended?); bust rule vs a player who keeps creeping over 20 km/h; off-centre palm hits slide past instead of wrapping; T-bone leaves the struck car's engine alive; reverse charges in the derby opening; "copy link to this run" button (default settings no longer put the seed in the URL); the out-and-back strip as a real track; a "refresh" button when a new build is deployed.

## Unmerged lane branches worth keeping
`lane/uc0-rigs`, `lane/uc1-wheels`, `lane/uc1-wheels-wip`, `lane/uc1-stack-owner` (owner's stuck stack test, until Stage 3), `lane/ramp-ground` (design doc), `lane/stack-profile` (open pickup bed + standsOn; not merged: second stacking test), `lane/parked-todos`, `lane/parked-todos-pops`, `lane/parked-todos-sag`, `lane/mobile-flicker`, `lane/WallRegress` (merged as a squash), `wip/WreckResidue-clamp-experiments`. `lane/course-perf-lod` a00d8bb is a superseded WIP: do not merge.

## Standing rules (lane-updates.md is the full list)
Gates are Main's only; lanes run `node --test --test-concurrency=1` on touched files plus oxlint, one process. Two browser slots. Never touch `~/.omp` (use `local://`, `agent://`, `history://`). No file-editing scripts (LSP, `ast_edit`, or read-then-edit). No `.forEach`, no `.push` in hot paths, no `implements`, nothing allowed to fail, one job one implementation, no new lanes or helper agents without the owner's go. Merges are staged on `merge/next`, gated there, and fast-forwarded to `main` only when green.

Working copy (from 2026-10-06): `~/github/crash-deformer-test` in WSL, `origin` = the Windows mount `/mnt/c/proj/crash-deformer-test`. Start with `scripts/wsl-pull.sh`, commit in WSL, then `scripts/wsl-push.sh` after every commit (fast-forwards the mount; the owner pushes the mount to GitHub). `scripts/wsl-check.sh` reports sync state.

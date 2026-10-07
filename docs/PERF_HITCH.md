# Race hitching

What makes a frame long in a race, the guards that keep each cause out, and how to measure a hitch. Design pillar:
no hitching (`docs/DESIGN_PILLARS.md`).

## Measuring

- **Attribute a long frame** by its parts: in the page, `fixedStep` (physics), the race director (`drive` / `collide` /
  `step` / `frame`), `emitHud`, FX updates, `Cinematics.update`, lamp pool, skinning, camera and `renderer.render`; from a
  CDP trace, GC, other main-thread tasks, layout, and the GPU process main thread (`CrGpuMain`). A frame whose own tick is
  short while the GPU process is busy the whole interval is "GPU process".
- **A run** for a hitch table: a fresh browser, 8 cars (7 AI + the player's car on the AI line), 60 s from the start command
  (so the countdown is in it), a CDP trace for every frame over 50 ms. Report p50 / p95 / p99 / max, frames over 33 and
  50 ms, programs linked mid-race, draw calls, and the cause of each frame over 50 ms.
- **A control:** a blank WebGL page in the same browser setup in the same session. On this box (RTX through WSL d3d12) it
  holds 16.7 ms only while the GPU is clocked up; check `nvidia-smi` and compare builds within one session.
- `npm run check:programs -- --url <server>` is the program-link guard (below). For headless physics spikes, time
  `stepWorld` in node.

## Causes and guards

**GPU process.** Frames where the tick is short and the GPU process main thread stays busy (`GLContextEGL::MakeCurrent`,
`SwapBuffers` on the WSL d3d12 path). It follows the host's GPU power state and box load, not the draw-call count. The
`minimal` FX tier is the cheapest path.

**Program links mid-race.** A GPU program linked on first sight, or compiled but never drawn to the real output, costs
75–330 ms through synchronous round trips to the GPU process. Guards:

- **Program warm-up.** `CrashEngine.ready` resolves after boot links every program play can reach: `PostFX.warm` compiles
  the scene for both outputs (canvas and HDR target) plus every post pass and the composite, with a hidden cracked-glass
  stand-in and the debug views added; the scene is drawn with every mesh shown and unculled through a zero-area scissor, so
  shadow-depth variants link, every uniform location is fetched and every texture uploads. The loop reads input from
  `start()` but only simulates and draws after `ready`.
- New scene content warms where it appears: a race course's art (`buildArt`) and new cars (`buildCar`) queue the same
  warm-up, so it runs in the setup menu or the countdown.
- Post render targets and the mark map are allocated once and resized with the canvas, so a tier switch allocates nothing.
- One material per draw kind: track art gives each draw kind its own copy of a material (`TrackArt.forDraw`) and
  instanced casters their own depth material, so three never re-selects a program between plain and instanced draws.
- `npm run check:programs` plays the sandbox (fleet crash with cracked glass, drive, night / wet, every FX tier, every
  scene, debug views) and a race on every course, and fails if any program links after the boot warm-up or between a
  race's green light and its end.

**The `minimal` tier** (the default, `INITIAL_HUD.fxTier`; `?fx=` sets it) renders straight to the canvas: no HDR target,
bloom, grade, vignette, grain or blur. It keeps every effect that needs no post (tyre marks, tyre smoke, slip sparks, shake,
FOV kick, hit-stop, crash-cam cuts) and draws sparks and glass plain. Order `off < minimal < low < high`; `off` also drops
marks, smoke, hit-stop and crash cam.

**Distance detail** (`present/car-detail.ts`, `DetailGovernor`): past a car's rung its small non-shadow parts leave the
camera's layer and only the body draws (`docs/CINEMATIC.md`).

**Crash path warm-up.** `warmCrashPath` (`engine/world-step.ts`) runs two throwaway crashes through `stepWorld` during the
boot warm-up, so V8 has compiled the crush path before the first real crash; cold, a race's first pile-up ran it
unoptimised. `deform/crash-physics.test.ts` checks that every warm-up hit crashes both cars and leaves the next crash
bit-identical.

### GC during races

Race GC pauses (30–64 ms) are driven by physics allocation. `contact/physics-alloc.test.ts` bounds the heap growth of a
warmed 24-car pile-up per frame, and the hot-path rules (`docs/ARCHITECTURE.md` H1–H4) keep per-step code allocation-free.
Measure allocation with the sampling heap profiler, including objects already collected.

**Not causes** (measured per frame): HUD React, FX emitters, tyre marks, lamp lights, skinning, texture uploads.

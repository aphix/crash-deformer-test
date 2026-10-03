# Stretched panels, flap, door pendulum, frame parity

Hinged body parts (quarter panels, arch flares, a hanging bumper) and open doors react to the wind, to the car's own
acceleration and to whatever touches them. All of it is a function of the car's relative motion and the contact. Code:
`vehicle/car-wear.ts` (the laws), `car-parts.ts` (the rules that use them), `car-panels.ts` (shell geometry),
`contact/external-contact.ts` `hitPanel` (the striker against a panel), `scenes/door-rig.ts` (Doors scenes D and E).

## Stand-off cap

A quarter panel peels about the vertical hinge line at its tail. Its peel angle is cut so the free end stands at most
`STAND_MAX` = 0.4 m off the body at hinge value 1 (`PanelRegion.peel = asin(STAND_MAX / reach)`, reach 1.33 m on the sedan,
0.30 rad). It was a fixed 1 rad: 1.20 m on the 80 km/h rear offset hit. The stand-off in metres is reach · sin(peel · t); an arch
flare flaps out 0.16 m at most.

## Stretched panels are easy to break

A quarter panel or arch flare hinged to `PANEL_FRAGILE_T` = 0.5 (a quarter panel: 0.2 m off) is *stretched*. In
`evaluateBreakage` it comes off on

- a **fresh contact**: whatever feeds `deform.notifyContact()` (wall, car, prop, ground rig) after a quiet pause of 0.15 s
  (`TOUCH_GAP`). The crash's own continuing contact does not count; the next touch does;
- a **scrape** (quarter panels only; an arch flare's box includes the sill, which the body sinks to the road on its own): its box reaches the ground under it.

A bumper is not torn by contact timing: a torn bumper changes the crash hulls, which a headless replay re-simulating from a keyframe could
not reproduce (tried: it moved a replayed first impact out of the 0.2 s window). It wears off in the wind like the panels.

The Doors-scene strikers (below) take a stretched panel at a nudge (`PANEL_FRAGILE_J` = 15 J).

## Flap and wear in the wind

`flapAmp(speed, hingeT)` = 0.3 rad · min(1, v/40 m/s)² · min(1, hingeT/0.25): zero at rest, ∝ v². Each car keeps one flap
clock turning at (3 + 0.2 v) Hz; a part beats it at its own phase (its rest spot's) with `flapWave`, a 0..1 two-beat wave (a
part lifts off its body and settles, it never folds into it). No random draw: speed, time and part only.

- quarter panel / arch flare: the whole shell mesh turns about its hinge line (`flutterShell`, a transform: **no vertex rebuild,
  no upload**); a quarter about the vertical line at its tail, an arch flare about the line along z at its top;
- hanging bumper: its roll about the corner it hangs by grows by the flutter.

`windWear(speed, hingeT)`: above 80 km/h (`FLAP_TEAR_MPS`) a hinged part wears (`fatigue` 0..1, off at 1) at
(v/22.2)² / 6 s, scaled by min(1, hingeT/0.25); a stretched part at (v/22.2)² / 1.5 s. Below 80 km/h it recovers. The clock and
the wear are host-side; the flutter is cosmetic (netplay clients and replays shake the parts they draw by the same law from
the interpolated speed, `flutterParts` in `netFrame`).

## Door pendulum

An unlatched door is a uniform slab hinged at (±0.86, 0.55) swinging along u = (sx sin θ, −cos θ). The car-frame pseudo force
F = −a + ω² p − α × p gives its opening acceleration (`swingAccel`): braking (a_z < 0) swings it forward (open), accelerating
shuts it, the outside of a turn opens it, the inside shuts it; a shut door has no torque from braking. a is the change of the
car's velocity since the last sample, rotated into the car frame and capped at 1.5 g (a crash's spike saturates; the crash rules
C1 tear or spare a door), α the same for the yaw rate. Hinge friction: 0.8/s viscous plus `DOOR_DRY` = 2 rad/s² dry, so a jostle
leaves a door hanging. Because only Δv enters, a car carried at any constant speed, or turned any way, swings the same.

The door ends on the check-strap stop (`loadDoorStop`), on its crash jam, or in the latch: `closeDoor` is the one rule for
reaching shut, used by the car's own swing and by the Doors ram alike (latched below `SLAM_TEAR_J`, wrenched off above it).

A door a **side hit** opens past `DOOR_AJAR` is sprung (`springDoor`): unlatched, hanging at least as far open as its crash
jam (`hingeT × 1.45`, which it can never shut past), swinging with the car. Frontal and rear hits still only jam it ajar,
latched (C1).

## The Doors scene: panels (D, E) and frame parity

- **D `panelPush`** (key 6): a quarter panel stands out at hinge 0.45; the ram runs rear→front and pushes it back onto the
  body. **E `panelPull`** (key 7): the ram runs front→rear into its free end and pulls it open. The panel is the door's mirror
  image: hinged at the tail, free end ahead, so the directions are swapped.
- `hitPanel` is in `partContact`, the contact a car passing alongside meets too. The slab goes where the face pushes it; the striker
  pays the plastic work `PANEL_BEND_NM` (36 N·m) × the angle moved; no rebound. Pushed back, the panel keeps its dent
  (`bendPanel` sets `hingeMax`: the crash target cannot raise it again, and it is never flat: `PANEL_SMUSH_MIN` = 0.1). Pulled
  out it opens to full hinge and holds. A striker carrying more than `PANEL_SLAM_J` (150 J, pushed back), `PANEL_PULL_J` (60 J,
  pulled out) or, once stretched, `PANEL_FRAGILE_J` (15 J) tears it off.
- **Frame parity**: `DoorRig.carMoves` parks the ram in the world and drives the car at it at the shot's speed. Both ways reach
  the same `partContact` with the same relative velocity: `door-frame.test.ts` tables every scenario × both directions × {ram
  moves, car moves} × both sides, and drives the contact with a world-fixed box and real car positions.

## Sim state and versions

Netted already: `hingeT` (also a smushed panel's), door `theta` and latch, part flags. A part with no swing leaves two of its
three hinge slots free; they now carry `fatigue` and `1 − hingeMax` (0 = uncapped, so old data reads as before), so a keyframe
restores the wear and the dent cap. Not carried: the flap clock (cosmetic), the contact timing and door motion sample (re-read from the
restored deform and velocity, `restoreWear`). No layout change: NET_VERSION 8 and REPLAY_VERSION 6 stay.

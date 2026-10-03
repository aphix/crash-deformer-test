# Controls

Every action, with its keyboard key, controller button and touch control. Keyboard and controller work together: per control, the stronger input wins. Browsers only expose a controller after its first button press; the HUD then shows "Xbox controller connected" (or PlayStation / Controller).

Hotkeys leave Ctrl / Cmd / Alt chords to the browser (Ctrl+R reloads, Ctrl+C copies) and skip keys typed into a text field, select or editable area.

## Touch screens

On a coarse pointer (phones, tablets) a thumb pad sits above the bottom bar. Desktop browsers never show it. It writes the same controller state a gamepad does (`GamepadInput.touch`, merged into `PadState` on every poll), so every controller binding below works by touch too, and keyboard, controller and touch mix freely.

- **Stick** (left thumb): up is gas, down brakes then reverses, left / right steer (left turns the nose left). It has a controller stick's deadzone and soft centre. It shows while you drive, or follow a car you may take over; pushing it takes the wheel.
- **Buttons** (right thumb), each with a caption. They show only where they act:
  - **Prev / Next** (outside a race): previous / next car. From the whole field they pick one to follow.
  - **Exit → Free** (outside a race): drive → follow → whole field, which frees the camera. In a race this slot is **Pause**.
  - **View** (driving or following; a spectated race car has it on the Spectating bar), **Recover** (in a race: **Respawn**), **Rear** (hold to look back), **Boost** (hold), **Handbrake** (hold).
- **On the 3D view**: one finger drags to orbit (it looks round the car while driving), two fingers pinch to zoom, and a tap on a car follows it.
- **Fullscreen**: a bottom-bar button (next to **Full menu** in the race focus view), using the Fullscreen API with the webkit fallback. Browsers that can't, such as iPhone Safari, don't show it.

A tap shorter than one frame still registers (the press is latched until the next poll), and each control tracks its own finger, so steering while holding the handbrake or boost works.

## Driving

| Action | Keyboard | Controller | Touch |
|---|---|---|---|
| Gas (brakes first while rolling backward) | W / ↑ | RT / R2 | stick up |
| Brake, then reverse once stopped | S / ↓ | LT / L2 (analog) | stick down |
| Steer, relative to the car. Reversing steers like a real car: left backs the tail to the left | A / ←, D / → | left stick | stick left / right |
| Handbrake (sharper turn, slows the car) | Space | A / Cross | Handbrake (hold) |
| Boost (drains under gas, recharges, fills on a derby takedown) | Shift | X / Square | Boost (hold) |
| Camera: chase → far chase → hood cam | V / C / T | Y / Triangle | View |
| Look back from the car while held; release returns at once | ` (Backquote) | R3 (click the right stick) | Rear (hold) |
| Look round the car (eases back 0.8 s after release) | mouse drag | right stick | one-finger drag on the view |
| Recover: back on its wheels where it stands, at rest and repaired (derby: only when flipped and still running) | R | D-pad ↓ | Recover |
| Step out: drive → follow → whole field | Esc | Back / View / Create | Exit, then Free |

## Following and the camera

| Action | Keyboard | Controller | Touch |
|---|---|---|---|
| Follow a car | click it | | tap it |
| Previous / next car (starts following from the whole field) | Q / E | LB / RB (L1 / R1) | Prev / Next |
| Take the wheel of the followed car | any drive key | RT, LT or the left stick | the stick |
| Free the camera (whole field) | Esc | Back | Free |
| Spectator cam: chase → far → hood → trackside → wheel well → orbit | V / T | Y / Triangle | View (in a race: the Spectating bar's camera button) |
| Look back from the followed car while held | ` | R3 | Rear (hold) |
| Orbit (also a thrown driver's ride-along: it orbits the dummy, the ride's shot changes wait during the drag and 2.5 s after) | drag | right stick | one-finger drag |
| Zoom | scroll | | two-finger pinch |

## Racing (no menu open)

| Action | Keyboard | Controller | Touch |
|---|---|---|---|
| Pause menu | Esc | Start / Back | Pause |
| Respawn | R | D-pad ↓ | Respawn |
| Previous / next car while spectating | Q / E | LB / RB | ‹ / › on the Spectating bar |
| Camera view | V / C / T | Y / Triangle | View |
| Look back from the driven or spectated car | ` | R3 | Rear (hold) |
| Focus view ↔ full menu (the sandbox hotkeys work only in the full menu) | H | | Full menu / Race view |
| Menus: move, choose, back, resume | arrows, Enter / Space, Esc, Tab | D-pad / left stick, A, B, Start | tap |

**Reset prompt**: once the car you drive has lost 2 or more wheels, a pulsing "R to reset" pill (pad: "D-pad ↓", touch: the pill itself is the button, "Tap to respawn" / "Tap to recover", pressing what the thumb pad's wrench presses) comes up mid-screen, in a race and in a derby. It shows only where the reset works: not in a no-reset race, while spectating, or in a derby while the car is upright.

## Scenes and the HUD

| Action | Keyboard | Controller | Touch |
|---|---|---|---|
| Pause / play | Space (when not driving) | Start | Play / Pause |
| Reset / reshuffle | R (when not driving) | | Reset |
| Scenes: Fleet, Derby, Race, Press, Pistons, Doors, Corkscrew, Range | D (from the whole field), Z, C (when not driving), I, N, , (comma), (none) | | scene buttons |
| Jersey barrier / ramp balls / jump ramps (fleet only) | B / K / . (period) | | wall / balls / ramps buttons |
| Loop, slow-mo, auto-orbit, audio | L, M, O, U | | Playback section |
| Night, wet asphalt, cinematic FX tier (off → minimal → low → high; turns Auto off) | H (outside a race), X, F | | Playback section (FX Auto button too) |
| Shape ↔ lattice | Y | | Cars & crash section |
| Deform rig, control particles, JSON capture | G, P, J | | Debug views section |
| Pistons: fire one ram (clockwise from front-left) / all eight | 1–8 / 0 | | piston panel |
| Doors: fire A / B / C, open or shut the door, swap side | 1–3, 4, 5 | | door panel |
| Fullscreen | (the browser's own F11) | | Fullscreen |
| Key list | | | ? |
| Multiplayer | | | Net |
| Play online (join the best open race, else host), live races list, Join / Host, Leave (race mode, top-left under the title) | | | Play online, "N live", Join, Host, Leave |

Control particles (P): size = mass, lime → red = plastic travel, magenta = contact, yellow line = shape-match pull (short pulls drawn up to 4×), blue line = rest → now; the bar above each car marks its worst travel.

## Shareable URL

The page's `#` follows the HUD: change a scene or setting and the address bar updates (no history entry, no reload); copy it, and anyone who opens it gets the same scene, settings and initial conditions. Only what differs from the defaults is written, so the default page's hash is just a seed:

```
#cars=5&smin=12&ramps=1&night=1&seed=3fa2c1
```

- **Keys** (`src/game/hud/share-url.ts` is the list): `scene` (omitted for fleet), `cars`, `smin`/`smax` (spawn speed, m/s), `night`, `wet`, `real` (realism), `fx` (only after a manual FX pick), `fxd` (particle density), `squash`, `buckle`, `loop`, `slomo`, `ts` (fixed time scale), `deform`, `car`, `barrier`/`balls`/`ramps` (fleet), the piston knobs `pkph`/`pkg`/`phard`/`phold`/`phop`, the door knobs `dkph`/`dkg`/`dside`, and, in the race, `track`/`laps`/`ai`/`aggr`/`police`/`noreset`/`spectate`. Booleans are `1`/`0`.
- **Initial conditions:** every run picks a `seed` (up to six hex digits); the fleet's spawn spots and speeds, its balls, the corkscrew car's speed and the derby's start bearing all derive from it, so the same URL spawns the same field. With Loop on, each new run rolls a new seed and the hash follows. Fixed scenes (press, pistons, doors, range) carry no seed. A spawn-speed change applies from the next spawn (R), as in the HUD, so press R after it and the URL describes the run on screen. Not covered: what happens after spawn is a live physics run, and a race's random picks (rival aggression spread, traffic) are not seeded; a race URL restores the course, laps, field size, aggression and police setting.
- **Applying:** the hash is applied when the page loads (it is the first reset, so the first run already uses it) and when it is edited or pasted into the open page. It is untrusted: unknown keys and malformed values are ignored, numbers clamp to the HUD's own ranges, and every value goes through the setter the HUD uses. A missing key means the default, except `fx` (a missing tier keeps Auto, or the `?fx=` pick).
- **Netplay:** a host writes its hash like any page; a client's scene and settings are the host's, so a client neither writes nor applies the hash. `?fx=` still works beside the hash.

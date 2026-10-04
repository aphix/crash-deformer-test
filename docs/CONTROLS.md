# Controls

Every action, with its keyboard key, controller button and touch control. Keyboard and controller work together: per control, the stronger input wins. Browsers only expose a controller after its first button press; the HUD then shows "Xbox controller connected" (or PlayStation / Controller).

Hotkeys leave Ctrl / Cmd / Alt chords to the browser (Ctrl+R reloads, Ctrl+C copies) and skip keys typed into a text field, select or editable area.

## Touch screens

On a coarse pointer (phones, tablets) a thumb pad sits above the bottom bar. Desktop browsers never show it. It writes the same controller state a gamepad does (`GamepadInput.touch`, merged into `PadState` on every poll), so every controller binding below works by touch too, and keyboard, controller and touch mix freely.

- **Stick** (left thumb): up is gas, down brakes then reverses, left / right steer (left turns the nose left). It has a controller stick's deadzone and soft centre. It shows while you drive, or follow a car you may take over; pushing it takes the wheel.
- **Buttons** (right thumb), each with a caption. They show only where they act:
  - **Prev / Next** (outside a race): previous / next car. From the whole field they pick one to follow; with no stick on screen, landscape puts them in the stick's corner (lower left), not mid-screen.
  - **Exit → Free** (outside a race): drive → follow → whole field, which frees the camera. In a race this slot is **Pause**.
  - **View** (driving or following; a spectated race car has it on the Spectating bar), **Recover** (in a race: **Respawn**), **Rear** (hold to look back), **Boost** (hold), **Handbrake** (hold).
- **On the 3D view**: one finger drags to orbit (it looks round the car while driving), two fingers pinch to zoom, and a tap on a car follows it.
- **Fullscreen**: a bottom-bar button (next to **Full menu** in the race focus view, which sits bottom centre on a phone on its side), using the Fullscreen API with the webkit fallback. Browsers that can't, such as iPhone Safari, don't show it.
- **Sandbox HUD on a phone on its side**: the left column is the title over the thumb pad and the bottom bar; the right column stacks the readouts, the scene's panel (derby board, rig controls) and the settings, which start hidden here. The derby board shows the three best scores plus the car you watch, in 44 px rows.
- **Idle HUD**: after 5 s without a tap the HUD mutes: the settings, key list and bottom-bar buttons hide, the scene picker keeps only the picked scene, the readouts and panels shrink and fade. Any tap on the page wakes it again; touches on the thumb pad don't count, so driving keeps it muted. Never while a menu is open (`use-hud-idle.ts`).

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
| Mouse look: look round with no drag (see Following and the camera) | ; (Semicolon) | | |
| Recover: back on its wheels where it stands, at rest and repaired (derby: only when flipped and still running) | R | D-pad ↓ | Recover |
| Step out: drive → follow → whole field | Esc | Back / View / Create | Exit, then Free |

## Following and the camera

| Action | Keyboard | Controller | Touch |
|---|---|---|---|
| Follow a car | click it | | tap it |
| Previous / next car (starts following from the whole field) | Q / E | LB / RB (L1 / R1) | Prev / Next |
| Take the wheel of the followed car | any drive key | RT, LT or the left stick | the stick |
| Free the camera (whole field) | Esc | Back | Free |
| Spectator cam: chase → far → hood → trackside → wheel well → orbit → Auto (the highlight reel's shots run live on the followed car; every cut checks room and sight first) | V / T | Y / Triangle | View (in a race: the Spectating bar's camera button) |
| Look back from the followed car while held | ` | R3 | Rear (hold) |
| Orbit (also a thrown driver's ride-along: it orbits the dummy, the ride's shot changes wait during the drag and 2.5 s after) | drag | right stick | one-finger drag |
| Mouse look (Pointer Lock on the canvas: the pointer hides and mouse movement looks round like a drag, no click; also the HUD's mouse button, desktop only). Chase views and the orbit when watching; the ride-along and fixed or cinematic spectator cams ignore it. Esc, a menu, a scene change or any lost lock (alt-tab, tab hide) ends it; a lost lock pauses a race, Survival run or derby once (the next Esc unpauses a race as usual). Chrome refuses a re-lock for ~1-2 s after an Esc exit: the toggle then stays off, press it again | ; (Semicolon) | | |
| Zoom | scroll | | two-finger pinch |

## Racing (no menu open)

| Action | Keyboard | Controller | Touch |
|---|---|---|---|
| Pause menu | Esc | Start / Back | Pause |
| Respawn | R | D-pad ↓ | Respawn |
| Previous / next car while spectating (the entry after the last car is **Auto**: the director picks the car, switching after every 3 camera shots or once nothing has happened to the car for 4 s and something may happen to another; the Standings' Auto row is the same pick) | Q / E | LB / RB | ‹ / › on the Spectating bar |
| Camera view | V / C / T | Y / Triangle | View |
| Look back from the driven or spectated car | ` | R3 | Rear (hold) |
| Focus view ↔ full menu (the sandbox hotkeys work only in the full menu) | H | | Full menu / Race view |
| Menus: move, choose, back, resume | arrows, Enter / Space, Esc, Tab | D-pad / left stick, A, B, Start | tap |

**Reset prompt**: once the car you drive has lost 2 or more wheels, a pulsing "R to reset" pill (pad: "D-pad ↓", touch: the pill itself is the button, "Tap to respawn" / "Tap to recover", pressing what the thumb pad's wrench presses) comes up mid-screen, in a race and in a derby (on a race phone under 640 px it hangs directly under the standings instead). It shows only where the reset works: not in a no-reset race, while spectating, or in a derby while the car is upright.

### Race HUD (focus view)

Top left: the standings with gaps. Top right: lap, position, the race time beside the **race completion %** (share of laps × lap length covered, the measure positions rank by), lap / last / best and the split. On a wide screen without a touch pad the **drive cluster** sits bottom right (a phone and a narrow window keep the compact speed / gear / boost line under the readouts):

- **Rev dial**: speed in the centre (mph with a US locale, else km/h), the gear under it. The revs are faked from the speed inside the gear's bucket: low at the bucket's foot, the redline at its top, falling back at every upshift.
- **Damage arc** (left of the dial): the weaker of the engine block's health and the wheels still on, amber under 60 %, red under 25 %. Under it the **wrench**: lit while a reset would be accepted (R, D-pad ↓), dim in a no-reset race and while spectating, and glowing like the other reset controls once two wheels are gone.
- **Nitrous bottle**: the boost meter (blue fill, glowing while there is a burst in it, white while burning; "Draft" above it while drafting). Hidden where this browser does not hold the meter.
- **Pursuit strip** (bottom centre): "Chased by N cops" while police chase the viewed car (a police race or Survival), with the bust hold and the seconds left while a cop holds the car slow. Hidden otherwise.
- **Near-goal banner** (top centre): "N yd remaining" (mph) or "N m remaining" (km/h) for the last 500 of the last lap.

## Scenes and the HUD

| Action | Keyboard | Controller | Touch |
|---|---|---|---|
| Pause / play | Space (when not driving) | Start | Play / Pause |
| Reset / reshuffle | R (when not driving) | | Reset |
| Scenes: Fleet, Derby, Race, Press, Pistons, Doors, Corkscrew, Stack, Range (each pick fades through a brief cel-shaded pulse and black; reduced motion: plain fade) | D (from the whole field), Z, C (when not driving), I, N, , (comma), / (slash), (none) | | scene buttons |
| Jersey barrier / ramp balls / jump ramps (fleet only) | B / K / . (period) | | wall / balls / ramps buttons |
| Loop, slow-mo, auto-orbit, audio | L, M, O, U | | Playback section |
| Night, wet asphalt, cinematic FX tier (off → minimal → low → high; turns Auto off) | H (outside a race), X, F | | Playback section (FX Auto button too) |
| Cel look: Auto (the cel look plays only as the scene-switch pulse) or a 0-100 % slider that holds it on, the pulse still playing over it | | | Playback section, Cel row (needs FX low / high; greyed with a hint on minimal / off) |
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

- **Keys** (`src/game/hud/share-url.ts` is the list): `scene` (omitted for fleet), `cars`, `smin`/`smax` (spawn speed, m/s), `night`, `wet`, `real` (realism), `fx` (only after a manual FX pick), `fxd` (particle density), `cel` (cel look 0-1; only after a manual slider pick, Auto leaves it out), `squash`, `buckle`, `loop`, `slomo`, `ts` (fixed time scale), `deform`, `car`, `barrier`/`balls`/`ramps` (fleet), the piston knobs `pkph`/`pkg`/`phard`/`phold`/`phop`, the door knobs `dkph`/`dkg`/`dside`, the stack knobs `scars` (2-20)/`sdrop` (m)/`sgap` (s), and, in the race, `track`/`laps`/`ai`/`aggr`/`police`/`noreset`/`spectate`. Booleans are `1`/`0`. In the stack scene `cars` is the sandbox's own count (it comes back on leaving); the stack's is `scars`.
- **Initial conditions:** every run picks a `seed` (up to six hex digits); the fleet's spawn spots and speeds, its balls, the corkscrew car's speed and the derby's start bearing all derive from it, so the same URL spawns the same field. With Loop on, each new run rolls a new seed and the hash follows. Fixed scenes (press, pistons, doors, range) carry no seed. A spawn-speed change applies from the next spawn (R), as in the HUD, so press R after it and the URL describes the run on screen. Not covered: what happens after spawn is a live physics run, and a race's random picks (rival aggression spread, traffic) are not seeded; a race URL restores the course, laps, field size, aggression and police setting.
- **Applying:** the hash is applied when the page loads (it is the first reset, so the first run already uses it) and when it is edited or pasted into the open page. It is untrusted: unknown keys and malformed values are ignored, numbers clamp to the HUD's own ranges, and every value goes through the setter the HUD uses. A missing key means the default, except `fx` (a missing tier keeps Auto, or the `?fx=` pick).
- **Netplay and the room:** `room=CODE` (a private code, `[A-Z0-9]`, ≤ 12; `tx=bc` only for two tabs of one browser) is in the hash while this browser hosts or has joined a room, and leaves it when the player leaves. A host writes `room=CODE` beside its settings; a client's scene and settings are the host's, so a client writes `room=CODE` alone and applies no settings. Opening a `#` that names a room joins it as a guest (a room nobody hosts shows "Nobody is hosting this room" with a **Host this room** button); a `#` without one never leaves a room. A public match's `pub-…` name is never put in the hash or read from it. Links made before `room=` existed decode as before. **Hosting shows the code:** a big room code with **Copy link** (`origin + base + #room=CODE`; a box to select when the browser refuses the clipboard) and **Share** (the system sheet, where the browser has one), top centre (top right on phones). **What a page load starts as:** only the `#`. Nothing the last run stored picks a scene, setting or room; localStorage holds preferences only (driver name and car, HUD layout, saved highlights). `?fx=` still works beside the hash.

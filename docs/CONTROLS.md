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
| Orbit | drag | right stick | one-finger drag |
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

## Scenes and the HUD

| Action | Keyboard | Controller | Touch |
|---|---|---|---|
| Pause / play | Space (when not driving) | Start | Play / Pause |
| Reset / reshuffle | R (when not driving) | | Reset |
| Scenes: Fleet, Derby, Race, Press, Pistons, Doors | D (from the whole field), Z, C (when not driving), I, N | | scene buttons |
| Jersey barrier / ramp balls (fleet only) | B / K | | wall / balls buttons |
| Loop, slow-mo, auto-orbit, audio | L, M, O, U | | Playback section |
| Night, wet asphalt, cinematic FX tier (off → low → high) | H (outside a race), X, F | | Playback section |
| Shape ↔ lattice | Y | | Cars & crash section |
| Deform rig, control particles, JSON capture | G, P, J | | Debug views section |
| Pistons: fire one ram (clockwise from front-left) / all eight | 1–8 / 0 | | piston panel |
| Doors: fire A / B / C, open or shut the door, swap side | 1–3, 4, 5 | | door panel |
| Fullscreen | (the browser's own F11) | | Fullscreen |
| Key list | | | ? |
| Multiplayer | | | Net |

Control particles (P): size = mass, lime → red = plastic travel, magenta = contact, yellow line = shape-match pull (short pulls drawn up to 4×), blue line = rest → now; the bar above each car marks its worst travel.

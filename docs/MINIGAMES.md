# Range minigames

Three throw events on the Range scene: Long jump, High jump and Ring Fling. Local and cosmetic: nothing here is in a replay or a snapshot, and netplay clients do not see minigame state. The one sim change is the vertical carry on an ejection (section 8). The Range scene itself is in [`CINEMATIC.md`](CINEMATIC.md).

## 1. What it is and how to play

Range scene -> Mini games -> Long jump / High jump / Ring Fling. There is no auto-drive: the car is parked at the top of the station's start hill until your first pedal press. Drive down the hill and the run-up, up the climb; at the lip the driver is thrown (section 2) and the camera follows him (`ride-cam.ts` leads its aim along the throw).

The score card shows the live value while he flies (metres past the lip, metres above it, or the ring zone under him), then the scored value once he is at rest. Buttons: **Retry** (Ring Fling: **Next throw**, then **New set** once the set is complete), the quick-switch buttons to the other two modes, **Reset run** and **Exit**.

Ring Fling throws per set: 1-10, default 5 (`THROWS_PER_SET`); a set's score is the sum of its throws and is recorded when the set completes. Bests are kept per mode x car type and overall, in `localStorage` under `crush.minigame.best.<mode>[.<throwsPerSet>].<carType | overall>` (`engine/minigame-store.ts`; only Ring Fling keys carry the set length).

## 2. Station anatomy

Each station is laid out in its own frame (`scenes/minigame-constants.ts`): +x is the throw direction, z = 0 the lane's middle, y measured from the pad. Stations sit at `STATION_ANCHORS` (long jump (0, 0), high jump (0, 90), Ring Fling (0, 170)), every one within `STATION_HALF_WIDTH` 12 m of its anchor.

Start pad (6 m) -> start hill (falls 3 m over `START_HILL_LENGTH`: 11 / 24 / 24 m) -> run-up (`RUN_UP_LENGTH`: 0 / 40 / 30 m) -> climb or kicker -> lip. The parked car faces +x.

- **Long jump**: lip = world origin, because the jersey barrier is origin-bound. The barrier throws the driver by a hit. Incline 7 degrees, 2 m, crest radius 100 m, flat for x in [-5, 0]. The barrier rebounds without ejecting above ~31.4 m/s arrival (lowest failing speed, phase dependent) and its minimum ejecting arrival is ~20.6 m/s (monster), so the approach is tuned: arrival at full throttle 24.4-27.0 m/s for all 7 classes (was 36-39), thrown exactly once at 20 of 20 start phases. No ejection below ~18 m/s horizontal.
- **High jump**: one R25 m arc kicker tangent to the run-up, lip pitch 60 degrees, lip 9.5 m up, run-up 40 m, hill 24 m. All 7 classes reach the lip at full throttle.
  Radius sweep at 60 degrees (lip height; sedan / muscle / truck / monster unboosted apex m; ratio): R20 7.0 m 60/142/110/219 3.64 | R22 8.0 m 127/146/123/213 1.81 | R25 9.5 m 135/158/125/200 1.67 | R28 11.0 m 125/151/127/207 1.66 | R30 12.0 m 136/154/125/218 1.75. R25 was chosen (R20 is a cliff for the sedan: lip speed 18.9 vs 27 m/s).
- **Ring Fling**: 5 degree incline plus a 4 m ball-hop quarter wave (1.005 m, the machine's 3.35 in on 120 in), lip 1.31 m high, hill 24 m, run-up 30 m; the board starts 6 m past the lip.

**Forced lip throw** (High jump, Ring Fling; `minigame-lip.ts` `LipThrow`): there is no wall on those ramps, so when a car's centre crosses the lip plane going +x (tested between two `collide` calls, so a fast slice cannot step over it) its driver leaves through the windscreen at the car's full 3D velocity (`EjectionWatch.throwDriverNow`) and the driverless car is cut to `LIP_CAR_SPEED_KEEP` (0.3) of its speed so it falls short of the boxes and board. **Back drop**: behind the lip the floor falls away at `LIP_BACK_FACE_PITCH_DEGREES` (60) down to the landing level.

Class lip speeds at full throttle (horizontal m/s): High jump sedan/hatchback/wagon 27.0, police 27.1, truck 26.6, muscle 29.8, monster 35.6. Ring Fling sedan 32.4, muscle 35.7, truck 32.3, monster 38.2, police 32.5.

## 3. Scoring

- **Long jump**: the torso's x at rest, past the lip (min 0).
- **High jump**: the torso's height above the lip as it crosses the posts' plane (`POSTS_DISTANCE`), from either side of the posts; 0 if he never crosses (scored 0 once at rest).
- **Ring Fling**: the cup the torso rests in, 10-50, or one of the two 100 pockets (`ringScore`); 0 off the board.

"At rest" is the torso's own still-time reaching `REST_HOLD` (1 s), never the ragdoll's `settled` flag (`minigame-session.ts`): the score reads the torso, so it waits on the torso's own still-time, not on a whole-body flag. Rest positions still carry a skid lottery after landing, so the sizing bars are on landing distance as well as rest.

## 4. The Ring Fling board

`present/ring-fling-art.ts` and `scenes/minigame-ring.ts` scale the real skee-ball machine's measurements (inches x `METRES_PER_REAL_INCH` 0.0254) by `SKEE_SCALE` 15, the least whole scale at which the 50 cup holds the 2.0 m lying dummy. The board starts `RING_BOARD_START_X` 6 m past the lip, slopes `BOARD_SLOPE` 0.06 over a 27 in lane; cups have radii 1.33-1.9 m; rim, skirt and rails come from the machine's rail inches; the two 100 pockets (window 2.29 m across) sit at the sides behind the 50 cup; a 19 m backstop (backboard) stops a long throw (`RING_BACKSTOP`).

## 5. The high jump frame

Posts at `POSTS_DISTANCE` 11 m (half-span `POST_HALF_SPAN`). Distance boards every 5 m to 50 m then every 10 m (`BOARD_FINE_STEP`, `BOARD_FINE_UNTIL`, `BOARD_COARSE_STEP`), big labelled boards every 50 m (`MAJOR_BOARD_EVERY_METRES`). Frame top = `FRAME_HEADROOM_FACTOR` 1.3 x the best measured crossing height (`HIGH_JUMP_MEASURED.crossingHeight` 156.4 m, so 210 m). A tall net stands `NET_DISTANCE_PAST_POSTS` 30 m past the posts (41 m). Between them, cardboard box piles end 35 m out: `BOX_COUNT` 48 dynamic cuboids (4x4 towers of 3, 0.9 m cartons in the cost test) in the ragdoll's own Rapier world (`present/ragdoll-boxes.ts`, art `cardboard-art.ts`). Cost per 60 Hz frame (8 Rapier steps): +0.03-0.05 ms asleep, +1.1 ms awake (budgets 0.5 / 3 ms).

## 6. The dummy boost

`THROW_BOOST` (`minigame-constants.ts`) holds a `{ forward, upward }` pair per minigame: multipliers on the thrown driver's horizontal and vertical launch velocity, applied only to a minigame throw and only on the ragdoll side (the ragdoll's launch). The sim's Ejection event stays physical, so replays and the fingerprint do not move.

Why a pair: the sim keeps a car's horizontal speed on a slope and lets its vertical speed follow the ground, so a 60 degree kicker throws at vy = vh x tan(60), a near-vertical rocket. Hence forward < 1 for the High jump.

| Mode | forward | upward | Intent |
|---|---|---|---|
| Long jump | 1.1 | 5 | the barrier throws a flat skim; upward 5 turns it into an arc |
| High jump | 0.108 | 1.03 | forward keeps the best run landing in the box field before the net; upward puts it over the posts |
| Ring Fling | 0.4 | 0.7 | a ballistic landing that puts a full-throttle sedan on the 30 cup |

Unboosted a best long jump rests 16-26 m.

## 7. Sizing table

Worst of 3 repeats, from `minigame-sizing.test.ts`.

**High jump** (boost 0.108 / 1.03; best run: crossing height at the posts / apex @ distance / lands, all m)

| Class | Crossing / apex @ dist / lands |
|---|---|
| sedan, hatchback, wagon | 110.3 / 111.1 @ 10.1 / 19.7 |
| police | 110.0 / 110.8 @ 10.1 / 19.8 |
| truck | 106.2 / 107.8 @ 9.7 / 19.2 |
| muscle | 129.0 / 130.3 @ 12.2 / 23.7 |
| monster | 156.4 / 178.2 @ 17.0 / 32.2 |

70% run: the sedan family, truck and police do not cross the posts (they land 9.1-9.4 m, short of the 11 m posts); muscle crosses at 4.3 m; monster at 75.2 m. The lowest share of full-throttle lip speed that still crosses: sedan family 0.75, police 0.75, truck 0.77, muscle 0.69, monster 0.59. Frame top 210 m, posts 11 m, net 41 m, box piles end 35 m.

**Ring Fling** (boost 0.4 / 0.7; lip h/v m/s -> rest x, cup)

| Class | Full throttle | 70% run |
|---|---|---|
| sedan, hatchback, wagon | 32.4/13.5 -> 31.7, cup 30 | sedan 21.6/8.9 -> 18.9, 0 (short of the 10 cup at 20.1 m); hatchback/wagon 23.3-23.6, cup 10 |
| truck | 32.2/13.7 -> 31.1, cup 30 | 23.3-23.6, cup 10 |
| police | 32.5/13.6 -> 31.0, cup 30 | 23.3-23.6, cup 10 |
| muscle | 35.6/14.9 -> 38.7, cup 50 | 21.0, cup 10 |
| monster | 38.2/18.0 -> 40.8, bounced off the backstop (0) | 25.1, cup 20 |

Sedan speed-share sweep (share of full-throttle lip speed -> cup): 0.72-0.86 -> 10, 0.88-0.94 -> 20, 0.96-1.00 -> 30; below 0.70 no cup.

**Long jump** (boost 1.1 / 5; best run: approach m/s -> release h/v -> lands / rests m, sign)

| Class | Best run | Mid run (85% of approach) |
|---|---|---|
| sedan, hatchback, wagon | 24.9 -> 30.6/15.9 -> 91.3 / 93.5, 90 | 26.2/17.1 -> 83.0 / 83.9, 80 |
| muscle | 26.7 -> 32.7/15.7 -> 96.3 / 99.2, 90 | 27.9/17.3 -> 89.6 / 90.6 |
| truck | 24.5 -> 30.2/14.5 -> 83.4 / 110.0 (skid after a short landing), 100 | 25.8/19.6 -> 92.2 / 92.8 |
| monster | 26.7 -> 32.7/17.2 -> 105.9 / 107.2, 100 | 27.9/23.3 -> 118.2 / 140.7 |
| police | 24.8 -> 30.5/16.3 -> 93.2 / 94.7, 90 | 26.2/17.6 -> 85.3 / 86.0 |

The barrier throws no driver below ~18 m/s horizontal, so the long jump's mid run is 85% of the approach (70% elsewhere). A slower car carries more vertical speed off the incline, so for the truck and monster the mid run can out-carry the best run; a multiplier cannot change that ratio.

## 8. Determinism and replay impact

The only sim change is in `vehicle/ejection.ts`. REPLAY entry:

> Ejection: the thrown driver keeps the car's vertical velocity (v.y = pre.y + THROW_UP, was the constant 3.5; the watch's velocity ring stores y), so a car leaving a ramp or kicker throws its driver along the ramp's climb. Flat-ground ejections are unchanged (pre.y ~ 0) but any ejection with a moving-vertical car (derby jumps, ramps) changes: replays and the sim fingerprint change. A forced-throw entry (EjectionWatch.throwDriverNow, used by the range minigames' lip trigger) is new and unreachable from existing scenes.

Everything else (session state, bests, boosts, boxes, boards, panel) is local presentation: not in replay or snapshots; netplay clients do not see minigame state.

## 9. Re-sizing and files

Change a number in `scenes/minigame-constants.ts`, then run the tests that print the tables: `minigame-sizing.test.ts` (boost and bars, pins `HIGH_JUMP_MEASURED` within 2%), `minigame-profile.test.ts` (hill and kicker speeds), `minigame-lip.test.ts` (lip throw and `LIP_CAR_SPEED_KEEP`). Update `HIGH_JUMP_MEASURED` and this doc's tables with what they print.

| File | Role |
|---|---|
| `scenes/minigame-constants.ts` | modes, anchors, hill/incline/kicker numbers, `THROW_BOOST`, `HIGH_JUMP_MEASURED` |
| `scenes/minigame-profile.ts` | station ground profile |
| `scenes/minigame-ground.ts` | ground solids built from the profile |
| `scenes/minigame-ring.ts` | Ring Fling board geometry, cups, pockets, `ringScore` |
| `scenes/minigame-high-jump.ts` | posts, boards, net, box layout, crossing capture |
| `scenes/minigame-lip.ts` | `LipThrow` forced throw |
| `scenes/minigame-session.ts` | attempt state machine, scoring, bests pairing |
| `engine/engine-minigame.ts`, `engine-minigame-commands.ts` | engine wiring and panel commands |
| `engine/minigame-store.ts` | `localStorage` bests |
| `present/ragdoll-boxes.ts`, `cardboard-art.ts` | box piles (Rapier cuboids) and their art |
| `present/minigame-art.ts`, `high-jump-art.ts`, `ring-fling-art.ts`, `long-jump-art.ts`, `minigame-surface-art.ts` | per-station art |
| `present/ride-cam.ts` | camera aim lead along the throw |
| `vehicle/ejection.ts` | `throwDriverNow`, vertical carry |
| `components/minigame-panel*.tsx` / `.ts` | score card and buttons |

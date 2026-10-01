A good derby/vehicle-combat AI usually works best as a layered system: pick a target with a utility score, approach from a favorable offset, attack the side or rear quarter, avoid prolonged head-on pushes, and keep a separate recovery layer for wall/stuck states. Steering-behavior building blocks like seek, pursue, evade, obstacle avoidance, wall avoidance, arrival, and separation are the standard foundation for this kind of game AI[1][4][8][9].

## Target selection scoring
Use a per-opponent score instead of “closest enemy wins.” A practical score can combine:
- Distance and travel time
- Relative velocity and intercept ease
- Exposed side/rear angle vs front-facing angle
- Enemy vulnerability, such as spinning, reversing, or being near a wall
- Threat level, such as whether the target is already focused on you
- Team/arena pressure, so multiple AIs do not all choose the same victim

A common pattern is to make the score favor targets that are easier to reach and easier to hit from the side, while adding a penalty if too many allies are already committed to that target. Steering literature and vehicle-AI implementations commonly combine multiple behaviors and then weight or prioritize them to produce one control result[3][4][7][9].

## Ramming approach angles
For derby combat, angle matters more than raw speed. Favor an approach that:
- Arrives at the target’s side or rear quarter
- Cuts in at about 30–70 degrees relative to the target’s forward vector
- Uses a shallow arc so your car can “wrap” into the hit rather than spearhead straight in

That angle gives better hit geometry and reduces the chance of bouncing off the enemy’s strongest direction. General steering systems support this well through pursuit/intercept plus offset positioning, rather than pure seek[4][8][9].

## T-bone attacks
T-boning works best when you predict where the opponent will be, then steer to intersect that point from the side. Predictive pursuit is specifically designed for this: estimate the target’s future position from current speed and distance, then steer toward that predicted intercept rather than the current location[5][8][9]. In practice:
- Predict target position \(t\) seconds ahead
- Choose an offset point perpendicular to the target’s velocity
- Hit the side panel with your front corner or broadside mass
- Abort if the line to the intercept becomes head-on

## Protecting the engine by reversing into opponents
That is a real derby tactic and it translates well into AI. Use it as a situational behavior, not the default:
- If the front arc is threatened and the rear is safer, switch to reverse pursuit
- Prefer backing into the attacker’s nose while keeping your most fragile zone away from impact
- Reverse only when there is enough space and when wall risk is low
- Blend this with a “face threat” or “keep rear toward attacker” behavior

This can be implemented as a high-priority defensive mode that temporarily inverts the usual facing/attack logic, while still using obstacle and wall avoidance to prevent self-trapping[4][8][9].

## Avoiding head-on hits
Head-on collisions should usually be a fallback, not a goal. Add a strong penalty when:
- Relative forward vectors are opposed
- Closing speed is high and impact normal is frontal
- Your armor/health model predicts major front-end damage

Instead, bias steering toward:
- Offsetting to one side
- Breaking line of approach with a short lateral move
- Waiting half a second to re-angle if the target is directly ahead

This is a natural fit for weight-based steering or context-based selection, where “front impact” gets low utility unless the target is disabled or trapped[3][7][9].

## Stuck and wall detection with recovery
A robust recovery layer should detect both “physically stuck” and “tactically stuck” states:
- Low speed for several frames while throttle/steering input is active
- Repeated collision contacts with wall geometry
- Little or no progress toward any meaningful goal
- Oscillation between left/right steering without displacement

Recovery actions:
- Brief reverse
- Turn away from the obstacle normal
- Short forward burst after rotation
- Recompute target or switch to wander/escape mode
- If boxed in, pick the least-blocked exit vector rather than continuing pursuit

Obstacle avoidance and wall avoidance are standard steering components for this, and they can be run continuously with a higher-priority recovery override when stagnation is detected[1][4][8][9][11].

## Predictive intercept steering
For fast vehicle combat, pure seek is too naive. Predictive intercept steering is the right default for chasing moving opponents:
- Estimate future target position based on target velocity and your closing speed
- Intercept that predicted point, not the current point
- Recompute frequently, but not every frame if CPU is tight

This is the same core idea behind pursuit behaviors and future-position prediction used in vehicle AI examples[5][8][9]. For impact attacks, you can use the same prediction but add a lateral offset for side hits.

## Aggression personalities
A good combat roster needs different personalities so every car feels distinct:
- Brawler: high pursuit weight, high head-on tolerance, low caution
- Hunter: moderate pursuit, strong side-angle bias, good target switching
- Opportunist: prefers damaged, spinning, or wall-trapped enemies
- Coward/Survivor: avoids head-on, prioritizes survival and rear defense
- Berserker: aggressive after taking damage, less selective, higher commit time

Implement personalities as parameter sets that adjust the same utility model:
- Target selection weights
- Commitment duration before switching targets
- Tolerance for frontal risk
- Recovery aggressiveness
- Preference for ramming vs avoidance

Steering systems are especially suited to this because personality can be expressed as weights over shared behaviors instead of separate bespoke logic[3][4][7][9].

## Preventing all AI from dogpiling one target
This is best solved at the squad/world decision layer, not the steering layer. Useful options:
- Add a crowding penalty for targets already selected by allies
- Reserve attack “slots” around each target, such as front, left, right, rear
- Give each AI a soft preference for a different target unless a target is weak or isolated
- Broadcast recent target claims to nearby allies
- Re-score targets periodically so focus naturally spreads

In practice, this makes the group look coordinated without requiring perfect planning. Group behaviors and separation concepts from steering AI are a strong fit here[4][9][12][15].

## Performance-friendly steering for 10–30 cars
For this many vehicles, keep the system simple and staged:
- Update expensive target scoring every 0.1–0.3 seconds, not every frame
- Run cheap steering and avoidance every frame
- Use local neighborhood queries instead of all-to-all checks
- Limit candidate targets to nearby or visible enemies
- Reuse cached predictions for a few frames
- Use priority or layered blending instead of evaluating every behavior equally

A practical stack is:
- L0: hard safety overrides, wall escape, stuck recovery
- L1: obstacle avoidance and separation
- L2: target utility scoring and intercept choice
- L3: attack steering, side-offset pursuit, ramming commit
- L4: style/personalities and occasional wandering

That structure scales well because most cars only need to consider a small set of nearby threats and targets, while the steering result is assembled from a few simple behaviors[1][3][4][7][9].

## A compact implementation model
A strong combat-car AI loop can look like this:
- Detect local threats and obstacles
- Score nearby enemies with distance, vulnerability, angle, and crowding
- Choose one target and one attack offset
- Predict intercept point
- Steer toward the intercept while avoiding head-on geometry
- If threatened, switch to defensive reverse mode
- If stuck, enter recovery
- Re-evaluate target periodically

If useful, a follow-up can turn this into:
- a utility-scoring formula,
- a behavior-tree/state-machine layout,
- or pseudocode for Unity/Unreal/Godot.

[1] OpenSteer Preliminary Documentation (https://opensteer.sourceforge.net/doc.html)
[2] GitHub - bidwars/Demolition-Derby---The-Fair-Grounds (https://github.com/bidwars/Demolition-Derby---The-Fair-Grounds)
[3] Getting AI to control giant speeding cars with lasers and machine guns using Unreal Engine (https://www.unrealengine.com/pt-BR/tech-blog/getting-ai-to-control-giant-speeding-cars-with-lasers-and-machine-guns-using-unreal-engine)
[4] Game Ai Chapter 3 | Hexo (https://lc1995.github.io/2018/03/13/Game%20Ai%20Chapter%203/)
[5] Demolition Derby - The Fair Grounds *Demo - BeamNG.drive (https://www.beamng.com/resources/demolition-derby-the-fair-grounds-demo.1784/update?update=5583)
[6] 01008975 (https://www.scribd.com/document/130861801/01008975)
[7] Developing Vehicle AI for Stingray, Part 1 | by Anders Elfgren | Medium (https://medium.com/@Srekel/developing-vehicle-ai-for-stingray-part-1-211c1bdbe9ad)
[8] wangchen/Programming-Game-AI-by-Example-src · GitHub (https://github.com/wangchen/Programming-Game-AI-by-Example-src/blob/master/Buckland_Chapter3-Steering%20Behaviors/SteeringBehaviors.h)
[9] (Kinematic) Motion (https://faculty.cc.gatech.edu/~surban6/2018sp-gameAI/lectures/2018_02_01_steering_continued.pdf)
[10] Demolition Derby and Figure 8 Race Review (https://www.gamespot.com/reviews/demolition-derby-and-figure-8-race-review/1900-2880585/)
[11] Steering Behaviors - recited (https://recited.io/kb/ai-in-game-development/machine-learning-applications/difficulty-adjustment-systems/)
[12] Microsoft PowerPoint - steeringBehaviors -slides.pptx - AMIS (https://artemis.ms.mff.cuni.cz/main/download/hagents/steeringBehaviors-slides-withPics.pdf)
[13] Demolition Derby 3 - Play Free Online (https://gamexplains.com/game/demolition-derby-3)
[14] Microsoft Word - Paper5.doc (https://ijssst.info/Vol-05/No-1&2/TOMLINSON.pdf)
[15] ARTIFICIAL INTELLIGENCE IN GAMES (http://www.cril.univ-artois.fr/~delima/teaching/mpia/assets/pdf/lec01.pdf)

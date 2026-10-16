# Talk guidance extracts

## Talk 1: ArcadeDriftPhysics (Parking Garage Rally Circuit; talk runs 00:00-25:10)

### Design goals
1. [00:15] Game should feel accessible and easy to control like Mario Kart, with one button to drift.
2. [00:19] Unlimited boost chaining.
3. [00:24] A "right-on-the-edge-of-control" feeling like Crazy Taxi.
4. [00:28] Approach: combine the Mario Kart and Crazy Taxi feels.

### Who is in charge: car or camera
5. [00:35] Core question (possibly incorrect epiphany about Mario Kart): who's in charge, the car or the camera?
6. [01:27] In Driver: a car simulation takes your inputs and the car has no idea a camera exists; a separate camera follows the car and frames the action.
7. [01:07] In Driver you let go of the steering input early (answer "1, 2, or 3" seconds), based on looking at the car, its pointing, traction, acceleration, slip, surface.
8. [01:55] In Mario Kart you generally let go of the steering input when the camera is pointed in the direction you want to be going.
9. [02:06] Hypothesis: in Mario Kart you steer the camera and the kart is a layer on top giving you other input about what you're doing.
10. [02:20] Driver: you stare at the car and occasionally glance at the road. Mario Kart: you look at the road and occasionally glance at the kart.
11. [02:33] Approach taken: the camera is in charge; you steer the camera through the world; the car is a layer on top.

### Camera-first build-up (point + raycast)
12. [02:46] Start with a point in space; raycast down, find ground, place itself a certain height above the ground.
13. [03:00] Add simple code: left/right inputs rotate the point.
14. [03:07] Forward/back inputs translate the point along its forward (blue, Z) direction.
15. [03:20] Place the camera on the point; back it up a little and attach it to the point for third-person view.
16. [04:12] Put a temporary car model on the point, change nothing else: it already looks like driving the car.
17. [04:22] Mario Kart hypothesis: whenever you turn left/right, simply rotate the car model on the point. "It's not a simulation or anything."
18. [04:54] Hide frame and debug things; steer the front tires the same way the car is turned.
19. [05:10] Limitation: going down a ramp breaks the illusion because it's a single point sliding through the world; more work needed to look like real Mario Kart.
20. [05:49] Result: you fly the camera through the world; the kart is a layer on top.

### Hovercraft physics body
21. [05:59] Next, connect the car to the world: a simple hovercraft.
22. [06:04] Cube with four raycasts, one per corner, shooting down and finding the ground.
23. [06:11] If a ray hits the ground, it pushes back on the cube to make it float a certain height above the ground.
24. [06:26] No friction concept: the hovercraft slides and skates around the world.
25. [06:35] It collides with and bounces off walls.
26. [06:42] Four raycasts each apply a force in the up direction.
27. [06:47] Strength of the force is based on how close that point is to the ground.
28. [06:53] Needs "get point velocity": velocity of a point on a rigid body, not of the whole body (a moving and rotating body has points moving in different directions). Godot doesn't have this built in.
29. [07:21] Camera places itself at the center point of the hovercraft; the hovercraft provides position only, nothing else, for the camera system.
30. [07:53] Hovercraft naturally orients to the terrain going down a hill.
31. [07:59] It is a physics object: smacking into other physics objects gives interactions for free.

### Acceleration and traction forces
32. [08:10] Accelerate: apply a force pushing the hovercraft in the direction it's pointed (camera direction).
33. [08:24] Problem: after steering, the hovercraft keeps sliding because of momentum from the old push in a different direction.
34. [08:59] Break velocity into two pieces: forward component (blue direction) and sideways component (red direction).
35. [09:20] Wish: all velocity only in the blue direction, none in the red.
36. [09:38] Forward/back drive code operates in the blue direction; add a force opposite the red component to stop sideways sliding.
37. [10:03] Acceleration force: input for forward/back becomes a desired speed (can be complicated by game design).
38. [10:12] Current forward speed = dot product of hovercraft velocity with the forward direction (the camera-facing direction).
39. [10:24] Compute acceleration to go from current forward speed to desired speed in one physics step.
40. [10:35] Force = acceleration times mass.
41. [10:42] That force would be super strong (car instantly jumps to desired speed), so put limitations on the force, then apply it.
42. [10:55] It is a central force: pushes the hovercraft, causes no spin.
43. [11:02] Traction force: sliding speed = dot product of actual velocity with the sideways axis.
44. [11:16] Compute acceleration to go from current sideways speed to desired sideways speed (zero) in one physics time step; force = mass times acceleration.
45. [11:37] Limit the traction force. If unlimited you'd have perfect traction and the car would never slide at all.
46. [11:52] Result: push forward/back freely; when turning, sideways velocity appears and is immediately destroyed by the traction force ("the car doesn't want to slide sideways").
47. [12:30] The car itself has no concept of traction; it is spinning through the world; hitting a wall makes it rotate.
48. [12:46] All forces applied to the hovercraft come from the camera: accelerate pushes in camera facing direction; constant force resists sliding sideways.

### Posing the car (torque)
49. [13:02] Want the Mario Kart look: the car is posed and always points forward.
50. [13:11] Work out the signed angle between the camera facing direction (dark blue) and hovercraft facing direction (light blue): zero, negative or positive.
51. [13:26] Use that angle to apply a torque rather than a push force, rotating the hovercraft to point where the camera faces.
52. [13:43] Torque is a big positive number on one side, ~zero when aligned, negative on the other: "almost like a spring".
53. [14:04] Torque in code: which way hovercraft points, which way camera points, signed angle between them.
54. [14:14] Spring on the angle: offset times spring power; positive turns one way, negative the other.
55. [14:31] Implemented as a damped spring: also subtract a portion of angular velocity (about the axis the torque is applied around).
56. [14:52] It's a spring force applied as a torque instead of a force.
57. [15:00] There's a little lag because it's a torque.
58. [15:33] Mario Kart step: the same torque points the car where you want; offset the target a little: when turning left, turn the car a little more to the left; same for right.
59. [16:11] Parking Garage Rally Circuit summary: you drive a camera through the world, the car is a hovercraft, and the car is posed relative to the camera to point a little in a plausible way and give feedback about what you're doing with the controls.

### Drifting
60. [16:47] Drifting is just two things.
61. [16:52] Thing 1: when you go into drift mode the car steers automatically; you can let go of the steering input and the car steers on its own.
62. [17:04] Thing 2: the direction the car wishes it was going is not the camera direction but offset a little.
63. [17:16] Drifting = automatically steering and sliding at the same time.
64. [17:33] Final step: steering input affects the offset angle you want to drive at (steer into the drift, counter the drift).
65. [17:50] Come around a corner, start a drift, adjust it, let go and drive straight again.
66. [18:14] Exaggerate the car pose: when you steer it's a little, when you drift it's a lot.
67. [18:19] Also tilt the 3D car model for an extra lean in the direction of the drift.
68. [18:29] Camera tilts and changes field of view to accentuate the effect.

### Boost system
69. [18:41] Speed graph: drive at normal top speed; green line lines up with the normal top-speed line.
70. [18:51] When you drift, speed drops.
71. [18:56] After the drift, if it's a clean drift, you get a boost.
72. [18:59] Boost lasts a little while, then top speed drops back to normal top speed.
73. [19:11] Boosts can be chained.
74. [19:15] Chain rule: if you start a drift while boosting, the boost that comes after it is stacked on top.
75. [19:37] Top speed ends up significantly above normal even while drifting.
76. [19:43] Stacking can reach about twice the normal top speed, maybe 3x with enough chaining on a track.
77. [19:57] Risk/reward comes from this; tight drifting controls give a feeling of control; physics-based hovercraft car plus boost chaining give the feeling of barely being in control and weaving through traffic.
78. [20:21] A little assist: colliding with cars didn't totally kill speed; the game is generous.

### Crashing (stated downside)
79. [20:33] Downside: what to do about crashing. No car simulation; a hovercraft puppeteered by forces and torques.
80. [20:46] Actual collider of the car floats above the ground.
81. [20:53] Debug states shown: driving, drifting, boosting, etc.
82. [21:03] Problem: constantly pointing the car where you want it to go; if you smack into something and the car is yanked to point forward, it looks weird; unclear how to stop puppeteering.
83. [21:20] Author calls this the weakest point of the game.
84. [21:26] Two criteria to decide you crashed (stop posing the car): (a) you hit something hard enough, or (b) the angle between which way you're headed and which way the car is facing is too big. Then go into the crashed state.
85. [21:47] Crashed state flips the logic: stop posing the car, let the car fly around with physics doing whatever it wants, and try to get the camera back around behind the car.
86. [22:03] Stay in crashed state until the camera is mostly back behind the car again; then turn posing back on.
87. [22:12] Binary decision: am I in control / puppeteering / crashing? Two state changes: entering the crash state and leaving it.
88. [22:30] If you smack into something it can flicker into the crash state.
89. [22:52] Must decide when to let go of the car (enter crash) and when things have settled enough to go back to puppeteering.
90. [22:59] Most complaints that the physics do weird things are about this topic: entering crash when it shouldn't, or exiting too soon so physics picks up and causes strange reactions.
91. [23:24] Author agrees he could have tuned the system and its thresholds better.
92. [23:34] Every design decision makes some things easy (drifting, boosting, steering come naturally from camera-first) and others hard (crashing); you have to deal with those trade-offs every time.

### Closing
93. [23:57] Author doesn't like follow-along step-by-step tutorials: hard to retain information; this video is a high-level breakdown.
94. [24:23] Things to look up: how to do a spring force, how to apply torques, what the dot product is.
95. [24:39] Promotion: DLC "European Tour", eight new tracks in Western Europe, about five bucks on Steam. (end 25:10)

## Talk 2: Vehicle Feel Masterclass: Arcade Feel With Simulation Depth (Matthew Harris, Criterion Games; talk runs 00:06-57:33)

### Talk intro (Matthew Harris, Criterion Games, "Vehicle Feel Masterclass: Balancing Arcade Accessibility with Simulation Depth")
1. [00:26] Talk isn't a set of hard and fast rules; it is a sharing of processes and guidelines followed during development.
2. [00:44] Talk is focused on the handling side of game feel only (audio, VFX, sense of speed, force feedback excluded).
3. [01:20] Criterion encourages cross-discipline skills; the programmer works closely with designers to tune and design vehicle handling.
4. [02:05] Structure: physicality-first approach to simulation -> add accessibility through an input-layer of assists (critical to accessibility without reducing depth) -> feed the handling back via the camera.

### Arcade vs simulation
5. [02:58] "Arcade" here means a particular set of game design decisions leading to an arcade feel, not a genre like top-down shooters.
6. [03:06] Arcadey games: intuitive controls readily apparent to the player; compromise on realism for the sake of fun; a multitude of game mechanics the player balances against each other.
7. [03:20] Simulation games: replicate a real-world experience; control system is immersiveness first; high degree of realism and believability from gameplay and handling.
8. [03:31] Simulation games have fewer game mechanics than arcade games; gameplay is focused on controlling a realistic vehicle, not weapons and boost.
9. [03:40] Design decisions give a sliding scale between arcade and simulation.
10. [03:49] Simulation end (Forza Horizon, Forza, iRacing): gameplay entirely around racing lines, cornering, drafting; most assists off by default but optional accessibility options (braking, steering help); high learning curve but very rewarding for players who master it.
11. [04:19] Simcade (middle; hybrid games such as Forza Horizon and Need for Speed Live): Hollywood realism, over the top but within the realms of real life; exaggerated drifts, massive jumps; additional challenges (extreme weather, weapons, cop chases).
12. [04:50] Arcade-style races: heavily stylized or cartoonish tone; large variety of game mechanics (drifting, boosting, stunts, weapons) learned in addition to racing; racing gameplay is quite accessible for new players but still has depth for players who want the most out of the game.
13. [05:17] Simulation races have fewer mechanics for the player to focus on; aim is to make cornering and racing as satisfying as possible.
14. [05:32] Arcade is generally more accessible and fun; simulation is harder to get into but offers a more serious take on racing competition.
15. [05:41] Key consistency: the player has to input controls at a satisfying cadence; actions per minute are actually pretty comparable between simulation and arcade.
16. [05:50] Simulation: the player focuses all attention on the racing line, tapping, braking and turning at just the right intervals to nail the corner.
17. [05:57] Arcade: the player divides attention between drifting around corners, boosting and firing weapons; arcade-style races have a wider variety of game challenges to focus on than simulation.
18. [06:17] Factors to decide where on the scale to be: (a) what sort of players are you targeting (serious sports fans demanding realism, or fantasy fulfillment)? (b) how serious and realistic is your game tone?
19. [06:31] If you plan lots of mechanics such as boosts and weapons you'll likely fall more on the arcade side.
20. [06:39] Balance the number of mechanics and complexity of the simulation against your assists, to achieve a sensible rate of actions per minute.
21. [06:46] How much effort do you want to spend on your physical simulation? If you can't put much time in but are building a realistic motorsport simulator you might end up with boring and shallow gameplay.
22. [06:57] Do you want the game accessible to lots of players or focused on an experienced target market?
23. [07:02] If building an arcade or simcade racer you'll likely need some assists to help keep input frequency at satisfying levels.
24. [07:09] These aren't hard and fast rules, but you should have a strong idea of where you want to sit on this spectrum.
25. [07:14] Don't try and have it all, otherwise you risk building an overly demanding and complex game.
26. [07:20] Criterion's approach: combine the best of both worlds; start with physicality and build a realistic, physically-based simulation; then build assists on top, which makes the simulation more accessible and lets the player focus on more things at once.
27. [07:35] Designers carefully balance physicality and accessibility to get a balanced experience: easy to learn but hard to master. Used since Need for Speed Hot Pursuit.

### Physical simulation
28. [07:54] Physical simulation is the foundation that allows building a game with deep mastery and rewarding challenge.
29. [08:11] The context of your game affects which elements to simulate; compare simulations of car dynamics using approaches that mimic real-world physical effects.
30. [08:20] Ideally pick parts of the simulation that add play to the handling, giving the player multiple things to balance and learn to achieve their goal.
31. [08:34] Before starting physical simulation, consider game context = a set of requirements on your simulation.
32. [08:40] Consider: is your environment wide open or enclosed? How does this affect desired vehicle behavior? What is the player's goal (racing, stunts, getting from A to B)? If A to B is a challenge, the game may be about complex traversal.
33. [09:01] Forza Motorsport: wide road, long curved turns; player wants to win through precision driving through corners and drafting.
34. [09:15] Burnout: urban roads, tight turns, some jumps; player could be racing or doing stunts for a score-attack mode; focus on cornering but also boosting and stunts.
35. [09:32] Destiny's Sparrow: transport vehicle designed for open terrain but piloted down narrow corridors; main intention is to reach the target without colliding and slowing down too much; lower pressure.
36. [09:49] Uncharted Jeep: light puzzle mechanics navigating up rookie mud slides; challenge is picking a route up the mudslide while keeping the tires in a state of grip.
37. [10:01] Each context has its own requirements from the vehicle. If you change the context, re-evaluate the vehicle and see if it still suits it.
38. [10:09] Example: Sparrow racing in Destiny worked as a timed special event but if they wanted to build more of the game around racing they would retune the vehicle to fit that context.
39. [10:26] During production it's easy to forget to update a vehicle if the context shifts, particularly if the vehicle has shipped before (speeder bike BF1 reworked entirely for BF2 because of new map topography plus tech debt).
40. [10:47] Vehicle and environment are complementary; changing one may require changing the other.
41. [10:53] Motorsport racing as context: somewhere on the SimK (Simcade) part of the spectrum; an expectation of realism, so simulation should be based off real physical effects and let the player play with grip and acceleration.
42. [11:13] Needs enough depth that each vehicle accelerates and turns differently; the simulation needs to be detailed enough to support that accurately.
43. [11:22] Benefit: with a realistic physical simulation, real-world tuning data (engine or tire metrics) can be used as a starting point for tuning vehicles.
44. [11:33] Trivially simple model: frictionless rigid body with a single force and torque applied at the centre of mass: result is flat, unrealistic motion that is not enjoyable or interesting to drive. Very few gains would be served by this model.
45. [11:53] Take inspiration from real-world vehicles to improve: look at real-world systems for motorsport vehicles (powertrain and tire friction as examples).

#### Powertrain
46. [12:39] Engine and transmission are the powertrain system: purpose is to transmit energy from the engine to the wheels (engine -> clutch -> transmission -> differential -> wheels).
47. [13:06] Powertrain is a feedback loop: the engine provides torque to the wheels but the wheels resist movement (not just wheel inertia but because the wheel is in contact with the ground and must overcome the inertia of the whole vehicle before rotating at optimal speed).
48. [13:29] Some of the energy is used to overcome inertia, affecting the amount of energy actually used to drive the vehicle forward.
49. [13:37] When modelling, look into each piece: engine simulation may need authorable torque at different operating RPM plus engine inertia and the feedback mechanism; clutch may want different operating efficiencies at different RPM; transmission could simulate numerous gear setups and how long it takes to change between them; tires apply force realistically via tire friction.
50. [14:14] Compare simple model with powertrain model on a speed-over-time graph: simple model has very uniform acceleration profile; complex model has a more curved profile: more acceleration at the beginning of takeoff than nearing top speed, with small bumps at the gear changes.
51. [14:38] Because of transmission simulation, multiple gears are more effective at providing acceleration at the lower end of their working speed range and then tail off as vehicle speed approaches the next gear's working range.
52. [14:49] Even just driving in a straight line, the simulation has added much more complexity and interesting physicality than the simple model.

#### Tire friction
53. [15:04] Wheel hub with rubber tire; the section at the bottom is slightly flattened under load of the vehicle and is called the contact patch.
54. [15:18] A point on the hub vs. the corresponding point where the tire touches the ground: as the hub rotates the tread and wall stretch between them; the elastic force of the rubber tries to spring back, pulling the contact point back and applying an equal force onto the wheel hub, pushing the whole vehicle forward slightly; continues until vehicle speed matches the rotational velocity of the tire.
55. [15:55] Need a simulation model for how much force is applied under what conditions: dynamics are incredibly complex, many models; Pacheco model used (formula takes the rotation speed of the wheel and relative velocity of the road).
56. [16:13] Slip angle = angle between the direction of the ground velocity and the direction of the wheel hub.
57. [16:18] Pacheco formula produces two forces: longitudinal force (drives the vehicle forward) and lateral force (turns the vehicle).
58. [16:26] During acceleration the road speed is lower than the wheel speed, so longitudinal slip maps to a particular force in the graph: right-hand side = accelerating, left-hand side = braking.
59. [16:39] Lateral force graph: under a particular slip angle gives the turning force during cornering.
60. [16:46] Each graph has a peak, which is where the most effective acceleration or cornering behavior is found; this gives the effect of playing with the limits of grip.
61. [16:56] The player has to try and hit these peaks to be as effective as possible during a race; this adds a lot of depth and mastery.
62. [17:09] Visible results: chassis rocks back and forth during gear changes due to drivetrain simulation; body rolls to the side during corners due to tire friction and suspension simulation. Depth of simulation shows through and gives the player precise control and physical play to master.

### Input and assists
63. [17:52] With accurate, deep simulation of the desired vehicle sorted, look at input and assists to give the feel and balance between arcade and simulation aimed for.
64. [18:01] Drifting definition: forcing the rear wheels of a tyre to break traction so the vehicle drifts sideways to maintain momentum in a turn; possible but tricky to achieve in real life, so Criterion applies several assists to help players achieve a long, satisfying drift.
65. [18:22] Input layer: control mapping and any modifications to control inputs, sent across to the simulation where it turns the wheels or drives the engine.
66. [18:35] Key point: you have assists that might work on either side (input layer or simulation). Example: input layer assist detects a button combo to trigger drift mode; simulation level assist applies increased physical damping while in drift mode.
67. [18:53] Decide what you want to achieve by adding assists. Once the input layer communicates with the simulation you have something playable; review and see what needs to change.
68. [19:03] Reasons for assists: input complexity too high (reduce it); reduce the simulation feel and move toward the arcade side; take existing forces or effects in the simulation and emphasize them (e.g. making drifts last longer).
69. [19:19] Detailed simulation can bring unwanted side effects such as extreme slowdown on uneven terrain or collision hitching; assists may target these.
70. [19:29] Assists can convey the game state back to the player in a more intuitive/obvious manner so that the learning curve is easier.
71. [19:37] Assists can also be accessibility options to make the game playable by a wider range of players.

#### Five assist categories
72. [19:52] Five categories: player intention, driver, physical, real world, feedback. Not hard templates; a thought exercise for deciding which parts of the game to target.
73. [20:07] Need for Speed drifting: took a simulation with realistic drifting behaviour and used multiple types of assists to make it more stable, easier to sustain, and maintain more of your speed than in real life.
74. [20:27] Player intention assist: at the input level, looks at the player's input and works out whether their intention differs from the normal mapping; can look at the current simulation for context.
75. [20:41] Example: brake tap to enter drift. Driving straight ahead and tap brake = want to slow down. Turning heavily when you tap brake = want to enter drift to turn more aggressively.
76. [20:56] Driver assist: simulates the experience and muscle memory of a professional driver.
77. [21:02] Example: balancing your torque. In real drifting the tires twist to match the drift direction and the driver feels it through the steering wheel and adjusts to extend the drift. Analog stick doesn't lend itself to this, so emulate it by re-centering steering input so that zero input = keep drifting at this angle rather than straighten the wheels.
78. [21:27] This is absolutely key for a controllable drift and gives the player the control an ace driver could achieve.
79. [21:34] Physical assists: forces applied directly to the vehicle's physics simulation; take existing qualities of the simulation you want to feel hyper-real and emphasize what's there; look at the forces applied by the simulation that hinder the desired effect and counteract them.
80. [21:50] Example: in a deep drift a component of the tire friction opposes motion and slows the vehicle. Calculate the magnitude of the frictional force slowing you down and reapply that force in the direction of the vehicle's velocity to minimize speed loss; lets designers tune how much speed loss they desire.
81. [22:10] Real-world assists: simulate part of the vehicle which exists in real life and manipulate it to achieve the desired effect. Example: ABS lets players brake effectively without carefully tapping triggers; when drifting starts, turn ABS off so back wheels spin and lose traction (enter the drift quickly); when the player is detected trying to exit the drift, turn ABS back on to allow fast acceleration out.
82. [22:40] Feedback assists: do not affect handling; help the player understand the simulation and show UI. Wherever possible feed back the simulation from real-world sources (strain of the engine, squeal of tires); feedback assists are specifically things you wouldn't see in real life. Example: Forza braking line highlights red if tires will lose traction and you should slow down.

#### Tips for assists
83. [23:07] Since assists influence both controls and the physical simulation, getting their feel right is just as important as tuning the physical simulation; wrongly tuned they can disguise all the great simulation work.
84. [23:19] Tip: tune assists to be as subtle as possible while still achieving the desired effect; it's easy to have very strong stabilization forces which help effectively but wipe over your simulation work.
85. [23:34] Tip: rather than switching behaviour on/off on a binary condition, fade it in or out over some parameter, even if that parameter is time; less obvious to the player and adds nuance.
86. [23:47] Tip: think about where the optimal assist strength is and let the player gradually learn to find the perfect balance (depth and mastery); the game should feed this back to the player so they can tell if they're doing better.
87. [23:59] Tip (programmers): add plenty of helpful debug visualizations so designers can see what physical effect their parameter changes have.
88. [24:13] Tip: set up auto tests for vehicles and their expected top speeds, accelerations etc. to catch unexpected changes or a physical assist affecting vehicle performance. (Most Wanted: a vehicle artist adjusted a wheel's size and it changed the top speed; caught by an auto test and fixed quickly.)

### Camera
89. [24:50] "Camera is handling" (phrase used a lot at Criterion): it doesn't matter how great the simulation and assists are if the camera doesn't feed it back well.
90. [24:59] A stiff or loose camera can massively change the feel of a vehicle, so it is part of the handling; the same designers who tune handling parameters tune the camera parameters because they're intrinsically linked.
91. [25:13] Two approaches: camera-led (player input turns the camera and a layer interprets camera direction and passes it to vehicle controls) vs vehicle-led (player input controls the vehicle directly and the camera follows as a separate system).
92. [25:36] Camera-led usually matches the shooter paradigm (aim/pitch on the right stick); lets the player point the camera accurately but at the loss of handling feel and precision; good where primary gameplay is aiming and shooting and driving is secondary (e.g. Mark V tank in Battlefield 1).
93. [26:04] Camera-led layer decides how to move the tank tracks to point at the camera rather than direct control; adds ambiguity and unexpected motion, particularly when reversing a vehicle with camera-led handling.
94. [26:23] Vehicle-led is usually the default for racing games; steering on left stick and camera follows the vehicle's motion; more direct control feel, greater driving precision and camera feedback but harder to quickly look behind (so usually accompanied by a look-behind button).
95. [26:45] BF1 armored car used a vehicle-led camera for best game feel. "At Criterion, we almost always use vehicle-led cameras due to the precise handling feel we require."
96. [27:07] A good camera should: feed back important game state (e.g. camera angle while drifting); respond to player needs (focused on what the player needs to see, doesn't obstruct line of sight); sell physicality by using the physical simulation to complement the vehicle motion.
97. [27:27] Rigid camera (locked behind the vehicle, pointing directly down the front; no behaviour): the simplest starting point; vehicle position locked on screen so physicality shows through the background rolling and pitching, which can be disorientating and makes it hard to focus on game objectives.
98. [27:58] Improve by conveying vehicle motion by moving it in relation to the frame of the screen: in a deep right turn the camera lags slightly and the vehicle shifts to the left of the screen.
99. [28:10] Sprung camera: set a target point for the camera to tend towards, allow motion in all directions with a force pulling the camera toward the target proportional to how far away it is.
100. [28:23] Tune the spring per axis (e.g. lots of sideways motion when turning, less forward/back motion when accelerating/decelerating).
101. [28:34] Also point the camera at a look-ahead target fixed in front of the vehicle which shows the player where the vehicle is heading.
102. [28:43] Consider velocity extrapolation on the look-ahead target so the camera looks into turns and keeps the player's focus near the center of the screen when turning.
103. [28:57] In all the demo videos the physical simulation and handling are identical; only the camera changes.
104. [29:27] Three key sprung-camera tuning parameters: convergence (most important; how far the camera moves toward the target each sim frame; higher = tighter to the back of the vehicle); momentum (accelerates the camera in the direction it's already travelling); damping (stops the camera overshooting the target and oscillating).
105. [29:53] Strong convergence: very similar to the rigid camera; vehicle isn't moving much on screen; doesn't feel very physical.
106. [30:11] Weak convergence: much more motion in frame; vehicle feels dynamic and alive; but the vehicle appears to point off screen during large turns, which is tricky to control as you can't see where you're going; fix by tightening the camera or adding velocity extrapolation to the look-ahead target.
107. [30:35] Landing camera: the camera must sell physicality; when the vehicle comes off a large jump and hits the ground so hard the suspension bottoms out, convey with a large camera movement that doesn't obscure the road ahead for long but still sells the impact; momentum and damping forces give an exaggerated behaviour when landing.
108. [31:04] The plain sprung camera already gives some feedback and could probably ship, but go the extra mile.
109. [31:18] Add camera shake on landing when all four wheels are on the ground after travelling downwards quickly: 30 Hz oscillation in pitch and roll for 0.5 seconds.
110. [31:39] Reduce the damping on the sprung camera so the momentum term carries it further downwards than the target, giving a better sense of impact.
111. [32:04] BF1 camera checks against the requirements: convergence affects the vehicle's position on screen so the player can tell the turning radius (feeds simulation back); looks into turns so player sees where they're going (responds to player needs); special attention to the landing camera makes the vehicle feel extra heavy and solid (sells physicality).

### Case study: Starfighters in Star Wars Battlefront 2
112. [33:27] Direction: players feel like an ace pilot; improve BF1 handling significantly; much larger scale game mode.
113. [33:54] BF1 shooting: hold left trigger to lock onto anything within a wide cone in the middle of the screen, right trigger to fire; shots auto-aimed as long as there's a lock-on. BF1 used a camera-led handling level (camera moves first, vehicle catches up).
114. [34:25] Player feedback on BF1: enjoyed the Star Wars fantasy; very accessible; but lacked depth around auto-aimed shooting, difficult to control, starfighters felt like toys on a string; players wanted manual roll control.
115. [34:48] BF2 fixes: aiming closer to a shooter; handling that felt precise; a camera that shows off the physicality of the vehicles; roll control.
116. [36:01] Arcade vs simulation balance: target market was casual gamers wanting accessibility plus hardcore players expecting a flight-sim-like pilot fantasy; decision: intuitive pitch and yaw controls like an arcade game, but give players full roll control, letting players execute their own evasive manoeuvres rather than cutscenes triggered on the D-pad (BF1).
117. [36:29] Shooter input paradigm (flight and aiming on the right stick) as more intuitive for players from a shooter background and matching the rest of the game; provide an option to fully remap the analog sticks for those expecting a flight-sim setup.
118. [36:47] Simulation analog: fighter planes. X-Wings bank into turns like planes; crashing Star Destroyers fall downwards.
119. [37:01] Airfoils (which keep planes in the air and give secondary effects like altitude loss when turning) were rejected as not matching expectations of a starfighter; went with a simple anti-grav simulation instead.
120. [37:15] Kept the banked turns from a fighter plane, simulated with a horizon steering setup: controls stay locked to the horizon but the starfighter banks on screen.
121. [37:26] Used a simple engine thrust force instead of a prop/jet engine model as no need for airflow play in space.
122. [37:36] Aerodynamic drag in a heavy turn affects how aggressively a plane can turn; did something similar with an air brake: experienced players pull the air brake when turning for a temporarily reduced turn radius. No physical justification but it felt right; prototyped and playtested until convinced it belonged in production.
123. [38:01] Horizon steering: two separate frames represent an orientation (matrix or quaternion). Control frame stays flat when the player yaws (points in the direction of flight following the ship's pitch) and allows the yaw of the ship to be expressed in the direction it appears on screen. Body frame rolls into the turn for banked turns; the camera stays flat so the player controls the direction intuitively.
124. [38:40] If the starfighter is pitched up, it rotates on the newly oriented horizon (pointing straight up and turning left/right ends up pointing downwards in the local pitch horizon rather than fading to the world horizon).
125. [38:55] Camera: camera-led was rejected (BF1 used it and it lacked the hoped-for precision); vehicle-led gives greater flight precision (an initial goal) and improved physicality; chose a vehicle-led sprung camera in a similar style to Battlefield 1.
126. [39:28] Vehicle-led camera looks into the direction of travel and allows the starfighter to move significantly but predictably on-screen.

### Camera shake and aim precision (BF2 starfighters)
127. [39:50] Problem: hard to aim while the camera is shaking (you aim down the camera).
128. [40:07] Conventional camera shake rotates the camera around its center point (pitch/roll by x degrees), so a distant focus point moves a lot on screen.
129. [40:16] Fix: orbit camera shake: shake the camera by moving it laterally as well as rotating it, keeping it pointed at a particular point far away towards the horizon; foreground things (the vehicle) move around on screen, distant targets stay stable.
130. [40:52] Blending the two shake types lets designers tune shake for near vs far objects; they chose distant aim stability due to the game's focus on shooting.

### Auto-roll
131. [41:06] Strong sense of up in levels: players ended up upside down frequently even without the roll control, so added auto-rolling that kicks in when the sticks are centered.
132. [41:18] Reasoning: return to center is a player intention to fly straight, so always accompanying it with rolling to the horizon isn't obtrusive; it is a smaller, more subtle force when almost level; as unobtrusive as possible.
133. [41:32] A small 20 degree window when the starfighter is inverted where auto-roll never kicks in, so players can fly upside down when they intend to; all other angles tend back to the horizon.
134. [41:44] Added a settings toggle to turn auto-roll off for hardcore players who want total control over orientation.

### Shooting assists
135. [41:56] Incredibly hard to hit a moving target by pointing your ship towards another.
136. [42:10] Numbers: max targeting range around 800 meters (ships small on screen); targets travel up to 120 meters per second; lasers have a travel time so you must lead the target; unassisted aiming incredibly difficult so assists were needed.
137. [42:31] Auto-aim cone: a cone in front of the player that retargets the gun barrels to fire the shots more towards the correct target position.
138. [42:38] Like BF1 but the effect gradually fades in and out rather than switching on and off.
139. [42:48] Show a reticle on screen at the predicted target position (where the ship will be when the shot gets there) so the player knows where to aim; this is a feedback assist (extra simulation data via UI).
140. [43:07] If the predicted position is inside the aim cone, shift the gun barrels toward the perfect predictive position, fading gradually based on how far into the cone the predicted position is.
141. [43:17] Aim far from the target = only a little help; crosshair closer to the target reticle = more assist; inside the reticle = fully assisted, guaranteed hit.
142. [43:30] Effect is subtle enough that players don't notice shots diverging from the crosshair, but hit a lot more; gives a feedback loop of gradually more hits as aim improves, rather than hit-or-miss.

### Sticky targeting
143. [43:46] Problem even with the aim cone: putting the crosshair on the predicted reticle felt fiddly; players constantly overshooting and making correctional inputs, because targets are constantly moving: the player is targeting an ideal angular velocity as well as an orientation.
144. [44:07] Reduce complexity with sticky targeting, inspired by an aim assist in Destiny that pulls the cursor along with the enemy when the enemy strafes left or right: drag the cursor along with the target.
145. [44:22] Method: take the target's linear velocity in world space, transform it into the player's local-space angular velocity; map this target angular velocity into the input layer; work out how close the player was to this ideal input and fade the value towards the ideal, similarly to the aim cone logic.
146. [44:42] Use the aim cone to fade the effect in and out; only apply sticky targeting when the player has non-zero right stick input ("we only help them aim when they are trying to aim").
147. [45:01] Demo: sticky targeting off = jerky correctional movements; most kills only when the enemy travels in a straight line. Maxed = aim point super stable, cursor dragged along exactly. Shipped tuning = much reduced correctional input but subtle enough that the player doesn't notice being assisted.
148. [45:45] Outcome: hybrid vehicle-shooter: simplified physical model with control options for highly skilled players; vehicle-led camera for precise handling; layered assists to make shooting feel precise and satisfying.

### Summary slide (46:02)
149. [46:08] Games should balance simulation depth with arcade accessibility to achieve intuitive controls with challenge and mastery.
150. [46:16] Build your vehicle for the context it's intended for, and retune if the context changes.
151. [46:21] Think about how deep your simulation should go.
152. [46:24] Look at real-world vehicles for inspiration, and decide which parts add depth to the player experience.
153. [46:31] Build assists to make the game more accessible.
154. [46:33] Balance the amount and strength of assists depending on how many game mechanics the player has to interact with, ensuring input frequency isn't too high.
155. [46:41] Consider camera-led and vehicle-led cameras.
156. [46:43] Allow the physicality of the vehicle to be conveyed through the camera, and give the player the feedback they need.

### Q&A: digital vs analog input
157. [47:34] Keyboard only gives on/off inputs; for both console and PC use steer rates: fade the input in and out, don't turn straight to maximum input; holding A gradually fades toward that.
158. [48:04] BF2: on pad you can balance rolling against the auto-roll system with an analog input (e.g. quarter-percent left to stay locked at an angle), impossible with A and D.
159. [48:31] PC mechanism: holding A and D at the same time means "lock wherever I am" (A to here, then both to lock in place); devise new mechanisms that suit PC better than pad.

### Q&A: understeer vs oversteer
160. [49:07] Depends on the key experience wanted.
161. [49:17] For a heavy-feeling vehicle a slightly understeery vehicle is often nice: even at max steering you might not make the corner, which encourages players to brake, turn in and drift round.
162. [49:36] Most Wanted's handling was a little understeery, which encourages kicking the back out into a big drift.
163. [49:45] If the game isn't about drifting and wants complete control on the left stick with maximum responsiveness (F-Zero-like), use something way more oversteering that kicks into turns aggressively.

### Q&A: suspension bottoming out
164. [50:28] BF1: four raycast suspension wheels plus a rigid body; bottoming out detected when suspension is more than 80% compressed.
165. [50:52] Rigid body often collides on bottom-out; smooth it as much as possible; some collision hitching occurs.
166. [51:01] Try to keep the maximum 20% of suspension travel very, very rigid in the suspension force applied back, so you remain in that 20% floating off the ground and stop the rigid body colliding; minimise hitching through a very small amount of very strong suspension at the top of the suspension raycast.
167. [51:30] Camera can lurch below ground if momentum term is massive; a separate capsule collision system pushes the camera out of terrain and resolves it so it won't go through.

### Q&A: gun convergence
168. [52:15] Guns are not at the camera (wing-tip barrels; Slave 1 has barrels at the bottom with the camera high up): aiming along the camera makes barrels point up (~40 degrees) for close targets and missed shots go up the screen.
169. [53:27] Either shoot down the camera centre or accurately from the barrels; solution was a fudge: fade based on target so shots always hit the target, and for very close targets limit the vertical deviation to a particular set angle.
170. [54:27] All calculations based on the predicted position; use the point you are trying to aim at to fade the effect in and out.

### Q&A: obstruction and real-world experience
171. [54:42] Suggestion: try autocross/real driving at the limit (SCCA, Porsche or BMW clubs) to develop intuition for systems at the edge of the performance envelope, weight transfer, and what happens when you lose control.
172. [55:50] Getting real experience with vehicles is valuable; when doing a new type of vehicle, try driving something similar.
173. [56:22] Object between gun and target but not between camera and target: BF2 didn't handle it much (mostly aiming at starfighters, tunnels at most). For a first-person shooter: raycast from the gun and, if obstructed, fire the bullet there instead of where it would go from the camera's point of view, and decide which is most applicable. (end 57:33)

## Talk 3: JustCause4_TireDynamics (talk runs 00:00-27:55)

### Intro (Hamish Young, lead mechanics designer on Just Cause 4)
1. [00:05] Talk is about vehicle physics and tire dynamics.
2. [00:10] Speaker is Hamish Young.
3. [00:11] He was the lead mechanics designer on Just Cause 4.
4. [00:15] Today covers tires in particular, and wheels.
5. [00:27] Just Cause 4 is a big open-world action game.
6. [00:32] A wide range of vehicles, over 100 different types of vehicle.
7. [00:38] A lot of them have wheels, "not all, but a lot of them do".
8. [00:42] Wheels and tires are the focus of the talk.
9. [00:46] Could talk about many different bits of physics, but tires are the focus; some of these principles can be applied to other phenomena.
10. [00:54] The code on the slides is deliberately hard to read because it will take you time to read it; get the notes afterwards. It is there as reference.

### Goals and limitations
11. [01:10] First set out the goals being trying to achieve.
12. [01:18] Limitation: a limited CPU budget.
13. [01:20] Making a big open-world game with a lot going on (tornadoes, all sorts of things), so keep performance pretty good.
14. [01:30] Limitation: the sim runs at 30 hertz.
15. [01:34] Unlike a dedicated driving game, limited frame rate.
16. [01:41] Want it to be believable. In quotes: not actually realistic like a driving sim, but cars should feel like they behave like cars.
17. [01:56] Limited cognitive load: when driving at high speed you want to be able to do other things and think about other things, not just driving, even in complex environments. One of the big design goals.
18. [02:14] A very wide range of vehicles, small, large and everything in between; want one system that can cope with all of them.
19. [02:25] Open world: a huge, diverse environment to drive in; want it to work in all those environments.

### Spectrum of handling models
20. [02:35] Different choices you can make in range of handling.
21. [02:41] Kart racing end (a lot of indie developers head this direction): there's no tire model; it's all just forces built on that core rigid body.
22. [02:58] Through arcade racers; to some extent a vehicle SDK from one of the physics providers, which has a constraint-based system.
23. [03:12] Then SimCade and driving simulations; at the far end a really accurate tire model with large complexity.
24. [03:24] The talk is about how to get "here": move up or down this spectrum to hit the sweet spot.

### Order of operations (what was done for Just Cause 4)
25. [03:45] Similar input parameters to the simulation models; take some elements from the simulation.
26. [03:52] But want much higher grip than is real, for that arcade kind of physics.
27. [04:00] Friction clamps to stay physically stable; similar to how the constraint-based driving models work.
28. [04:12] How to draw friction curves.
29. [04:16] Then scale down the pitch and roll components to compensate for the grip.
30. [04:20] Then driver assist, which is very similar to the kart racing kind of physics at that end.
31. [04:29] Bring all those elements together into something that works as a whole.

### Why not real (semi-empirical, Forza/Gran Turismo) tires
32. [04:35] Semi-empirical Forza, Gran Turismo end of things.
33. [04:44] Take a real tire, put it in a real machine, vary the input parameters, measure the outcome.
34. [04:53] Curve-fit that outcome to replicate it in the game; the more accurately and the higher the frequency you run, the more accurate.
35. [05:05] Downside: if you want to modify what those tires do (you don't want real), it gets pretty hard to modify.
36. [05:14] Real reasons you may not want real tires.
37. [05:19] Running at 30 hertz you get terrible feedback, especially with weight transfer.
38. [05:27] You're not going to feel it, and the car is unpredictable in behavior.
39. [05:33] Understeer is a big deal for anyone going from arcade to a driving simulator: if you brake and understeer you don't hit the corner, unacceptable in an open-world game ("I need to come up to a T-junction and get around that corner").
40. [05:50] Oversteer can be an issue, but not such a big issue.
41. [05:54] To correct oversteer in a very physical, correct way you need complex traction control and stability control, difficult to get right.

### Tire setup and reference frame
42. [06:07] Tire setup: basic parameters assumed generated.
43. [06:14] The wheel has a position and orientation, which includes the steer.
44. [06:18] A linear velocity of the wheel.
45. [06:20] Its angular velocity in the direction of the spin.
46. [06:24] A ground position and normal where the tire hits the ground.
47. [06:32] Tire reference frame: split the velocity into the part along the line of the wheel and the part lateral to the wheel, plus the angular velocity of the wheel's spin.

### Slip ratio
48. [06:48] Slip ratio is one of the input parameters.
49. [06:55] Wheel spin, defined in the slip ratio, is when the wheel is spinning faster than it's moving forwards.
50. [07:03] Intuition: a point on the rim going round, if perfectly gripping, gives zero (you're following the road); wheel spin is when it's going faster than the road.
51. [07:21] Locked: the wheel is completely locked and sliding forwards, and that's negative.
52. [07:27] When braking you're in this negative value up to minus one, which gives a braking force; a positive value means acceleration and a positive force.
53. [07:45] Slip ratio is defined from minus one (fully locked) up to essentially positive infinity (wheel stationary but spinning fast).
54. [07:57] The equation you see in books is literally that; the slide shows a little code that does the same.
55. [08:11] In the game engine it's a little more complicated: a gotcha.
56. [08:17] If wheel spin is positive and you're going backwards (negative speed) you get a minus sign on the first piece and end up more negative than minus one, which you don't want.
57. [08:38] So make a modification: more complicated code to cope with those edge cases, which are things you might want to try and avoid.

### Slip angle, camber, wheel load
58. [08:52] Slip angle is literally an angle: the angle where the direction of the wheel is essentially sliding; all you work out is that angle from the two directions of the wheel velocity. Pretty simple code.
59. [09:18] Camber: how much the wheel is rolling over relative to the ground; relatively simple equation; core piece for understanding how the wheel relates to the ground patch.
60. [09:38] Wheel load: in a sim the suspension is very high frequency and you get a lot of detail in wheel load, with the tire model reacting dynamically.
61. [09:54] At 30 hertz that's not really possible to get great results from, and you basically don't want too much weight transfer.
62. [10:04] To keep it realistic: take the suspension force at rest (when the thing isn't moving) and blend it into the suspension force with the dynamics; ends up scaled right and gives a wheel load that's reliable.

### Why more grip diverges; friction clamp
63. [10:23] If you want more grip, there's an issue: grip can cause things to diverge.
64. [10:33] Velocity of a wheel through the tire model gives a big force; it can end up going the wrong way and even faster than it started, which means a bigger force, which starts it going the other way. The model can diverge.
65. [10:52] Drag from the grip flipping the sign of velocity is something you should never want; one of the reasons these things can be unstable.
66. [11:02] Friction clamp: a way of enforcing that the friction only behaves like a friction; it's not going to go wrong.
67. [11:14] The principle is used all over the place: for aerodynamics with an unbounded V squared term, a clamp stops it firing your thing backwards when going too fast.
68. [11:29] Danger: the mass in the equation, the applicable mass. With more than one tire (pretty much every vehicle) you can't apply it all to the same mass, so it's more complicated.
69. [11:48] In an iterative solver (a lot of physics engines) this is essentially how they do vehicle physics: take the clamp and scale down how much force you get out relative to it, which keeps it always in the middle.
70. [12:04] Downside: if you wanted any effects based on wheel spin, like losing grip because of wheel spin, it doesn't model that at all.

### Useful mass heuristic
71. [12:15] Instead, provide the friction clamp in code but introduce the idea of "useful mass".
72. [12:25] It goes back to wheel load: with all wheels at the correct load and everything stationary, the relative mass for a wheel is that wheel load divided by all those wheel loads.
73. [12:45] That gives the ratio of vehicle mass one tire's friction clamp should represent.
74. [12:51] Not completely perfect, but a pretty good heuristic, and works very, very well up to tiny, tiny velocities; used for the rest of the talk.

### Longitudinal, angular and lateral clamps
75. [13:06] Different dimensions need these clamps. First: wheel sliding forwards; prevent it going back on itself in a completely linear sense.
76. [13:18] Use the useful mass and prevent the forward force being bigger than required to stop that wheel.
77. [13:27] Complication: the wheel is putting power in if it has torque, so take that into account too (the second term).
78. [13:36] Angular clamp: prevent the wheel spinning the wrong way and changing the sign of the slip; the reaction force must not be too big.
79. [13:49] Work out what the new velocity needs to be relative to the slip; code more complicated; generates the maximum force that prevents the wheel spinning the wrong way relative to road speed.
80. [14:07] Third: lateral clamp. Looks like just the mass going sideways, but you have to worry about angular considerations; theoretically the longitudinal clamp should do the same.
81. [14:26] Takes the inertia into account, not just the linear force.

### Clamp on vs off demo
82. [14:34] With the friction clamp on, the car accelerates; markers on the curves are smooth, not jumping around; no jitter.
83. [14:53] With the clamp off, the car is shaking as it drives away and the values jitter all over the place because they're not getting clamped; you get divergence. Don't want that in your game.
84. [15:13] Once the clamps are in place you can turn up the friction as much as you like because you're never going to break it; designers can go absolutely wild.

### Drawing friction curves
85. [15:25] To set things up controllably without recording real tire data, find the right friction curves for your game.
86. [15:37] Literally draw the friction curves in a spline tool.
87. [15:43] A three-phase model: any of the curves goes from zero relative to a peak, then saturates out at the far end. The curve can have as many points as you like.
88. [16:01] Difficulty: in a more complicated model there are complicated mathematical relationships between the parameters; simplify that down to only a few graphs.
89. [16:20] "Possibly the most difficult part of the talk."
90. [16:25] Forward force, if not slipping sideways at all: accelerating gives a certain curve; braking gives a certain curve.
91. [16:44] When sliding sideways and wanting to go forwards you may get more wheel spin, so you reduce the shape of the curve.
92. [16:53] This lets you have things like doughnutting: to doughnut you want the side slip to let you wheel spin.
93. [17:04] The other way around: lateral force, curves are force relative to slip angle; five of them for each of the slips of the wheels.
94. [17:18] That's how you get drifting naturally: slam the handbrake on and the bottom graph kicks in (a negative slip angle, as stated), so low lateral grip and you slide sideways.
95. [17:36] Then pump the accelerator: now in the saturated slip angle, getting wheel spin, which gives low lateral force as well.
96. [17:48] The bottom graph and top graph skip all the middle ground, and you get that change of behavior.
97. [17:55] The relationship between lateral and longitudinal graphs can be counterintuitive, but is still simpler than modifying a complicated mathematical function like a magic formula tire.
98. [18:10] Takes a while to get your head around, but very powerful once you do; it's really this that is the basis of the model.
99. [18:20] The angle you have and the steepness of the curve represent the feel in a different way than you might expect.
100. [18:36] The steepness of the curve is how much grip you feel; not the actual height, the steepness matters.
101. [18:43] Going up the curve it feels grippy; as it levels off it feels like it's sliding; if it drops, it feels like the slide is getting faster.
102. [18:57] Gain intuition about what the curves feel like: play with when you get wheel spin, how the car feels when turning, how it feels when drifting, and balance it out.

### Normalized curves and grip authoring
103. [19:13] In the engine all of these curves are normalized.
104. [19:21] In the final game pretty much only two or three sets of tires for all vehicles in the whole game, because they basically did the right things; only the actual grip value had to be set up per vehicle.
105. [19:36] The grip authored for front and rear wheels was essentially just a value; trying to balance front and rear grip.
106. [19:42] That value is multiplied by the graph set, then by the wheel load so it's scaled correctly, then by the time step to get the impulse.
107. [20:00] Grip level × graph × wheel load × time step: quite a simple equation of these forces.

### Scaling pitch and roll to compensate for grip
108. [20:12] Big thing: if you want something believable and turn the grip up, the car will wallow and roll and do horrible things.
109. [20:22] You can add "anti-damp, like suspension" (as transcribed) and stiffen the suspension, but if you want those values vaguely realistic, the best thing is to modify how you apply the force to begin with.
110. [20:38] Reduce the pitch and roll components of the forces you were going to apply to the wheel; turns it down in a very controllable way; don't have to redo your suspension setup.
111. [20:48] Implementation: decompose the impulse at the point into linear and angular components, then multiply by a factor into the roll and pitch.
112. [20:58] That let the suspension setup be completely realistic, and the extra grip didn't cause too many problems.

### High-level summary
113. [21:09] Input parameters: slip ratio and slip angle.
114. [21:16] Grip turned up higher than real, prevented from getting too big with the friction clamps.
115. [21:24] The clamps keep us physically stable whatever graph is drawn.
116. [21:33] Then draw friction curves; tremendous freedom once the clamp is in place.
117. [21:42] For planes and non-cars, just a linear ramp and a saturation, without the complicated wheel spin effect, because the clamps meant that whatever happened it would stay physically believable.
118. [22:01] If you then have too much grip, scale down the pitch and roll components.

### Driver assist / drift control
119. [22:04] Final step: driver assist, drift control; this goes back to kart racer type physics.
120. [22:13] You're controlling the car from the basis of a rigid body and the forces; many, many ways of doing this; a talk in its own right, not diving deep (questions welcome).
121. [22:33] If you come from a kart racer feel, you'll be very familiar with the kinds of forces you'd want here.
122. [22:40] Drift is triggered either by button press and control, or if the slip angle of the rear wheels gets beyond the limit, which gets you into the drift phase.
123. [22:54] You then start controlling the vehicle at the whole-vehicle stage and not about the tires.

### Wrap-up
124. [22:59] The model uses all parts of the spectrum: kart-racer handling for drift, physics-SDK-style friction clamp model for keeping inbounds, and a slightly semi-realistic tire model modified heading in the more sim direction.
125. [23:25] Together this means running at 30 hertz, going around the corner very fast ("unrealistically fast"), controlling in the drift.
126. [23:37] Final point for indie developers with kart racer mechanics who want to go more physical and add tires: the next step is to get friction clamps right for the wheels, then do whatever you like with your tire model. Not that hard to move from one to the other.
127. [24:09] End of talk (applause/questions follow).

### Q&A: wheel placement and suspension (asker 24:27)
128. [24:39] Question: how did you decide where to place tires on the ground and how did that interact with suspension forces?
129. [24:46] Line tests (raycasts) placed the wheel on the ground; the suspension force held the vehicle off the ground; similar to lots of simplistic behaviors.
130. [25:01] Line tests were linear, nothing sophisticated; for more sophisticated suspension geometry you'd put it on a circle to change how the roll center worked; kept very simple, just line tests.

### Q&A: debris under the line test
131. [25:20] Question: if debris flew under your line test, would that push the car up?
132. [25:28] Depended: a physics model with layers; the raycast collision depends on whether something was tagged in the layer.
133. [25:42] Big enough debris: absolutely, the car would climb up on it. Very small things were not put in that physics layer and were ignored by the line test.

### Q&A: Havok integration
134. [26:00] Question: Just Cause went through Havok; how did tire forces integrate back into Havok, or own solver?
135. [26:12] Used Havok's API to apply forces; once the force was calculated it was applied; the solve happened in the Havok solver.

### Q&A: curbs / line-test compression
136. [26:34] Question: line tests down, going over a curb immediately changes the suspension; cars fly when hitting curbs; did you do anything about it?
137. [27:00] Restated: line tests and wheel compression across a time step finding a surface that wasn't there before.
138. [27:09] Two issues. One: being load-insensitive (as transcribed), they didn't get side forces based on that; the only issue was the suspension force itself, so they didn't suddenly gain grip just because they hit a curb.
139. [27:33] Essentially you have to damp those forces; multiple ways of doing it; took a pretty basic approach.
140. [27:41] You can tell you need to damp when you've moved the suspension a long way in one frame. (end 27:55)

## Talk 4: Uncharted4_ScienceOfOffroading (talk runs 00:00-29:00)

### Intro and goals
1. [00:06] Speaker Ed Pereira, programmer at Naughty Dog; talk: "the science of off-roading" (00:07), about the 4x4 Drake drives around Madagascar in Uncharted 4; bounces between high- and low-level topics (00:12).
2. [00:30] Goal 1: the 4x4 "needed to be fun to drive for as many people as possible"; Uncharted 4 is an adventure game anyone should be able to pick up and enjoy, and the 4x4 is a critical part of the story.
3. [00:44] Goal 2: "a sense of realism to keep the player grounded in Drake's adventure."
4. [00:49] Goal 3: design must work on the "rockier, muddy terrain found when driving around the mountains of Madagascar."

### Where on the realism spectrum
5. [01:00] When making a vehicle simulation you have to figure out where on the spectrum you want to fall.
6. [01:05] Real end: Gran Turismo (tagline "the real driving simulator"): very realistic tire grip simulation, maybe the rubber wears down and the tire loses friction (01:11–01:15); motor complex, e.g. power generated when each cylinder fires (01:17); chassis shape changes airflow, giving different handling and efficiency (01:22).
7. [01:29] Simple end: Super Mario Kart, "simple fun is much more important"; racing aspects are largely game mechanics rather than a simulation (01:34); best example drifting: you hop around so you don't take a penalty and play a canned spinning-out animation (01:39); fairly simple motor plus boost mechanics (mushroom, or rev the engine just right at race start) (01:44).
8. [01:54] Where the 4x4 ended up: "somewhere in the middle."
9. [01:57] Opinion: in an environment going for realism, it's easier to run a simulation on the more real side; modelling it as simply as possible, the complexities of a realistic environment require several hacks to get the simulation to look right (02:00–02:10).
10. [02:11] With a more realistic simulation you can throw really varied terrain at it and it should remain stable; you may still tweak parameters to make it feel good, but won't fundamentally change the underlying physical model (02:11–02:22).
11. [02:23] Physical model covered in three parts: collision detection (chassis and wheels and how that responds to collision) (02:26); motor simulation and how it generates torque (02:32); how torque is applied to the wheels and generates forces on the vehicle (02:35).

### Vehicle structure: rigid bodies, point constraints, raycast
12. [02:41] Vehicle = rigid bodies held together with constraints: a single rigid body for the chassis, a rigid body per wheel, and constraints keeping everything together (02:48).
13. [02:55] Havok is the solver for the constraints, but they provide many of their own inputs.
14. [03:01] Collision turned off on the wheels in favor of Havok's point constraint system: pass it a point the tires should stick to; it also generates a normal force based on the motion and mass of the chassis and wheels (03:05); this normal force is later used to compute friction (03:14).
15. [03:19] Contact point found by a raycast per wheel from the "hard point" to the furthest point the suspension can extend; the hard point is where the suspension attaches to the chassis and is a reference point for the wheel math (03:26). Yellow sphere = detected collision point (03:36).
16. [03:51] Works on flat ground ("a great start"). [03:55] "I'm a huge fan of getting something up and running as fast as possible first and add features as they go."

### Collision problems on rough terrain and fixes
17. [04:00] On the rough test track it breaks: the car hits an invisible wall (04:08). Issues: (a) unpredictable collision response (04:15); (b) collision response not fast enough, wheels visibly penetrate bumps (04:21–04:31).
18. [04:34] A raycast "just won't cut it"; moving the raycast forward when moving was considered but not accurate enough (04:37). Replace raycast with a shapecast using the tire dimensions as a cylinder (04:42).
19. [04:48] Cast the shape from well above the hard point: otherwise the nose of the vehicle would spend a frame already in collision and get stuck (04:54).
20. [05:01] Shapecast returns several points on a round bump; first step: take the closest return point (05:04). Vast improvement, less visible penetration (05:14), but under certain circumstances the response is unstable with jitter (05:20).
21. [05:26] Jitter cause: only taking the first collision point, "ping-ponging between which plank to put the tire on top of" (05:29).
22. [05:35] Fix: take more collision points and pass them to the point constraint system so the tire sits on multiple planks, stabilizing the response (05:38). Limit: three points per wheel, more has diminishing returns (05:46).
23. [05:55] Dislike: collision response is rough on surfaces whose normal is not aligned with the suspension direction; hitting the first bump you "completely lose all momentum" (06:03). An implementation detail of Havok they wanted to work around.
24. [06:11] Workaround: fake it — tell Havok all normals are in the direction of the suspension. Result "Smooth as butter" (06:22).
25. [06:23] Liked how "player favoring" the response is: the 4x4 keeps momentum nicely and doesn't frustrate the player. [06:31] "Obviously quite unrealistic, but this is one of the many times we leaned away from realism to make for a more fun driving experience."
26. [06:38] Side effect: wheels no longer respond perfectly to collision (visibly penetrate bumps) (06:41). Solution: reimplement wheel collision response ourselves (06:46).

### Custom wheel collision response (math)
27. [06:49] Using the highest point from before, place the wheel so it tangents the point.
28. [06:54] Find P1 and P2, two potential points furthest penetrating into geometry; because the wheel could be at an angle, consider either side as deepest (06:59–07:08). Compute them from the wheel's orientation vectors up and right, offset from the center point C (07:09).
29. [07:15] Deepest point via dot products: vectors C→P1 and C→P2 dotted with N (surface normal) give scalars S1, S2 (07:19–07:29) — how far CP1/CP2 travel along N; the larger is deeper (07:40). Example: P1 deeper (07:44).
30. [07:47] Can't use S1 directly (centre-to-corner distance); compute S3 = distance from contact point to the corner along the contact normal: vector from contact point to CP1 dotted with N (07:51–08:05). That is the final distance to move the wheel so its corner rests on the surface (08:05).
31. [08:12] Separating along the contact normal would pull the wheel out of alignment with the suspension; so project the separation vector onto the suspension direction and move along that (08:17–08:23).
32. [08:29] Low penetration distances give a stable, correct-looking response.
33. [08:40] Problem: moving the wheel so far along the suspension direction that it passes the hard point and goes into the chassis (08:44).
34. [08:51] Fix: limit how far the wheel can travel upward so it never passes the hard point (avoids clipping the wheel well) (08:51–08:57).
35. [08:57] To counteract seeing the wheel penetrate the ground, apply an upward force on the hard point, two benefits: gets the 4x4 out of collision (09:04), and when you slam it to the ground hard it creates "a nice jerk that the player can feel" (09:07). Side note: that force is delivered to Nate (09:12).

### Valid contact surfaces (angle limit)
36. [09:30] Next issue: casts detect any collision, so walls count as surfaces to place a tire on top of (09:41).
37. [09:46] Limit based on surface angle: angle between the vertical vector and the surface normal; ignore surfaces whose angle exceeds a designer-tuned maximum angle (09:50–09:57). With the wall ignored, the 4x4 bumps the wall and continues (10:03).
38. [10:09] Sometimes you do want to drive on a wall: design can turn off the angle check in script (10:16).

### Anti-flip and air control
39. [10:22] Driving off a cliff into drivable space: wanted to avoid flipping onto the 4x4's side or roof, which would disrupt the driving experience (10:28).
40. [10:33] Quickest solution: counter the Jeep's rotation using forces based on what direction the vehicle is currently rotating.
41. [10:45] "A little unrealistic, but it's very important to keep the player happily driving around."
42. [10:50] "For fun" added air control: apply forces to the 4x4 when in the air and pushing a direction on the steering stick, "constantly keeping the player feeling like they have some control."

### Motor simulation
43. [11:06] Powering the vehicle via a motor simulation. [11:08] Chose a manual transmission: simpler simulation without a torque converter (11:10).
44. [11:18] Simulating a motor needs a differential equation because the speed you travel feeds back into the motor's power curve (11:21). Implemented by splitting into two parts, the motor and the wheels (11:23).
45. [11:28] Chart: power and torque generated at any given RPM. Curve is tuned by designers using X/Y coordinates based on the size of the space and how responsive they want the 4x4 (11:33).
46. [11:40] Curve behavior: power grows as the motor spins faster up to a peak power, then efficiency is lost and power starts dropping (11:44–11:48).
47. [11:50] In the simulation the motor starts at a minimum idle RPM; how much gas pedal is pressed applies a similar percentage of the torque generated at the current motor RPM (11:55). "A big simplification of how gas is applied to a real motor, but it's very effective" (12:00).

### Differential and torque split
48. [12:06] Second part: how torque goes from the motor to the wheels; needs a differential (12:14).
49. [12:17] Differential allows attached wheels to rotate at different rates: if you slam the gas and one wheel is stuck and locked, the other spins freely and you won't flood or stall the engine (12:20–12:27).
50. [12:28] Looked at many elements of a real car and considered which to simulate; differentials seemed worth including (12:30–12:36).
51. [12:37] Primary reason: improve handling — free-to-turn-at-different-rates wheels give more grip on the outside tires (12:40). Explanation: two circles (yellow, blue) with different circumferences; if the wheels were fixed to turn at the same rate they'd necessarily slide since they travel different distances (12:44–13:00).
52. [13:02] Secondary benefit: big amounts of wheel spin, giving FX and foreground team plenty of opportunity to send mud and rocks flying (13:06).
53. [13:11] Torque applied to a differential is divided evenly between the attached wheels (13:14). With a forward and rear differential and a differential between these two, torque is divided evenly among all four wheels (13:20–13:26).
54. [13:28] Each wheel spins freely, so next frame's RPM is calculated using the fastest-spinning wheel, "because in a manual transmission with the clutch applied, the wheels and the motor are directly linked" (13:32–13:37).

### Friction model
55. [13:46] Friction: power must go from the wheel to the ground so the 4x4 moves (13:47). Friction dictates how much force can be applied before there is a slip, and how much slip there is (13:54).
56. [13:59] Friction is between two surfaces so define friction for the tires and for the geometric surfaces the tires drive on (14:02). Environment broken into several surface types each with a tuned amount of friction (14:06).
57. [14:13] Designers and artists lay out all the friction types together for a fun and interesting driving experience.
58. [14:22] Example layout (yellow on picture): grass with very high friction (14:22); a muddy transition point with in-between friction (14:26); very little friction in a muddy riverbed (14:31).
59. [14:33] Surface map is broken up very roughly — no fine details of little bits of higher friction here and there — and it still feels really good to drive across (14:36–14:41).
60. [14:42] Spent a lot of time tuning friction on some surface types to make muddy climbs challenging while still fun (14:46). Keep throwing it at a playtester with fresh eyes to see how difficult they find it (14:49).
61. [15:01] Normal force N applied to the tire: gotten back out of Havok for each wheel once the point of contact is applied (15:03–15:10). Let the solver provide it because the pressure on the wheel depends on the downward momentum of the chassis and forces generated by the suspension; doing it yourself is "needlessly gritty" (15:11–15:21).
62. [15:21] Coefficient of friction = friction of the tire multiplied by the friction of the surface in contact (15:21–15:26). This coefficient multiplied with the force returned from Havok gives a maximum friction force (15:27).
63. [15:33] Torque is the rotational force applied to the wheel; with friction resisting this rotation, the opposite force pushes the wheel forward (15:36).
64. [15:42] The maximum friction force is split into two directions. Forward: torque applied to the wheel divided by the radius gives a linear forward force (15:44).
65. [15:50] Lateral force: a lateral slip coefficient based on lateral velocity divided by forward velocity (15:53); multiplied by the normal force returned from Havok it gives "a nice simulation where you regain control in a reasonable amount of time, no matter how fast you're sliding" (15:58–16:05).
66. [16:07] Combining the two directions gives a total force vector; its length must be below the maximum friction force computed earlier (16:10). Dividing the two gives a scalar applied to both input vectors so the total falls below the max (16:14–16:25).
67. [16:27] Lateral friction force is applied against the lateral velocity to slow the vehicle when sliding side to side (16:31).
68. [16:33] Forward direction: apply up to the maximum friction to the wheel; the leftover difference is applied back to the wheel as extra rotational velocity "because the tire is slipping in this case" (16:37–16:42) (= wheelspin).
69. [16:43] Other direction: if the torque applied is less than the maximum friction force, apply an opposite braking force on the wheel's angular velocity so it slows to meet the friction if the wheel is overspinning and slipping (16:47–16:55).

### Power slide / handbrake
70. [16:57] Final request from Design: ability to power slide; most important was making it easy to use (17:00).
71. [17:04] "A big fake with a hint of realism": when you hit the handbrake button, simply reduce the friction on the back tires (17:08). This lets the rear kick out "in a way we can easily tune" (17:11).
72. [17:15] Concludes driving and physical aspects. Design gave a layout the 4x4 would drive on; they worked together to get the vehicle to feel and look right for the space (17:18–17:25).

### AI driving: why and navigation
73. [17:25] Designer request: have the car drive itself (17:28–17:31) so NPCs like Sullivan or Elena can hop into the driver's seat and drive to Drake if he got too far from the 4x4 (17:36–17:43).
74. [17:45] AI work partly done already: the nav mesh search code used by NPCs converts over pretty easily, so static paths are generated almost immediately (17:47–17:55).
75. [17:57] Questions: how to turn to face the point; how fast to travel; what if the next waypoint is behind you and how do you know; how to know there's a physical object in front and how to drive around it (18:00–18:16).

### Turn radius and reversing
76. [18:17] Principles: cars have a defined turn radius — the radius of the smallest circular turn the vehicle can make (18:19–18:25).
77. [18:26] The turning circle size changes with speed because the wheels won't necessarily grip hard enough to make the given turn (18:26–18:33). The circle also expands the further the steering wheel is from its furthest edge (18:33–18:37).
78. [18:38] Understanding these aspects lets you decide how far to turn the wheel to make the target (18:38–18:43).
79. [18:44] Turn radius from physical dimensions using Ackerman steering geometry (18:49): theta = max angle the wheels can rotate left to right (18:52); W = width, L = length of the 4x4 (18:59); gives the radius of the turning circle (19:01). Unsure it's the perfect tightest-circle calculation but close enough to work for the AI logic (19:04–19:12).
80. [19:14] Turning circles are attached to the car (known location); assuming infinite cylinders, 2D algebra tests whether the waypoint is inside either circle (19:17–19:26).
81. [19:28] If the waypoint is inside either circle: put the 4x4 in reverse, turn the wheel the opposite direction so the nose turns toward the target (19:33–19:39); once the nose is close enough that the target is outside the turning circle, switch back to drive and complete the turn (19:39–19:46).
82. [19:47] Same logic applies when the target is behind: reverse until the turn can be made, then continue (19:47–19:52).

### Obstacle avoidance and splines
83. [20:04] Obstacle avoidance: nav mesh handles buildings/boulders (20:07) but not another car that does not affect the nav mesh (20:13).
84. [20:18] Detect with several raycasts, one per corner, forward and back, with length based on the speed (20:22).
85. [20:25] When a cast detects something, push the steering in the opposite direction based on how close the cast detected collision (20:29). Never forget the target; the probe says when it's clear to start turning back (20:33–20:39).
86. [20:39] Probe direction is tunable: in the videos directly front and back, but could angle out for more consideration of what's around the vehicle (20:43–20:52).
87. [20:53] Simplification: assume design hasn't caused a traffic jam impossible to steer around; wouldn't work in a city full of cars but is effective in the hills of Madagascar (20:57–21:04).
88. [21:06] Spline following (small design request): turn off NavMesh search and get a point on the spline some distance ahead based on how fast you're traveling (21:08–21:16). Obstacle avoidance stays on; steer around the obstacle and keep using the nearest point on the spline as the target (21:17–21:25).
89. [21:26] Navigation + steering + obstacle avoidance = "a pretty good system for getting around most spaces."

### Wrap-up
90. [21:32] Collision detection: rigid bodies, constraints and own wheel response produce a vehicle that moves around rough terrain smoothly (21:35–21:41).
91. [21:42] Motor: a mix of realism and glossed-over details gives a balance between a tunable, realistic motor and avoiding the grittiness of a deeper simulation (21:42–21:50).
92. [21:51] Tire friction simulation lets players drive and make turns "in an easy-to-use way that most players can grasp."
93. [21:59] AI: navigation brought over from existing systems, steering behaviors layered on so the 4x4 follows generated paths (21:59–22:09).
94. [22:10] Credits: Inkyo visual model (22:19); Kristoff rigging (22:22); Rob audio designer and Jonathan audio programmer, "together they worked to get things like the motor purring just right" (22:23–22:29); Alice and Travis programmers on the simulation (22:30); Kurt and James designers on tuning and level layout (22:33).
95. [22:37] "The development is really about problem solving" (22:38); "a very design-oriented approach to development and always focused changes on the needs for making the game fun" (22:40–22:45).

### Q&A
96. [23:12] Q (SPEAKER_03): not using Unity? [23:18] A: "We use Havok, but it's our own game engine" (23:19).
97. [23:28] Q (SPEAKER_02): when falling and pushing the wheel up so it doesn't go through the ground with force — not instantly or it pops; add force over time, but falling far means a lot of force in a short time, bounces the car high (23:36–24:04). How handled?
98. [24:05] A: "I'm actually okay with it being in collision for a little bit" (24:14); don't push so hard it flies out of collision (24:17); a tuning with a maximum amount of force allowed to be applied so it never gets pushed out that far (24:20–24:28).
99. [24:31] Q (SPEAKER_04): vehicle bottoms out and chassis snags on a small rock? [24:43] A: "The vehicle does bottom out a lot" (24:43); Havok rigid-body system is pretty good at making sure it doesn't cause a problem (24:45–24:53); some cases remain in the shipped game where rocks go flying because the chassis hits a rock in a bad way (24:53–25:05); looked into a little but not cared enough to fix (25:06–25:11).
100. [25:12] Q: Is the 4x4 a one-off? [25:17] A: "Well, we had the boat" (25:18); always exploring other things (25:22); the 4x4 was a starting point for the boat, they share a lot of the same code, a good jumping-off point for any other vehicle simulation (25:27–25:39).
101. [25:43] Q (SPEAKER_03, truck simulator with trailer): how to balance power between inner and outer tire when turning (friction differs); they solved it by tuning a lot (25:47–26:59); and on Uncharted 4 the car runs on uneven paths, wheels on the brink of ground contact — how keep force moving forward (27:01–27:24).
102. [27:24] A (summary): all four tires run on different friction most of the time; going from riverbed to grass one side still slips while the other catches (27:31–27:37).
103. [27:39] A: the differential helps here because torque is split to all four tires; it makes a smoother transition since you don't get a sudden very hard grip on one tire that would make it "just stop" (27:39–27:59).
104. [28:01] A: otherwise no real issues in that area, possibly because of how stable Havok's point constraint system is; "We basically told it the lateral friction we wanted, how much force is being applied there, and it would do a decent job of stabilizing" (28:01–28:19).
105. [28:23] Q (SPEAKER_00): do the chase-sequence cars and motorcycle use the same model? [28:33] A: "A lot of that is faked with splines" (28:33); tires/collision detection probably the same (28:37–28:48) but "the actual driving and movement is on a spline" (28:48). No obstacle avoidance there (28:55–28:56).

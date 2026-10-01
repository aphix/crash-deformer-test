A solid 60 Hz arcade-racer AI can be built as a layered controller: follow a spline with lookahead pure pursuit, choose speed from upcoming curvature and grip, add lane-offset overtakes/defense, and modulate blocking/ramming with an aggression scalar. Rubber-banding can keep races tight, but it should be bounded so it does not feel obviously unfair.

## 1) Track representation

Use a closed spline sampled into a dense loop of points with precomputed metadata:

- Arc length \(s_i\)
- Tangent \(\mathbf{t}_i\)
- Normal \(\mathbf{n}_i\)
- Curvature \(\kappa_i\)
- Surface grip multiplier \(g_i\in(0,1]\)
- Width left/right
- Obstacle/traffic occupancy flags

For a closed circuit, keep all distances modulo lap length \(L\).

## 2) Lookahead pure pursuit steering

Pick a target point ahead on the chosen racing line, not just the centerline.

A practical target distance at 60 Hz:

\[
d_{look} = \mathrm{clamp}(d_0 + k_v v,\; d_{min},\; d_{max})
\]

Typical values:

- \(d_0 = 4\) to \(6\) m
- \(k_v = 0.3\) to \(0.6\) s
- \(d_{min} = 4\) m
- \(d_{max} = 20\) to \(30\) m

For a wheelbase \(L_w\), pure pursuit curvature is:

\[
\kappa_{pp} = \frac{2 \sin(\alpha)}{d_{look}}
\]

where \(\alpha\) is the signed angle between vehicle forward vector and the vector to the lookahead target.

Convert to steering:

\[
\delta = \arctan(L_w \kappa_{pp})
\]

Then apply steering rate limits for stability at 60 Hz:

- Max steer angle: \(25^\circ\) to \(35^\circ\)
- Max steering rate: \(120^\circ/s\) to \(240^\circ/s\)

That gives per-frame steering change:

\[
\Delta \delta_{max} = \dot{\delta}_{max}/60
\]

## 3) Speed planning from curvature and grip

The key speed limit from lateral acceleration is:

\[
v_{max}(s) = \sqrt{\frac{a_{lat,max}}{|\kappa(s)|+\epsilon}}
\]

with surface grip scaling:

\[
a_{lat,max}(s) = a_0 \, g(s)
\]

Typical arcade values:

- Dry asphalt: \(g=1.0\)
- Dirt: \(g=0.65\) to \(0.8\)
- Wet: \(g=0.75\) to \(0.9\)
- Ice: \(g=0.3\) to \(0.5\)

Reasonable baseline lateral limits:

- Conservative: \(a_0 = 8\ \mathrm{m/s^2}\)
- Arcade: \(a_0 = 10\) to \(14\ \mathrm{m/s^2}\)
- Very “Burnout-like”: \(a_0 = 14\) to \(18\ \mathrm{m/s^2}\)

For lookahead planning, take the minimum speed limit over the next preview window:

\[
v_{plan} = \min_{s \in [s_0,\,s_0+d_{preview}]}\sqrt{\frac{a_0 g(s)}{|\kappa(s)|+\epsilon}}
\]

with:

- \(d_{preview} = 20\) to \(60\) m depending on speed
- \(\epsilon = 10^{-3}\) to avoid divide-by-zero

Then enforce braking by available deceleration:

\[
v_{cmd} = \min\left(v_{plan}, \sqrt{v_{current}^2 + 2 a_{brake} \Delta s}\right)
\]

Typical decel limits:

- Normal brake: \(a_{brake} = 8\) to \(14\ \mathrm{m/s^2}\)
- Emergency brake: \(14\) to \(20\ \mathrm{m/s^2}\)

Acceleration can be limited separately:

- \(a_{accel} = 4\) to \(10\ \mathrm{m/s^2}\)

A practical 60 Hz throttle update is:

\[
v_{t+1} = v_t + \mathrm{clamp}(v_{cmd}-v_t,\,-a_{brake}\Delta t,\;a_{accel}\Delta t)
\]

## 4) Racing line and overtaking via lateral offsets

Instead of only following the centerline, define a lane offset \(o\) in track-normal coordinates:

\[
\mathbf{p}_{target} = \mathbf{p}_{center}(s) + o \mathbf{n}(s)
\]

Useful offset logic:

- Inner line in a corner: \(o = -0.25W\) to \(-0.4W\)
- Outer defensive line: \(o = +0.25W\) to \(+0.4W\)
- Overtake line: choose the side with more free space and lower collision risk

Where \(W\) is track width, measured from centerline to edge.

Simple overtaking rule:

- If trailing and overlap with opponent is positive, choose side lane offset away from opponent
- If opponent blocks the center, shift to the outside before turn-in
- If lane is clear and corner entry is near, use the line that gives higher exit speed, not just shortest path

A useful cost for candidate offsets:

\[
J(o)=w_c C_{track}(o)+w_o C_{obs}(o)+w_r C_{risk}(o)-w_s S(o)
\]

Choose the offset with minimum \(J\), where:

- \(C_{track}\): track edge penalty
- \(C_{obs}\): obstacle/traffic penalty
- \(C_{risk}\): collision risk with opponents
- \(S\): opportunity score, such as pass probability or exit speed gain

## 5) Blocking and ramming with aggression

Use an aggression parameter \(a \in [0,1]\).

Suggested mapping:

- \(a=0\): clean racing, avoid contact
- \(a=0.3\): mild defense
- \(a=0.6\): assertive blocking
- \(a=1.0\): full “takedown” behavior

Define a pressure distance to defend:

\[
d_{block} = d_{min} + a(d_{max}-d_{min})
\]

Typical values:

- \(d_{min}=3\) m
- \(d_{max}=15\) m

Blocking behavior:

- If a pursuer is within \(d_{block}\) behind, shift toward their projected line by a fraction of track width
- Increase steering aggressiveness and prioritize inside protection before corner entry
- Reduce willingness to yield racing space as \(a\) rises

Example offset for defense:

\[
o_{def} = \mathrm{sign}(\text{opponent side}) \cdot \mathrm{clamp}(a \cdot 0.35W,\;0,\;0.35W)
\]

Ramming/takedown logic:

- Only engage if relative speed, angle, and contact zone are favorable
- Prefer side-swipe or rear-quarter impact over head-on contact
- Trigger “attack” only when success probability exceeds a threshold

A simple attack score:

\[
P_{ram}= \sigma\left(
b_0 + b_1 a + b_2 \Delta v_{toward} + b_3 \cos\theta - b_4 d
\right)
\]

where:

- \(\Delta v_{toward}\) is closing speed
- \(\theta\) is attack angle relative to opponent side
- \(d\) is separation
- \(\sigma(x)=1/(1+e^{-x})\)

Use \(P_{ram} > 0.6\) or \(0.7\) to commit.

## 6) Rubber-banding: pros and cons

A simple speed multiplier based on position gap:

\[
m_{rb} = \mathrm{clamp}(1 + k_{rb} \Delta p,\;m_{min},\;m_{max})
\]

where \(\Delta p\) is normalized positional lag behind the player.

Typical bounds:

- \(m_{min}=0.92\)
- \(m_{max}=1.08\)
- \(k_{rb}=0.02\) to \(0.05\)

Pros:

- Keeps races close
- Reduces boring runaway leads
- Helps weaker AI stay competitive

Cons:

- Feels unfair if overdone
- Players can detect “cheating”
- Can break natural pacing and strategic racing
- Can cause odd behavior in traffic-heavy or tightly packed races

Best practice:

- Use rubber-banding only as a soft modifier
- Never override collision physics or track constraints
- Prefer skill scaling and mistake rates over raw speed boosts
- Apply stronger banding to rear positions and weaker banding to leaders

A cleaner alternative is to adjust AI skill parameters instead of top speed:

- braking margin
- steering precision
- overtaking willingness
- defensive aggression

## 7) Recovery when off-track or stuck

Use a recovery state if the car is:

- Off-track for more than \(0.5\) to \(1.0\) s
- Speed below a threshold, like \(v < 2\) m/s
- Not advancing along the spline for \(1\) to \(2\) s
- Repeatedly colliding or spinning

Recovery target:

- Find nearest valid spline point
- Project the car onto the spline
- Aim for a point \(5\) to \(10\) m ahead on the track
- Temporarily increase grip and steering authority
- Reduce aggression during recovery

Recovery actions:

- Reverse if facing away from the track and blocked
- Otherwise yaw toward forward travel and apply throttle gently
- Add an “unstuck timer” to avoid oscillation

Useful thresholds:

- Stuck if forward progress \(<0.5\) m/s for \(1.2\) s
- Recovery timeout \(= 2\) to \(4\) s
- Temporary recovery grip multiplier \(= 1.1\) to \(1.3\)

## 8) Avoiding traffic and obstacles

For obstacles, use a forward capsule or swept volume along the predicted path.

Simple steering avoidance:

- Predict the car position \(t_p = 0.5\) to \(1.5\) s ahead
- Compute lateral separation from obstacles and opponents
- Add a repulsive steering term

\[
\delta_{avoid} = \sum_i k_i \frac{\mathbf{n}\cdot(\mathbf{p}-\mathbf{p}_i)}{\|\mathbf{p}-\mathbf{p}_i\|^2 + \epsilon}
\]

Or simpler in lane space:

- If obstacle lies in current lane within \(d_{avoid}\), bias target offset to the safer side
- If both sides blocked, brake first, then steer

Practical avoid distances:

- At 30–60 mph equivalent: \(d_{avoid}=6\) to \(15\) m
- Faster cars: \(15\) to \(30\) m

## 9) A workable 60 Hz update loop

Per frame:

1. Determine current spline position and lap progress.
2. Pick behavior state: race, overtake, defend, recover, avoid.
3. Compute target offset \(o\) for state.
4. Get lookahead target on offset racing line.
5. Compute pure-pursuit steering.
6. Compute speed limit from upcoming curvature and grip.
7. Apply braking/accel limits.
8. Add avoidance and collision constraints.
9. Apply aggression-based block/ram adjustments if appropriate.
10. Smooth outputs with rate limits.

## 10) Good starter parameter set

For an arcade racer at 60 Hz:

- Lookahead base \(d_0 = 5\) m
- Lookahead speed scale \(k_v = 0.45\) s
- Lookahead clamp \(4\) to \(25\) m
- Lateral acceleration \(a_0 = 12\ \mathrm{m/s^2}\)
- Brake decel \(a_{brake} = 12\ \mathrm{m/s^2}\)
- Accel \(a_{accel} = 7\ \mathrm{m/s^2}\)
- Max steering rate \(180^\circ/s\)
- Rubber-band bounds \(0.92\) to \(1.08\)
- Aggression \(a \in [0,1]\)
- Block distance \(3\) to \(15\) m
- Recovery trigger: off-track or stuck for \(1\) s

If helpful, this can be turned into pseudocode or a compact state machine next.

[1] AI Tutorial 3: AI in Games Development (https://research.ncl.ac.uk/game/mastersdegree/gametechnologies/previousinformation/artificialintelligence3aiingamesdevelopment/2016%20Tutorial%2010%20-%20AI%20in%20Games%20Development.pdf)
[2] A Rubber-Banding System for Gameplay and Race Management (http://www.gameaipro.com/GameAIPro/GameAIPro_Chapter42_A_Rubber-Banding_System_for_Gameplay_and_Race_Management.pdf)
[3] 471 (http://www.gameaipro.com/GameAIPro/GameAIPro_Chapter38_An_Architecture_Overview_for_AI_in_Racing_Games.pdf)
[4] Rubber Band AI (https://allthetropes.org/wiki/Rubber_Band_AI)
[5] Burnout 3: Takedown - Wikipedia (https://en.wikipedia.org/wiki/Burnout_3:_Takedown)
[6] stoicescueric.github.io · control-lab · docsPure Pursuit | Control Lab (https://stoicescueric.github.io/control-lab/docs/path-following/pure-pursuit)
[7] The Pure Advantage: Advanced Racing Game AI (https://www.gamedeveloper.com/design/the-pure-advantage-advanced-racing-game-ai)
[8] Sports Games AI (https://www.cse.lehigh.edu/~munoz/CSE348/classes/SportsAIPhillipsRuthrauf.pptx)
[9] Burnout 3 Takedown Review (https://www.ogxbox.co.uk/game-reviews/burnout-3-takedown-review)
[10] Are cars in Burnout Legends supposed to slow down during Road Rage? (https://www.reddit.com/r/Burnout/comments/1moqmwz/are_cars_in_burnout_legends_supposed_to_slow_down/)
[11] Integrating Sportsmanship into Autonomous Racing Systems (https://arxiv.org/pdf/2503.03774)
[12] Burnout 3: Takedown (https://gamicus.fandom.com/wiki/Burnout_3:_Takedown)
[13] Winning the 3rd Japan Automotive AI Challenge - (https://arxiv.org/pdf/2206.00770)
[14] EXAMENSARBETE (https://www.diva-portal.org/smash/get/diva2:1028260/FULLTEXT02)
[15] Drivatar difficulty and behavior discussion (https://forums.forza.net/t/drivatar-difficulty-and-behavior-discussion/534854?page=43)

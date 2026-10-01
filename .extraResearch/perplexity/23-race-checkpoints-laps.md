Arcade racers usually implement this with a **directed checkpoint graph plus a per-racer progress state**, not with “distance only” alone. The robust pattern is: each checkpoint stores a gate/volume, a forward direction, a respawn anchor, and whether it is a lap line or a key checkpoint; the racer stores which checkpoints have been validated this lap, the last valid checkpoint index, and a monotonic progress value used for ranking[1][2][5].

## Core data model

A practical setup looks like this:

- **Track spline / centerline**
- **Checkpoint gates**
- **Respawn points**
- **Lap-control metadata**
- **Per-racer progress state**

Typical per-checkpoint fields:

```text
Checkpoint {
  id: int
  shape: volume or gate segment
  forwardNormal: vector3
  respawnId: int
  type: lapLine | keyCheckpoint | optionalCheckpoint
  sequenceIndex: int   // order required for lap validation
  routeGroup: int      // for alternative routes, if needed
}
```

Typical per-racer state:

```text
RacerState {
  lap: int
  lastPassedCheckpoint: int
  validatedMask: bitset
  progressAlongTrack: float
  segmentIndex: int
  segmentT: float
  wrongWayTime: float
  lastSafeRespawnId: int
  finished: bool
}
```

## Lap counting

The usual algorithm is:

- Treat the start/finish as a **lap-count trigger**.
- A lap increments only if the player reaches that trigger **after having satisfied the checkpoint rules for the current lap**.
- The racer’s shown lap should usually be clamped so it never displays below 1 once the race has started, even if reverse travel can technically decrement internal counters[2][5].

A common implementation:

1. When the racer enters a checkpoint gate, test approach direction using the dot product between velocity and gate forward normal.
2. If direction is forward, mark that checkpoint as passed.
3. If it is the lap line, and all required key checkpoints for the lap are validated, increment `lap`.
4. Clear the per-lap checkpoint validation state and begin the next lap.

This is how games block unintended “drive back and forth over the line” exploits: the start/finish alone is not enough; it only counts when the required checkpoint set is complete[2][5].

## Hidden checkpoints and key checkpoints

To stop shortcuts while allowing designed shortcuts, designers typically use two layers:

- **Hidden route checkpoints**: invisible gates distributed along the intended legal path.
- **Key checkpoints**: a smaller subset that must be hit in order before the lap line is accepted[2][5].

This is the main anti-shortcut rule:

- A shortcut is allowed if it still intersects the minimal required checkpoint path.
- A shortcut is blocked if it bypasses a required key checkpoint.
- Some tracks use multiple checkpoint groups/routes so the player can take one of several valid designed branches, but still cannot skip the “must pass” gates.

A clean rule set:

```text
CanCountLap(racer):
  return racer.validatedMask contains all requiredKeyCheckpoints
     and racer.lastPassedCheckpoint is startLine
     and racer.enteredStartLineForward == true
```

For more complex tracks, you can define:

- **mandatory checkpoints**
- **branch checkpoints**
- **optional scenic checkpoints**

Then the lap is valid if the mandatory set is complete and the racer reaches the finish from the legal side[1][2][5].

## Race position ranking between checkpoints

When racers are not at a checkpoint boundary, position is usually ranked by **progress along the track spline** rather than raw 3D distance.

A good algorithm:

1. Project the car position onto the nearest spline segment.
2. Compute `progress = segmentIndex + segmentT`.
3. Use that as the primary ordering key.
4. Break ties with:
- lap count
- checkpoint completion count
- finish status
- elapsed time

Example ranking tuple:

```text
rankKey = (
  lap,
  checkpointProgressCount,
  progressAlongTrack,
  raceTime
)
```

If two racers are on different route branches, you need a **route-aware progress model**:

- Each checkpoint belongs to a route graph node.
- Progress becomes “distance through the directed graph,” not just Euclidean progress.
- For split routes, compare by “distance to next required checkpoint” or by accumulated graph path length.

This is how arcade racers avoid weird ordering when someone takes a shortcut or jumps across the track.

## Wrong-way detection

Wrong-way detection is usually simple and cheap:

- Keep the track tangent at the player’s projected spline point.
- Compare the car’s forward vector or velocity vector to that tangent.
- If the dot product stays below a threshold for long enough, show wrong-way warning.

Typical rule:

```text
if dot(carForward, trackTangent) < cos(120°):
    wrongWayTimer += dt
else:
    wrongWayTimer = 0
```

Then:

- after a short grace period, show a warning
- optionally reduce progress scoring
- optionally prevent checkpoint credit if entered from the wrong side[2][5]

This is more reliable than using only camera orientation or raw world coordinates.

## Respawn / Lakitu / reset placement

The respawn rule should be:

- Respawn to the **last valid respawn anchor behind the most recently validated checkpoint**
- Never respawn the player ahead of the checkpoint that was just validated
- If the player is inside a checkpoint volume after falling, respawn them to the anchor associated with that checkpoint or the last safe checkpoint[1][2][5]

A robust rule:

```text
OnFallOrReset(racer):
  if racer.lastPassedCheckpoint exists:
      respawnId = checkpoint[racer.lastPassedCheckpoint].respawnId
  else:
      respawnId = startRespawnId
  place car at respawnPoint[respawnId]
  align car forward to track tangent at respawn
  zero velocity
```

Key anti-exploit rule:

- The respawn point for a checkpoint must be **before** that checkpoint in track space, not after it, or the player can be placed ahead and accidentally skip validation or miscount laps[1][5].

That “spawn before the checkpoint” detail is one of the most important parts of preventing lap-count bugs and unintended checkpoint bypasses[1][5].

## Why designed shortcuts still work

Designed shortcuts usually work because the shortcut still lands the player into the next required checkpoint region. In other words:

- the shortcut may cut path length
- but it must still satisfy the checkpoint sequence
- it cannot skip the key checkpoint chain

This is exactly the reason checkpoint graphs are better than just a finish-line trigger.

## Multiplayer / netcode considerations

For multiplayer, the safest model is **server-authoritative race state**:

- server owns checkpoint validation
- server owns lap count
- server owns respawn location
- clients send inputs or movement commands
- clients may predict locally for responsiveness, but the server corrects the authoritative state

Authoritative state should include:

```text
RemoteRacerState {
  lap
  validatedMask
  lastPassedCheckpoint
  progressAlongTrack
  speed
  respawnId
  finishTime
}
```

Important rules:

- Never let clients decide lap completion.
- Never let clients choose their own respawn checkpoint.
- Server must validate checkpoint crossings based on replicated positions and direction.
- If the game is deterministic enough, the server can simulate physics from inputs; otherwise it should reconcile state from periodic authoritative snapshots.

For ranking, the server should compute the live leaderboard from the authoritative `rankKey` tuple and broadcast snapshots to clients.

Practical anti-cheat checks:

- checkpoint crossings must be order-valid
- crossing direction must be forward
- respawn must come from the last legal checkpoint
- progress must not jump backward or forward implausibly between snapshots
- teleport-like motion should be flagged unless it matches a legal respawn or teleport mechanic

## Minimal implementation pattern

A solid arcade-racer implementation can be summarized as:

- Track = directed spline + checkpoint gates
- Each checkpoint = gate volume + forward normal + respawn anchor + key/optional flag
- Each racer = lap, validated checkpoints, spline progress, last safe respawn
- Lap count = start line only after mandatory checkpoint set is complete
- Ranking = lap, checkpoint progress, spline distance, time
- Wrong-way = dot product against tangent over time
- Respawn = last valid respawn anchor behind current legal progress
- Multiplayer = server authoritative state with client prediction only for feel

If useful, a follow-up can turn this into concrete pseudocode for:
- a **Mario Kart–style checkpoint/lap system**
- a **TrackMania-style checkpoint/respawn system**
- or a **Unity/Unreal implementation with data structures and update loops**.

[1] mkpc.malahieude.net · topicMaking your checkpoints - MKPC Forum - Malahieude (https://mkpc.malahieude.net/topic.php?topic=5384)
[2] Checkpoint (https://old.tockdom.com/wiki/Key_checkpoint)
[3] Comunidade Steam :: Guia :: Trackmania: The Basics (https://steamcommunity.com/sharedfiles/filedetails/?l=brazilian&id=290939249)
[4] The Hidden Shortcuts of Mario Kart Double Dash (https://videodb.org/the-hidden-shortcuts-of-mario-kart-double-dash/ToO7IeVx1y8)
[5] KMP (File Format) (https://wiki.tockdom.com/wiki/KMP_(File_Format))
[6] WHAT IS THIS TRACK? WHERE’S MY LAP COUNT?? (https://www.reddit.com/r/MarioKartWii/comments/18b5h06/what_is_this_track_wheres_my_lap_count/)
[7] XmlRpc scripted callbacks and methods - Trackmania Wiki (https://wiki.trackmania.io/en/dedicated-server/XML-RPC/Modescript-documentation)
[8] something about checkpoints :: Trackmania Turbo General Discussions (https://steamcommunity.com/app/375900/discussions/0/1736589520010383573/)
[9] TrackMania - Wikipedia (https://en.wikipedia.org/wiki/TrackMania)
[10] Update: Club items are available! - Trackmania (https://www.trackmania.com/news/1495?lang=en)
[11] Can you set gate to not add time :: Trackmania General ... (https://steamcommunity.com/app/2225070/discussions/0/592899688507642786/)
[12] Proto:Mario Kart DS/USA Kiosk Demo/Early Courses (https://tcrf.net/Proto:Mario_Kart_DS/USA_Kiosk_Demo/Early_Courses)
[13] The history of 'Ultra shortcut' that can shorten the turnover ... (https://gigazine.net/gsc_news/en/20181001-mario-kart-wii-ultra-shortcut/)
[14] manual.pdf (https://cdn.akamai.steamstatic.com/steam/apps/7200/manuals/manual.pdf)
[15] TrackMania is NP-complete (http://arxiv.org/pdf/1411.5765)

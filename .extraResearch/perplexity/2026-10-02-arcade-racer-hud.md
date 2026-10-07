# Query

Racing game HUD design of classic arcade racers: Need for Speed Hot Pursuit 2 (2002), Need for Speed Underground 1 and 2, Burnout 2 Point of Impact, Burnout 3 Takedown, Burnout Revenge. For each: what the HUD shows (speedometer/tachometer and gear, nitro/boost meter, race position, lap counter, lap time and total time, best lap, minimap, gaps to rivals, takedown/crash call-outs), where each element sits on screen (corners), and what design choices make it readable at high speed. Also mobile racing game HUD layout conventions.

Classic arcade racers usually keep the most critical info in the corners and edges: speed/RPM low and near a corner, position and lap info at the top, and minimap or route guidance on the left or right side where it’s easy to glance without blocking the road. For **Need for Speed Hot Pursuit 2**, the interface is explicitly split into map on the center-left, leaderboard upper-left, time/completion upper-right, rear-view/radar top-center, and speedometer/tachometer at the bottom or bottom-right depending on camera view; it also lets players toggle the HUD, track map, and rear-view mirror, and switch MPH/KPH[1].

## Per-game HUD breakdown

| Game | What the HUD shows | Where it sits | Readability / design choices |
|---|---|---|---|
| **Need for Speed Hot Pursuit 2 (2002)** | Speedometer/tachometer, track map, leaderboard/race position, time/completion data, rear-view mirror, radar detector, MPH/KPH option[1] | Map center-left; leaderboard upper-left; time/completion upper-right; rear-view mirror and radar detector top-center; speedometer/tachometer bottom or bottom-right depending on view[1] | Uses a strong corner-based layout to keep the center clear; the optional “3D” road map shows more upcoming road and helps anticipate roadblocks[1] |
| **Need for Speed Underground 1** | Typical NFS race HUD elements such as speed, gear/RPM-style driving feedback, lap/time info, minimap, and race position are the expected core set for the series[13] | Generally cornered around the screen edges to avoid blocking the street view; exact positions vary by mode and platform | The main readability trick in arcade racers is car-like instrumentation, simplified minimaps, and large, glanceable counters rather than dense text[13] |
| **Need for Speed Underground 2** | Similar core set: speed, gear/RPM feedback, minimap, race position, lap/time tracking, and route/navigation emphasis[13] | Edge-aligned, usually with map and timing info separated from speed feedback | Underground-style HUDs work best when the map is simplified and the speed/RPM display resembles a real car cluster for instant recognition[13] |
| **Burnout 2: Point of Impact** | Racing HUD conventions center on speed/position/time and track navigation; Burnout’s style prioritizes quick readability at high velocity[13] | Edge-mounted and minimal to keep the action visible | Burnout’s design philosophy is to reduce clutter so the road and crashes dominate the screen[13] |
| **Burnout 3: Takedown** | Speed, race position, lap/time, minimap/route, and prominent takedown/crash feedback are key; Takedowns are a signature mode feature[7][13] | Likely split across corners and edges so crash feedback can appear without covering the driving line | Readability comes from bold event feedback and a stripped-down race HUD; Burnout 3 also supports HUD visibility as a configurable rendering layer[12] |
| **Burnout Revenge** | Same arcade-racer essentials plus crash/takedown emphasis, with race position and timing still central[13] | Corners/edges, keeping the center open for impacts and traffic | Readability depends on high-contrast, low-text HUD placement and clear separation between driving info and crash-callout moments[13] |

## What each element typically does in these games

- **Speedometer / tachometer / gear**: Usually the main lower-corner cluster, because it is the most frequently checked driving metric[1][13].
- **Nitro / boost meter**: In arcade racers this is usually placed near the speed readout or another lower corner so the player can monitor acceleration without shifting focus far from the road[13].
- **Race position**: Commonly placed upper-left or upper-right as a compact list or single position readout[1][13].
- **Lap counter / lap time / total time / best lap**: Usually upper-right or another upper-corner timing block, where the player can glance during straights and checkpoints[1][13].
- **Minimap**: Usually left-side or right-side, often slightly above the speed cluster so upcoming turns are visible without covering the horizon[1][13].
- **Gaps to rivals**: Usually integrated into the position list or timing panel rather than shown separately, because arcade racers favor compact comparisons over dense telemetry[13].
- **Takedown / crash call-outs**: Burnout-style games use large, high-contrast on-screen feedback that appears centrally or near the action because the event itself is the momentary focus[7][12].

## Why these HUDs read well at high speed

- They keep the **center of the screen mostly open**, which preserves visibility of the road, traffic, and opponents[1][13].
- They use **small clusters in the corners** so the player can gather information with a quick eye flick instead of reading across the screen[1][13].
- They rely on **car-like gauges and simplified icons**, which are recognized instantly and don’t require long decoding[13].
- They keep **navigation separate from timing**, which reduces visual overload during fast cornering[1][13].
- Burnout-style games amplify **event feedback** so takedowns feel immediate without needing a large permanent HUD footprint[7][12].

## Mobile racing HUD layout conventions

Mobile racing HUDs usually follow the same logic, but more aggressively:
- **Bottom-right**: throttle, brake, nitro, and speed cluster, because it avoids thumb conflict and keeps frequent controls near the player’s dominant reach[5].
- **Top-left**: lap/time or race status, since it is readable without interfering with touch controls[5].
- **Top-right or upper edge**: pause/settings and less urgent status info[5].
- **Mini-map**: often top-right or mid-left, sized small enough to avoid blocking the driving line[13].
- **Design goal**: maximize finger-safe zones, larger icons, high contrast, and minimal text so the HUD remains usable on small screens and during rapid motion[5].

If useful, this can be turned into a **per-game HUD wireframe map** showing the likely screen corners for each title.

[1] Need for Speed: Hot Pursuit 2 - IGN (https://www.ign.com/articles/2002/10/14/need-for-speed-hot-pursuit-2-9)
[2] Inspirational racing hud designs (https://dribbble.com/search/racing-hud)
[3] Need for Speed: Hot Pursuit 2 "WideScreen Fix" (https://www.playground.ru/nfs_hot_pursuit_2/file/need_for_speed_hot_pursuit_2_widescreen_fix-1043163)
[4] Readme | PDF - Scribd (https://www.scribd.com/document/533175351/Readme)
[5] How I Designed a Racing HUD in 4 Steps - LinkedIn (https://www.linkedin.com/posts/muhammad-fahad-a1a04923b_how-i-designed-a-racing-game-hud-in-4-steps-activity-7362128437072867328-Y9LM)
[6] Burnout 3: Takedown Images (https://gamesdb.launchbox-app.com/games/images/3938-burnout-3-takedown)
[7] Burnout 3: Takedown | Burnout Wiki - Fandom (https://burnout.fandom.com/wiki/Burnout_3:_Takedown)
[8] Racing Hud Projects - Behance (https://www.behance.net/search/projects/racing%20hud?locale=en_US)
[9] Games Out Now (https://www.purexbox.com/games/browse?status=released&page=72)
[10] Use of patches/mods - Burnout 3: Takedown - Foren - Speedrun.com (https://www.speedrun.com/de-DE/b3t/forums/gvgwr)
[11] Project Drag - Concept Drag Racing Game HUD/UI Design (https://akilaattygalle.artstation.com/projects/L3yg60)
[12] Burnout 3 Rendering Flags - KC Forums - MattKC (https://forum.mattkc.com/viewtopic.php?t=175)
[13] Racing Game Design (Principles, Mechanics, Template) (https://gamedesignskills.com/game-design/racing/)
[14] racing game ui (https://dribbble.com/search/racing-game-ui)
[15] mobile game hud (https://dribbble.com/search/mobile-game-hud)

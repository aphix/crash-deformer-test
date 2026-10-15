import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LINCOLN, PREFABS } from "./catalog.ts";
import { CAPITOL_POOL } from "./landmarks.ts";
import { placeProps } from "./placements.ts";
import { blankProjection, Track } from "./track.ts";
import { TRACKS } from "./tracks/index.ts";
import { RaceSession } from "../match/session.ts";
import { centreline, field, polyline, runTo } from "../match/session-drive.test-util.ts";

/** 1.7 miles: the published length of the 2026 Freedom 250 street circuit the course follows. */
const CIRCUIT_M = 2736;
/** The published frontstretch: 0.4 miles of Pennsylvania Avenue. */
const FRONTSTRETCH_M = 644;
/** The longest the course's ground may take to bake (ms): 0.38 s measured alone (1.4 s with every metre of a street stamped, 2.1 s with every paint polygon tested over the whole ground), held with room for a loaded test machine. */
const BAKE_MS = 1200;
/** The Mall's lawn between Madison Drive (north) and Jefferson Drive (south), 7th Street to 3rd Street (z south). */
const LAWN = { minX: -572, maxX: 0, minZ: -345, maxZ: -160 };

describe("given the National Mall street circuit (x east, z south, origin 3rd St and Independence Ave)", () => {
  const json = TRACKS.find((j) => new Track(j).id === "national-mall");
  assert.ok(json, "the race menu lists the national-mall course");
  const track = new Track(json);
  const bakeStarted = performance.now();
  const ground = track.ground();
  const bakeMs = performance.now() - bakeStarted;
  const placed = placeProps(track);
  const far = track.json.environment.far;
  const pr = blankProjection();
  const sampleAt = (x: number, z: number): number => {
    track.project(x, z, -1, pr);
    return pr.k;
  };

  it("when its lap is measured, then it is within 3 % of the real circuit's 1.7 miles", () => {
    assert.ok(Math.abs(track.length - CIRCUIT_M) / CIRCUIT_M < 0.03, `lap ${track.length.toFixed(0)} m`);
  });

  it("when its straights are measured, then the longest is the Pennsylvania Avenue frontstretch, at least 0.4 miles and wider than the side streets", () => {
    const p = track.path;
    const ds = track.length / p.count;
    let best = { run: 0, end: 0 };
    let run = 0;
    for (let k = 0; k < p.count * 2; k++) {
      run = Math.abs(p.curv[k % p.count]!) < 1e-3 ? run + ds : 0;
      if (run > best.run) best = { run, end: k % p.count };
    }
    const mid = (best.end - Math.round(best.run / ds / 2) + p.count) % p.count;
    assert.ok(best.run >= FRONTSTRETCH_M, `longest straight ${best.run.toFixed(0)} m`);
    assert.ok(p.tx[mid]! < -0.9 && p.tz[mid]! < 0, "it runs west-north-west, toward the Washington Monument");
    assert.ok(p.half[mid]! > p.half[sampleAt(-572, -400)]!, "Pennsylvania Avenue is wider than 7th Street");
  });

  it("when the road down Independence Avenue into turn six is ridden, then it rises and falls over at least four bumps of 0.25-0.35 m, and is level before them", () => {
    const heights: number[] = [];
    for (let x = -260; x <= -60; x += 2) heights.push(ground.heightAt(x, 0));
    const humps = heights.filter((h, i) => i > 0 && i < heights.length - 1 && h > heights[i - 1]! && h >= heights[i + 1]!);
    assert.ok(humps.length >= 4, `${humps.length} bumps`);
    for (const h of humps) assert.ok(h >= 0.25 && h <= 0.35, `a bump ${h.toFixed(2)} m high`);
    assert.ok(Math.abs(ground.heightAt(-420, 0)) < 0.01, "level before the bumps");
  });

  it("when 3rd Street is driven north, then it runs under a roof from just past turn six and is open sky at the start line", () => {
    assert.equal(track.path.tunnel[sampleAt(0, -80)], 1, "the underpass");
    assert.equal(track.path.tunnel[sampleAt(0, -290)], 0, "the line");
  });

  it("when the open streets beside the Mall's lawn are looked at, then 7th and 3rd Streets have no walls from Madison Drive to Jefferson Drive, only a line of light cones, and there is no shortcut across", () => {
    const p = track.path;
    for (const [x, z] of [[-572, -300], [-572, -200], [0, -300], [0, -200]] as const) {
      const k = sampleAt(x, z);
      assert.ok(p.wallL[k] === 0 && p.wallR[k] === 0, `no wall at (${x}, ${z})`);
    }
    assert.ok(p.wallL[sampleAt(-572, -100)] === 1 && p.wallL[sampleAt(0, -80)] === 1, "walled again past Jefferson Drive (and in the underpass)");
    assert.equal(track.shortcuts.length, 0, "the lawn is no shortcut");
    const cones = placed.filter((q) => q.prefab === "cone" && q.z > LAWN.minZ && q.z < LAWN.maxZ);
    for (const x of [LAWN.minX, LAWN.maxX]) {
      const beside = cones.filter((q) => Math.abs(q.x - x) < 10);
      assert.ok(beside.length >= 2 * 30, `${beside.length} cones along the street at x ${x}`);
    }
    const stray = placed.filter((q) => q.prefab === "cone" && !(q.z > LAWN.minZ - 10 && q.z < LAWN.maxZ + 5));
    assert.equal(stray.length, 0, `${stray.length} cones away from the open streets, the first at (${stray[0]?.x.toFixed(0)}, ${stray[0]?.z.toFixed(0)})`);
    assert.equal(PREFABS.cone.body, "knock");
    assert.ok(PREFABS.cone.mass <= 5, "a cone barely slows a car that hits it");
  });

  it("when a car leaves 7th Street after checkpoint 4 and crosses the lawn to 3rd Street and the line, then it earns no lap and is told it missed a checkpoint; driving the streets round earns the lap", () => {
    const L = track.length;
    const cut = [...centreline(track, L - 6, L + track.gates[4]!.s + 5), { x: -520, z: -250 }, { x: -60, z: -250 }, { x: 0, z: -260 }, { x: 0, z: -330 }];
    const across = new RaceSession(track, field(1), { laps: 1, noReset: false });
    const ev = runTo(across, [polyline(cut, 40)], 120);
    assert.equal(ev.filter((e) => e.type === "lap").length, 0, "no lap across the grass");
    assert.equal(across.cars[0]!.missed, true, "the HUD is told a checkpoint was skipped");
    const round = new RaceSession(track, field(1), { laps: 1, noReset: false });
    const done = runTo(round, [polyline(centreline(track, L - 6, 2 * L + 10), 40)], 200);
    assert.equal(done.filter((e) => e.type === "lap").length, 1, "the lap by the streets counts");
  });

  it("when the landmarks are placed, then the Capitol stands on Capitol Hill east of 3rd Street and the Washington Monument down the Mall within the camera's reach of the frontstretch", () => {
    const capitol = placed.find((p) => p.prefab === "capitol");
    const obelisk = placed.find((p) => p.prefab === "obelisk");
    assert.ok(capitol && obelisk, "both landmarks are placed");
    assert.ok(capitol.x > 0 && capitol.y >= 10, `the Capitol at x ${capitol.x}, y ${capitol.y}`);
    assert.ok(obelisk.x < -754, "the monument is west of 9th Street, past the circuit");
    assert.equal(PREFABS.obelisk.size[1], 169, "the monument is its real 169 m");
    for (const [name, x, z] of [["turn one", 0, -577], ["turn two", -754, -710]] as const) {
      assert.ok(Math.hypot(obelisk.x - x, obelisk.z - z) < far, `drawn from ${name}`);
    }
  });

  it("when the Mall between Madison and Jefferson Drives is walked, then it is open lawn, and every building, museum and grandstand stands on paved ground off it", () => {
    for (let x = LAWN.minX + 20; x < LAWN.maxX - 20; x += 25) {
      for (let z = LAWN.minZ + 5; z < LAWN.maxZ - 5; z += 25) {
        if (Math.abs(z + 205) > 8) assert.equal(ground.surfaceAt(x, z), "grass", `the lawn at (${x}, ${z})`);
      }
    }
    for (const p of placed.filter((q) => ["building", "grandstand", "marble"].includes(q.prefab))) {
      const [w, , d] = PREFABS[p.prefab].size;
      const hx = (w * p.sx) / 2 - 1;
      const hz = (d * p.sz) / 2 - 1;
      for (const [u, v] of [[0, 0], [-hx, -hz], [hx, -hz], [-hx, hz], [hx, hz]] as const) {
        const x = p.x + u * Math.cos(p.yaw) + v * Math.sin(p.yaw);
        const z = p.z - u * Math.sin(p.yaw) + v * Math.cos(p.yaw);
        assert.notEqual(ground.surfaceAt(x, z), "grass", `a ${p.prefab} at (${p.x.toFixed(0)}, ${p.z.toFixed(0)}) stands on grass at (${x.toFixed(0)}, ${z.toFixed(0)})`);
      }
    }
  });

  it("when the White House is placed, then it stands as on the map: north of the Ellipse and the Monument, its North Portico toward Lafayette Square, the Treasury east and the Executive Office Building west, inside the camera's reach of turn two", () => {
    const wh = placed.find((p) => p.prefab === "white-house");
    const obelisk = placed.find((p) => p.prefab === "obelisk")!;
    assert.ok(wh, "the White House is placed");
    assert.ok(Math.abs(wh.yaw) < 1e-9, "unturned: its north front (-z) faces north");
    assert.ok(wh.z < obelisk.z - 500 && Math.abs(wh.x - obelisk.x) < 150, "north of the Monument, a little west");
    const ellipse = track.routes.find((r) => r.id === "ellipse-road");
    assert.ok(ellipse, "the Ellipse's road");
    const ez = Array.from(ellipse.path.z.slice(0, ellipse.path.count));
    const middle = (Math.min(...ez) + Math.max(...ez)) / 2;
    assert.ok(wh.z < middle && middle < obelisk.z, "the Ellipse between the White House and the Monument");
    const flank = placed.filter((p) => p.prefab === "marble" && Math.abs(p.z - wh.z) < 60 && Math.abs(p.x - wh.x) < 200);
    assert.ok(flank.some((p) => p.x > wh.x + 100) && flank.some((p) => p.x < wh.x - 100), "the Treasury east, the Executive Office Building west");
    assert.ok(Math.hypot(wh.x + 754, wh.z + 710) < far, "drawn from turn two");
  });

  it("when the race starts, then the mushroom cloud is a secret (the Konami code brings it out), and it rises down the frontstretch toward the White House: right of the avenue's line, within 10° of it, so the straight's buildings never hide it", () => {
    const wh = placed.find((p) => p.prefab === "white-house")!;
    const sky = track.json.environment.backdrop;
    assert.equal(sky?.kind, "mushroom-cloud");
    assert.equal(sky?.secret, true, "not there until the code");
    const deg = (dx: number, dz: number): number => ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
    const avenue = deg(-754, -710 + 577);
    const house = deg(wh.x + 377, wh.z + 643.5);
    assert.ok(house > avenue, "the White House stands right of the avenue's line");
    assert.ok(sky!.bearing > avenue && sky!.bearing < Math.min(house, avenue + 10), `the cloud at ${sky!.bearing}°, the avenue ${avenue.toFixed(1)}°, the White House ${house.toFixed(1)}°`);
  });

  it("when the Mall is looked down from the Monument, then west lie the WWII Memorial's basin, the long Reflecting Pool and the Lincoln Memorial facing east down it, and east the Capitol Reflecting Pool below the Hill, all within the camera's reach of the frontstretch", () => {
    const obelisk = placed.find((p) => p.prefab === "obelisk")!;
    const basin = placed.find((p) => p.prefab === "basin");
    const lincoln = placed.find((p) => p.prefab === "lincoln");
    const pools = placed.filter((p) => p.prefab === "reflecting-pool").sort((a, b) => a.x - b.x);
    const capitol = placed.find((p) => p.prefab === "capitol")!;
    const capitolPool = placed.find((p) => p.prefab === "capitol-pool");
    assert.ok(basin && lincoln && pools.length === 2 && capitolPool, "the basin, the memorial, the Reflecting Pool and the lake, and the Capitol's pool");
    const reflecting = pools.find((p) => p.x < basin.x && Math.abs(p.z - obelisk.z) < 30)!;
    // In order down the axis: Lincoln, the Reflecting Pool, the basin, the Monument ... the Capitol's pool, the Capitol.
    assert.ok(lincoln.x < reflecting.x && reflecting.x < basin.x && basin.x < obelisk.x, "west of the Monument in order");
    assert.ok(capitolPool.x > 0 && capitolPool.x < capitol.x, "the Capitol's pool between 3rd Street and the Capitol");
    for (const p of [basin, lincoln, reflecting]) assert.ok(Math.abs(p.z - obelisk.z) < 30, "on the Mall's axis by the Monument (it stands a little off it, as it does)");
    const long = (PREFABS["reflecting-pool"].size[0] * reflecting.sx) / (PREFABS["reflecting-pool"].size[2] * reflecting.sz);
    assert.ok(long > 5, `the Reflecting Pool is long and narrow (${long.toFixed(1)} : 1)`);
    // Its front (+z at yaw 0) turned to face east (+x), down the pool.
    assert.ok(Math.sin(lincoln.yaw) > 0.99, "the Lincoln Memorial faces east");
    for (const p of [lincoln, capitolPool]) assert.ok(Math.hypot(p.x - 0, p.z + 577) < far, `${p.prefab} drawn from turn one`);
  });

  it("when the city round the circuit is walked, then no ground within 150 m of the course, off its streets, lies more than 40 m from a building, tree or monument: only the lawns (the Mall, the Ellipse, the parks) stay open", () => {
    const solid = placed.filter((q) => q.prefab !== "cone");
    const reach = solid.map((q) => (Math.max(PREFABS[q.prefab].size[0] * q.sx, PREFABS[q.prefab].size[2] * q.sz)) / 2);
    const p = track.path;
    const empty: string[] = [];
    for (let x = Math.ceil(track.bounds.minX / 10) * 10; x < track.bounds.maxX; x += 10) {
      for (let z = Math.ceil(track.bounds.minZ / 10) * 10; z < track.bounds.maxZ; z += 10) {
        let course = Infinity;
        for (let k = 0; k < p.count; k++) course = Math.min(course, Math.hypot(p.x[k]! - x, p.z[k]! - z));
        const surface = ground.surfaceAt(x, z);
        if (course < 15 || course > 150 || surface === "grass" || surface === "asphalt") continue;
        let near = Infinity;
        for (let i = 0; i < solid.length; i++) near = Math.min(near, Math.hypot(solid[i]!.x - x, solid[i]!.z - z) - reach[i]!);
        if (near > 40) empty.push(`(${x}, ${z}) ${near.toFixed(0)} m`);
      }
    }
    assert.equal(empty.length, 0, `${empty.length} empty lots: ${empty.slice(0, 8).join(", ")}`);
  });

  it("when the House side south of Independence Avenue is placed, then South Capitol Street runs on the Capitol's axis, Rayburn (the largest) stands west of it, Longworth and then Cannon east of it", () => {
    const capitol = placed.find((p) => p.prefab === "capitol")!;
    const southCapitol = track.routes.find((r) => r.id === "south-capitol-street");
    assert.ok(southCapitol, "South Capitol Street");
    assert.ok(Math.abs(southCapitol.path.x[0]! - capitol.x) < 1, `South Capitol St at x ${southCapitol.path.x[0]}, the Capitol at ${capitol.x}`);
    const offices = placed.filter((p) => p.prefab === "marble" && p.z > 8 && p.x > 0).sort((a, b) => a.x - b.x);
    assert.equal(offices.length, 3, "Rayburn, Longworth, Cannon");
    const [rayburn, longworth, cannon] = offices as [typeof capitol, typeof capitol, typeof capitol];
    assert.ok(rayburn.x < capitol.x && longworth.x > capitol.x && cannon.x > longworth.x, "west to east about the axis");
    assert.ok(rayburn.sx > longworth.sx && rayburn.sx > cannon.sx, "Rayburn is the largest");
  });

  it("when the Lincoln Memorial is looked at, then it stands on its terrace with the grand stair down its front to the Reflecting Pool, inside its circle road, and the seated Lincoln faces out through the open east front", () => {
    const lincoln = placed.find((p) => p.prefab === "lincoln")!;
    const stair = LINCOLN.stair;
    assert.ok(stair.length >= 15, `${stair.length} steps`);
    assert.equal(stair.at(-1)!.y1, LINCOLN.terrace.y1, "the stair climbs to the terrace's top");
    for (const [k, b] of stair.entries()) if (k > 0) assert.ok(b.y1 > stair[k - 1]!.y1 && b.hz < stair[k - 1]!.hz, "each step higher and shallower");
    // The stair's foot, the front's farthest reach (local +z), turned to the world by the memorial's yaw.
    const reach = stair[0]!.z! + stair[0]!.hz;
    const foot = { x: lincoln.x + Math.sin(lincoln.yaw) * reach, z: lincoln.z + Math.cos(lincoln.yaw) * reach };
    const pool = placed.filter((p) => p.prefab === "reflecting-pool").sort((a, b) => Math.hypot(a.x - lincoln.x, a.z - lincoln.z) - Math.hypot(b.x - lincoln.x, b.z - lincoln.z))[0]!;
    assert.ok(Math.hypot(foot.x - pool.x, foot.z - pool.z) < Math.hypot(lincoln.x - pool.x, lincoln.z - pool.z) - reach + 1, "the stair runs down toward the pool");
    const circle = track.routes.find((r) => r.id === "lincoln-memorial-circle")!;
    const inner = Math.min(...Array.from(circle.path.x.slice(0, circle.path.count), (x, k) => Math.hypot(x - lincoln.x, circle.path.z[k]! - lincoln.z))) - circle.path.half[0]!;
    assert.ok(PREFABS.lincoln.foot < inner, `the memorial (${PREFABS.lincoln.foot.toFixed(0)} m) inside its circle road (${inner.toFixed(0)} m)`);
    const { cella, statue } = LINCOLN;
    assert.ok(cella.door > statue.pedestal.hx * 2, "the door is wider than the statue's pedestal");
    assert.ok(Math.abs(statue.pedestal.z) + statue.pedestal.hz < cella.hz - cella.wall, "the statue inside the chamber");
  });

  it(`when its ground (some 4 M one-metre cells under 50 streets) is baked on loading, then it takes under ${BAKE_MS / 1000} s (6.2 s before each street's straight runs were stamped once)`, () => {
    assert.ok(bakeMs < BAKE_MS, `baked in ${bakeMs.toFixed(0)} ms`);
  });

  it("when the Washington Monument's grounds are walked (owner, 2026-10-14: like the map of them), then it stands on a knoll in a paved circle ringed by 50 flags, gravel walks loop round it and cross the lawn, and the lawn round them is open", () => {
    const obelisk = placed.find((p) => p.prefab === "obelisk")!;
    const flags = placed.filter((p) => p.prefab === "flagpole");
    assert.equal(flags.length, 50, "the 50 flags");
    for (const f of flags) assert.ok(Math.abs(Math.hypot(f.x - obelisk.x, f.z - obelisk.z) - 23) < 1, "in a ring round its foot");
    assert.ok(ground.heightAt(obelisk.x, obelisk.z) - ground.heightAt(-812, obelisk.z) > 3, "on a knoll over the lawn at 15th Street's edge");
    assert.equal(ground.surfaceAt(obelisk.x + 15, obelisk.z), "cobble", "the paved circle");
    // Along a north-south line through the western circle's middle: the oval walk and the circle at each end, lawn between.
    const line: string[] = [];
    for (let z = obelisk.z - 120; z <= obelisk.z + 120; z += 1) line.push(ground.surfaceAt(obelisk.x - 45, z));
    const crossings = line.filter((s, i) => s === "gravel" && line[i - 1] !== "gravel").length;
    assert.ok(crossings >= 4, `${crossings} walks crossed north to south`);
    assert.ok(line.filter((s) => s === "grass").length > line.length * 0.6, "mostly lawn");
  });

  it("when the course is listed for the race menu, then it is called Washington DC", () => {
    assert.equal(track.json.name, "Washington DC");
  });

  it("when Madison and Jefferson Drives are followed east down the Mall, then each runs on to 3rd Street's edge, where the course's barrier closes it", () => {
    const ends = (prefix: string) => track.routes.filter((r) => r.id.startsWith(prefix)).map((r) => Math.max(...Array.from(r.path.x.slice(0, r.path.count))));
    for (const drive of ["madison-drive", "jefferson-drive"]) {
      const east = Math.max(...ends(drive));
      assert.ok(east > -10 && east < 0, `${drive} reaches x ${east.toFixed(1)} (3rd Street's centre at 0, its runoff to 7.5)`);
    }
  });

  it("when Union Square is looked at, then the Capitol Reflecting Pool is a wedge wider at its west end, the Grant Memorial stands at its east end facing down the Mall, and the Peace and Garfield Monuments stand in circles on 1st Street at its north and south corners", () => {
    const pool = placed.find((p) => p.prefab === "capitol-pool")!;
    const capitol = placed.find((p) => p.prefab === "capitol")!;
    assert.ok(CAPITOL_POOL.westHalf > CAPITOL_POOL.eastHalf * 1.4, "a wedge narrowing toward the Capitol");
    assert.ok(pool.x > 0 && pool.x < capitol.x && Math.abs(pool.yaw) < 1e-9, "between 3rd Street and the Capitol, its wide end west");
    const grant = placed.find((p) => p.prefab === "grant-memorial")!;
    assert.ok(grant.x > pool.x + CAPITOL_POOL.halfLength && grant.x < capitol.x && Math.abs(grant.z - pool.z) < 1, "at the pool's east end, on its axis");
    assert.ok(Math.sin(grant.yaw) < -0.99, "facing west, down the Mall");
    const first = track.routes.find((r) => r.id === "1st-street")!;
    for (const [circle, statue, north] of [["peace-circle", "peace-monument", true], ["garfield-circle", "garfield-monument", false]] as const) {
      const ring = track.routes.find((r) => r.id === circle)!;
      const xs = Array.from(ring.path.x.slice(0, ring.path.count));
      const zs = Array.from(ring.path.z.slice(0, ring.path.count));
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
      const m = placed.find((p) => p.prefab === statue)!;
      assert.ok(ring.path.closed && Math.hypot(m.x - cx, m.z - cz) < 1, `${statue} in the middle of ${circle}`);
      assert.ok(Math.abs(cx - first.path.x[0]!) < 1, `${circle} on 1st Street`);
      assert.ok(north ? cz < pool.z - CAPITOL_POOL.westHalf : cz > pool.z + CAPITOL_POOL.eastHalf, `${circle} at the plaza's ${north ? "north" : "south"} corner`);
    }
  });

  it("when the National Archives block is placed, then it stands inside the corner that turns two, three and four make", () => {
    const blocks = placed.filter((p) => p.prefab === "marble");
    assert.ok(
      blocks.some((b) => b.x > -754 && b.x < -572 && b.z > -710 && b.z < -522),
      "a block between 9th and 7th Streets, Pennsylvania and Constitution Avenues",
    );
  });
});

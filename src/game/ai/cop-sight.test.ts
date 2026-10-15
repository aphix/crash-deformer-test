import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blankAiCar } from "./derby-ai.ts";
import { RacerSight, SIGHT_MARGIN } from "./cop-sight.ts";
import { blankPoint, Track } from "../world/track.ts";
import oval from "../world/tracks/oval.json" with { type: "json" };

const track = new Track(oval);
const pt = blankPoint();
/** Where the racer stands: a point on the oval's centreline. */
const RACER_S = 100;
/** Metres to spare past a limit, to stand clear of it on either side. */
const CLEAR = 5;

/** A racer on the road at `RACER_S` and the sight that reads it. */
function sightOfRacer(): RacerSight {
  const sight = new RacerSight(track, 1);
  const p = track.pointAt(RACER_S, pt);
  sight.watch([{ ...blankAiCar(0), x: p.x, z: p.z }]);
  return sight;
}

/** Whether a spot `ds` m along the centreline from the racer is out of its sight. */
function hiddenAlong(sight: RacerSight, ds: number): boolean {
  const p = track.pointAt(RACER_S + ds, pt);
  return sight.hiddenAt(p.x, p.z, RACER_S + ds, true);
}

describe("given a racer on the oval's road and the sight a police pack puts its cops out of", () => {
  const sight = sightOfRacer();
  const { near, ahead } = sight.range;

  it("when a candidate spot lies on the road within the near range (plus the margin) of the racer, then it is in sight, ahead or behind", () => {
    assert.equal(hiddenAlong(sight, near + SIGHT_MARGIN - CLEAR), false, "just inside the near range, ahead");
    assert.equal(hiddenAlong(sight, -(near + SIGHT_MARGIN - CLEAR)), false, "just inside the near range, behind");
  });

  it("when a candidate spot lies on the road ahead of the racer, then it is in sight up to the ahead range (plus the margin) and out of it past", () => {
    assert.equal(hiddenAlong(sight, ahead + SIGHT_MARGIN - CLEAR), false, "just inside the ahead range");
    assert.equal(hiddenAlong(sight, ahead + SIGHT_MARGIN + CLEAR), true, "just past the ahead range");
  });

  it("when a candidate spot lies on the road behind the racer, then it is out of sight past the near range (plus the margin): the mirrors reach no further", () => {
    assert.equal(hiddenAlong(sight, -(near + SIGHT_MARGIN + CLEAR)), true, "just past the near range, behind");
  });

  it("when the racer is off the road and a spot is off it too, then the racer sees the ahead range all round it and no further", () => {
    const off = track.pointAt(RACER_S, pt);
    const racerOff = new RacerSight(track, 1);
    // 60 m to the side of the road: past its corridor, so the racer's heading says nothing of the road.
    racerOff.watch([{ ...blankAiCar(0), x: off.x + off.tz * 60, z: off.z - off.tx * 60 }]);
    const at = (radial: number) => racerOff.hiddenAt(off.x + off.tz * (60 + radial), off.z - off.tx * (60 + radial), RACER_S, false);
    assert.equal(at(ahead + SIGHT_MARGIN - CLEAR), false, "just inside the ahead range, round the racer");
    assert.equal(at(ahead + SIGHT_MARGIN + CLEAR), true, "just past it");
  });

  it("when a cop car stands in the racer's near range, then `hiddenCar` reads it as seen, and out of every range as hidden", () => {
    const stand = (ds: number) => {
      const p = track.pointAt(RACER_S + ds, pt);
      return { ...blankAiCar(1), x: p.x, z: p.z };
    };
    assert.equal(sight.hiddenCar(stand(near - CLEAR)), false, "inside the near range");
    assert.equal(sight.hiddenCar(stand(ahead + SIGHT_MARGIN + CLEAR)), true, "past the ahead range");
  });
});

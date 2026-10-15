import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { TIME_OF_DAY, TIMES_OF_DAY } from "../match/types.ts";
import { courseDay, sunElevation, sunOffset } from "./engine-world.ts";
import { rowElevation, SKY_LOOKS, uAtNorth } from "./sky-dome.ts";

/** The sun's place before times of day: every course's daylight was lit from here. */
const OLD_SUN = new THREE.Vector3(-10, 22, 9);
const DEG = Math.PI / 180;

describe("given the race's times of day: the sky pictures and the light", () => {
  it("when the race runs by day, then the sun shines from exactly where it always has", () => {
    const off = sunOffset(TIME_OF_DAY.day, new THREE.Vector3());
    assert.ok(off.distanceTo(OLD_SUN) < 1e-9, `the day's sun at (${off.x}, ${off.y}, ${off.z})`);
  });

  it("when a course with no daylight of its own is lit, then its sky (and fog) colour is the course's, not the studio's near-black", () => {
    assert.equal(courseDay(null, "#9db3c7").sky, 0x9db3c7);
    assert.equal(courseDay({ sun: "#fff0d4", sunIntensity: 2.6, hemi: "#b7d0ea", fill: "#f6e2c8" }, "#a6c6e2").sky, 0xa6c6e2);
  });

  it("when the race runs at sunset, then the sun comes in low (12-25°) from the day's side, at the day's height over the shadow box", () => {
    const el = sunElevation(TIME_OF_DAY.sunset);
    assert.ok(el >= 12 * DEG - 1e-9 && el <= 25 * DEG, `${(el / DEG).toFixed(1)}°`);
    const off = sunOffset(TIME_OF_DAY.sunset, new THREE.Vector3());
    assert.ok(Math.abs(Math.atan2(off.x, -off.z) - Math.atan2(OLD_SUN.x, -OLD_SUN.z)) < 1e-9, "the same bearing");
    assert.ok(Math.abs(off.y - OLD_SUN.y) < 1e-9, "the same height");
  });

  for (const time of TIMES_OF_DAY) {
    const look = SKY_LOOKS[time];
    it(`when the ${time} sky is drawn, then its disc (if any) lands on the light's bearing, and its strip runs from under the horizon to well above it`, () => {
      const bearing = Math.atan2(OLD_SUN.x, -OLD_SUN.z);
      const u0 = uAtNorth(look, bearing);
      assert.ok(u0 >= 0 && u0 < 1, `u at north ${u0}`);
      if (look.disc) {
        // The shader's u at the light's bearing is the disc's column.
        const u = (((bearing / (2 * Math.PI) + u0) % 1) + 1) % 1;
        assert.ok(Math.abs(u * look.width - look.disc.column) < 1e-6, `u ${u * look.width} against column ${look.disc.column}`);
        assert.ok(rowElevation(look, look.disc.row) > 0, "the disc above the horizon");
      }
      assert.ok(rowElevation(look, look.height - 1) < 0, "the bottom row under the horizon");
      assert.ok(rowElevation(look, 0) > 40 * DEG, `the top row at ${(rowElevation(look, 0) / DEG).toFixed(0)}°`);
    });
  }
});

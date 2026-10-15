import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { backdropGeometry, PANEL } from "./sky-backdrop.ts";

describe("given the sky backdrop's panel (`environment.backdrop`)", () => {
  for (const bearing of [0, 90, 280]) {
    it(`when it is built round a bearing of ${bearing}°, then its middle points that way (−z north, +x east) and it reaches from under the horizon to above it`, () => {
      const g = backdropGeometry(bearing);
      const pos = g.getAttribute("position");
      const uv = g.getAttribute("uv");
      const b = (bearing * Math.PI) / 180;
      let middle = -1;
      let low = Infinity;
      let high = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        low = Math.min(low, pos.getY(i));
        high = Math.max(high, pos.getY(i));
        const el = PANEL.foot + (PANEL.top - PANEL.foot) * uv.getY(i);
        if (uv.getX(i) === 0.5 && Math.abs(el) < 0.03 && (middle < 0 || Math.abs(pos.getY(i)) < Math.abs(pos.getY(middle)))) middle = i;
      }
      assert.ok(middle >= 0, "a vertex on the middle column at the horizon");
      const flat = Math.hypot(pos.getX(middle), pos.getZ(middle));
      assert.ok(Math.abs(pos.getX(middle) / flat - Math.sin(b)) < 1e-6 && Math.abs(pos.getZ(middle) / flat + Math.cos(b)) < 1e-6, "the middle column on the bearing");
      assert.ok(low < 0 && high > Math.sin(PANEL.top) - 1e-6, `elevations from ${low.toFixed(3)} to ${high.toFixed(3)}`);
    });
  }

  it("when it is built, then u runs with the bearing: the left edge of the painting is the anticlockwise one, as seen facing it", () => {
    const g = backdropGeometry(0);
    const pos = g.getAttribute("position");
    const uv = g.getAttribute("uv");
    for (let i = 0; i < pos.count; i++) {
      if (uv.getX(i) === 0) assert.ok(pos.getX(i) < 0, "u = 0 lies west of north");
      if (uv.getX(i) === 1) assert.ok(pos.getX(i) > 0, "u = 1 lies east of north");
    }
  });
});

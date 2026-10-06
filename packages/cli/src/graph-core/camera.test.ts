import { describe, expect, it } from "vitest";
import { freeSpaceCenter, perspectivePlaneOffset } from "./camera.js";

describe("freeSpaceCenter", () => {
  it.each([
    [393, 620, 200, 198],
    [393, 620, 300, 148],
    [320, 480, 216, 120],
    [844, 390, 175, 95.5],
    [1024, 900, 400, 238],
    // An in-viewport tab bar and bottom padding add to the obstruction.
    [393, 704, 200 + 84 + 12, 192],
    [393, 620, 212, 192],
  ])("centers a %i x %i viewport above a %i-point bottom inset", (width, height, bottomInset, y) => {
    const center = freeSpaceCenter({ width, height, bottomInset });
    expect(center).toEqual({ x: width / 2, y });
    expect(center.y).toBeLessThanOrEqual(height - bottomInset - 24);
  });

  it("moves up by half of the card's growth and supports a top inset", () => {
    const before = freeSpaceCenter({ width: 393, height: 620, bottomInset: 200, topInset: 44 });
    const after = freeSpaceCenter({ width: 393, height: 620, bottomInset: 280, topInset: 44 });
    expect(before.y).toBe(220);
    expect(after.y).toBe(180);
  });

  it("clamps to the available top edge when no free space remains", () => {
    expect(freeSpaceCenter({ width: 320, height: 200, bottomInset: 300, topInset: 12 })).toEqual({ x: 160, y: 12 });
  });
});

describe("perspectivePlaneOffset", () => {
  it("accounts for lens zoom and horizontal aspect", () => {
    expect(perspectivePlaneOffset({ x: 600, y: 150 }, { width: 800, height: 600 }, 200, 90, 2).x).toBeCloseTo(200 / 3);
    expect(perspectivePlaneOffset({ x: 600, y: 150 }, { width: 800, height: 600 }, 200, 90, 2).y).toBeCloseTo(50);
  });
});

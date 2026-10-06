import { describe, expect, it } from "vitest";
import { displayWidth } from "../render.js";
import { graphGlyphs, iconMode } from "./glyphs.js";

describe("graph glyphs", () => {
  it("defaults to plain Unicode and switches to Nerd Font icons on request", () => {
    expect(iconMode({})).toBe("unicode");
    expect(iconMode({ PHREN_ICONS: "Nerd" })).toBe("nerd");
    expect(graphGlyphs({}).project).toBe("◉");
    expect(graphGlyphs({ PHREN_ICONS: "nerd" }).project).not.toBe("◉");
  });

  it("only uses single-cell glyphs so the canvas stays aligned", () => {
    for (const env of [{}, { PHREN_ICONS: "nerd" }]) {
      for (const glyph of Object.values(graphGlyphs(env))) expect(displayWidth(glyph)).toBe(1);
    }
  });
});

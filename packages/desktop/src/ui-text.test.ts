import { describe, expect, it } from "vitest";
import { countOf } from "../ui/text.js";

describe("countOf", () => {
  it("uses the singular only for one", () => {
    expect(countOf(1, "file")).toBe("1 file");
    expect(countOf(0, "file")).toBe("0 files");
    expect(countOf(3, "open task")).toBe("3 open tasks");
  });
  it("takes an irregular plural", () => {
    expect(countOf(2, "repository", "repositories")).toBe("2 repositories");
  });
});

import { describe, expect, it } from "vitest";
import { extractKnowsBlock, rememberThis } from "../ui/chat/knows.js";

describe("extractKnowsBlock", () => {
  it("reads the prose inside the marked block", () => {
    const summary = "# phren\n\n<!-- phren:knows:start at=2026-10-10 -->\n## What phren knows\n\nThe hook retries once before failing.\n<!-- phren:knows:end -->\n";
    expect(extractKnowsBlock(summary)).toBe("The hook retries once before failing.");
  });

  it("returns an empty string without the markers", () => {
    expect(extractKnowsBlock("# phren\n\n## What phren knows\n\nNo markers here.")).toBe("");
  });
});

describe("rememberThis validation", () => {
  it("rejects empty text", async () => {
    await expect(rememberThis({ computer: "This computer", project: "phren", text: "   " }))
      .rejects.toThrow("Select some text first.");
  });

  it("rejects a session with no project", async () => {
    await expect(rememberThis({ computer: "This computer", project: "", text: "something" }))
      .rejects.toThrow("This session has no project yet.");
  });
});

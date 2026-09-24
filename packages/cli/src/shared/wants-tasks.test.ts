import { describe, expect, it } from "vitest";
import { detectTaskIntent, wantsTasks } from "./retrieval.js";

describe("wantsTasks", () => {
  it("lets tasks in for building and for questions about the work, not for a debugging question", () => {
    const ask = (p: string) => wantsTasks(p, detectTaskIntent(p));
    expect(ask("build the release pipeline")).toBe(true);
    expect(ask("what's left on this project?")).toBe(true);
    expect(ask("show me the backlog")).toBe(true);
    expect(ask("what are the priorities for the api?")).toBe(true);
    expect(ask("why does the login throw a stack trace on refresh")).toBe(false);
    expect(ask("explain how the retry policy works")).toBe(false);
  });
});

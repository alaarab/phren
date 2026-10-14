import { describe, expect, it } from "vitest";
import { formatGitWrites } from "../ui/sections/settings/git-writes.js";

describe("git write diagnostic line", () => {
  it("reports none for a Hook with no unchecked writes", () => {
    expect(formatGitWrites([])).toBe("Git writes without a repository check: none");
  });

  it("shows each client's count using the Hook 0.3.47 snapshot", () => {
    expect(formatGitWrites([
      { client: "android / 1.2", count: 3, warning: "3 git writes without expectedRepository from android / 1.2" },
      { client: "unknown client", count: 1, warning: "1 git writes without expectedRepository from unknown client" },
    ])).toBe("Git writes without a repository check: 3 from android / 1.2; 1 from unknown client");
  });

  it("includes routes when the Hook supplies them", () => {
    expect(formatGitWrites([
      { client: "desktop", count: 2, routes: ["/v1/git/stage", "/v1/git/commit"] },
    ])).toBe("Git writes without a repository check: 2 from desktop (/v1/git/stage, /v1/git/commit)");
  });

  it("distinguishes a missing snapshot from zero writes", () => {
    expect(formatGitWrites(undefined)).toBe("Git writes without a repository check: Hook too old to report");
  });
});

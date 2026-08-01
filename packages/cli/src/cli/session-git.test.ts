import { describe, expect, it } from "vitest";
import { TEAM_STORE_PATHSPECS } from "./session-git.js";

// Folded in from the deleted cli-hooks-git.ts / cli-hooks-git.test.ts, which
// carried a byte-identical duplicate of this module plus a now-dead
// `addTeamPathspecs` helper (no production caller — the team-store push path
// in tools/finding.ts inlines the same per-pathspec `git add --sparse` loop,
// each iteration already wrapped in its own try/catch so one no-match can't
// abort the rest). Only the constant's shape is still meaningful to pin down.
describe("TEAM_STORE_PATHSPECS", () => {
  it("includes the journal/tasks/findings/reference/skills patterns", () => {
    expect(TEAM_STORE_PATHSPECS).toContain("*/journal/*");
    expect(TEAM_STORE_PATHSPECS).toContain("*/tasks.md");
    expect(TEAM_STORE_PATHSPECS).toContain("*/FINDINGS.md");
    expect(TEAM_STORE_PATHSPECS).toContain("*/reference/**");
    expect(TEAM_STORE_PATHSPECS).toContain("*/skills/**");
    expect(TEAM_STORE_PATHSPECS).toContain("*/notes/**");
  });
});

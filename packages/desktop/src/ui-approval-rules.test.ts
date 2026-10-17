import { describe, expect, it } from "vitest";
import { ruleDates, ruleScope, ruleSentence, ruleStatus } from "../ui/sections/settings/approval-rule-text.js";

const base = {
  id: "11111111-1111-4111-8111-111111111111", tool: "Bash", command: "pnpm test", match: "exact", effect: "always-ask",
  scope: { project: "/Users/me/Projects/phren", harness: "claude" }, projectName: "phren",
  createdAt: "2026-10-07T12:00:00Z", owner: "ab", enabled: true,
};
const NOW = Date.parse("2026-10-10T12:00:00Z");

describe("approval rule wording", () => {
  it("covers every match kind", () => {
    expect(ruleSentence(base)).toBe("Claude must ask before running `pnpm test` in phren.");
    expect(ruleSentence({ ...base, match: "prefix", command: "git push" })).toBe("Claude must ask before running commands starting with `git push` in phren.");
    expect(ruleSentence({ ...base, match: "glob", command: "rm -rf *" })).toBe("Claude must ask before running commands matching `rm -rf *` in phren.");
  });

  it("covers both effects", () => {
    expect(ruleSentence({ ...base, effect: "deny" })).toBe("Claude may not run `pnpm test` in phren.");
  });

  it("names every harness and the any-harness scope", () => {
    for (const [harness, name] of [["claude", "Claude"], ["codex", "Codex"], ["copilot", "Copilot"], ["opencode", "OpenCode"], ["phren", "The Phren agent"]]) {
      expect(ruleSentence({ ...base, scope: { project: base.scope.project, harness } })).toMatch(new RegExp(`^${name} must ask`));
    }
    expect(ruleSentence({ ...base, scope: { project: base.scope.project } })).toMatch(/^Any agent must ask/);
  });

  it("adds session and computer scope", () => {
    const rule = { ...base, scope: { ...base.scope, session: "abc", computer: "mini" } };
    expect(ruleSentence(rule)).toBe("Claude must ask before running `pnpm test` in phren in one session on mini.");
    expect(ruleScope(rule)).toBe("Project /Users/me/Projects/phren · Claude only · Session abc · Computer mini");
    expect(ruleScope({ ...base, scope: { project: "/p" } })).toBe("Project /p · Any agent");
  });

  it("falls back to the project path without a name", () => {
    expect(ruleSentence({ ...base, projectName: "" })).toContain("in /Users/me/Projects/phren.");
  });

  it("reports status, creation and expiry", () => {
    expect(ruleStatus(base, NOW)).toBe("On");
    expect(ruleStatus({ ...base, enabled: false }, NOW)).toBe("Off");
    expect(ruleStatus({ ...base, until: "2026-10-09T00:00:00Z" }, NOW)).toBe("Expired");
    expect(ruleDates(base, NOW)).toBe("Added Oct 7 (3d ago) · No expiry");
    expect(ruleDates({ ...base, until: "2026-10-20T00:00:00Z" }, NOW)).toBe("Added Oct 7 (3d ago) · Expires Oct 20");
    expect(ruleDates({ ...base, until: "2026-10-09T00:00:00Z" }, NOW)).toBe("Added Oct 7 (3d ago) · Expired Oct 9");
  });
});

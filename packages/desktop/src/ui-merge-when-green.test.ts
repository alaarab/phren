import { describe, expect, it } from "vitest";
import { mergeDecision } from "../ui/shell/merge-when-green.js";

const arm = { number: 42, headSha: "abc1234" };
const pull = (over: Record<string, unknown> = {}) => ({ number: 42, state: "OPEN", headSha: "abc1234", checks: "passing", mergeState: "CLEAN", ...over });

describe("mergeDecision", () => {
  it("merges the armed head once checks pass and the host does not block it", () => {
    expect(mergeDecision(arm, pull())).toBe("merge");
    expect(mergeDecision(arm, pull({ mergeState: undefined }))).toBe("merge");
  });

  it("waits while checks run or the host still blocks the merge", () => {
    expect(mergeDecision(arm, pull({ checks: "pending" }))).toBe("wait");
    expect(mergeDecision(arm, pull({ mergeState: "BLOCKED" }))).toBe("wait");
  });

  it("disarms on new commits, a failing check, conflicts or a request that is gone", () => {
    expect(mergeDecision(arm, pull({ headSha: "def5678" }))).toEqual({ stop: "new commits arrived; arm it again" });
    expect(mergeDecision(arm, pull({ checks: "failing" }))).toEqual({ stop: "checks failed" });
    expect(mergeDecision(arm, pull({ mergeState: "DIRTY", checks: "pending" }))).toEqual({ stop: "it has conflicts" });
    expect(mergeDecision(arm, pull({ state: "MERGED" }))).toEqual({ stop: "it was merged" });
    expect(mergeDecision(arm, null)).toEqual({ stop: "the branch no longer has it open" });
  });
});

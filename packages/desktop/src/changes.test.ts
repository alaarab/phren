// @ts-expect-error changes.js is plain JavaScript without type declarations
import { isDefaultBranch, planPublish, prReason, pushReason } from "../ui/changes.js";
import { describe, expect, it } from "vitest";

// Minimal GitStatus shape for the publish plan.
const status = (over: Record<string, unknown> = {}) => ({
  branch: "feat/x", upstream: "origin/feat/x", ahead: 0, behind: 0,
  defaultBranch: "main", files: [], ...over,
} as never);

describe("planPublish", () => {
  it("offers Commit when something is staged", () => {
    const plan = planPublish(status({ files: [{ path: "a.ts", staged: true }] }), null);
    expect(plan.commit).toBe(true);
    expect(plan.stageAll).toBe(0);
  });

  it("offers Stage all with nothing staged, counting unique paths", () => {
    const files = [{ path: "a.ts", staged: false }, { path: "a.ts", staged: false }, { path: "b.ts", staged: false }];
    const plan = planPublish(status({ files, upstream: null }), null);
    expect(plan.commit).toBe(false);
    expect(plan.stageAll).toBe(2);
  });

  it("labels Push branch with no upstream, Push N when ahead", () => {
    expect(planPublish(status({ upstream: null }), null).push).toBe("Push branch");
    expect(planPublish(status({ ahead: 3 }), null).push).toBe("Push 3");
    expect(planPublish(status({ ahead: 0 }), null).push).toBeNull();
  });

  it("opens a pull request only when pushed and off the default branch", () => {
    expect(planPublish(status({ ahead: 0 }), null).pull).toEqual({ open: true });
    expect(planPublish(status({ ahead: 0, upstream: null }), null).pull).toBeNull();
    expect(planPublish(status({ ahead: 0, branch: "main" }), null).pull).toBeNull();
    expect(planPublish(status({ ahead: 1 }), null).pull).toBeNull();
  });

  it("links the existing pull request for the branch", () => {
    const current = { head: "feat/x", number: 7, url: "https://x/7", checks: "passing" };
    expect(planPublish(status(), current).pull).toEqual({ existing: 7, url: "https://x/7", checks: "passing" });
  });

  it("is empty for a clean, pushed default branch", () => {
    expect(planPublish(status({ branch: "main", upstream: "origin/main" }), null).isEmpty).toBe(true);
    // A clean, pushed feature branch still offers to open a pull request.
    expect(planPublish(status(), null).isEmpty).toBe(false);
  });
});

describe("disabled reasons", () => {
  it("explains an unavailable push", () => {
    expect(pushReason(status({ branch: "" }))).toBe("HEAD is detached.");
    expect(pushReason(status({ ahead: 0 }))).toBe("Nothing to push.");
    expect(pushReason(status({ ahead: 1 }))).toBe("");
    expect(pushReason(status({ upstream: null }))).toBe("");
  });

  it("explains an unavailable pull request", () => {
    expect(prReason(status({ branch: "" }))).toContain("No branch");
    expect(prReason(status({ branch: "main" }))).toContain("default branch");
    expect(prReason(status({ upstream: null }))).toContain("Push the branch");
    expect(prReason(status({ ahead: 2 }))).toContain("Push 2");
    expect(prReason(status({ ahead: 0 }))).toBe("");
  });
});

describe("isDefaultBranch", () => {
  it("matches only the recorded default branch", () => {
    expect(isDefaultBranch(status({ branch: "main", defaultBranch: "main" }) as never)).toBe(true);
    expect(isDefaultBranch(status({ branch: "feat/x" }) as never)).toBe(false);
    expect(isDefaultBranch(status({ branch: "", defaultBranch: null }) as never)).toBe(false);
  });
});

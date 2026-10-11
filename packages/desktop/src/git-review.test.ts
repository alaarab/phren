import { describe, expect, it } from "vitest";
import {
  branchProblem, checksSummary, diffModes, diffSides, hunkAt, hunkPatch, lineChangeTotals, localForRemote,
  capitalize, hostTerms, pullStanding, splitHunks, stepChange, syncAction, trackingText,
// @ts-expect-error git-review.js is plain JavaScript without type declarations
} from "../ui/git-review.js";

const HEADER = "diff --git a/a.ts b/a.ts\nindex 1..2 100644\n--- a/a.ts\n+++ b/a.ts";
const PATCH = `${HEADER}\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n keep\n@@ -10 +11,2 @@ function f() {\n-x\n+y\n+z\n`;

describe("splitHunks and hunkPatch", () => {
  it("splits a patch into its header and hunks with ranges and counts", () => {
    const { header, hunks } = splitHunks(PATCH);
    expect(header).toBe(HEADER);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, added: 2, removed: 1 });
    // A missing count means one line.
    expect(hunks[1]).toMatchObject({ oldStart: 10, oldLines: 1, newStart: 11, newLines: 2, added: 2, removed: 1 });
    expect(hunks[1].header).toBe("@@ -10 +11,2 @@ function f() {");
  });

  it("rebuilds one hunk as a patch Git can apply alone", () => {
    const { header, hunks } = splitHunks(PATCH);
    expect(hunkPatch(header, hunks[1])).toBe(`${HEADER}\n@@ -10 +11,2 @@ function f() {\n-x\n+y\n+z\n`);
    expect(splitHunks("").hunks).toEqual([]);
  });

  it("finds the hunk under a line, or the next one, on either side", () => {
    const { hunks } = splitHunks(PATCH);
    expect(hunkAt(hunks, 2, "new")).toBe(0);
    expect(hunkAt(hunks, 6, "new")).toBe(1);
    expect(hunkAt(hunks, 12, "new")).toBe(1);
    expect(hunkAt(hunks, 400, "new")).toBe(1);
    expect(hunkAt(hunks, 10, "old")).toBe(1);
    expect(hunkAt([], 1)).toBe(-1);
  });
});

describe("diff sides and modes", () => {
  it("compares HEAD, the index and the working file by mode, and a commit with its parent", () => {
    expect(diffSides("all")).toEqual({ original: "HEAD", modified: null });
    expect(diffSides("unstaged")).toEqual({ original: "INDEX", modified: null });
    expect(diffSides("staged")).toEqual({ original: "HEAD", modified: "INDEX" });
    expect(diffSides("all", { sha: "abc1234", parent: "def5678", oldPath: "old.ts" })).toEqual({ original: "def5678", modified: "abc1234", originalPath: "old.ts", readOnly: true });
    expect(diffSides("all", { sha: "abc1234", parent: null }).original).toBeNull();
  });

  it("offers All, Unstaged and Staged only when a file has both", () => {
    expect(diffModes([{ kind: "staged", patch: "p" }, { kind: "unstaged", patch: "p" }])).toEqual({ modes: ["all", "unstaged", "staged"], initial: "unstaged" });
    expect(diffModes([{ kind: "staged", patch: "p" }])).toEqual({ modes: ["staged"], initial: "staged" });
    expect(diffModes([{ kind: "unstaged", patch: "p" }, { kind: "staged", patch: "" }])).toEqual({ modes: ["unstaged"], initial: "unstaged" });
    expect(diffModes([])).toEqual({ modes: ["unstaged"], initial: "unstaged" });
  });
});

describe("branch bar", () => {
  const status = (over: Record<string, unknown> = {}) => ({ branch: "main", upstream: "origin/main", ahead: 0, behind: 0, ...over });

  it("pulls when behind and fetches otherwise; nothing on a detached HEAD", () => {
    expect(syncAction(status({ behind: 3 }))).toEqual({ kind: "pull", label: "Pull 3" });
    expect(syncAction(status({ ahead: 2 }))).toEqual({ kind: "fetch", label: "Fetch" });
    expect(syncAction(status({ upstream: null, behind: 0 }))).toEqual({ kind: "fetch", label: "Fetch" });
    expect(syncAction(status({ branch: "" }))).toBeNull();
  });

  it("shows ahead and behind, or that the branch was never pushed", () => {
    expect(trackingText(status({ ahead: 2, behind: 1 }))).toBe("↑2 ↓1");
    expect(trackingText(status())).toBe("");
    expect(trackingText(status({ upstream: null }))).toBe("not pushed");
  });

  it("checks branch names the way Git does", () => {
    expect(branchProblem("feat/login")).toBe("");
    expect(branchProblem("")).toMatch(/Enter/);
    expect(branchProblem("-x")).toMatch(/dash/);
    expect(branchProblem("a b")).toMatch(/spaces/);
    expect(branchProblem("a..b")).toMatch(/two dots/);
    expect(branchProblem("a~1")).toMatch(/~/);
    expect(branchProblem("a/")).toMatch(/Slashes/);
    expect(branchProblem("a//b")).toMatch(/Slashes/);
    expect(branchProblem("x.lock")).toMatch(/\.lock/);
    expect(branchProblem("a/.hidden")).toMatch(/start with a dot/);
    expect(branchProblem("HEAD")).toMatch(/reserved/);
    expect(branchProblem("a@{1}")).toMatch(/@\{/);
  });

  it("names the local branch for a remote one", () => {
    expect(localForRemote("origin/feat/x")).toBe("feat/x");
    expect(localForRemote("upstream/main", ["origin", "upstream"])).toBe("main");
    expect(localForRemote("plain")).toBe("plain");
  });
});

describe("pull request standing", () => {
  it("summarises checks failing first and names review and merge state", () => {
    expect(checksSummary([{ state: "passing" }, { state: "failing" }, { state: "passing" }, { state: "pending" }, { state: "neutral" }]))
      .toBe("1 failing · 1 pending · 2 passing");
    expect(checksSummary([])).toBe("");
    expect(pullStanding({ reviewDecision: "CHANGES_REQUESTED", mergeState: "BLOCKED" })).toBe("Changes requested · Merge blocked");
    expect(pullStanding({ reviewDecision: "APPROVED", mergeState: "CLEAN" })).toBe("Approved · Ready to merge");
    expect(pullStanding({ mergeState: "SOMETHING_NEW" })).toBe("");
    expect(pullStanding(null)).toBe("");
  });
});

describe("change navigation", () => {
  // Monaco's ILineChange: an insertion has originalEndLineNumber 0, a deletion modifiedEndLineNumber 0.
  const changes = [
    { originalStartLineNumber: 1, originalEndLineNumber: 1, modifiedStartLineNumber: 1, modifiedEndLineNumber: 2 },
    { originalStartLineNumber: 9, originalEndLineNumber: 0, modifiedStartLineNumber: 10, modifiedEndLineNumber: 12 },
    { originalStartLineNumber: 20, originalEndLineNumber: 22, modifiedStartLineNumber: 22, modifiedEndLineNumber: 0 },
  ];

  it("counts added and removed lines from Monaco's line changes", () => {
    expect(lineChangeTotals(changes)).toEqual({ added: 5, removed: 4 });
    expect(lineChangeTotals([])).toEqual({ added: 0, removed: 0 });
  });

  it("steps to the next or previous change from a line and wraps", () => {
    expect(stepChange(changes, 0, 1)).toBe(0);
    expect(stepChange(changes, 1, 1)).toBe(1);
    expect(stepChange(changes, 11, 1)).toBe(2);
    expect(stepChange(changes, 30, 1)).toBe(0);
    expect(stepChange(changes, 30, -1)).toBe(2);
    expect(stepChange(changes, 10, -1)).toBe(0);
    expect(stepChange(changes, 1, -1)).toBe(2);
    expect(stepChange([], 1, 1)).toBe(-1);
  });
});

describe("host terms", () => {
  it("names requests the way the remote's host does, and stays generic until it is known", () => {
    expect(hostTerms({ kind: "gitlab", name: "GitLab", terms: { short: "MR", long: "merge request", ref: "!" }, supported: false }))
      .toEqual({ short: "MR", long: "merge request", ref: "!", name: "GitLab", supported: false });
    expect(hostTerms({ kind: "github", name: "GitHub", terms: { short: "PR", long: "pull request", ref: "#" }, supported: true }).name).toBe("GitHub");
    expect(hostTerms(undefined)).toEqual({ short: "PR", long: "pull request", ref: "#", name: "the git host", supported: false });
    expect(hostTerms({ kind: null, name: "the git host", terms: { short: "PR", long: "pull request", ref: "#" } }).name).toBe("the git host");
    expect(capitalize("merge request")).toBe("Merge request");
  });
});

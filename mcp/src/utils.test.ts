import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "./test-helpers.js";
import { runGit, runGitOrThrow } from "./utils.js";

describe("runGit", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => {
    tmp = makeTempDir("run-git-");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("includes git stderr in debug output when a command fails", () => {
    const logs: string[] = [];

    const result = runGit(tmp.path, ["rev-parse", "HEAD"], 1000, (msg) => logs.push(msg));

    expect(result).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("not a git repository");
  });

  it("throws with captured git stderr when callers need hard failures", () => {
    expect(() => runGitOrThrow(tmp.path, ["rev-parse", "HEAD"], 1000)).toThrow(/not a git repository/);
  });
});

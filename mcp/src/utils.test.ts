import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "./test-helpers.js";
import * as fs from "fs";
import * as path from "path";
import { resetCortexDotEnvBootstrapForTests } from "./cortex-dotenv.js";
import { isFeatureEnabled, runGit, runGitOrThrow } from "./utils.js";

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

describe("feature flag bootstrap", () => {
  let tmp: { path: string; cleanup: () => void };
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  const origDedup = process.env.CORTEX_FEATURE_SEMANTIC_DEDUP;

  beforeEach(() => {
    tmp = makeTempDir("feature-flags-");
    process.env.HOME = tmp.path;
    process.env.USERPROFILE = tmp.path;
    delete process.env.CORTEX_FEATURE_SEMANTIC_DEDUP;
    fs.mkdirSync(path.join(tmp.path, ".cortex"), { recursive: true });
    resetCortexDotEnvBootstrapForTests();
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;
    if (origDedup === undefined) delete process.env.CORTEX_FEATURE_SEMANTIC_DEDUP;
    else process.env.CORTEX_FEATURE_SEMANTIC_DEDUP = origDedup;
    resetCortexDotEnvBootstrapForTests();
    tmp.cleanup();
  });

  it("loads persisted feature flags from ~/.cortex/.env when env is unset", () => {
    fs.writeFileSync(path.join(tmp.path, ".cortex", ".env"), "CORTEX_FEATURE_SEMANTIC_DEDUP=1\n");

    expect(isFeatureEnabled("CORTEX_FEATURE_SEMANTIC_DEDUP", false)).toBe(true);
  });

  it("does not override an explicit environment setting with ~/.cortex/.env", () => {
    fs.writeFileSync(path.join(tmp.path, ".cortex", ".env"), "CORTEX_FEATURE_SEMANTIC_DEDUP=1\n");
    process.env.CORTEX_FEATURE_SEMANTIC_DEDUP = "0";

    expect(isFeatureEnabled("CORTEX_FEATURE_SEMANTIC_DEDUP", true)).toBe(false);
  });
});

import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "../test-helpers.js";

describe("handleBackgroundSync", () => {
  let tmp: { path: string; cleanup: () => void };
  const origCortexPath = process.env.CORTEX_PATH;

  beforeEach(() => {
    tmp = makeTempDir("cortex-bg-sync-");
    execFileSync("git", ["init"], { cwd: tmp.path, stdio: "ignore" });
    fs.mkdirSync(path.join(tmp.path, ".governance"), { recursive: true });
    process.env.CORTEX_PATH = tmp.path;
  });

  afterEach(() => {
    if (origCortexPath === undefined) delete process.env.CORTEX_PATH;
    else process.env.CORTEX_PATH = origCortexPath;
    tmp.cleanup();
  });

  it("records saved-local state when no remote is configured", async () => {
    const { handleBackgroundSync } = await import("../cli-hooks-session.js");
    await handleBackgroundSync();

    const runtimePath = path.join(tmp.path, ".runtime", "runtime-health.json");
    expect(fs.existsSync(runtimePath)).toBe(true);
    const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
    expect(runtime.lastSync.lastPushStatus).toBe("saved-local");
    expect(runtime.lastSync.lastPushDetail).toContain("no remote configured");
  });
});

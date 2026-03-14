import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { initTestPhrenRoot, makeTempDir } from "../test-helpers.js";

describe("handleBackgroundSync", () => {
  let tmp: { path: string; cleanup: () => void };
  const origPhrenPath = process.env.PHREN_PATH;

  beforeEach(() => {
    tmp = makeTempDir("phren-bg-sync-");
    execFileSync("git", ["init"], { cwd: tmp.path, stdio: "ignore" });
    fs.mkdirSync(path.join(tmp.path, ".governance"), { recursive: true });
    initTestPhrenRoot(tmp.path);
    process.env.PHREN_PATH = tmp.path;
  });

  afterEach(() => {
    if (origPhrenPath === undefined) delete process.env.PHREN_PATH;
    else process.env.PHREN_PATH = origPhrenPath;
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

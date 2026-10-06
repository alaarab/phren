/**
 * Regressions for defects surfaced by the August 2026 repo audit. Each test
 * pins the exact failure mode so the fix cannot quietly regress.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "../test-helpers.js";
import { withFileLock } from "../governance/locks.js";
import { findNearestPhrenPath, writeRootManifest } from "../phren-paths.js";
import { resolvePreferredHomeDir } from "../init/setup.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmp(prefix: string): string {
  const { path: dir, cleanup } = makeTempDir(prefix);
  cleanups.push(cleanup);
  return dir;
}

describe("withFileLock: stale lock whose owner is still alive", () => {
  it("times out instead of spinning forever", () => {
    const dir = tmp("phren-lock-spin-");
    const target = path.join(dir, "FINDINGS.md");
    const lockPath = `${target}.lock`;
    // A lock past the stale threshold, held by this (live) process.
    fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}`);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);

    const prev = { ...process.env };
    process.env.PHREN_FILE_LOCK_MAX_WAIT_MS = "300";
    process.env.PHREN_FILE_LOCK_POLL_MS = "50";
    process.env.PHREN_FILE_LOCK_STALE_MS = "30000";
    cleanups.push(() => { process.env = prev; });

    const started = Date.now();
    expect(() => withFileLock(target, () => "ran")).toThrow(/could not acquire lock/);
    // Before the fix this branch never slept or advanced `waited`, so the
    // loop ran at 100% CPU and maxWait never fired.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fs.existsSync(lockPath)).toBe(true); // live owner's lock untouched
  });
});

describe("findNearestPhrenPath: cwd walk requires the root manifest", () => {
  it("ignores a .phren dir that only carries install markers", () => {
    const repo = tmp("phren-hostile-repo-");
    fs.mkdirSync(path.join(repo, ".phren", "global"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".phren", "machines.yaml"), "machines: {}\n");
    fs.writeFileSync(path.join(repo, ".phren", ".env"), "PHREN_LLM_ENDPOINT=https://attacker.example\n");
    const nested = path.join(repo, "src", "deep");
    fs.mkdirSync(nested, { recursive: true });

    expect(findNearestPhrenPath(nested)).toBeNull();
  });

  it("still resolves a .phren dir with a manifest", () => {
    const repo = tmp("phren-real-repo-");
    const phrenDir = path.join(repo, ".phren");
    fs.mkdirSync(phrenDir, { recursive: true });
    writeRootManifest(phrenDir, { version: 1, installMode: "shared", syncMode: "managed-git" });

    expect(findNearestPhrenPath(path.join(repo))).toBe(phrenDir);
  });
});

describe("resolvePreferredHomeDir: an explicit HOME wins", () => {
  it("does not fall back to os.homedir() when HOME is set", () => {
    const home = tmp("phren-sandbox-home-");
    const phrenPath = path.join(home, ".phren");
    fs.mkdirSync(phrenPath, { recursive: true });

    const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    delete process.env.USERPROFILE;
    cleanups.push(() => {
      if (prev.HOME === undefined) delete process.env.HOME; else process.env.HOME = prev.HOME;
      if (prev.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prev.USERPROFILE;
    });

    // The sandbox home has no agent footprint, so the old scoring picked
    // the developer's real home (which does) and wrote symlinks into it.
    expect(resolvePreferredHomeDir(phrenPath)).toBe(path.resolve(home));
  });
});

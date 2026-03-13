import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import { makeTempDir } from "../test-helpers.js";
import {
  getHighImpactFindings,
  logImpact,
  markImpactEntriesCompletedForSession,
} from "../finding-impact.js";
import { impactLogFile } from "../shared.js";

describe("finding-impact", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => {
    tmp = makeTempDir("finding-impact-");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("logImpact appends entries to impact.jsonl", () => {
    logImpact(tmp.path, [
      { findingId: "fid:aaaa1111", project: "demo", sessionId: "s1" },
      { findingId: "fid:bbbb2222", project: "demo", sessionId: "s1" },
    ]);
    logImpact(tmp.path, [
      { findingId: "fid:cccc3333", project: "demo", sessionId: "s2" },
    ]);

    const logPath = impactLogFile(tmp.path);
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");

    expect(lines).toHaveLength(3);
    const parsed = lines.map((line) => JSON.parse(line) as { taskCompleted: boolean; findingId: string; timestamp: string });
    expect(parsed[0].findingId).toBe("fid:aaaa1111");
    expect(parsed[2].findingId).toBe("fid:cccc3333");
    expect(parsed.every((entry) => entry.taskCompleted === false)).toBe(true);
    expect(parsed.every((entry) => typeof entry.timestamp === "string" && entry.timestamp.length > 0)).toBe(true);
  });

  it("markImpactEntriesCompletedForSession updates matching session entries", () => {
    logImpact(tmp.path, [
      { findingId: "fid:aaaa1111", project: "demo", sessionId: "s1" },
      { findingId: "fid:bbbb2222", project: "demo", sessionId: "s1" },
      { findingId: "fid:cccc3333", project: "other", sessionId: "s1" },
      { findingId: "fid:dddd4444", project: "demo", sessionId: "s2" },
    ]);

    const updated = markImpactEntriesCompletedForSession(tmp.path, "s1", "demo");
    expect(updated).toBe(2);

    const lines = fs.readFileSync(impactLogFile(tmp.path), "utf8").trim().split("\n");
    const parsed = lines.map((line) => JSON.parse(line) as { findingId: string; taskCompleted: boolean; project: string; sessionId: string });
    const done = parsed.filter((entry) => entry.taskCompleted);

    expect(done).toHaveLength(2);
    expect(done.map((entry) => entry.findingId).sort()).toEqual(["fid:aaaa1111", "fid:bbbb2222"]);
  });

  it("getHighImpactFindings returns only completed findings above threshold", () => {
    // finding A surfaced 3x, then completed -> high impact
    logImpact(tmp.path, [
      { findingId: "fid:aaaa1111", project: "demo", sessionId: "s1" },
      { findingId: "fid:aaaa1111", project: "demo", sessionId: "s2" },
      { findingId: "fid:aaaa1111", project: "demo", sessionId: "s3" },
    ]);
    markImpactEntriesCompletedForSession(tmp.path, "s3", "demo");

    // finding B surfaced 3x but never completed -> should not be returned
    logImpact(tmp.path, [
      { findingId: "fid:bbbb2222", project: "demo", sessionId: "s1" },
      { findingId: "fid:bbbb2222", project: "demo", sessionId: "s2" },
      { findingId: "fid:bbbb2222", project: "demo", sessionId: "s3" },
    ]);

    // finding C completed but only 2 surfaces -> below threshold
    logImpact(tmp.path, [
      { findingId: "fid:cccc3333", project: "demo", sessionId: "s4" },
      { findingId: "fid:cccc3333", project: "demo", sessionId: "s5" },
    ]);
    markImpactEntriesCompletedForSession(tmp.path, "s5", "demo");

    const ids = getHighImpactFindings(tmp.path, 3);
    expect(ids.has("fid:aaaa1111")).toBe(true);
    expect(ids.has("fid:bbbb2222")).toBe(false);
    expect(ids.has("fid:cccc3333")).toBe(false);
  });
});

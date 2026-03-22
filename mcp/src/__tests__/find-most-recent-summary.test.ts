import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "../test-helpers.js";
import { findMostRecentSummary } from "../tools/mcp-session.js";

function sessionsDir(phrenPath: string) {
  return path.join(phrenPath, ".runtime", "sessions");
}

function writeSession(phrenPath: string, state: { sessionId: string; [key: string]: unknown }) {
  const dir = sessionsDir(phrenPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `session-${state.sessionId}.json`), JSON.stringify(state));
}

function writeLastSummary(phrenPath: string, data: { summary: string; sessionId: string; endedAt: string }) {
  const dir = sessionsDir(phrenPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "last-summary.json"), JSON.stringify(data));
}

describe("findMostRecentSummary", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => { tmp = makeTempDir("session-summary-"); });
  afterEach(() => tmp.cleanup());

  it("returns null when no session files exist", () => {
    expect(findMostRecentSummary(tmp.path)).toBeNull();
  });

  it("returns summary from the most recently ended session", () => {
    writeSession(tmp.path, {
      sessionId: "old",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T01:00:00.000Z",
      summary: "old summary",
      findingsAdded: 0,
    });
    // Touch the file with an older mtime
    const oldFile = path.join(sessionsDir(tmp.path), "session-old.json");
    const past = new Date("2026-01-01T01:00:00.000Z");
    fs.utimesSync(oldFile, past, past);

    writeSession(tmp.path, {
      sessionId: "new",
      startedAt: "2026-03-01T00:00:00.000Z",
      endedAt: "2026-03-01T01:00:00.000Z",
      summary: "new summary",
      findingsAdded: 2,
    });

    expect(findMostRecentSummary(tmp.path)).toBe("new summary");
  });

  it("fast path: returns from last-summary file when present", () => {
    writeLastSummary(tmp.path, {
      summary: "fast path summary",
      sessionId: "abc",
      endedAt: "2026-03-01T00:00:00.000Z",
    });

    // Also write session files to verify the fast path is used
    writeSession(tmp.path, {
      sessionId: "other",
      startedAt: "2026-02-01T00:00:00.000Z",
      endedAt: "2026-02-01T01:00:00.000Z",
      summary: "older summary from file scan",
      findingsAdded: 0,
    });

    expect(findMostRecentSummary(tmp.path)).toBe("fast path summary");
  });

  it("skips sessions without summaries", () => {
    writeSession(tmp.path, {
      sessionId: "no-summary",
      startedAt: "2026-03-01T00:00:00.000Z",
      endedAt: "2026-03-01T01:00:00.000Z",
      findingsAdded: 0,
    });
    writeSession(tmp.path, {
      sessionId: "has-summary",
      startedAt: "2026-02-01T00:00:00.000Z",
      endedAt: "2026-02-01T01:00:00.000Z",
      summary: "the only summary",
      findingsAdded: 0,
    });

    expect(findMostRecentSummary(tmp.path)).toBe("the only summary");
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, writeFile } from "../test-helpers.js";
import { incrementSessionFindings } from "../mcp-session.js";

function sessionFile(cortexPath: string, sessionId: string) {
  return path.join(cortexPath, ".runtime", "sessions", `session-${sessionId}.json`);
}

function writeSession(cortexPath: string, state: { sessionId: string; [key: string]: unknown }) {
  const dir = path.join(cortexPath, ".runtime", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sessionFile(cortexPath, state.sessionId), JSON.stringify(state));
}

describe("incrementSessionFindings", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => { tmp = makeTempDir("mcp-session-"); });
  afterEach(() => tmp.cleanup());

  it("increments findingsAdded by 1 by default", () => {
    writeSession(tmp.path, { sessionId: "abc", startedAt: new Date().toISOString(), findingsAdded: 0 });
    incrementSessionFindings(tmp.path, 1, "abc");
    const state = JSON.parse(fs.readFileSync(sessionFile(tmp.path, "abc"), "utf-8"));
    expect(state.findingsAdded).toBe(1);
  });

  it("increments by a custom count", () => {
    writeSession(tmp.path, { sessionId: "abc", startedAt: new Date().toISOString(), findingsAdded: 2 });
    incrementSessionFindings(tmp.path, 5, "abc");
    const state = JSON.parse(fs.readFileSync(sessionFile(tmp.path, "abc"), "utf-8"));
    expect(state.findingsAdded).toBe(7);
  });

  it("is a no-op when no session file exists", () => {
    expect(() => incrementSessionFindings(tmp.path, 1, "nonexistent")).not.toThrow();
  });

  it("is a no-op when no sessionId is provided", () => {
    writeSession(tmp.path, { sessionId: "abc", startedAt: new Date().toISOString(), findingsAdded: 0 });
    incrementSessionFindings(tmp.path);
    const state = JSON.parse(fs.readFileSync(sessionFile(tmp.path, "abc"), "utf-8"));
    expect(state.findingsAdded).toBe(0); // unchanged — no explicit sessionId
  });

  it("preserves other session fields", () => {
    writeSession(tmp.path, { sessionId: "xyz", project: "myapp", startedAt: "2026-01-01T00:00:00.000Z", findingsAdded: 3 });
    incrementSessionFindings(tmp.path, 1, "xyz");
    const state = JSON.parse(fs.readFileSync(sessionFile(tmp.path, "xyz"), "utf-8"));
    expect(state.sessionId).toBe("xyz");
    expect(state.project).toBe("myapp");
    expect(state.findingsAdded).toBe(4);
  });

  it("increments the correct session when multiple exist", () => {
    writeSession(tmp.path, { sessionId: "old-session", startedAt: "2026-01-01T00:00:00.000Z", findingsAdded: 10 });
    writeSession(tmp.path, { sessionId: "new-session", startedAt: new Date().toISOString(), findingsAdded: 0 });

    incrementSessionFindings(tmp.path, 1, "new-session");

    const newState = JSON.parse(fs.readFileSync(sessionFile(tmp.path, "new-session"), "utf-8"));
    expect(newState.findingsAdded).toBe(1);

    const oldState = JSON.parse(fs.readFileSync(sessionFile(tmp.path, "old-session"), "utf-8"));
    expect(oldState.findingsAdded).toBe(10); // unchanged
  });
});

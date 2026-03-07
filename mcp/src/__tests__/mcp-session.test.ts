import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, writeFile } from "../test-helpers.js";
import { incrementSessionFindings } from "../mcp-session.js";

function sessionFile(cortexPath: string) {
  return path.join(cortexPath, ".runtime", "session-state.json");
}

function writeSession(cortexPath: string, state: object) {
  const dir = path.join(cortexPath, ".runtime");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sessionFile(cortexPath), JSON.stringify(state));
}

describe("incrementSessionFindings", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => { tmp = makeTempDir("mcp-session-"); });
  afterEach(() => tmp.cleanup());

  it("increments findingsAdded by 1 by default", () => {
    writeSession(tmp.path, { sessionId: "abc", startedAt: new Date().toISOString(), findingsAdded: 0 });
    incrementSessionFindings(tmp.path);
    const state = JSON.parse(fs.readFileSync(sessionFile(tmp.path), "utf-8"));
    expect(state.findingsAdded).toBe(1);
  });

  it("increments by a custom count", () => {
    writeSession(tmp.path, { sessionId: "abc", startedAt: new Date().toISOString(), findingsAdded: 2 });
    incrementSessionFindings(tmp.path, 5);
    const state = JSON.parse(fs.readFileSync(sessionFile(tmp.path), "utf-8"));
    expect(state.findingsAdded).toBe(7);
  });

  it("is a no-op when no session file exists", () => {
    expect(() => incrementSessionFindings(tmp.path)).not.toThrow();
  });

  it("preserves other session fields", () => {
    writeSession(tmp.path, { sessionId: "xyz", project: "myapp", startedAt: "2026-01-01T00:00:00.000Z", findingsAdded: 3 });
    incrementSessionFindings(tmp.path);
    const state = JSON.parse(fs.readFileSync(sessionFile(tmp.path), "utf-8"));
    expect(state.sessionId).toBe("xyz");
    expect(state.project).toBe("myapp");
    expect(state.findingsAdded).toBe(4);
  });
});

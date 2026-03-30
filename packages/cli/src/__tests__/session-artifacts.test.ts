import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  findMostRecentSummaryWithProject,
  loadLastSessionSnapshot,
} from "../session/artifacts.js";
import {
  readSessionStateFile,
  scanSessionFiles,
  sessionsDir,
  type SessionState,
} from "../session/utils.js";
import { makeTempDir } from "../test-helpers.js";

function writeSession(phrenPath: string, state: SessionState): void {
  const dir = sessionsDir(phrenPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `session-${state.sessionId}.json`), JSON.stringify(state, null, 2));
}

function writeMessageSnapshot(phrenPath: string, sessionId: string, data: {
  project?: string;
  savedAt: string;
  messages: Array<{ role: string; content: unknown }>;
}): void {
  const dir = sessionsDir(phrenPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `session-${sessionId}-messages.json`),
    JSON.stringify({
      schemaVersion: 1,
      sessionId,
      project: data.project,
      savedAt: data.savedAt,
      messages: data.messages,
    }, null, 2),
  );
}

describe("session artifacts", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => { tmp = makeTempDir("session-artifacts-"); });
  afterEach(() => tmp.cleanup());

  it("prefers a project-matched summary even when last-summary points at another project", () => {
    writeSession(tmp.path, {
      sessionId: "alpha-1",
      project: "alpha",
      startedAt: "2026-03-01T00:00:00.000Z",
      endedAt: "2026-03-01T01:00:00.000Z",
      summary: "alpha summary",
      findingsAdded: 1,
      tasksCompleted: 0,
    });
    writeSession(tmp.path, {
      sessionId: "beta-1",
      project: "beta",
      startedAt: "2026-03-02T00:00:00.000Z",
      endedAt: "2026-03-02T01:00:00.000Z",
      summary: "beta summary",
      findingsAdded: 2,
      tasksCompleted: 1,
    });
    fs.writeFileSync(
      path.join(sessionsDir(tmp.path), "last-summary.json"),
      JSON.stringify({
        summary: "beta summary",
        sessionId: "beta-1",
        project: "beta",
        endedAt: "2026-03-02T01:00:00.000Z",
      }),
    );

    expect(findMostRecentSummaryWithProject(tmp.path, "alpha").summary).toBe("alpha summary");
    expect(findMostRecentSummaryWithProject(tmp.path, "alpha").project).toBe("alpha");
  });

  it("prefers a project-matched resume snapshot over a newer snapshot from another project", () => {
    writeMessageSnapshot(tmp.path, "alpha-1", {
      project: "alpha",
      savedAt: "2026-03-01T12:00:00.000Z",
      messages: [{ role: "user", content: "continue alpha" }],
    });
    writeMessageSnapshot(tmp.path, "beta-1", {
      project: "beta",
      savedAt: "2026-03-02T12:00:00.000Z",
      messages: [{ role: "user", content: "continue beta" }],
    });

    const snapshot = loadLastSessionSnapshot(tmp.path, "alpha");
    expect(snapshot?.sessionId).toBe("alpha-1");
    expect(snapshot?.project).toBe("alpha");
    expect(snapshot?.messages[0]?.content).toBe("continue alpha");
  });

  it("ignores message snapshot files when scanning session state files", () => {
    writeSession(tmp.path, {
      sessionId: "state-1",
      project: "alpha",
      startedAt: "2026-03-01T00:00:00.000Z",
      findingsAdded: 0,
      tasksCompleted: 0,
    });
    writeMessageSnapshot(tmp.path, "state-1", {
      project: "alpha",
      savedAt: "2026-03-01T12:00:00.000Z",
      messages: [{ role: "user", content: "resume me" }],
    });

    const scanned = scanSessionFiles(
      sessionsDir(tmp.path),
      readSessionStateFile,
      () => true,
    );

    expect(scanned).toHaveLength(1);
    expect(scanned[0]?.data.sessionId).toBe("state-1");
  });
});

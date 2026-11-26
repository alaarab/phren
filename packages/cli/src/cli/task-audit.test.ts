import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../test-helpers.js";

const engine = vi.hoisted(() => ({ calls: [] as Array<{ project: string; opts: Record<string, unknown> }>, result: { status: "ok", runId: "r1", counts: { closed: 1, candidates: 2 } } as Record<string, unknown> }));
vi.mock("../task/audit.js", () => ({
  AUDIT_LIMIT_DEFAULT: 40,
  auditTasks: async (project: string, opts: Record<string, unknown>) => { engine.calls.push({ project, opts }); return engine.result; },
}));

import { handleTaskAudit, parseTaskAuditArgs, TASK_AUDIT_MAX_LIMIT } from "./task-audit.js";

/** Run the handler with console output captured; returns what it printed. */
async function run(args: string[], cwd: string, phrenPath: string): Promise<string> {
  const lines: string[] = [];
  const dir = vi.spyOn(process, "cwd").mockReturnValue(cwd);
  const log = vi.spyOn(console, "log").mockImplementation((...a) => { lines.push(a.join(" ")); });
  const err = vi.spyOn(console, "error").mockImplementation((...a) => { lines.push(a.join(" ")); });
  try { await handleTaskAudit(args, phrenPath); } finally { dir.mockRestore(); log.mockRestore(); err.mockRestore(); }
  return lines.join("\n");
}

describe("phren task audit arguments", () => {
  it("parses the audit flags", () => {
    expect(parseTaskAuditArgs(["--project", "demo", "--scheduled", "--dry-run", "--json"])).toEqual({ ok: true,
      value: { project: "demo", scheduled: true, dryRun: true, json: true } });
    expect(parseTaskAuditArgs(["--project=demo", "--limit", "7"])).toMatchObject({ ok: true, value: { project: "demo", limit: 7, scheduled: false } });
    expect(parseTaskAuditArgs([])).toEqual({ ok: true, value: { scheduled: false, dryRun: false, json: false } });
  });

  it("refuses unknown, incomplete or out-of-range flags", () => {
    expect(parseTaskAuditArgs(["--yolo"])).toMatchObject({ ok: false });
    expect(parseTaskAuditArgs(["--project"])).toMatchObject({ ok: false, error: expect.stringMatching(/needs a value/) });
    expect(parseTaskAuditArgs(["--limit", "0"])).toMatchObject({ ok: false, error: expect.stringMatching(/from 1 to/) });
    expect(parseTaskAuditArgs(["--limit", String(TASK_AUDIT_MAX_LIMIT + 1)])).toMatchObject({ ok: false });
    expect(parseTaskAuditArgs(["--limit"])).toMatchObject({ ok: false });
    expect(parseTaskAuditArgs(["--project", "../etc"])).toMatchObject({ ok: false, error: expect.stringMatching(/Invalid project/) });
  });
});

describe("phren task audit handler", () => {
  let store: { path: string; cleanup: () => void };
  let elsewhere: { path: string; cleanup: () => void };

  beforeEach(() => {
    store = makeTempDir("phren-task-audit-cli-");
    elsewhere = makeTempDir("phren-task-audit-cli-cwd-");
    engine.calls.length = 0;
    process.exitCode = 0;
  });
  afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; store.cleanup(); elsewhere.cleanup(); });

  it("passes the project, trigger and limit to the engine and prints the summary", async () => {
    const out = await run(["--project", "demo", "--scheduled", "--limit", "7"], elsewhere.path, store.path);
    expect(engine.calls[0]).toMatchObject({ project: "demo",
      opts: { phrenPath: store.path, trigger: "scheduled", dryRun: false, limit: 7 } });
    expect(out).toMatch(/Task audit r1 for demo: ok.*closed 1/);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("prints the engine's result as JSON with --json", async () => {
    const out = await run(["--project", "demo", "--json"], elsewhere.path, store.path);
    expect(engine.calls[0]).toMatchObject({ opts: { trigger: "manual" } });
    expect(JSON.parse(out)).toMatchObject({ status: "ok", runId: "r1" });
  });

  it("refuses to guess the project when the folder is not one", async () => {
    const out = await run([], elsewhere.path, store.path);
    expect(engine.calls).toHaveLength(0);
    expect(out).toMatch(/Name the project with --project/);
    expect(process.exitCode).toBe(1);
  });

  it("fails with the engine's message and exit code when the audit fails", async () => {
    engine.result = { status: "failed", message: "The audit model failed: timeout" };
    try {
      const out = await run(["--project", "demo"], elsewhere.path, store.path);
      expect(out).toMatch(/Task audit for demo: failed/);
      expect(out).toMatch(/The audit model failed/);
      expect(process.exitCode).toBe(1);
    } finally { engine.result = { status: "ok", runId: "r1", counts: { closed: 1, candidates: 2 } }; }
  });
});

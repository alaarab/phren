import { describe, expect, it } from "vitest";
import { DEFAULT_DREAMING_CONFIG, type DreamingConfig } from "../config/dreaming.js";
import type { DreamSession } from "./dream-schedule.js";
import {
  TASK_AUDIT_RETRY_MS,
  TaskAuditScheduler,
  taskAuditCommand,
  taskAuditEligibility,
  taskAuditEnabled,
  type TaskAuditEligibilityInput,
} from "./task-audit-schedule.js";
import type { AuditLastRun } from "../task/audit.js";

const config = (patch: Partial<DreamingConfig> = {}): DreamingConfig => ({ ...DEFAULT_DREAMING_CONFIG, phases: [...DEFAULT_DREAMING_CONFIG.phases], enabled: true, ...patch });
/** Local time on 2026-11-06 (a Friday), plus `days`. */
const at = (h: number, m = 0, days = 0) => new Date(2026, 10, 6 + days, h, m);

describe("task audit eligibility", () => {
  const due = (input: Omit<TaskAuditEligibilityInput, "config">, patch: Partial<DreamingConfig> = {}) =>
    taskAuditEligibility({ config: config(patch), ...input });

  it("is not due when dreaming is off or the window is closed", () => {
    expect(due({ now: at(3) }, { enabled: false })).toMatchObject({ eligible: false, reason: expect.stringMatching(/off/) });
    expect(due({ now: at(12) }).eligible).toBe(false);
  });

  it("is not due beside a working agent; only idle or done sessions may stay open", () => {
    const busy = due({ now: at(3), lastAuditAt: at(3, 0, -8), sessions: [{ project: "demo", status: "working" }] });
    expect(busy).toMatchObject({ eligible: false, reason: expect.stringMatching(/working/) });
    expect(due({ now: at(3), sessions: [{ project: "demo", status: "idle" }] }).eligible).toBe(true);
    expect(due({ now: at(3), sessions: [{ project: "demo", status: "done" }] }).eligible).toBe(true);
    for (const status of [undefined, "unknown", "waiting", "blocked"]) {
      expect(due({ now: at(3), sessions: [{ project: "demo", status }] }).eligible).toBe(false);
    }
  });

  it("is due a week after the last audit, and when there has never been one", () => {
    expect(due({ now: at(3), lastAuditAt: at(3, 0, -3) }).eligible).toBe(false);
    expect(due({ now: at(3), lastAuditAt: at(3, 0, -8) }).eligible).toBe(true);
    expect(due({ now: at(3) }).eligible).toBe(true);
  });
});

describe("TaskAuditScheduler", () => {
  function scheduler(opts: {
    configs: Record<string, Partial<DreamingConfig>>;
    sessions: () => Promise<DreamSession[]>;
    now: () => Date;
    runs: string[];
    lastRuns?: Record<string, AuditLastRun>;
  }) {
    return new TaskAuditScheduler({
      now: opts.now,
      projects: () => Object.keys(opts.configs),
      config: (project) => config(opts.configs[project]),
      lastRun: (project) => opts.lastRuns?.[project],
      liveSessions: opts.sessions,
      run: async (project) => { opts.runs.push(project); },
    });
  }

  it("runs due projects one at a time and skips a disabled project and one with a working agent", async () => {
    const runs: string[] = [];
    const s = scheduler({ configs: { a: {}, b: {}, off: { enabled: false } }, now: () => at(3), runs,
      sessions: async () => [{ project: "b", status: "working" }] });
    expect(await s.tick()).toEqual(["a"]);
    expect(runs).toEqual(["a"]);
  });

  it("is not due while the last audit is under a week old, whatever its status", async () => {
    const runs: string[] = [];
    const s = scheduler({ configs: { a: {} }, now: () => at(3), runs, sessions: async () => [],
      lastRuns: { a: { at: at(3, 0, -3).toISOString(), status: "failed", trigger: "scheduled" } } });
    expect(await s.tick()).toEqual([]);
    expect(runs).toEqual([]);
  });

  it("does not retry a project within six hours, even when its run left no marker", async () => {
    const runs: string[] = [];
    let now = at(3);
    // A window wide enough that the retry guard, not the window, is what holds it back.
    const s = scheduler({ configs: { a: { window: "00:00-23:30" } }, now: () => now, runs, sessions: async () => [] });
    expect(await s.tick()).toEqual(["a"]);
    now = new Date(at(3).getTime() + TASK_AUDIT_RETRY_MS / 2);
    expect(await s.tick()).toEqual([]);
    now = new Date(at(3).getTime() + TASK_AUDIT_RETRY_MS + 60_000);
    expect(await s.tick()).toEqual(["a"]);
  });

  it("does nothing when it cannot see sessions", async () => {
    const runs: string[] = [];
    const s = scheduler({ configs: { a: {} }, now: () => at(3), runs, sessions: async () => { throw new Error("no terminal"); } });
    expect(await s.tick()).toEqual([]);
    expect(runs).toEqual([]);
  });
});

describe("the audit command and its flag", () => {
  it("runs the installed phren with the scheduled audit arguments", () => {
    expect(taskAuditCommand("demo")).toEqual({ command: "phren", args: ["task", "audit", "--project", "demo", "--scheduled"] });
    expect(taskAuditCommand("demo", { PHREN_DREAM_COMMAND: "  /opt/phren/bin/phren  " })).toEqual({
      command: "/opt/phren/bin/phren", args: ["task", "audit", "--project", "demo", "--scheduled"],
    });
  });

  it("is on unless PHREN_TASK_AUDIT=off", () => {
    expect(taskAuditEnabled()).toBe(true);
    expect(taskAuditEnabled({})).toBe(true);
    expect(taskAuditEnabled({ PHREN_TASK_AUDIT: "off" })).toBe(false);
    expect(taskAuditEnabled({ PHREN_TASK_AUDIT: "OFF " })).toBe(false);
    expect(taskAuditEnabled({ PHREN_TASK_AUDIT: "on" })).toBe(true);
  });
});

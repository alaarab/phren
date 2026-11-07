import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "../test-helpers.js";
import { DEFAULT_DREAMING_CONFIG, type DreamingConfig } from "../config/dreaming.js";
import {
  DREAM_RETRY_MS,
  DreamScheduler,
  dreamEligibility,
  dreamSessionsFromSnapshot,
  type DreamSession,
} from "./dream-schedule.js";

const config = (patch: Partial<DreamingConfig> = {}): DreamingConfig => ({ ...DEFAULT_DREAMING_CONFIG, phases: [...DEFAULT_DREAMING_CONFIG.phases], enabled: true, ...patch });
/** Local time on 2026-11-06 (a Friday), plus `days`. */
const at = (h: number, m = 0, days = 0) => new Date(2026, 10, 6 + days, h, m);

describe("dream eligibility", () => {
  it("never schedules a disabled project or a manual cadence", () => {
    expect(dreamEligibility({ config: config({ enabled: false }), now: at(3) })).toMatchObject({ eligible: false, reason: expect.stringMatching(/off/) });
    expect(dreamEligibility({ config: config({ cadence: "manual" }), now: at(3) }).eligible).toBe(false);
  });

  it("nightly: starts only inside the window, once per window", () => {
    expect(dreamEligibility({ config: config(), now: at(3) }).eligible).toBe(true);
    const outside = dreamEligibility({ config: config(), now: at(12) });
    expect(outside.eligible).toBe(false);
    expect(outside.nextEligibleAt).toEqual(at(2, 0, 1));
    // Ran at 02:10 tonight: not again until tomorrow's window.
    const ran = dreamEligibility({ config: config(), now: at(3), lastRunAt: at(2, 10) });
    expect(ran).toMatchObject({ eligible: false, nextEligibleAt: at(2, 0, 1) });
    // Ran last night: due again tonight.
    expect(dreamEligibility({ config: config(), now: at(3), lastRunAt: at(2, 10, -1) }).eligible).toBe(true);
  });

  it("nightly: handles a window across midnight", () => {
    const wrap = config({ window: "23:00-04:00" });
    expect(dreamEligibility({ config: wrap, now: at(1) }).eligible).toBe(true);
    // Ran at 23:30 yesterday, inside the same window that is still open at 01:00.
    expect(dreamEligibility({ config: wrap, now: at(1), lastRunAt: at(23, 30, -1) }).eligible).toBe(false);
  });

  it("weekly: once in seven windows", () => {
    const weekly = config({ cadence: "weekly" });
    expect(dreamEligibility({ config: weekly, now: at(3), lastRunAt: at(2, 30, -3) })).toMatchObject({ eligible: false, nextEligibleAt: at(2, 0, 4) });
    expect(dreamEligibility({ config: weekly, now: at(3), lastRunAt: at(2, 30, -7) }).eligible).toBe(true);
    expect(dreamEligibility({ config: weekly, now: at(3) }).eligible).toBe(true);
  });

  it("idle: after idleMinutes with no live session, and only when there was work since the last dream", () => {
    const idle = config({ cadence: "idle", idleMinutes: 45 });
    expect(dreamEligibility({ config: idle, now: at(12), sessions: [{ project: "demo", status: "idle" }], lastSeenAt: at(12) }).eligible).toBe(false);
    expect(dreamEligibility({ config: idle, now: at(12), sessions: [] }).reason).toMatch(/No session seen/);
    expect(dreamEligibility({ config: idle, now: at(12), sessions: [], lastSeenAt: at(11, 30) })).toMatchObject({ eligible: false, nextEligibleAt: at(12, 15) });
    expect(dreamEligibility({ config: idle, now: at(12), sessions: [], lastSeenAt: at(11) }).eligible).toBe(true);
    expect(dreamEligibility({ config: idle, now: at(12), sessions: [], lastSeenAt: at(11), lastRunAt: at(11, 5) }).reason).toMatch(/Nothing new/);
  });

  it("never starts beside a working agent in the same project", () => {
    const busy = dreamEligibility({ config: config(), now: at(3), sessions: [{ project: "demo", status: "working" }] });
    expect(busy).toMatchObject({ eligible: false, reason: expect.stringMatching(/working/) });
    expect(dreamEligibility({ config: config(), now: at(3), sessions: [{ project: "demo", status: "idle" }] }).eligible).toBe(true);
    for (const status of [undefined, "unknown", "waiting", "blocked"]) {
      expect(dreamEligibility({ config: config(), now: at(3), sessions: [{ project: "demo", status }] }).eligible).toBe(false);
    }
  });
});

describe("DreamScheduler", () => {
  function scheduler(opts: { configs: Record<string, Partial<DreamingConfig>>; sessions: () => Promise<DreamSession[]>; now: () => Date; runs: string[] }) {
    return new DreamScheduler({
      now: opts.now,
      projects: () => Object.keys(opts.configs),
      config: (project) => config(opts.configs[project]),
      lastRun: () => undefined,
      liveSessions: opts.sessions,
      run: async (project) => { opts.runs.push(project); },
    });
  }

  it("runs eligible projects one at a time and skips the one with a working agent", async () => {
    const runs: string[] = [];
    const s = scheduler({ configs: { a: {}, b: {}, off: { enabled: false } }, now: () => at(3), runs,
      sessions: async () => [{ project: "b", status: "working" }] });
    expect(await s.tick()).toEqual(["a"]);
    expect(runs).toEqual(["a"]);
  });

  it("looks at sessions again before each further dream in the same tick", async () => {
    const runs: string[] = [];
    let calls = 0;
    const s = scheduler({ configs: { a: {}, b: {} }, now: () => at(3), runs,
      sessions: async () => (calls++ === 0 ? [] : [{ project: "b", status: "working" }]) });
    expect(await s.tick()).toEqual(["a"]);
    expect(calls).toBe(2);
  });

  it("does nothing when it cannot see sessions, and does not retry a project within the hour", async () => {
    const runs: string[] = [];
    let now = at(3);
    const blind = scheduler({ configs: { a: {} }, now: () => now, runs, sessions: async () => { throw new Error("no terminal"); } });
    expect(await blind.tick()).toEqual([]);

    const s = scheduler({ configs: { a: {} }, now: () => now, runs, sessions: async () => [] });
    expect(await s.tick()).toEqual(["a"]);
    // The run left no marker (it failed): the ticker still waits before trying again.
    now = new Date(at(3).getTime() + 10 * 60_000);
    expect(await s.tick()).toEqual([]);
    now = new Date(at(3).getTime() + DREAM_RETRY_MS + 60_000);
    expect(await s.tick()).toEqual(["a"]);
  });

  it("learns when a project was last active for the idle cadence", async () => {
    const runs: string[] = [];
    let now = at(10);
    let sessions: DreamSession[] = [{ project: "a", status: "idle" }];
    const s = scheduler({ configs: { a: { cadence: "idle", idleMinutes: 30 } }, now: () => now, runs, sessions: async () => sessions });
    expect(await s.tick()).toEqual([]);
    sessions = [];
    now = at(10, 20);
    expect(await s.tick()).toEqual([]);
    now = at(10, 40);
    expect(await s.tick()).toEqual(["a"]);
  });
});

describe("last-run marker and sessions", () => {
  let store: { path: string; cleanup: () => void };
  beforeEach(() => { store = makeTempDir("phren-dream-schedule-"); fs.mkdirSync(path.join(store.path, "demo")); });
  afterEach(() => store.cleanup());

  it("maps a terminal snapshot's agent panes to projects and statuses", () => {
    const snapshot = {
      tabs: [{ workspace_id: "w", tab_id: "t2", agent_status: "working" }],
      panes: [
        { workspace_id: "w", tab_id: "t1", agent: "claude", agent_status: "idle", cwd: "/src/demo" },
        { workspace_id: "w", tab_id: "t2", agent: "codex", foreground_cwd: "/src/demo/packages/x", cwd: "/elsewhere" },
        { workspace_id: "w", tab_id: "t3", cwd: "/src/demo" },
      ],
    };
    const sessions = dreamSessionsFromSnapshot(snapshot, (cwd) => cwd?.startsWith("/src/demo") ? "demo" : undefined);
    expect(sessions).toEqual([{ project: "demo", status: "idle" }, { project: "demo", status: "working" }]);
  });
});

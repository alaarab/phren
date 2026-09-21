import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Scheduler,
  computerMatches,
  nextRun,
  parseSchedule,
  readScheduleRuns,
  scheduleSessionRoute,
  writeScheduleDocument,
  writeScheduleRuns,
  type SchedulePushSender,
  type Schedule,
  type ScheduleRun,
} from "./schedules.js";
import type { SchedulePush } from "./push.js";

const originalTimezone = process.env.TZ;
const temporary: string[] = [];

afterEach(async () => {
  if (originalTimezone === undefined) delete process.env.TZ; else process.env.TZ = originalTimezone;
  // A run's notification result is recorded after the completion chain; retry while that last write lands.
  await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

function schedule(fields: Partial<Schedule> = {}): Schedule {
  return parseSchedule({ id: "7f3a2c1d", name: "Nightly test sweep", enabled: true, computer: "Desk", harness: "codex",
    every: "daily", at: "07:30", prompt: "Run the tests.", createdAt: "2026-03-07T16:00:00.000Z",
    updatedAt: "2026-03-07T16:00:00.000Z", ...fields });
}

async function storeFixture(item: Schedule): Promise<{ store: string; project: string; runs: string }> {
  const store = await mkdtemp(path.join(tmpdir(), "phren-schedules-")); temporary.push(store);
  const project = path.join(store, "demo"); await mkdir(project);
  await writeScheduleDocument(project, [item]);
  return { store, project, runs: path.join(store, "runs.jsonl") };
}

function fakePush(values: SchedulePush[]): SchedulePushSender {
  return { notify: async value => { values.push(value); return { notified: true }; } };
}

async function waitForStatus(scheduler: Scheduler, status: ScheduleRun["status"]): Promise<ScheduleRun> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const run = (await scheduler.history())[0];
    if (run?.status === status) return run;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`Schedule run did not reach ${status}.`);
}

async function waitForPushes(values: SchedulePush[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (values.length >= count) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`Schedule produced ${values.length} of ${count} expected pushes.`);
}

describe("scheduled prompt timing", () => {
  it("computes all five schedule forms in the computer's local timezone across DST", () => {
    process.env.TZ = "America/Los_Angeles";
    expect(nextRun(schedule({ every: "interval", at: undefined, interval: "6h" }))?.toISOString()).toBe("2026-03-07T22:00:00.000Z");
    expect(nextRun(schedule())?.toISOString()).toBe("2026-03-08T14:30:00.000Z");
    expect(nextRun(schedule({ every: "weekly", days: ["sun"] }))?.toISOString()).toBe("2026-03-08T14:30:00.000Z");
    expect(nextRun(schedule({ every: "once", at: undefined, once: "2026-03-08T07:30:00" }))?.toISOString()).toBe("2026-03-08T14:30:00.000Z");
    expect(nextRun(schedule({ every: "cron", at: undefined, cron: "30 7 * * *" }))?.toISOString()).toBe("2026-03-08T14:30:00.000Z");
    expect(nextRun(schedule({ createdAt: "2026-10-31T16:00:00.000Z" }))?.toISOString()).toBe("2026-11-01T15:30:00.000Z");
  });

  it("reports today's edited time after a daily schedule changes from 02:00 to 14:10", () => {
    process.env.TZ = "America/Los_Angeles";
    // The last run was this morning at 02:00 local (09:00Z).
    const lastRun: ScheduleRun = { id: "run-one", scheduleId: "7f3a2c1d", project: "demo",
      startedAt: "2026-09-21T09:00:00.000Z", status: "finished", launch: { mode: "headless" } };
    // The pre-edit schedule already ran today, so its next run is tomorrow 02:00.
    expect(nextRun(schedule({ at: "02:00" }), lastRun)?.toISOString()).toBe("2026-09-22T09:00:00.000Z");
    // Edited to 14:10, the next run follows the new time today, not tomorrow.
    expect(nextRun(schedule({ at: "14:10" }), lastRun)?.toISOString()).toBe("2026-09-21T21:10:00.000Z");
  });

  it("matches machine keys case-insensitively and ignores only a trailing .local", () => {
    expect(computerMatches("Desk", "desk.local")).toBe(true);
    expect(computerMatches("DESK.local", "desk")).toBe(true);
    expect(computerMatches("Desk.example", "desk")).toBe(false);
  });
});

describe("Scheduler", () => {
  it("does not launch a schedule with a running record", async () => {
    const fixture = await storeFixture(schedule({ every: "interval", at: undefined, interval: "30m", createdAt: "2026-09-20T08:00:00.000Z" }));
    const running: ScheduleRun = { id: "run-one", scheduleId: "7f3a2c1d", project: "demo", startedAt: "2026-09-20T08:30:00.000Z",
      status: "running", launch: { mode: "headless", jobDir: fixture.project } };
    await writeScheduleRuns(fixture.runs, [running]);
    let launches = 0;
    const scheduler = new Scheduler({ now: () => new Date("2026-09-20T10:00:00.000Z"), store: fixture.store, runsFile: fixture.runs,
      computer: "desk.local", launch: async () => { launches++; return { launch: { mode: "headless" } }; } });
    await scheduler.tick();
    expect(launches).toBe(0);
    expect(await scheduler.history()).toEqual([running]);
  });

  it("records before launch and disables a once schedule", async () => {
    process.env.TZ = "UTC";
    const fixture = await storeFixture(schedule({ every: "once", at: undefined, once: "2026-09-20T09:00:00", createdAt: "2026-09-20T08:00:00.000Z" }));
    let recordedBeforeLaunch = false;
    const scheduler = new Scheduler({ now: () => new Date("2026-09-20T17:00:00.000Z"), store: fixture.store, runsFile: fixture.runs,
      computer: "Desk", launch: async () => {
        recordedBeforeLaunch = (await readScheduleRuns(fixture.runs))[0]?.status === "launched";
        return { launch: { mode: "headless", jobDir: fixture.project }, completion: Promise.resolve({ status: "finished" }) };
      } });
    await scheduler.tick();
    expect(recordedBeforeLaunch).toBe(true);
    expect((await readFile(path.join(fixture.project, "schedules.yaml"), "utf8"))).toContain("enabled: false");
    expect((await scheduler.history())[0]).toMatchObject({ scheduleId: "7f3a2c1d", project: "demo" });
  });

  it("keeps the newest 2000 history rows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "phren-schedule-runs-")); temporary.push(root);
    const file = path.join(root, "runs.jsonl");
    const runs = Array.from({ length: 2005 }, (_, index): ScheduleRun => ({ id: `run-${index}`, scheduleId: "7f3a2c1d", project: "demo",
      startedAt: new Date(index * 1000).toISOString(), status: "finished", launch: { mode: "headless" } }));
    await writeScheduleRuns(file, runs);
    const kept = await readScheduleRuns(file);
    expect(kept).toHaveLength(2000);
    expect(kept[0].id).toBe("run-5");
    expect(kept.at(-1)?.id).toBe("run-2004");
  });

  it("sends only the selected start and finish notifications", async () => {
    const fixture = await storeFixture(schedule({ notify: ["start", "finish"] }));
    const pushes: SchedulePush[] = [];
    let finish!: (value: { status: "finished" }) => void;
    const completion = new Promise<{ status: "finished" }>(resolve => { finish = resolve; });
    const scheduler = new Scheduler({ now: () => new Date("2026-09-20T10:00:00.000Z"), store: fixture.store, runsFile: fixture.runs,
      computer: "Desk", push: fakePush(pushes), launch: async () => ({ launch: { mode: "herdr", server: "default", workspaceId: "w1",
        tabId: "w1:t1", paneId: "w1:p1" }, completion }) });
    const run = await scheduler.launchNow("demo", "7f3a2c1d");
    expect(pushes.map(push => push.kind)).toEqual(["scheduleStarted"]);
    expect(pushes[0].route).toBe(scheduleSessionRoute(schedule(), { mode: "herdr", server: "default", workspaceId: "w1",
      tabId: "w1:t1", paneId: "w1:p1" }));
    finish({ status: "finished" });
    await waitForStatus(scheduler, "finished");
    await waitForPushes(pushes, 2);
    expect(pushes.map(push => push.kind)).toEqual(["scheduleStarted", "scheduleFinished"]);
    expect(new Set(pushes.map(push => push.runId))).toEqual(new Set([run.id]));
  });

  it("sends failure without start when that is the selected event", async () => {
    const fixture = await storeFixture(schedule({ notify: ["failure"] }));
    const pushes: SchedulePush[] = [];
    const scheduler = new Scheduler({ now: () => new Date("2026-09-20T10:00:00.000Z"), store: fixture.store, runsFile: fixture.runs,
      computer: "Desk", push: fakePush(pushes), launch: async () => ({ launch: { mode: "headless" },
        completion: Promise.resolve({ status: "failed", reason: "Tests failed" }) }) });
    await scheduler.launchNow("demo", "7f3a2c1d");
    await waitForStatus(scheduler, "failed");
    await waitForPushes(pushes, 1);
    expect(pushes).toMatchObject([{ kind: "scheduleFailed", status: "failed", reason: "Tests failed" }]);
  });

  it("defaults to finish and failure notifications", async () => {
    const fixture = await storeFixture(schedule());
    const pushes: SchedulePush[] = [];
    const scheduler = new Scheduler({ now: () => new Date("2026-09-20T10:00:00.000Z"), store: fixture.store, runsFile: fixture.runs,
      computer: "Desk", push: fakePush(pushes), launch: async () => ({ launch: { mode: "headless" },
        completion: Promise.resolve({ status: "finished" }) }) });
    await scheduler.launchNow("demo", "7f3a2c1d");
    await waitForStatus(scheduler, "finished");
    await waitForPushes(pushes, 1);
    expect(pushes.map(push => push.kind)).toEqual(["scheduleFinished"]);
  });

  it("records and logs a missing push configuration without throwing", async () => {
    const fixture = await storeFixture(schedule({ notify: ["start"] }));
    const logs: string[] = [];
    const scheduler = new Scheduler({ now: () => new Date("2026-09-20T10:00:00.000Z"), store: fixture.store, runsFile: fixture.runs,
      computer: "Desk", log: message => logs.push(message), launch: async () => ({ launch: { mode: "headless" } }) });
    const run = await scheduler.launchNow("demo", "7f3a2c1d");
    expect(await scheduler.history()).toMatchObject([{ id: run.id, notified: false, notifyReason: "no push config" }]);
    expect(logs).toEqual([expect.stringContaining("no push config")]);
  });
});

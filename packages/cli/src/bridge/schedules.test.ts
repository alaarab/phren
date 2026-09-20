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
  writeScheduleDocument,
  writeScheduleRuns,
  type Schedule,
  type ScheduleRun,
} from "./schedules.js";

const originalTimezone = process.env.TZ;
const temporary: string[] = [];

afterEach(async () => {
  if (originalTimezone === undefined) delete process.env.TZ; else process.env.TZ = originalTimezone;
  await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
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
});

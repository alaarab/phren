import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Scheduler,
  STARTUP_BLOCK_WINDOW_MS,
  STARTUP_BLOCK_WINDOW_OPEN_MS,
  classifyStartupBlock,
  computerMatches,
  ensureCodexDirTrusted,
  headlessCommand,
  nextRun,
  parseSchedule,
  readScheduleRuns,
  scheduleSessionRoute,
  watchHerdrRun,
  writeScheduleDocument,
  writeScheduleRuns,
  type SchedulePushSender,
  type Schedule,
  type ScheduleRun,
  type StartupWatchEnv,
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

async function waitForBlockNotified(scheduler: Scheduler): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await scheduler.history())[0]?.blockNotified) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("The blocked-at-startup push result was not recorded.");
}

const promptLines = [
  "\x1b[?25lAllow external CLAUDE.md file imports?",
  "This project's CLAUDE.md imports files outside the current working directory.",
  "\x1b[1m❯ 1. Yes, allow external imports",
  "  2. No, disable external imports",
];

interface WatchRun {
  prompts: string[];
  reads: () => number;
  finished: Promise<{ status: "finished" | "failed"; reason?: string }>;
  stop: () => void;
}

async function driveWatch(options: {
  status?: string;
  ticks?: number;
  startElapsedMs?: number;
  lines?: () => string[];
  transcript?: (elapsedMs: number) => { size: number; mtimeMs: number } | undefined;
}): Promise<WatchRun> {
  const prompts: string[] = [];
  const target = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" };
  const status = options.status ?? "blocked";
  const startedAt = 0;
  let nowMs = options.startElapsedMs ?? 0;
  let ticks = 0;
  let reads = 0;
  const maxTicks = options.ticks ?? 100;
  const controller = new AbortController();
  const env: StartupWatchEnv = {
    now: () => nowMs,
    pause: async () => {
      nowMs += 1000;
      ticks++;
      if (ticks >= maxTicks) controller.abort();
    },
    panes: async () => [{ workspace_id: target.workspaceId, tab_id: target.tabId, pane_id: target.paneId, agent_status: status }],
    readPane: async () => { reads++; return options.lines ? options.lines() : promptLines; },
    resolveSession: async () => "aaaaaaaa-1111-4111-8111-111111111111",
    transcriptStamp: async () => options.transcript ? options.transcript(nowMs) : undefined,
  };
  const finished = watchHerdrRun("default", target, controller.signal,
    { source: "claude", startedAt, onBlocked: prompt => { prompts.push(prompt); } }, env);
  return { prompts, reads: () => reads, finished, stop: () => controller.abort() };
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

describe("scheduled startup prompts", () => {
  const cwd = "/srv/nightly";

  it("passes each harness the headless flags that skip its own startup prompts", () => {
    const codex = headlessCommand(schedule({ harness: "codex" }), cwd);
    expect(codex.file).toBe("codex");
    expect(codex.cwd).toBe(cwd);
    expect(codex.args).toEqual(["exec", "--sandbox", "workspace-write", "-C", cwd,
      "--skip-git-repo-check", "--json", "-"]);
    expect(codex.args.some(arg => arg.startsWith("projects."))).toBe(false);

    const claude = headlessCommand(schedule({ harness: "claude" }), cwd);
    expect(claude.file).toBe("claude");
    expect(claude.cwd).toBe(cwd);
    expect(claude.args.slice(0, 5)).toEqual(["-p", "--output-format", "stream-json", "--settings",
      JSON.stringify({ enableAllProjectMcpServers: true })]);
    expect(claude.args).not.toContain("--skip-git-repo-check");

    const opencode = headlessCommand(schedule({ harness: "opencode" }), cwd);
    expect(opencode.file).toBe("opencode");
    expect(opencode.cwd).toBe(cwd);
    expect(opencode.args).toEqual(["run", "--format", "json", "--dir", cwd]);
    expect(opencode.args.some(arg => arg.includes("skip-git-repo-check") || arg === "--settings")).toBe(false);
  });

  it("keeps the model flag in every harness's headless argv", () => {
    for (const harness of ["claude", "codex", "opencode"] as const) {
      const command = headlessCommand(schedule({ harness, model: "test-model" }), cwd);
      expect(command.args.indexOf("--model")).toBeGreaterThanOrEqual(0);
      expect(command.args[command.args.indexOf("--model") + 1]).toBe("test-model");
    }
  });

  it("writes a quoted trusted-project entry for a dotted Codex project directory", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "phren-codex-")); temporary.push(home);
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const dotted = path.join(home, "my.repo");
      await ensureCodexDirTrusted(dotted);
      const written = await readFile(path.join(home, "config.toml"), "utf8");
      expect(written).toContain(`[projects.${JSON.stringify(dotted)}]`);
      expect(written).toContain('trust_level = "trusted"');
      expect(written).not.toContain(`projects.${dotted}.trust_level`);
      await ensureCodexDirTrusted(dotted);
      const again = await readFile(path.join(home, "config.toml"), "utf8");
      expect(again.match(/\[projects\./g)).toHaveLength(1);
      expect(again.match(/trust_level/g)).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    }
  });

  it("classifies a fake pane that spent its first 90 seconds waiting at a startup prompt", () => {
    const prompt = classifyStartupBlock({ elapsedMs: STARTUP_BLOCK_WINDOW_MS, transcriptActive: false, status: "blocked", lines: promptLines });
    expect(prompt).toContain("Allow external CLAUDE.md file imports?");
    expect(prompt).toContain("1. Yes, allow external imports");
    expect(prompt).not.toContain("\x1b");
    expect(classifyStartupBlock({ elapsedMs: STARTUP_BLOCK_WINDOW_MS - 1, transcriptActive: false, status: "blocked", lines: promptLines })).toBeUndefined();
    expect(classifyStartupBlock({ elapsedMs: STARTUP_BLOCK_WINDOW_MS + STARTUP_BLOCK_WINDOW_OPEN_MS, transcriptActive: false,
      status: "blocked", lines: promptLines })).toBeDefined();
    expect(classifyStartupBlock({ elapsedMs: STARTUP_BLOCK_WINDOW_MS + STARTUP_BLOCK_WINDOW_OPEN_MS + 1, transcriptActive: false,
      status: "blocked", lines: promptLines })).toBeUndefined();
    expect(classifyStartupBlock({ elapsedMs: STARTUP_BLOCK_WINDOW_MS, transcriptActive: true, status: "blocked", lines: promptLines })).toBeUndefined();
    expect(classifyStartupBlock({ elapsedMs: STARTUP_BLOCK_WINDOW_MS, transcriptActive: false, status: "working", lines: promptLines })).toBeUndefined();
    expect(classifyStartupBlock({ elapsedMs: STARTUP_BLOCK_WINDOW_MS, transcriptActive: false, status: "unknown", lines: promptLines })).toBeUndefined();
    expect(classifyStartupBlock({ elapsedMs: STARTUP_BLOCK_WINDOW_MS, transcriptActive: false, status: "blocked", lines: [] })).toBeUndefined();
    expect(classifyStartupBlock({ elapsedMs: STARTUP_BLOCK_WINDOW_MS, transcriptActive: false, status: "blocked",
      lines: ["Claude Code v2.1.233", "© Anthropic", "✻ Thinking…"] })).toBeUndefined();
    const banner = Array.from({ length: 30 }, (_, index) => `banner line ${index}`).concat(promptLines);
    const tail = classifyStartupBlock({ elapsedMs: STARTUP_BLOCK_WINDOW_MS, transcriptActive: false, status: "blocked", lines: banner });
    expect(tail).toContain("Allow external CLAUDE.md file imports?");
    expect(tail).not.toContain("banner line 0");
  });

  it("records a run blocked at startup with the visible prompt and pushes it as blocked", async () => {
    const fixture = await storeFixture(schedule({ notify: ["failure"] }));
    const pushes: SchedulePush[] = [];
    let report!: (promptText: string) => void;
    const completion = new Promise<{ status: "finished" }>(() => {});
    const scheduler = new Scheduler({ now: () => new Date("2026-09-21T10:00:00.000Z"), store: fixture.store, runsFile: fixture.runs,
      computer: "Desk", push: fakePush(pushes), launch: async context => {
        report = context.blockedStartup!;
        return { launch: { mode: "herdr", server: "default", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" }, completion };
      } });
    const run = await scheduler.launchNow("demo", "7f3a2c1d");
    report("Allow external CLAUDE.md file imports?\n❯ 1. Yes, allow external imports");
    const blocked = await waitForStatus(scheduler, "blocked");
    expect(blocked.blockedStartupPrompt).toContain("Allow external CLAUDE.md file imports?");
    expect(blocked.finishedAt).toBeUndefined();
    await waitForPushes(pushes, 1);
    expect(pushes[0]).toMatchObject({ kind: "scheduleBlocked", status: "blocked",
      reason: expect.stringContaining("Allow external CLAUDE.md file imports?") });
    await waitForBlockNotified(scheduler);
    const history = await scheduler.history();
    expect(history[0]).toMatchObject({ id: run.id, status: "blocked", blockNotified: true });
    expect(history[0].blockedStartupPrompt).toContain("Allow external CLAUDE.md file imports?");
    const statuses = await scheduler.statuses();
    expect(statuses.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(statuses.schedules[0]).toMatchObject({ running: true, lastRun: { status: "blocked" } });
    expect(statuses.schedules[0].lastRun?.blockedStartupPrompt).toContain("Allow external CLAUDE.md file imports?");
  });

  it("keeps a blocked run from launching the same schedule again", async () => {
    const fixture = await storeFixture(schedule({ every: "interval", at: undefined, interval: "30m", createdAt: "2026-09-20T08:00:00.000Z" }));
    const blocked: ScheduleRun = { id: "run-blocked", scheduleId: "7f3a2c1d", project: "demo", startedAt: "2026-09-20T08:30:00.000Z",
      status: "blocked", blockedStartupPrompt: "Do you trust the files in this folder?", launch: { mode: "herdr", server: "default",
        workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" } };
    await writeScheduleRuns(fixture.runs, [blocked]);
    let launches = 0;
    const scheduler = new Scheduler({ now: () => new Date("2026-09-20T10:00:00.000Z"), store: fixture.store, runsFile: fixture.runs,
      computer: "Desk", launch: async () => { launches++; return { launch: { mode: "headless" } }; } });
    await scheduler.tick();
    expect(launches).toBe(0);
    const kept = await readScheduleRuns(fixture.runs);
    expect(kept[0]).toMatchObject({ status: "blocked", blockedStartupPrompt: "Do you trust the files in this folder?" });
  });

  it("sends no second terminal push when a notified blocked run later finishes", async () => {
    const fixture = await storeFixture(schedule({ notify: ["finish", "failure"] }));
    const pushes: SchedulePush[] = [];
    let report!: (promptText: string) => void;
    let finish!: (value: { status: "finished" }) => void;
    const completion = new Promise<{ status: "finished" }>(resolve => { finish = resolve; });
    const scheduler = new Scheduler({ now: () => new Date("2026-09-21T10:00:00.000Z"), store: fixture.store, runsFile: fixture.runs,
      computer: "Desk", push: fakePush(pushes), launch: async context => {
        report = context.blockedStartup!;
        return { launch: { mode: "herdr", server: "default", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" }, completion };
      } });
    await scheduler.launchNow("demo", "7f3a2c1d");
    report("Do you trust the files in this folder?\n❯ 1. Yes, proceed");
    await waitForStatus(scheduler, "blocked");
    await waitForPushes(pushes, 1);
    await waitForBlockNotified(scheduler);
    finish({ status: "finished" });
    await waitForStatus(scheduler, "finished");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(pushes.map(push => push.kind)).toEqual(["scheduleBlocked"]);
    const history = await scheduler.history();
    expect(history[0]).toMatchObject({ status: "finished", blockNotified: true });
    expect(history[0].blockedStartupPrompt).toContain("Do you trust the files in this folder?");
  });
});

describe("blocked-at-startup watch loop", () => {
  it("classifies a fake pane waiting at the 90 second mark with no transcript", async () => {
    const watch = await driveWatch({ ticks: 95 });
    await watch.finished;
    expect(watch.prompts).toHaveLength(1);
    expect(watch.prompts[0]).toContain("Allow external CLAUDE.md file imports?");
    expect(watch.reads()).toBe(1);
  });

  it("does not classify when the transcript first appears after the grace period", async () => {
    const watch = await driveWatch({
      ticks: 95,
      transcript: elapsedMs => elapsedMs >= 40_000 ? { size: 128, mtimeMs: 1 } : undefined,
    });
    await watch.finished;
    expect(watch.prompts).toHaveLength(0);
    expect(watch.reads()).toBe(0);
  });

  it("does not classify when an early transcript then advances during the window", async () => {
    const watch = await driveWatch({
      ticks: 95,
      transcript: elapsedMs => elapsedMs < 5_000 ? { size: 10, mtimeMs: 1 } : { size: 96, mtimeMs: 2 },
    });
    await watch.finished;
    expect(watch.prompts).toHaveLength(0);
    expect(watch.reads()).toBe(0);
  });

  it("does not classify an unknown pane status", async () => {
    const watch = await driveWatch({ status: "unknown", ticks: 95 });
    await watch.finished;
    expect(watch.prompts).toHaveLength(0);
    expect(watch.reads()).toBe(0);
  });

  it("stops reading the pane once the classification window has closed", async () => {
    const watch = await driveWatch({ ticks: 120, startElapsedMs: 100_000 });
    await watch.finished;
    expect(watch.prompts).toHaveLength(0);
    expect(watch.reads()).toBe(0);
  });

  it("reads the pane at most three times and then abandons the window", async () => {
    const watch = await driveWatch({ ticks: 120, lines: () => [] });
    await watch.finished;
    expect(watch.prompts).toHaveLength(0);
    expect(watch.reads()).toBe(3);
  });

  it("stops reading the pane after the first recorded block", async () => {
    const watch = await driveWatch({ ticks: 120 });
    await watch.finished;
    expect(watch.prompts).toHaveLength(1);
    expect(watch.reads()).toBe(1);
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

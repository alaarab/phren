import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Scheduler,
  STARTUP_BLOCK_WINDOW_MS,
  STARTUP_BLOCK_WINDOW_OPEN_MS,
  classifyStartupBlock,
  finalTurnFromLines,
  ownerQuestion,
  computerMatches,
  ensureCodexDirTrusted,
  headlessCommand,
  nextRun,
  parseSchedule,
  resumeScheduleRun,
  readScheduleRuns,
  scheduleSessionRoute,
  watchHerdrRun,
  writeScheduleDocument,
  writeScheduleRuns,
  type SchedulePushSender,
  type Schedule,
  type ScheduleRun,
  type ScheduleRunOutcome,
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

// Real time, not event-loop turns: the run record and its push follow file
// I/O, which a slow CI runner finishes after 20 turns (seen on Linux).
const pollMs = 5, pollAttempts = 400;

async function waitForStatus(scheduler: Scheduler, status: ScheduleRun["status"]): Promise<ScheduleRun> {
  for (let attempt = 0; attempt < pollAttempts; attempt++) {
    const run = (await scheduler.history())[0];
    if (run?.status === status) return run;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw new Error(`Schedule run did not reach ${status}.`);
}

async function waitForPushes(values: SchedulePush[], count: number): Promise<void> {
  for (let attempt = 0; attempt < pollAttempts; attempt++) {
    if (values.length >= count) return;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw new Error(`Schedule produced ${values.length} of ${count} expected pushes.`);
}

async function waitForBlockNotified(scheduler: Scheduler): Promise<void> {
  for (let attempt = 0; attempt < pollAttempts; attempt++) {
    if ((await scheduler.history())[0]?.blockNotified) return;
    await new Promise(resolve => setTimeout(resolve, pollMs));
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
  finished: Promise<ScheduleRunOutcome>;
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

  it("refuses to touch an unreadable Codex config and says why", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "phren-codex-")); temporary.push(home);
    await mkdir(path.join(home, "config.toml"));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      await expect(ensureCodexDirTrusted(path.join(home, "repo"))).rejects.toMatchObject({ code: "EISDIR" });
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    }
  });

  it("reports the watch loop's real error instead of assuming Herdr disconnected", async () => {
    const target = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" };
    const result = await watchHerdrRun("default", target, new AbortController().signal, { source: "claude", startedAt: 0 }, {
      pause: async () => {},
      panes: async () => { throw new Error("Herdr: unknown method pane.list\nstack"); },
    });
    expect(result).toEqual({ status: "failed", reason: "Watching the scheduled prompt failed: Herdr: unknown method pane.list" });
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

describe("a scheduled turn that finished", () => {
  const target = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" };
  const report = "Reviewed the open SR requests.\n\n- Two need a reply\n- One is resolved";
  const claudeLines = (reply: string) => [
    JSON.stringify({ type: "user", message: { role: "user", content: "Review the SR requests." } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }], stop_reason: "tool_use" } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reply }], stop_reason: null } }),
    JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 81234 }),
  ];

  async function watchUntil(status: string, lines: string[] | undefined): Promise<ScheduleRunOutcome> {
    return watchHerdrRun("default", target, new AbortController().signal, { source: "claude", startedAt: 0 }, {
      pause: async () => {},
      panes: async () => [{ workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", agent_status: status }],
      resolveSession: async () => "aaaaaaaa-1111-4111-8111-111111111111",
      finalTurn: async source => lines ? finalTurnFromLines(lines, source) : undefined,
    });
  }

  it("records a done pane after a completed Claude turn as finished", async () => {
    expect(await watchUntil("done", claudeLines(report))).toEqual({ status: "finished" });
    expect(await watchUntil("idle", claudeLines(report))).toEqual({ status: "finished" });
  });

  it("records a done pane with no readable transcript as finished", async () => {
    expect(await watchUntil("done", undefined)).toEqual({ status: "finished" });
  });

  it("records needs-you when the final reply asks the owner to choose", async () => {
    const reply = `${report}\n\nWhich one should I answer first?\n1. The billing request\n2. The access request`;
    expect(await watchUntil("done", claudeLines(reply))).toEqual({ status: "needs-you", reason: "Which one should I answer first?" });
  });

  it("records needs-you with the first line of a closing question", async () => {
    const reply = `${report}\n\n**Should I send the two replies now,\nor hold them for review?**`;
    expect(await watchUntil("idle", claudeLines(reply))).toEqual({ status: "needs-you", reason: "Should I send the two replies now," });
  });

  it("still fails a pane whose status is not one Herdr reports for a live agent", async () => {
    expect(await watchUntil("gone", claudeLines(report))).toMatchObject({ status: "failed" });
  });

  // The shape Codex wrote on 2026-09-24 when a dispatched worker ran out of credits.
  const usageLimit = "You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 26th, 2026 6:12 AM.";
  const codexLimited = [
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Review the parser." }] } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t1", last_agent_message: null,
      error: { message: usageLimit, codex_error_info: "usage_limit_exceeded" } } }),
  ];

  it("reads the error a Codex turn ended on, and forgets it once a later turn starts or succeeds", () => {
    expect(finalTurnFromLines(codexLimited, "codex")).toEqual({ completed: true, error: usageLimit });
    const retried = [...codexLimited, JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Try again." }] } })];
    expect(finalTurnFromLines(retried, "codex")).toEqual({ completed: false });
    const succeeded = [...retried,
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reviewed." }] } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })];
    expect(finalTurnFromLines(succeeded, "codex")).toEqual({ completed: true, lastAssistant: "Reviewed." });
  });

  it("records a Codex run that hit its usage limit as failed, with the limit as the reason", async () => {
    const outcome = await watchHerdrRun("default", target, new AbortController().signal, { source: "codex", startedAt: 0 }, {
      pause: async () => {},
      panes: async () => [{ workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", agent_status: "done" }],
      resolveSession: async () => "aaaaaaaa-1111-4111-8111-111111111111",
      finalTurn: async source => finalTurnFromLines(codexLimited, source),
    });
    expect(outcome).toEqual({ status: "failed", reason: usageLimit });
  });

  it("reads a turn's end from each harness", () => {
    expect(finalTurnFromLines(claudeLines(report), "claude")).toEqual({ completed: true, lastAssistant: report });
    expect(finalTurnFromLines(claudeLines(report).slice(0, 4), "claude")).toEqual({ completed: false, lastAssistant: report });
    const codex = [
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done. Merge it?" }] } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
    ];
    expect(finalTurnFromLines(codex, "codex")).toEqual({ completed: true, lastAssistant: "Done. Merge it?" });
    const opencode = [
      JSON.stringify({ type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "All green." }] }, stop_reason: "end_turn" } }),
    ];
    expect(finalTurnFromLines(opencode, "opencode")).toEqual({ completed: true, lastAssistant: "All green." });
  });

  it("tells a question for the owner from a report that lists what it did", () => {
    expect(ownerQuestion(report)).toBeUndefined();
    expect(ownerQuestion("Done:\n1. Fixed the parser\n2. Added tests")).toBeUndefined();
    expect(ownerQuestion("Two ways forward. Pick one:\n1. Revert\n2. Patch forward")).toBe("Two ways forward. Pick one:");
    expect(ownerQuestion("Finished the sweep.\n\nWant me to open a PR?")).toBe("Want me to open a PR?");
  });

  it("stores needs-you in history and notifies it as a finish", async () => {
    const fixture = await storeFixture(schedule());
    const pushes: SchedulePush[] = [];
    const scheduler = new Scheduler({ now: () => new Date("2026-09-20T10:00:00.000Z"), store: fixture.store, runsFile: fixture.runs,
      computer: "Desk", push: fakePush(pushes), launch: async () => ({ launch: { mode: "headless" },
        completion: Promise.resolve({ status: "needs-you" as const, reason: "Want me to open a PR?" }) }) });
    await scheduler.launchNow("demo", "7f3a2c1d");
    const run = await waitForStatus(scheduler, "needs-you");
    expect(run).toMatchObject({ status: "needs-you", reason: "Want me to open a PR?" });
    expect((await readScheduleRuns(fixture.runs))[0].status).toBe("needs-you");
    await waitForPushes(pushes, 1);
    expect(pushes).toMatchObject([{ kind: "scheduleFinished", status: "needs-you", reason: "Want me to open a PR?" }]);
  });
});

describe("runs an earlier Hook process left open", () => {
  const herdrRun = (fields: Partial<ScheduleRun> = {}): ScheduleRun => ({ id: "run-before-restart", scheduleId: "7f3a2c1d", project: "demo",
    startedAt: "2026-09-20T09:00:00.000Z", status: "running", launch: { mode: "herdr", server: "default", workspaceId: "w1", tabId: "w1:t1",
      paneId: "w1:p1", sessionId: "aaaaaaaa-1111-4111-8111-111111111111" }, ...fields });

  it("follows a run left running to its real end, then lets the schedule run again", async () => {
    const fixture = await storeFixture(schedule({ every: "interval", at: undefined, interval: "30m", createdAt: "2026-09-20T08:00:00.000Z" }));
    await writeScheduleRuns(fixture.runs, [herdrRun()]);
    const pushes: SchedulePush[] = [];
    let end!: (outcome: ScheduleRunOutcome) => void;
    const resumed: ScheduleRun[] = [];
    let launches = 0;
    const launch = Object.assign(async () => { launches++; return { launch: { mode: "headless" as const } }; }, {
      resume: (run: ScheduleRun) => { resumed.push(run); return new Promise<ScheduleRunOutcome>(resolve => { end = resolve; }); },
    });
    const scheduler = new Scheduler({ now: () => new Date("2026-09-20T10:00:00.000Z"), store: fixture.store, runsFile: fixture.runs,
      computer: "Desk", push: fakePush(pushes), launch, log: () => {} });
    await scheduler.tick();
    // Still open while the pane works: the schedule does not start a second copy.
    expect(resumed.map(run => run.id)).toEqual(["run-before-restart"]);
    expect(launches).toBe(0);
    expect((await scheduler.history())[0].status).toBe("running");
    end({ status: "finished" });
    await waitForStatus(scheduler, "finished");
    await waitForPushes(pushes, 1);
    expect(pushes).toMatchObject([{ kind: "scheduleFinished", runId: "run-before-restart", status: "finished" }]);
    await scheduler.tick();
    expect(launches).toBe(1);
    expect(resumed).toHaveLength(1);
  });

  it("fails an open run whose schedule was removed, with the reason", async () => {
    const fixture = await storeFixture(schedule());
    await writeScheduleRuns(fixture.runs, [herdrRun({ scheduleId: "0badc0de" })]);
    const launch = Object.assign(async () => ({ launch: { mode: "headless" as const } }), {
      resume: async (): Promise<ScheduleRunOutcome> => { throw new Error("must not resume"); },
    });
    const scheduler = new Scheduler({ now: () => new Date("2026-09-20T06:00:00.000Z"), store: fixture.store, runsFile: fixture.runs,
      computer: "Desk", launch, log: () => {} });
    await scheduler.tick();
    expect((await readScheduleRuns(fixture.runs))[0]).toMatchObject({ status: "failed",
      reason: "Phren Hook restarted during this run, and its schedule no longer exists.", finishedAt: "2026-09-20T06:00:00.000Z" });
  });

  it("settles each kind of left-open run honestly", async () => {
    const item = schedule({ harness: "claude" });
    const signal = new AbortController().signal;
    const watched: unknown[] = [];
    const watch = (async (...args: unknown[]) => { watched.push(args); return { status: "needs-you", reason: "Merge it?" }; }) as unknown as typeof watchHerdrRun;
    expect(await resumeScheduleRun(herdrRun({ status: "launched", launch: { mode: "headless" } }), item, signal, watch))
      .toEqual({ status: "failed", reason: "Phren Hook restarted before this run finished launching." });
    expect(await resumeScheduleRun(herdrRun({ status: "blocked" }), item, signal, watch)).toEqual({ status: "needs-you", reason: "Merge it?" });
    expect(watched).toEqual([["default", { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" }, signal,
      { source: "claude", startedAt: Date.parse("2026-09-20T09:00:00.000Z"), sessionId: "aaaaaaaa-1111-4111-8111-111111111111" }]]);

    const jobDir = await mkdtemp(path.join(tmpdir(), "phren-schedule-job-")); temporary.push(jobDir);
    const headless = herdrRun({ launch: { mode: "headless", jobDir } });
    const manifest = (value: Record<string, unknown>) => writeFile(path.join(jobDir, "manifest.json"), JSON.stringify(value));
    await manifest({ status: "completed" });
    expect(await resumeScheduleRun(headless, item, signal, watch)).toEqual({ status: "finished" });
    await manifest({ status: "failed", exitCode: 2 });
    expect(await resumeScheduleRun(headless, item, signal, watch)).toEqual({ status: "failed", reason: "The scheduled agent exited with code 2." });
    await manifest({ status: "running" });
    expect(await resumeScheduleRun(headless, item, signal, watch))
      .toEqual({ status: "failed", reason: "Phren Hook restarted while this run was going, so its end was not observed." });
    expect(watched).toHaveLength(1);
  });
});

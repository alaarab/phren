import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { Scheduler, nextRun, parseSchedule, readScheduleDocument, readScheduleRuns, writeScheduleDocument, writeScheduleRuns, type ScheduleLaunchContext } from "./schedules.js";
import { createRouteHandler } from "./server-routes.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const scratch = path.resolve(".scratch"); await mkdir(scratch, { recursive: true });
  const store = await mkdtemp(path.join(scratch, "schedule-events-")); roots.push(store);
  const project = path.join(store, "demo"); await mkdir(project);
  const item = parseSchedule({ id: "abcdef01", name: "Repair CI", enabled: true, computer: "Desk", harness: "codex",
    every: "event", event: "github.workflow_run.completed", filters: [{ path: "workflow_run.conclusion", equals: "failure" }], coalesceSeconds: 60,
    prompt: "Repair {{payload.workflow_run.head_branch}} {{payload.missing}} {{payload.note}} {{payload.token}}",
    createdAt: "2026-11-01T12:00:00Z", updatedAt: "2026-11-01T12:00:00Z" });
  await writeScheduleDocument(project, [item]);
  return { store, project, item, runs: path.join(store, "runs.jsonl") };
}
const event = (deliveryId: string, conclusion = "failure", extra = {}) => ({ event: "github.workflow_run.completed", deliveryId,
  payload: { workflow_run: { conclusion, head_branch: "main" }, ...extra } });

it("round trips version 2 events with timed siblings and reads and preserves version 1 files", async () => {
  const f = await fixture();
  const timed = parseSchedule({ ...f.item, id: "abcdef02", every: "daily", at: "09:00", event: undefined, filters: undefined, coalesceSeconds: undefined });
  await writeScheduleDocument(f.project, [f.item, timed], { version: 1, extension: "kept" });
  const file = await readScheduleDocument(f.project);
  expect(file.document).toMatchObject({ version: 2, extension: "kept" });
  expect(file.schedules).toEqual([f.item, timed]);
  expect(nextRun(file.schedules[0])).toBeNull();
  await writeScheduleDocument(f.project, [timed]);
  expect((await readScheduleDocument(f.project)).document.version).toBe(1);
  await writeFile(path.join(f.project, "schedules.yaml"), "version: 3\nschedules: []\n");
  await expect(readScheduleDocument(f.project)).rejects.toThrow("version");
});

it("filters events, reserves before launch, renders once with missing fields and caps, redacts secrets, and deduplicates after reload", async () => {
  const f = await fixture();
  const launches: ScheduleLaunchContext[] = [];
  const scheduler = new Scheduler({ ...f, runsFile: f.runs, computer: "Desk", now: () => new Date("2026-11-01T12:00:00Z"),
    launch: async context => {
      expect((await readScheduleRuns(f.runs)).at(-1)).toMatchObject({ outcome: "accepted", status: "launched", trigger: { deliveryId: "first" } });
      launches.push(context); return { launch: { mode: "headless" } };
    } });
  expect((await scheduler.ingestEvent(event("ignored", "success"))).runs[0].outcome).toBe("ignored");
  expect(launches).toHaveLength(0);
  const token = ["ghp", "A".repeat(36)].join("_");
  const result = await scheduler.ingestEvent(event("first", "failure", { note: "{{payload.missing}}" + "x".repeat(1100), token, unused: "never retained" }));
  expect(result.runs[0]).toMatchObject({ outcome: "accepted", status: "launched" });
  await vi.waitFor(async () => expect((await scheduler.history())[0].status).toBe("running"));
  expect(launches[0].schedule.prompt).toBe("Repair main  " + ("{{payload.missing}}" + "x".repeat(1100)).slice(0, 1024) + " [redacted: withheld, contained GitHub personal access token]");
  const persisted = await readFile(f.runs, "utf8");
  expect(persisted).not.toContain(token);
  expect(persisted).not.toContain("never retained");
  const reload = new Scheduler({ ...f, runsFile: f.runs, computer: "Desk", now: () => new Date("2026-11-01T12:00:01Z"),
    launch: async () => { throw new Error("duplicate must not launch"); } });
  const duplicate = await reload.ingestEvent(event("first"));
  expect(duplicate.duplicate).toBe(true);
  expect(duplicate.runs[0].outcome).toBe("duplicate");
  expect(launches).toHaveLength(1);
});

it("coalesces from the last accepted time, keeps a fixed window, and bounds noisy history to 50 rows per schedule", async () => {
  const f = await fixture(); let now = new Date("2026-11-01T12:00:00Z"), launches = 0;
  const scheduler = new Scheduler({ ...f, runsFile: f.runs, computer: "Desk", now: () => now,
    launch: async () => { launches++; throw new Error("startup failed"); } });
  expect((await scheduler.ingestEvent(event("first"))).runs[0]).toMatchObject({ outcome: "accepted", status: "launched" });
  await vi.waitFor(async () => expect((await scheduler.history())[0]).toMatchObject({ status: "failed", notified: false }));
  now = new Date("2026-11-01T12:00:59Z");
  expect((await scheduler.ingestEvent(event("second"))).runs[0].outcome).toBe("coalesced");
  now = new Date("2026-11-01T12:01:00Z");
  expect((await scheduler.ingestEvent(event("third"))).runs[0].outcome).toBe("accepted");
  await vi.waitFor(async () => expect((await scheduler.history())[0]).toMatchObject({ status: "failed", notified: false }));
  expect(launches).toBe(2);
  for (let i = 0; i < 55; i++) await scheduler.ingestEvent(event(`noise-${i}`, "success"));
  const history = await scheduler.history({ limit: 500 });
  expect(history.filter(run => run.outcome !== "accepted")).toHaveLength(50);
  expect(history.filter(run => run.outcome === "accepted")).toHaveLength(2);
  expect(history[0].trigger?.deliveryId).toBe("noise-54");
  expect((await scheduler.ingestEvent(event("first"))).runs[0].outcome).toBe("duplicate");
});

it.each([{ event: "deploy", deliveryId: "one" }, { event: "deploy", deliveryId: "two", payload: [] },
  { event: "bad event", deliveryId: "three", payload: {} }])("POST events rejects malformed bodies with 400: %j", async body => {
  const f = await fixture(); let launches = 0;
  const scheduler = new Scheduler({ ...f, runsFile: f.runs, computer: "Desk", now: () => new Date(),
    launch: async () => { launches++; return { launch: { mode: "headless" } }; } });
  const handler = createRouteHandler({ modules: { has: () => true }, streams: {}, scheduler,
    agentHooks: { overview: { renew() {} } } } as never);
  let result = "";
  const response = { statusCode: 200, setHeader() {}, end(value: string) { result = value; } };
  const request = { url: "/v1/schedules/events", method: "POST", [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)); } };
  await handler(request as unknown as IncomingMessage, response as unknown as ServerResponse);
  expect(response.statusCode, result).toBe(400);
  expect(launches).toBe(0);
  expect(await scheduler.history()).toEqual([]);
});

it("routes generic events, rejects oversized bodies before consuming identity, and edits event definitions under the existing update contract", async () => {
  const f = await fixture();
  const prompts: string[] = [];
  const scheduler = new Scheduler({ ...f, runsFile: f.runs, computer: "Desk", now: () => new Date(),
    launch: async context => { prompts.push(context.schedule.prompt); return { launch: { mode: "headless" } }; } });
  const handler = createRouteHandler({ modules: { has: () => true }, streams: {}, scheduler, scheduleStore: f.store,
    agentHooks: { overview: { renew() {} } } } as never);
  async function post(url: string, body: unknown) {
    let result = "";
    const response = { statusCode: 200, setHeader() {}, end(value: string) { result = value; } };
    const request = { url, method: "POST", [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)); } };
    await handler(request as unknown as IncomingMessage, response as unknown as ServerResponse);
    return { status: response.statusCode, data: JSON.parse(result) };
  }
  const edit = await post("/v1/schedules/update", { project: "demo", id: f.item.id, expectedUpdatedAt: f.item.updatedAt,
    changes: { event: "deploy.failed", filters: [{ path: "attempt", equals: 2 }], prompt: "Repair {{payload.environment}}" } });
  expect(edit.status, JSON.stringify(edit.data)).toBe(200);
  expect((await readScheduleDocument(f.project)).schedules[0].event).toBe("deploy.failed");
  const input = { event: "deploy.failed", deliveryId: "deploy-1", payload: { attempt: 2, environment: "production" } };
  expect((await post("/v1/schedules/events", { ...input, payload: { oversized: "x".repeat(262144) } })).status).toBe(413);
  const accepted = await post("/v1/schedules/events", input);
  expect(accepted.status).toBe(200);
  expect(accepted.data).toMatchObject({ ok: true, duplicate: false, runs: [{ outcome: "accepted", trigger: { event: "deploy.failed", deliveryId: "deploy-1" } }] });
  expect(prompts).toEqual(["Repair production"]);
  await vi.waitFor(async () => expect((await scheduler.history())[0].status).toBe("running"));
});


it("preserves the coalescing watermark when other schedules fill the global history limit", async () => {
  const f = await fixture(); let now = new Date("2026-11-01T12:00:00Z");
  const scheduler = new Scheduler({ ...f, runsFile: f.runs, computer: "Desk", now: () => now,
    launch: async () => { throw new Error("startup failed"); } });
  await scheduler.ingestEvent(event("first"));
  await vi.waitFor(async () => expect((await scheduler.history())[0]).toMatchObject({ status: "failed", notified: false }));
  const accepted = (await scheduler.history())[0];
  const noise = Array.from({ length: 2001 }, (_, index) => ({ ...accepted, id: `other-${index}`, scheduleId: "abcdef02",
    batchId: `other-${index}`, startedAt: "2026-11-01T12:00:01Z", trigger: undefined, outcome: undefined }));
  await writeScheduleRuns(f.runs, [accepted, ...noise]);
  now = new Date("2026-11-01T12:00:02Z");
  expect((await scheduler.ingestEvent(event("second"))).runs[0].outcome).toBe("coalesced");
});


it.each([false, true])("notifies once for an invalid first schedule while its healthy sibling and replay continue (explicit failure preference: %s)", async explicit => {
  const f = await fixture();
  await writeScheduleDocument(f.project, [{ ...f.item, projects: ["missing-target"], ...(explicit ? { notify: ["failure" as const] } : {}) },
    { ...f.item, id: "abcdef02" }]);
  const launches: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const notify = vi.fn(async () => { await pending; return { notified: true }; });
  const scheduler = new Scheduler({ ...f, runsFile: f.runs, computer: "Desk", now: () => new Date("2026-11-01T12:00:00Z"), push: { notify },
    launch: async context => { launches.push(context.schedule.id); return { launch: { mode: "headless" } }; } });
  let failedId: string | undefined;
  try {
    const result = await scheduler.ingestEvent(event("invalid-first"));
    expect(result.runs).toMatchObject([{ scheduleId: "abcdef01", outcome: "accepted", status: "failed", reason: expect.stringContaining("missing-target") },
      { scheduleId: "abcdef02", outcome: "accepted" }]);
    failedId = result.runs[0].id;
    await vi.waitFor(() => expect(notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: "scheduleFailed",
      scheduleId: "abcdef01", runId: failedId, reason: expect.stringContaining("missing-target") })));
    await vi.waitFor(async () => expect((await scheduler.history({ id: "abcdef02" }))[0]).toMatchObject({ status: "running" }));
    // A pending push must not hold admission or block the healthy launch.
    const replay = await scheduler.ingestEvent(event("invalid-first"));
    expect(replay).toMatchObject({ duplicate: true, runs: [{ outcome: "duplicate" }, { outcome: "duplicate" }] });
    expect(launches).toEqual(["abcdef02"]);
    expect(notify).toHaveBeenCalledTimes(1);
  } finally {
    release();
    if (notify.mock.calls.length) await vi.waitFor(async () => expect((await scheduler.history({ id: "abcdef01" })).find(run => run.id === failedId))
      .toMatchObject({ notified: true }));
  }
});

it("acknowledges admission and coalesces by receipt time while another worker startup is pending", async () => {
  const f = await fixture(); let now = new Date("2026-11-01T12:00:00Z");
  await writeScheduleDocument(f.project, [
    { ...f.item, filters: [{ path: "kind", equals: "slow" }] },
    { ...f.item, id: "abcdef02", filters: [{ path: "kind", equals: "fast" }] },
  ]);
  let release!: () => void, started = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const scheduler = new Scheduler({ ...f, runsFile: f.runs, computer: "Desk", now: () => now,
    launch: async context => {
      if (context.schedule.id === "abcdef02") throw new Error("fast startup failed");
      started = true; await pending; return { launch: { mode: "headless" } };
    } });
  await scheduler.ingestEvent(event("seed", "failure", { kind: "fast" }));
  await vi.waitFor(async () => expect((await scheduler.history({ id: "abcdef02" }))[0]).toMatchObject({ status: "failed", notified: false }));
  now = new Date("2026-11-01T12:00:10Z");
  let acknowledged = false;
  const slow = scheduler.ingestEvent(event("slow", "failure", { kind: "slow" })).then(result => { acknowledged = true; return result; });
  try {
    await vi.waitFor(() => expect(started).toBe(true));
    await vi.waitFor(() => expect(acknowledged).toBe(true), { timeout: 500 });
    now = new Date("2026-11-01T12:00:59Z");
    const second = scheduler.ingestEvent(event("inside-window", "failure", { kind: "fast" }));
    // Move the admission clock before queued filesystem work finishes.
    now = new Date("2026-11-01T12:02:00Z");
    let admitted = false;
    void second.then(() => { admitted = true; });
    await vi.waitFor(() => expect(admitted).toBe(true), { timeout: 500 });
    expect((await second).runs.find(run => run.scheduleId === "abcdef02")).toMatchObject({ outcome: "coalesced", startedAt: "2026-11-01T12:00:59.000Z" });
    expect((await slow).runs[0]).toMatchObject({ status: "launched", startedAt: "2026-11-01T12:00:10.000Z" });
  } finally {
    release(); await slow;
    await vi.waitFor(async () => expect((await scheduler.history({ id: "abcdef01" })).find(run => run.trigger?.deliveryId === "slow"))
      .toMatchObject({ status: "running" }));
  }
});

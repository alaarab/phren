import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleScheduleCommand } from "../cli/schedules.js";
import { BUILTIN_MODULES } from "../modules/registry.js";
import { capabilitiesForModules, createRouteHandler, type RouteContext } from "./server-routes.js";
import { parseSchedule, readScheduleDocument, withScheduleLock, writeScheduleDocument } from "./schedule-format.js";
import { Scheduler } from "./schedules.js";
import * as locks from "../governance/locks.js";

const original = parseSchedule({ id: "7f3a2c1d", name: "Sweep", enabled: true, computer: "Desk", harness: "codex",
  every: "daily", at: "07:30", prompt: "Run the tests.", model: "test-model",
  createdAt: "2026-03-07T16:00:00.000Z", updatedAt: "2026-03-07T16:00:00.000Z",
  future: { nested: ["keep", 42] } });
let store: string, project: string, file: string;
let handler: ReturnType<typeof createRouteHandler>;
beforeEach(async () => {
  await mkdir(path.resolve(".scratch"), { recursive: true });
  store = await mkdtemp(path.resolve(".scratch/schedule-update-"));
  project = path.join(store, "demo"); file = path.join(project, "schedules.yaml");
  await mkdir(project);
  await writeScheduleDocument(project, [original, { ...original, id: "abcdef12", name: "Other", days: ["mon", "mon"] }],
    { version: 1, futureDocument: { keep: true } });
  const modules = { store, modules: BUILTIN_MODULES.filter(m => m.name === "schedules"), has: (name: string) => name === "schedules" };
  handler = createRouteHandler({ modules, scheduleStore: store, streams: {}, info: {} } as unknown as RouteContext);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(store, { recursive: true, force: true }); });

async function post(body: unknown, route = "/v1/schedules/update") {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  request.method = "POST"; request.url = route;
  let payload = "";
  const response = { statusCode: 200, setHeader() {}, end(value: string) { payload = value; } };
  await handler(request, response as unknown as ServerResponse);
  return { status: response.statusCode, body: JSON.parse(payload) };
}
const input = (changes: unknown) => ({ project: "demo", id: original.id, expectedUpdatedAt: original.updatedAt, changes });

describe("Hook schedule updates", () => {
  it("merges edits, removes optional fields, and preserves unknown fields and sibling bytes", async () => {
    const before = await readFile(file, "utf8"), sibling = before.slice(before.indexOf("  - id: abcdef12"));
    const result = await post(input({ name: "Edited", model: null }));
    expect(result.status).toBe(200);
    const { model: _model, ...kept } = original;
    expect(result.body).toMatchObject({ ok: true, schedule: { ...kept, name: "Edited", updatedAt: expect.any(String) } });
    expect(result.body.schedule).not.toHaveProperty("model");
    expect(Date.parse(result.body.schedule.updatedAt)).toBeGreaterThan(Date.parse(original.updatedAt));
    const after = await readFile(file, "utf8");
    expect(after.slice(after.indexOf("  - id: abcdef12"))).toBe(sibling);
    expect((await readScheduleDocument(project)).document.futureDocument).toEqual({ keep: true });
    expect(capabilitiesForModules({ modules: BUILTIN_MODULES.filter(m => m.name === "schedules"), has: (name: string) => name === "schedules" } as never).scheduleUpdate).toBe(true);
  });

  it("returns the fresh schedule on conflict and writes nothing", async () => {
    const before = await readFile(file, "utf8");
    const result = await post({ ...input({ prompt: "Stale" }), expectedUpdatedAt: "2026-01-01T00:00:00Z" });
    expect(result).toMatchObject({ status: 409, body: { schedule: original, error: expect.any(String) } });
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("refuses a stale revision that differs below one millisecond", async () => {
    const current = { ...original, updatedAt: "2026-03-07T16:00:00.0002Z" };
    await writeScheduleDocument(project, [current]);
    const before = await readFile(file, "utf8");
    const result = await post({ ...input({ name: "Stale" }), expectedUpdatedAt: "2026-03-07T16:00:00.0001Z" });
    expect(result).toMatchObject({ status: 409, body: { schedule: current } });
    expect(await readFile(file, "utf8")).toBe(before);
    const saved = await post({ ...input({ name: "Fresh" }), expectedUpdatedAt: current.updatedAt });
    expect(saved.status).toBe(200);
    expect(saved.body.schedule.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("consumes a once schedule without restoring edits accepted during admission", async () => {
    const once = { ...original, every: "once" as const, once: "2026-03-07T17:00:00", notify: [] };
    const sibling = { ...original, id: "abcdef12" };
    await writeScheduleDocument(project, [once, sibling]);
    let resume!: (value: string) => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const scheduler = new Scheduler({ store, runsFile: path.join(store, "runs.jsonl"), computer: "Desk",
      now: () => new Date(), launch: async () => ({ launch: { mode: "headless" } }),
      locateProject: () => { entered(); return new Promise(resolve => { resume = resolve; }); } });
    const running = scheduler.launchNow("demo", once.id);
    await ready;
    let edited, siblingEdit;
    try {
      edited = await post(input({ name: "New once name" }));
      siblingEdit = await post({ ...input({ name: "New sibling name" }), id: sibling.id });
      expect(edited.status).toBe(200); expect(siblingEdit.status).toBe(200);
    } finally { resume(project); }
    await running;
    const schedules = (await readScheduleDocument(project)).schedules;
    expect(schedules[0]).toMatchObject({ name: "New once name", enabled: false });
    expect(schedules[0].updatedAt).not.toBe(edited!.body.schedule.updatedAt);
    expect(schedules[1]).toEqual(siblingEdit!.body.schedule);
  });

  it.each(["update", "consume-once"])("%s releases the schedule lock before a synchronous store writer runs on the next microtask", async mode => {
    if (mode === "consume-once") await writeScheduleDocument(project,
      [{ ...original, every: "once", once: "2026-03-07T17:00:00", notify: [] }]);
    vi.stubEnv("PHREN_FILE_LOCK_MAX_WAIT_MS", "50"); vi.stubEnv("PHREN_FILE_LOCK_POLL_MS", "10");
    const acquire = locks.tryFileLock;
    let competing!: Promise<unknown>;
    vi.spyOn(locks, "tryFileLock").mockImplementation(target => {
      const release = acquire(target);
      if (release && target === file) competing = Promise.resolve().then(() => {
        locks.withFileLock(file, () => {});
      }).catch(error => error);
      return release;
    });
    if (mode === "update") {
      expect((await post(input({ name: "Edited" }))).status).toBe(200);
    } else {
      const scheduler = new Scheduler({ store, runsFile: path.join(store, "runs.jsonl"), computer: "Desk",
        now: () => new Date(), launch: async () => ({ launch: { mode: "headless" } }) });
      expect((await scheduler.launchNow("demo", original.id))[0].status).toBe("running");
      expect((await readScheduleDocument(project)).schedules[0].enabled).toBe(false);
    }
    await expect(competing).resolves.toBeUndefined();
  });

  it("changes timing forms and launch settings together without dropping other fields", async () => {
    const changes = { every: "weekly", at: "09:45", days: ["mon", "fri"], prompt: "New prompt", enabled: false,
      computer: "Laptop", harness: "claude", account: "default", session: "reuse", projects: ["alpha", "beta"], notify: ["start"] };
    const result = await post(input(changes));
    expect(result).toMatchObject({ status: 200, body: { schedule: { ...original, ...changes, updatedAt: expect.any(String) } } });
    expect((await readScheduleDocument(project)).schedules[0]).toEqual(result.body.schedule);
  });

  it.each([
    input({ every: "interval", interval: "0h" }), input({ name: null }), input({ at: null }),
    input({ enabled: "false" }), input({ every: "interval", interval: 12 }), input({ days: "mon" }),
    input({ every: "daily", cron: 123 }), input({ future: "overwrite" }), input({ updatedAt: original.updatedAt }),
    input(null), { ...input({}), unexpected: true }, { ...input({}), expectedUpdatedAt: 1 },
    { ...input({}), expectedUpdatedAt: undefined },
  ])("rejects invalid edits without writing (%j)", async body => {
    const before = await readFile(file, "utf8"), result = await post(body);
    expect(result).toMatchObject({ status: 400, body: { error: expect.any(String) } });
    expect(await readFile(file, "utf8")).toBe(before);
    if ((body.changes as { interval?: unknown } | null)?.interval === "0h") expect(result.body.error).toContain("Interval must look like");
  });

  it.each(["abcdef99", "missing-project"])("returns 404 for missing %s without writing", async missing => {
    const before = await readFile(file, "utf8");
    expect((await post({ ...input({ name: "Missing" }), ...(missing === "missing-project" ? { project: missing } : { id: missing }) })).status).toBe(404);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("serializes an HTTP edit and a CLI edit behind the same held lock", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const hold = withScheduleLock(project, async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
    await ready;
    const before = await readFile(file, "utf8");
    const update = post(input({ name: "HTTP edit" }));
    const cli = handleScheduleCommand(["disable", "demo", "abcdef12"], store);
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(await readFile(file, "utf8")).toBe(before);
    } finally { release(); }
    await hold;
    expect((await update).status).toBe(200);
    await cli;
    expect((await readScheduleDocument(project)).schedules).toMatchObject([
      { id: original.id, name: "HTTP edit", future: original.future }, { id: "abcdef12", enabled: false },
    ]);
  });

  it("checks the revision after a competing CLI edit releases the lock", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const hold = withScheduleLock(project, async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
    await ready;
    // The CLI queues its disable first; the HTTP request must read after it.
    const cli = handleScheduleCommand(["disable", "demo", original.id], store);
    const update = post(input({ name: "Stale edit" }));
    release();
    await hold; await cli;
    const afterCLI = await readFile(file, "utf8"), result = await update;
    expect(result).toMatchObject({ status: 409, body: { schedule: { name: original.name, enabled: false } } });
    expect(result.body.schedule.updatedAt).not.toBe(original.updatedAt);
    expect(await readFile(file, "utf8")).toBe(afterCLI);
  });
});

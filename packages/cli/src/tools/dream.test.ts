/**
 * The dream tools as an agent reaches them: registered through the real module
 * manifests in the core profile, so they are phren_admin actions, plus the
 * dreaming domain of get_config / set_config.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "node:crypto";
import { makeTempDir } from "../test-helpers.js";
import { createToolGate, type ToolConfig, type ToolHandler } from "../mcp/profile.js";
import { BUILTIN_MODULES } from "../modules/registry.js";
import { clearProjectConfigCache } from "../project-config.js";
import type { McpContext } from "./types.js";

const engine = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../dream/run.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../dream/run.js")>(),
  dream: async (project: string) => { engine.calls.push(project); return { status: "ok", runId: "r9", counts: { proposed: 2 } }; },
}));

import { register as registerDream } from "./dream.js";
import { register as registerConfig } from "./config.js";

const parse = (res: unknown) => JSON.parse((res as { content: { text: string }[] }).content[0].text);

let store: { path: string; cleanup: () => void };
beforeEach(() => {
  store = makeTempDir("phren-dream-mcp-");
  fs.mkdirSync(path.join(store.path, "demo", "dreams"), { recursive: true });
  fs.writeFileSync(path.join(store.path, "demo", "dreams", "journal.md"), "- r1 proposed 2 changes\n");
  clearProjectConfigCache();
  engine.calls.length = 0;
});
afterEach(() => store.cleanup());

function admin() {
  const exposed = new Map<string, { config: ToolConfig; handler: ToolHandler }>();
  const gate = createToolGate({ profile: "core", modules: BUILTIN_MODULES, register: (name, config, handler) => { exposed.set(name, { config, handler }); } });
  const ctx = { phrenPath: store.path, profile: "", rebuildIndex: async () => {}, updateFileInIndex: () => {},
    db: () => { throw new Error("no index"); }, withWriteQueue: async <T>(fn: () => Promise<T>) => fn() } as unknown as McpContext;
  const server = { registerTool: gate.registerTool } as never;
  registerDream(server, ctx);
  registerConfig(server, ctx);
  gate.finish();
  return (args: Record<string, unknown>) => exposed.get("phren_admin")!.handler(args);
}

describe("dream MCP actions", () => {
  it("are phren_admin actions in the core profile", async () => {
    const listing = parse(await admin()({ action: "list_actions" }));
    const names = JSON.stringify(listing);
    for (const action of ["dream_run", "dream_status", "dream_log", "dream_apply"]) expect(names).toContain(action);
  });

  it("dream_status reports config and the last run", async () => {
    const call = admin();
    const status = parse(await call({ action: "dream_status", project: "demo" }));
    expect(status).toMatchObject({ ok: true, data: { project: "demo", enabled: false, cadence: "nightly", nextEligibleAt: null } });
  });

  it("dream_run runs the engine and dream_log reads the journal", async () => {
    const call = admin();
    const run = parse(await call({ action: "dream_run", project: "demo", force: true }));
    expect(run).toMatchObject({ ok: true, data: { status: "ok", counts: { proposed: 2 } } });
    expect(engine.calls).toEqual(["demo"]);
    expect(parse(await call({ action: "dream_status", project: "demo" })).data.lastRun).toBeUndefined();
    expect(parse(await call({ action: "dream_log", project: "demo", limit: 5 })).data.entries).toEqual(["- r1 proposed 2 changes"]);
  });

  it("dream_apply executes selected structured proposals through the admin action", async () => {
    fs.writeFileSync(path.join(store.path, "demo", "dreams", "r1.json"), JSON.stringify({
      changeset: { project: "demo", runId: "r1", changes: [{ op: "write_page", page: "reference/pages/cache.md", markdown: "---\ntitle: Cache\nsummary: Cache policy\n---\nCache policy", links: [] }] },
      mode: "propose", outcomes: [{ index: 0, op: "write_page", status: "proposed" }], dropped: [],
    }));
    const result = parse(await admin()({ action: "dream_apply", project: "demo", runId: "r1", only: [0] }));
    expect(result).toMatchObject({ ok: true, data: { outcomes: [{ index: 0, status: "applied" }] } });
    expect(fs.readFileSync(path.join(store.path, "demo", "reference", "pages", "cache.md"), "utf8")).toContain("Cache policy");
    expect(parse(await admin()({ action: "dream_status", project: "demo" })).data.pendingProposals).toBe(0);
  });

  it("dream_apply rejects only the requested indices and preserves the first decision on retry", async () => {
    const file = path.join(store.path, "demo", "dreams", "r1.json");
    fs.writeFileSync(file, JSON.stringify({
      changeset: { project: "demo", runId: "r1", changes: [{ op: "retract" }, { op: "edit" }, { op: "add_finding" }] },
      mode: "propose", outcomes: [{ index: 0, op: "retract", status: "proposed" }, { index: 1, op: "edit", status: "proposed" },
        { index: 2, op: "add_finding", status: "deferred" }], dropped: [],
    }));
    const call = admin();
    const args = { action: "dream_apply", project: "demo", runId: "r1", only: [0], reject: true };
    const reason = "Insufficient evidence";
    const original = fs.readFileSync(file, "utf8");
    const result = parse(await call({ ...args, reason }));
    expect(result).toMatchObject({ ok: true, data: { outcomes: [
      { index: 0, status: "rejected", reason, decidedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
      { index: 1, status: "proposed" },
      { index: 2, status: "deferred" },
    ] } });
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    const rejected = result.data.outcomes[0];
    expect(parse(await call({ ...args, reason: "Another reason" })).data.outcomes[0]).toEqual(rejected);
    expect(parse(await call({ ...args, reject: false })).data.outcomes[0]).toEqual(rejected);
    expect(parse(await call({ ...args, only: [1] })).data.outcomes[1]).toMatchObject({ status: "rejected" });
    expect(parse(await call({ ...args, only: [2] }))).toMatchObject({ ok: false, error: expect.stringMatching(/review queue/) });
  });

  it("dream_status aggregates decisions by op over the requested recent runs", async () => {
    const write = (runId: string, day: number, mode: "propose" | "apply", outcomes: Array<{ op: string; status: string }>) => {
      fs.writeFileSync(path.join(store.path, "demo", "dreams", `${runId}.json`), JSON.stringify({
        changeset: { project: "demo", runId, changes: outcomes.map(({ op }) => ({ op })) }, finishedAt: `2026-11-0${day}T10:00:00Z`, mode,
        outcomes: outcomes.map((outcome, index) => ({ index, ...outcome })),
      }));
    };
    const decide = (runId: string, index: number, op: string, outcome: string, id: string = randomUUID(), supersedes?: string[]) => {
      const dir = path.join(store.path, "demo", "dreams", "decisions", runId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${index}-${id}.json`), JSON.stringify({
        runId, index, op, outcome, decidedAt: "2026-11-05T04:00:00Z", computer: "laptop", supersedes,
      }));
    };
    write("z-old", 1, "propose", [{ op: "retract", status: "proposed" }]);
    write("a-review", 2, "propose", [
      { op: "edit", status: "applied" }, { op: "edit", status: "proposed" },
      { op: "add_finding", status: "deferred" }, { op: "add_finding", status: "skipped" },
      { op: "merge", status: "skipped" }, { op: "retract", status: "proposed" },
    ]);
    write("b-reject", 3, "propose", [{ op: "edit", status: "proposed" }, { op: "edit", status: "proposed" }]);
    write("c-auto", 4, "apply", [{ op: "edit", status: "applied" }]);
    const valid = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    decide("b-reject", 0, "edit", "rejected", valid);
    decide("b-reject", 0, "edit", "applied", first, [second, valid]);
    decide("b-reject", 0, "edit", "applied", second, [first]);
    decide("a-review", 0, "edit", "rejected", "a".repeat(36));
    fs.mkdirSync(path.join(store.path, "demo", "dreams", "decisions", "a-review", `0-${randomUUID()}.json`));
    decide("a-review", 5, "retract", "applied");
    decide("a-review", 5, "retract", "rejected");
    const call = admin();
    const status = parse(await call({ action: "dream_status", project: "demo", limit: 3 }));
    expect(status.data.pendingProposals).toBe(4);
    expect(parse(await call({ action: "dream_log", project: "demo" })).data.pendingProposals).toBe(4);
    expect(status.data.acceptance).toEqual({ runs: 3, byOp: {
      edit: { proposed: 4, applied: 1, rejected: 1, pending: 2, conflicted: 0, skipped: 0, acceptRate: 0.5 },
      merge: { proposed: 1, applied: 0, rejected: 0, pending: 0, conflicted: 0, skipped: 1, acceptRate: null },
      retract: { proposed: 1, applied: 0, rejected: 0, pending: 0, conflicted: 1, skipped: 0, acceptRate: null },
    } });
    expect(status.data.conflicts).toMatchObject([{ runId: "a-review", index: 5, op: "retract" }]);
    expect(parse(await call({ action: "dream_status", project: "demo" })).data.acceptance.byOp.retract.pending).toBe(1);
  });

  it("set_config and get_config handle the dreaming domain per project", async () => {
    const call = admin();
    const set = parse(await call({ action: "set_config", domain: "dreaming", project: "demo", settings: { enabled: true, cadence: "idle", idleMinutes: 30 } }));
    expect(set).toMatchObject({ ok: true, data: { dreaming: { enabled: true, cadence: "idle", idleMinutes: 30 } } });
    clearProjectConfigCache();
    const got = parse(await call({ action: "get_config", domain: "dreaming", project: "demo" }));
    expect(got.data.dreaming).toMatchObject({ enabled: true, cadence: "idle" });
    expect(got.data.fields["dreaming.cadence"]).toMatchObject({ value: "idle", source: "project" });
    expect(got.data.schema.map((d: { id: string }) => d.id)).toEqual(["dreaming"]);

    const bad = parse(await call({ action: "set_config", domain: "dreaming", settings: { cadence: "hourly", colour: "blue" } }));
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/Unknown dreaming settings: colour/) });
    const badValue = parse(await call({ action: "set_config", domain: "dreaming", settings: { cadence: "hourly" } }));
    expect(badValue).toMatchObject({ ok: false, error: expect.stringMatching(/cadence must be one of/) });
  });
});

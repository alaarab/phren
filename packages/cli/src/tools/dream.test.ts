/**
 * The dream tools as an agent reaches them: registered through the real module
 * manifests in the core profile, so they are phren_admin actions, plus the
 * dreaming domain of get_config / set_config.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "../test-helpers.js";
import { createToolGate, type ToolConfig, type ToolHandler } from "../mcp/profile.js";
import { BUILTIN_MODULES } from "../modules/registry.js";
import { clearProjectConfigCache } from "../project-config.js";
import type { McpContext } from "./types.js";

const engine = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../dream/run.js", () => ({
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
    for (const action of ["dream_run", "dream_status", "dream_log"]) expect(names).toContain(action);
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
    expect(parse(await call({ action: "dream_status", project: "demo" })).data.lastRun).toMatchObject({ runId: "r9", trigger: "manual" });
    expect(parse(await call({ action: "dream_log", project: "demo", limit: 5 })).data.entries).toEqual(["- r1 proposed 2 changes"]);
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

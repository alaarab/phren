import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { indexProject } from "../../../code/src/indexer.js";
import { AgentHooks } from "./agent-hooks.js";
import { serve } from "./server.js";

// Exercise the actual HTTP handler without a listening socket. Herdr's IPC
// boundary and account services are fixtures; transcript and code I/O are real.
const fixture = vi.hoisted(() => ({ snapshot: {} as Record<string, unknown>, branchDelay: 0, active: 0, peak: 0, listener: undefined as any, ready: undefined as (() => void) | undefined }));
vi.mock("node:http", async importOriginal => {
  const actual = await importOriginal<typeof import("node:http")>();
  return { ...actual, createServer: (listener: any) => {
    fixture.listener = listener;
    const server = actual.createServer();
    server.listen = ((file: string, callback: () => void) => {
      void writeFile(file, "").then(() => { callback(); fixture.ready?.(); });
      return server;
    }) as typeof server.listen;
    return server;
  } };
});
vi.mock("./herdr.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./herdr.js")>();
  return { ...actual, snapshot: async () => fixture.snapshot, servers: async () => [], recentServers: async () => [],
    paneIdentity: async (_server: string, pane: any) => pane.agent_session.value,
    paneChatState: async (_server: string, pane: any) => ({ sessionId: pane.agent_session.value }),
    validateTarget: async () => (fixture.snapshot.panes as any[])[0] };
});
vi.mock("../modules/runtime.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../modules/runtime.js")>();
  const { BUILTIN_MODULES } = await import("../modules/registry.js");
  return { ...actual, activateModules: (store: string) => ({ store, profile: "", generation: "test",
    modules: BUILTIN_MODULES.filter(m => ["hook", "git", "code"].includes(m.name)),
    has: (name: string) => ["hook", "git", "code"].includes(name) }) };
});
vi.mock("./usage.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./usage.js")>();
  return { ...actual, AccountUsageReader: class extends actual.AccountUsageReader {
    constructor() {
      super(async () => ({ source: "codex", windows: [] }), Date.now,
        async () => ({ source: "claude", windows: [] }), async () => ({ source: "opencode", windows: [] }),
        async () => undefined, async () => ({ source: "opencode-go", windows: [] }));
    }
  } };
});
vi.mock("./projects.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./projects.js")>();
  return { ...actual, repositoryBranch: async (directory: string) => {
    if (!fixture.branchDelay) return actual.repositoryBranch(directory);
    fixture.peak = Math.max(fixture.peak, ++fixture.active);
    try { await new Promise(resolve => setTimeout(resolve, fixture.branchDelay)); return "sample"; }
    finally { fixture.active--; }
  } };
});
let previousUmask = 0;
let root: string, serving: Promise<void>, stop: (() => void) | undefined;
const session = "aaaaaaaa-1111-4111-8111-111111111111";
const target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "codex", session };

beforeAll(async () => {
  await mkdir(".scratch", { recursive: true });
  root = await mkdtemp(path.resolve(".scratch/phone-speed-"));
  const store = path.join(root, "store"), repo = path.join(root, "repo"), transcripts = path.join(root, "codex/sessions/2026/09/20");
  vi.stubEnv("PHREN_PATH", store); vi.stubEnv("PHREN_BRIDGE_HOME", path.join(root, "bridge")); vi.stubEnv("CODEX_HOME", path.join(root, "codex"));
  vi.spyOn(AgentHooks.prototype, "start").mockResolvedValue(undefined);
  await mkdir(path.join(store, "speed"), { recursive: true }); await mkdir(repo); await mkdir(transcripts, { recursive: true });
  await writeFile(path.join(store, "speed/phren.project.yaml"), `sourcePath: ${JSON.stringify(repo)}\n`);
  await writeFile(path.join(repo, "sample.ts"), Array.from({ length: 500 }, (_, i) => `export function sample${i}() { return ${i}; }`).join("\n"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "sample.ts"], { cwd: repo });
  await indexProject(store, "speed", { repoRoot: repo });
  const contents = Array.from({ length: 5_000 }, (_, i) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `Reply ${i} ${"sample ".repeat(100)}` }] } })).join("\n") + "\n";
  const panes = [], tabs = [];
  for (let i = 1; i <= 24; i++) {
    const id = i === 1 ? session : `aaaaaaaa-1111-4111-8111-${String(i).padStart(12, "0")}`;
    await writeFile(path.join(transcripts, `rollout-2026-09-20T00-00-00-${id}.jsonl`), contents);
    tabs.push({ tab_id: `w1:t${i}`, workspace_id: "w1", label: String(i) });
    panes.push({ pane_id: `w1:p${i}`, tab_id: `w1:t${i}`, workspace_id: "w1", cwd: repo, agent: "codex", agent_status: "working", agent_session: { kind: "id", agent: "codex", value: id } });
  }
  fixture.snapshot = { panes, tabs, workspaces: [{ workspace_id: "w1", label: "Project" }] };
  const previous = process.listeners("SIGTERM");
  const ready = new Promise<void>(resolve => { fixture.ready = resolve; });
  previousUmask = process.umask();
  serving = serve("test");
  await Promise.race([ready, serving]);
  // serve installs shutdown listeners after its asynchronous startup completes.
  for (let i = 0; i < 100 && !stop; i++) {
    stop = process.listeners("SIGTERM").find(fn => !previous.includes(fn)) as (() => void) | undefined;
    if (!stop) await new Promise(resolve => setTimeout(resolve, 5));
  }
  expect(stop).toBeDefined();
}, 30_000);

afterAll(async () => {
  stop?.(); if (serving) await serving;
  if (stop) { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
  process.umask(previousUmask);
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

it("measures phone route handlers with 24 panes and 5000 transcript lines", async () => {
  for (const route of ["/v1/health", "/v1/workspaces", "/v1/transcripts/history?" + new URLSearchParams({ ...target, beforeLine: "4500" }),
    "/v1/subagents?" + new URLSearchParams(target), "/v1/usage", "/v1/code/search?project=speed&q=sample&limit=20"]) {
    const samples = [];
    for (let i = 0; i < 11; i++) {
      const response = Object.assign(new EventEmitter(), { statusCode: 200, writableEnded: false,
        setHeader: () => {}, end: (payload: string) => { response.writableEnded = true; data = JSON.parse(payload); } });
      let data: any;
      const started = performance.now();
      await fixture.listener({ method: "GET", url: route }, response);
      samples.push(performance.now() - started);
      expect(response.statusCode, JSON.stringify(data)).toBe(200);
      if (route.includes("history")) expect(data.totalLines).toBe(5_000);
      if (route.includes("code/search")) expect(data.symbols).toHaveLength(20);
    }
    const cold = samples.shift()!; samples.sort((a, b) => a - b);
    process.stdout.write(`PHONE_SPEED ${route.split("?")[0]} cold=${cold.toFixed(2)} median=${samples[5].toFixed(2)} max=${samples[9].toFixed(2)} ms\n`);
    expect(samples[9]).toBeLessThan(2_000);
  }
}, 30_000);

it("enriches four tabs concurrently while preserving response order and targets", async () => {
  fixture.branchDelay = 5; fixture.peak = 0;
  let data: any;
  const response = Object.assign(new EventEmitter(), { statusCode: 200, writableEnded: false,
    setHeader: () => {}, end: (payload: string) => { data = JSON.parse(payload); } });
  try {
    await fixture.listener({ method: "GET", url: "/v1/workspaces" }, response);
    expect(response.statusCode).toBe(200);
    expect(fixture.peak).toBe(4);
    expect(fixture.active).toBe(0);
    const tabs = data.groups[0].children;
    expect(tabs.map((tab: any) => tab.id)).toEqual(Array.from({ length: 24 }, (_, i) => `w1:t${i + 1}`));
    expect(tabs[0].target).toEqual(target);
    expect(tabs.every((tab: any) => tab.branch === "sample" && tab.currentStep === "Writing a reply")).toBe(true);
  } finally { fixture.branchDelay = 0; }
});

import { runtimeFile } from "../phren-paths.js";
import { refreshCitationFreshness } from "../content/citation-freshness.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTestPhrenRoot, makeTempDir } from "../test-helpers.js";
import { clearProjectConfigCache, getProjectRemote } from "../project-config.js";
import { registerStoreIdentity } from "../store-registry.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MEMORY_LIMITS, memoryForFiles, memorySearch, projectMemory, saveFinding } from "./project-memory.js";

vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

// The code index is a separate package; the files route only needs its symbol resolver.
const codeIndex = vi.hoisted(() => ({ files: {} as Record<string, string>, calls: 0 }));
vi.mock("../modules/code-package.js", async original => ({
  ...(await original<typeof import("../modules/code-package.js")>()),
  loadCodePackage: async () => ({
    resolveSymbolFiles: async (_store: string, _project: string, names: string[]) => {
      codeIndex.calls++;
      return { available: true, databasePath: "", value: Object.fromEntries(names.filter(name => codeIndex.files[name]).map(name => [name, codeIndex.files[name]])) };
    },
    symbolCitationForFinding: async () => ({}),
  }),
}));
import { createRouteHandler } from "./server-routes.js";

async function hookGet(url: string, method = "GET", memoryOn = true, payload?: unknown): Promise<{ status: number; body: any }> {
  const handler = createRouteHandler({ modules: { has: (name: string) => name !== "memory" || memoryOn, store }, info: {}, streams: {},
    agentHooks: { overview: { renew() {} }, pendingPanes: () => new Set() }, journal: { record: async () => {} },
    tabActivity: { observe: async () => ({ generation: 0, stamps: new Map() }), recordStatus: async () => new Map() }, contextUsage: { read: async () => new Map() } } as never);
  let result = "";
  const response = { statusCode: 200, setHeader() {}, end(value: string) { result = value; } };
  await handler({ url, method, [Symbol.asyncIterator]: async function* () { if (payload !== undefined) yield Buffer.from(JSON.stringify(payload)); } } as unknown as IncomingMessage, response as unknown as ServerResponse);
  return { status: response.statusCode, body: JSON.parse(result) };
}

let store: string, cleanup: () => void;

const write = (relative: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(store, relative)), { recursive: true });
  fs.writeFileSync(path.join(store, relative), content);
};

beforeEach(() => {
  ({ path: store, cleanup } = makeTempDir("project-memory-"));
  initTestPhrenRoot(store);
  clearProjectConfigCache();
});
afterEach(() => cleanup());

it("lets older phones verify the store before reading finding freshness", async () => {
  write("app/FINDINGS.md", "# app Findings\n");
  const storeId = registerStoreIdentity(store);
  const legacy = await hookGet("/v1/tasks/stores");
  expect(legacy.status).toBe(200);
  expect(legacy.body).toMatchObject({
    ok: true, version: 1,
    stores: [expect.objectContaining({
      id: storeId, name: expect.any(String), role: "primary", projects: ["app"],
      primary: true, available: true, identityReady: true, ambiguous: false, metadataWritable: false,
    })],
  });
  expect(await hookGet("/v1/store/directory")).toEqual(legacy);
  expect((await hookGet("/v1/projects/app/memory")).body).toMatchObject({ store_id: storeId });
  expect((await hookGet("/v1/tasks/stores", "POST")).status).toBe(405);
});

describe("GET /v1/projects/:project/memory", () => {
  it("returns the gitboy contract with empty task groups even for a legacy store", () => {
    write("app/FINDINGS.md", `# app Findings

## 2026-07-20

- [pitfall] Old cache key collides <!-- fid:11111111 --> <!-- phren:status "superseded" -->
  <!-- phren:cite {"created_at":"2026-07-20T10:00:00.000Z","repo":"/home/me/app","file":"src/cache.ts","line":42,"commit":"abc1234","symbol":"cacheKey()"} -->

## 2026-07-26

- Plain finding <!-- fid:22222222 -->
- Leaked AKIAABCDEFGHIJKLMNOP in a log <!-- fid:33333333 -->
`);
    write("app/truths.md", "# app truths\n\n- Ship from main only\n");
    write("app/phren.project.yaml", "remote: https://alice:hunter2@git.example.com/alice/app.git\n");

    write("app/tasks.md", "# app tasks\n\n## Active\n\n- Legacy task\n");
    const memory = projectMemory(store, "app");
    expect(memory).toMatchObject({ project: "app", remote: "https://git.example.com/alice/app.git", truncated: false, truths: [{ text: "Ship from main only" }] });
    expect(memory.tasks).toEqual({ active: [], queue: [], done: [] });
    // Newest first; the tag becomes the type; the local repo path never leaves.
    expect(memory.findings.map(f => f.id)).toEqual(["fid:22222222", "fid:33333333", "fid:11111111"]);
    expect(memory.findings[2]).toEqual({ id: "fid:11111111", text: "Old cache key collides", type: "pitfall", status: "superseded", created: "2026-07-20",
      citation: { file: "src/cache.ts", line: 42, commit: "abc1234", name: "cacheKey()" } });
    expect(memory.findings[0]).toMatchObject({ type: null, status: "active", citation: null });
    expect(memory.findings[1].text).toMatch(/^\[redacted: withheld/);
    expect(JSON.stringify(memory)).not.toContain("/home/me/app");
  });

  it("is served by the Hook's route handler, GET only, with the memory module on", async () => {
    write("app/FINDINGS.md", "# app Findings\n\n## 2026-07-26\n\n- Served <!-- fid:44444444 -->\n");
    const served = await hookGet("/v1/projects/app/memory");
    expect(served.status).toBe(200);
    expect(served.body).toMatchObject({ project: "app", tasks: { active: [], queue: [], done: [] }, findings: [{ id: "fid:44444444", text: "Served" }] });
    expect((await hookGet("/v1/projects/app/memory", "POST")).status).toBe(405);
    expect((await hookGet("/v1/projects/app/memory", "GET", false)).status).toBe(404);
    expect((await hookGet("/v1/projects/missing/memory")).status).toBe(404);
  });

  it("caps each list and says so", () => {
    write("app/FINDINGS.md", `# app Findings\n\n## 2026-07-26\n\n${Array.from({ length: MEMORY_LIMITS.findings + 5 }, (_, i) => `- Finding ${i}`).join("\n")}\n`);
    const memory = projectMemory(store, "app");
    expect(memory.truncated).toBe(true);
    expect(memory.findings).toHaveLength(MEMORY_LIMITS.findings);
  });

  it("refuses invalid and unknown projects", () => {
    expect(() => projectMemory(store, "..")).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => projectMemory(store, "%2e%2e")).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => projectMemory(store, "missing")).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe("phren.project.yaml remote", () => {
  const remote = (value: string) => getProjectRemote(store, "app", { remote: value });
  it("keeps clone URLs from any host and drops credentials and local paths", () => {
    expect(remote("git@gitboy.example:alice/app.git")).toBe("git@gitboy.example:alice/app.git");
    expect(remote("ssh://git@gitboy.example:2222/alice/app.git")).toBe("ssh://git@gitboy.example:2222/alice/app.git");
    expect(remote("https://token@github.com/alice/app")).toBe("https://github.com/alice/app");
    expect(remote("/home/alice/app")).toBeNull();
    expect(remote("file:///home/alice/app")).toBeNull();
    expect(remote("https://host/app?token=x")).toBeNull();
    expect(getProjectRemote(store, "app", {})).toBeNull();
  });
});

const FINDINGS = `# app Findings

## 2026-07-20

- [pitfall] Upload retries double-charge on 502 from the payment gateway <!-- fid:aaaa0001 -->
  <!-- phren:cite {"created_at":"2026-07-20T10:00:00.000Z","file":"src/pay.ts","line":40} -->
- Cache key ignores locale <!-- fid:aaaa0002 -->
  <!-- phren:cite {"created_at":"2026-07-20T10:00:00.000Z","file":"src/other.ts","symbol":"cacheKey()"} -->
- Old note about payment gateway timeouts <!-- fid:aaaa0003 --> <!-- phren:status "superseded" -->
- Unrelated finding about fonts <!-- fid:aaaa0004 -->
`;

describe("GET /v1/projects/:project/memory/files", () => {
  beforeEach(() => { codeIndex.files = {}; codeIndex.calls = 0; write("app/FINDINGS.md", FINDINGS); });

  it("matches cited files, and cited names the code index places in those files", async () => {
    write(".config/modules.yaml", "version: 1\nenabled:\n  code: true\n");
    codeIndex.files = { "cacheKey()": "src/cache.ts" };
    const result = await memoryForFiles(store, "app", ["src/pay.ts", "src/cache.ts"]);
    expect(result).toMatchObject({ project: "app", symbols: "indexed", truncated: false });
    expect(result.findings.map(f => [f.id, f.match])).toEqual([["fid:aaaa0001", "file"], ["fid:aaaa0002", "symbol"]]);
    expect(result.findings[0]).toMatchObject({ type: "pitfall", citation: { file: "src/pay.ts", line: 40 } });
  });

  it("matches by file alone when the code module is off", async () => {
    codeIndex.files = { "cacheKey()": "src/cache.ts" };
    const result = await memoryForFiles(store, "app", ["src/cache.ts", "src/other.ts"]);
    expect(result.symbols).toBe("unavailable");
    expect(codeIndex.calls).toBe(0);
    expect(result.findings.map(f => [f.id, f.match])).toEqual([["fid:aaaa0002", "file"]]);
  });

  it("refuses invalid path lists through the Hook route", async () => {
    expect((await hookGet("/v1/projects/app/memory/files?path=src/pay.ts")).body.findings).toHaveLength(1);
    expect((await hookGet("/v1/projects/app/memory/files")).status).toBe(400);
    expect((await hookGet("/v1/projects/app/memory/files?path=../x")).status).toBe(400);
    await expect(memoryForFiles(store, "app", Array.from({ length: 501 }, (_, i) => `f${i}`))).rejects.toMatchObject({ status: 400 });
  });
});

describe("GET /v1/projects/:project/memory/search", () => {
  beforeEach(() => { write("app/FINDINGS.md", FINDINGS); write("app/truths.md", "- The payment gateway returns 502 under load\n"); });

  it("ranks findings and truths against an error excerpt, with scores", () => {
    const result = memorySearch(store, "app", "Error: payment gateway 502 at upload (src/pay.ts:41)\n    at retry", 5);
    expect(result.project).toBe("app");
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]).toMatchObject({ kind: "finding", finding: { id: "fid:aaaa0001" } });
    expect(result.results.map(r => r.kind)).toContain("truth");
    for (const hit of result.results) expect(hit.score).toBeGreaterThan(0), expect(hit.score).toBeLessThanOrEqual(1);
    const superseded = result.results.find(r => r.finding?.id === "fid:aaaa0003");
    if (superseded) expect(superseded.score).toBeLessThan(result.results[0].score);
    expect(result.results.find(r => r.finding?.id === "fid:aaaa0004")).toBeUndefined();
  });

  it("honours limit and refuses bad input", async () => {
    expect(memorySearch(store, "app", "payment gateway", 1).results).toHaveLength(1);
    expect(memorySearch(store, "app", "zebra quantum", 5).results).toEqual([]);
    expect(() => memorySearch(store, "app", "x".repeat(1001), 5)).toThrow(expect.objectContaining({ status: 400 }));
    expect((await hookGet("/v1/projects/app/memory/search?q=payment+gateway&limit=2")).body.results.length).toBeLessThanOrEqual(2);
    expect((await hookGet("/v1/projects/app/memory/search?q=x&limit=50")).status).toBe(400);
  });
});





describe("POST /v1/projects/:project/findings", () => {
  beforeEach(() => { codeIndex.files = {}; write("app/FINDINGS.md", "# app Findings\n"); });

  it("saves through the add_finding path with gitboy provenance and reports duplicates", async () => {
    const saved = await saveFinding(store, "app", { text: "Retry uploads only after the idempotency key is stored", type: "pitfall",
      citation: { file: "src/pay.ts", line: 40, commit: "abc1234" } });
    expect(saved).toMatchObject({ project: "app", status: "saved", finding: { type: "pitfall", text: "Retry uploads only after the idempotency key is stored",
      citation: { file: "src/pay.ts", line: 40, commit: "abc1234" } } });
    expect(saved.finding?.id).toMatch(/^fid:[0-9a-f]{8}$/);
    expect(fs.readFileSync(path.join(store, "app/FINDINGS.md"), "utf8")).toContain("tool:gitboy");
    const again = await saveFinding(store, "app", { text: "Retry uploads only after the idempotency key is stored", type: "pitfall" });
    expect(again.status).toBe("duplicate");
  });

  it("refuses secrets, bad shapes and unknown projects", async () => {
    await expect(saveFinding(store, "app", { text: "Deploy key is AKIAABCDEFGHIJKLMNOP" })).rejects.toMatchObject({ status: 400 });
    await expect(saveFinding(store, "app", { text: "x", extra: 1 })).rejects.toBeDefined();
    await expect(saveFinding(store, "missing", { text: "x" })).rejects.toMatchObject({ status: 404 });
    expect((await hookGet("/v1/projects/app/findings", "POST", true, { text: "Saved through the Hook route" })).status).toBe(200);
    expect((await hookGet("/v1/projects/app/findings", "GET")).status).toBe(405);
    expect((await hookGet("/v1/projects/app/findings", "POST", true, { text: "y".repeat(9000) })).status).toBe(413);
  });
});


it("serves cached citation freshness on Hook memory, files and search responses", async () => {
  const cite = { created_at: "2026-10-15T00:00:00Z", file: "src/cache.ts", commit: "abcdef1" };
  write("app/FINDINGS.md", `# app Findings\n\n## 2026-10-15\n\n- Cache key collides <!-- fid:12345678 -->\n  <!-- phren:cite ${JSON.stringify(cite)} -->\n`);
  write("app/phren.project.yaml", "remote: https://gitboy.example/alice/app.git\n");
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ head: "123456789", paths: [{ path: "src/cache.ts", changed: true, last_commit: null }] })));
  await refreshCitationFreshness([cite], { phrenPath: store, projectRemote: "https://gitboy.example/alice/app.git", budgetMs: 1500, fetchImpl });
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  try {
    for (const url of ["/v1/projects/app/memory", "/v1/projects/app/memory/files?path=src/cache.ts", "/v1/projects/app/memory/search?q=cache%20key"]) {
      const response = await hookGet(url);
      expect(response.status).toBe(200);
      const item = response.body.findings?.[0] ?? response.body.results[0].finding;
      expect(item.citationFreshness).toMatchObject({ state: "changed", head: "123456789", lastCommit: null });
    }
    await new Promise(resolve => setImmediate(resolve));
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
});


it("returns before a background gitboy check and exposes it on the next poll", async () => {
  const cite = { created_at: "2026-10-15T00:00:00Z", file: "src/pay.ts", commit: "abcdef2" };
  write("app/FINDINGS.md", `# app Findings\n\n## 2026-10-15\n\n- Payment retries double charge <!-- fid:87654321 -->\n  <!-- phren:cite ${JSON.stringify(cite)} -->\n`);
  write("app/phren.project.yaml", "remote: https://gitboy.example/alice/app.git\n");
  let finish!: (response: Response) => void;
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => await new Promise<Response>(resolve => { finish = resolve; }));
  try {
    const first = await hookGet("/v1/projects/app/memory");
    expect(first.body.findings[0]).not.toHaveProperty("citationFreshness");
    await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(1));
    const overlapping = await hookGet("/v1/projects/app/memory");
    expect(overlapping.body.findings[0]).not.toHaveProperty("citationFreshness");
    await new Promise(resolve => setImmediate(resolve));
    expect(network).toHaveBeenCalledTimes(1);
    finish(new Response(JSON.stringify({ head: "123456789", paths: [{ path: "src/pay.ts", changed: true, last_commit: null }] })));
    await vi.waitFor(async () => {
      expect((await hookGet("/v1/projects/app/memory")).body.findings[0].citationFreshness).toMatchObject({ state: "changed" });
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(network).toHaveBeenCalledTimes(1);
  } finally { network.mockRestore(); }
});


it("reads the freshness cache once for a request with 500 findings", async () => {
  const cite = { created_at: "2026-10-15T00:00:00Z", file: "src/cache.ts", commit: "abcdef1" };
  write("app/FINDINGS.md", `# app Findings\n\n## 2026-10-15\n\n${Array.from({ length: 500 }, (_, i) =>
    `- Cache finding ${i} <!-- fid:${i.toString(16).padStart(8, "0")} -->\n  <!-- phren:cite ${JSON.stringify(cite)} -->`).join("\n")}\n`);
  write("app/phren.project.yaml", "remote: https://gitboy.example/alice/app.git\n");
  await refreshCitationFreshness([cite], { phrenPath: store, projectRemote: "https://gitboy.example/alice/app.git", budgetMs: 1500,
    fetchImpl: async () => new Response(JSON.stringify({ head: "123456789", paths: [{ path: cite.file, changed: true, last_commit: null }] })) });
  const cache = runtimeFile(store, "citation-freshness.json");
  // An external writer invalidates the process memo before this request.
  fs.appendFileSync(cache, "\n");
  vi.mocked(fs.readFileSync).mockClear();
  const result = await hookGet("/v1/projects/app/memory");
  expect(result.body.findings).toHaveLength(500);
  expect(result.body.findings.every((item: any) => item.citationFreshness?.state === "changed")).toBe(true);
  expect(vi.mocked(fs.readFileSync).mock.calls.filter(([file]) => file === cache)).toHaveLength(1);
  await new Promise(resolve => setImmediate(resolve));
});

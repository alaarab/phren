import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTestPhrenRoot, makeTempDir } from "../test-helpers.js";
import { clearProjectConfigCache, getProjectRemote } from "../project-config.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MEMORY_LIMITS, memoryForFiles, memorySearch, projectMemory, saveFinding, tasksForBranch } from "./project-memory.js";

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
    tabActivity: { observe: async () => new Map() }, contextUsage: { read: async () => new Map() } } as never);
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

describe("GET /v1/projects/:project/memory", () => {
  it("returns findings, truths, tasks and remote in the gitboy contract", () => {
    write("app/FINDINGS.md", `# app Findings

## 2026-07-20

- [pitfall] Old cache key collides <!-- fid:11111111 --> <!-- phren:status "superseded" -->
  <!-- phren:cite {"created_at":"2026-07-20T10:00:00.000Z","repo":"/home/me/app","file":"src/cache.ts","line":42,"commit":"abc1234","symbol":"cacheKey()"} -->

## 2026-07-26

- Plain finding <!-- fid:22222222 -->
- Leaked AKIAABCDEFGHIJKLMNOP in a log <!-- fid:33333333 -->
`);
    write("app/truths.md", "# app truths\n\n- Ship from main only\n");
    write("app/tasks.md", "# app tasks\n\n## Active\n\n- [ ] Fix login <!-- bid:aaaaaaaa -->\n  Context: token expiry\n\n## Queue\n\n- [ ] Add search\n\n## Done\n\n- [x] Set up CI\n");
    write("app/phren.project.yaml", "remote: https://alice:hunter2@git.example.com/alice/app.git\n");

    const memory = projectMemory(store, "app");
    expect(memory).toMatchObject({ project: "app", remote: "https://git.example.com/alice/app.git", truncated: false, truths: [{ text: "Ship from main only" }] });
    expect(Object.keys(memory).sort()).toEqual(["findings", "project", "remote", "store_id", "tasks", "truncated", "truths"]);
    // Newest first; the tag becomes the type; the local repo path never leaves.
    expect(memory.findings.map(f => f.id)).toEqual(["fid:22222222", "fid:33333333", "fid:11111111"]);
    expect(memory.findings[2]).toEqual({ id: "fid:11111111", text: "Old cache key collides", type: "pitfall", status: "superseded", created: "2026-07-20",
      citation: { file: "src/cache.ts", line: 42, commit: "abc1234", name: "cacheKey()" } });
    expect(memory.findings[0]).toMatchObject({ type: null, status: "active", citation: null });
    expect(memory.findings[1].text).toMatch(/^\[redacted: withheld/);
    expect(JSON.stringify(memory)).not.toContain("/home/me/app");
    expect(memory.tasks.active[0]).toEqual({ id: "bid:aaaaaaaa", text: "Fix login", created: null, context: "token expiry" });
    expect(memory.tasks.queue.map(t => t.text)).toEqual(["Add search"]);
    expect(memory.tasks.done.map(t => t.text)).toEqual(["Set up CI"]);
  });

  it("is served by the Hook's route handler, GET only, with the memory module on", async () => {
    write("app/FINDINGS.md", "# app Findings\n\n## 2026-07-26\n\n- Served <!-- fid:44444444 -->\n");
    const served = await hookGet("/v1/projects/app/memory");
    expect(served.status).toBe(200);
    expect(served.body).toMatchObject({ project: "app", findings: [{ id: "fid:44444444", text: "Served" }], tasks: { active: [], queue: [], done: [] } });
    expect((await hookGet("/v1/projects/app/memory", "POST")).status).toBe(405);
    expect((await hookGet("/v1/projects/app/memory", "GET", false)).status).toBe(404);
    expect((await hookGet("/v1/projects/missing/memory")).status).toBe(404);
  });

  it("caps each list and says so", () => {
    write("app/FINDINGS.md", `# app Findings\n\n## 2026-07-26\n\n${Array.from({ length: MEMORY_LIMITS.findings + 5 }, (_, i) => `- Finding ${i}`).join("\n")}\n`);
    write("app/tasks.md", `# app tasks\n\n## Active\n\n## Queue\n\n## Done\n\n${Array.from({ length: 60 }, (_, i) => `- [x] Done ${i}`).join("\n")}\n`);
    const memory = projectMemory(store, "app");
    expect(memory.truncated).toBe(true);
    expect(memory.findings).toHaveLength(MEMORY_LIMITS.findings);
    expect(memory.tasks.done).toHaveLength(MEMORY_LIMITS.done);
    expect(memory.tasks.done[0].text).toBe("Done 0");
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
    expect(remote("git@gitboy.lan:alice/app.git")).toBe("git@gitboy.lan:alice/app.git");
    expect(remote("ssh://git@gitboy.lan:2222/alice/app.git")).toBe("ssh://git@gitboy.lan:2222/alice/app.git");
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
    write(".config/modules.yaml", "version: 1\nenabled:\n  tasks: true\n  code: true\n");
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

describe("GET /v1/projects/:project/tasks?branch=", () => {
  beforeEach(() => write("app/tasks.md", `# app tasks

## Active

- [ ] Fix login redirect on feature/login-fix <!-- bid:bbbb0001 -->
- [ ] Track issue https://git.example.com/me/app/issues/123 <!-- bid:bbbb0002 -->

## Queue

- [ ] Something else entirely <!-- bid:bbbb0003 -->
  Context: see #77

## Done

- [x] Done work on feature/login-fix <!-- bid:bbbb0004 -->
`));

  it("returns open tasks naming the branch or its issue number", async () => {
    expect(tasksForBranch(store, "app", "feature/login-fix").tasks.map(t => [t.id, t.section, t.match])).toEqual([["bid:bbbb0001", "active", "branch"]]);
    expect(tasksForBranch(store, "app", "fix/123-oauth").tasks.map(t => [t.id, t.match])).toEqual([["bid:bbbb0002", "issue"]]);
    expect(tasksForBranch(store, "app", "issue-77").tasks.map(t => [t.id, t.section])).toEqual([["bid:bbbb0003", "queue"]]);
    expect(tasksForBranch(store, "app", "main").tasks).toEqual([]);
    expect((await hookGet("/v1/projects/app/tasks?branch=feature%2Flogin-fix")).body.tasks).toHaveLength(1);
    expect((await hookGet("/v1/projects/app/tasks?branch=a..b")).status).toBe(400);
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

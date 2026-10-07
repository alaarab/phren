import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initTestPhrenRoot, makeTempDir } from "../test-helpers.js";
import { clearProjectConfigCache, getProjectRemote } from "../project-config.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MEMORY_LIMITS, projectMemory } from "./project-memory.js";
import { createRouteHandler } from "./server-routes.js";

async function hookGet(url: string, method = "GET", memoryOn = true): Promise<{ status: number; body: any }> {
  const handler = createRouteHandler({ modules: { has: (name: string) => name !== "memory" || memoryOn, store }, info: {}, streams: {},
    agentHooks: { overview: { renew() {} }, pendingPanes: () => new Set() }, journal: { record: async () => {} },
    tabActivity: { observe: async () => new Map() }, contextUsage: { read: async () => new Map() } } as never);
  let result = "";
  const response = { statusCode: 200, setHeader() {}, end(value: string) { result = value; } };
  await handler({ url, method, [Symbol.asyncIterator]: async function* () {} } as unknown as IncomingMessage, response as unknown as ServerResponse);
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

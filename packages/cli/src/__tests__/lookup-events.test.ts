import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin, writeFile } from "../test-helpers.js";
import { register } from "../tools/search.js";
import { buildIndex, type SqlJsDatabase } from "../shared/index.js";
import type { McpContext } from "../tools/types.js";
import {
  recordLookupEvents,
  readRecentLookups,
  type LookupEvent,
} from "../governance/activity.js";
import { lookupEventsLogFile } from "../phren-paths.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;

function makeMockServer() {
  const tools = new Map<string, ToolHandler>();
  return {
    registerTool(name: string, _meta: unknown, handler: ToolHandler) {
      tools.set(name, handler);
    },
    call(name: string, args: Record<string, unknown>) {
      const handler = tools.get(name);
      if (!handler) throw new Error(`Tool "${name}" not registered`);
      return handler(args);
    },
  };
}

function parseResult(res: { content: { type: string; text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

describe("activity: recordLookupEvents / readRecentLookups", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => {
    tmp = makeTempDir("lookup-events-");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("writes a JSONL line per event and reads them back newest-first", () => {
    recordLookupEvents(tmp.path, [
      { query: "redis", project: "app", filename: "FINDINGS.md", type: "findings", source: "search" },
      { query: "redis", project: "app", filename: "reference/cache.md", type: "reference", source: "search" },
    ]);

    const raw = fs.readFileSync(lookupEventsLogFile(tmp.path), "utf8").trim().split("\n");
    expect(raw).toHaveLength(2);

    const events = readRecentLookups(tmp.path);
    expect(events).toHaveLength(2);
    // Newest-first: the second-written event comes back first.
    expect(events[0].filename).toBe("reference/cache.md");
    expect(events[1].filename).toBe("FINDINGS.md");
    expect(events[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("clamps long snippets and respects the limit argument", () => {
    const longSnippet = "x".repeat(1000);
    recordLookupEvents(tmp.path, [
      { query: "q", project: "p", filename: "a.md", type: "findings", source: "search", snippet: longSnippet },
    ]);
    const [event] = readRecentLookups(tmp.path);
    expect(event.snippet!.length).toBeLessThanOrEqual(240);

    for (let i = 0; i < 10; i++) {
      recordLookupEvents(tmp.path, [
        { query: "q", project: "p", filename: `f${i}.md`, type: "findings", source: "search" },
      ]);
    }
    expect(readRecentLookups(tmp.path, 3)).toHaveLength(3);
  });

  it("returns an empty list when no log exists and survives malformed lines", () => {
    expect(readRecentLookups(tmp.path)).toEqual([]);
    fs.mkdirSync(path.dirname(lookupEventsLogFile(tmp.path)), { recursive: true });
    fs.writeFileSync(lookupEventsLogFile(tmp.path), "not json\n" + JSON.stringify({ at: new Date().toISOString(), project: "p", filename: "ok.md", type: "findings", source: "search" }) + "\n");
    const events = readRecentLookups(tmp.path);
    expect(events).toHaveLength(1);
    expect(events[0].filename).toBe("ok.md");
  });
});

describe("mcp-search: lookup-event recording", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;
  let db: SqlJsDatabase;

  beforeEach(async () => {
    tmp = makeTempDir("lookup-events-search-");
    grantAdmin(tmp.path);

    const dir = path.join(tmp.path, "app");
    fs.mkdirSync(dir, { recursive: true });
    writeFile(
      path.join(dir, "FINDINGS.md"),
      "# app Findings\n\n## 2026-03-01\n\n- Redis caching uses a TTL of 300 seconds\n- Authentication uses JWT tokens\n",
    );

    db = await buildIndex(tmp.path);
    server = makeMockServer();
    const ctx: McpContext = {
      phrenPath: tmp.path,
      profile: "test",
      db: () => db,
      rebuildIndex: async () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };
    register(server as any, ctx);
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it("records a lookup event for each search hit", async () => {
    const res = parseResult(await server.call("search_knowledge", { query: "Redis" }));
    expect(res.ok).toBe(true);
    expect(res.data.results.length).toBeGreaterThan(0);

    const events: LookupEvent[] = readRecentLookups(tmp.path);
    expect(events.length).toBe(res.data.results.length);
    for (const ev of events) {
      expect(ev.source).toBe("search");
      expect(ev.query).toBe("Redis");
      expect(ev.project).toBe("app");
    }
  });

  it("does not record events when a search has zero results", async () => {
    const res = parseResult(await server.call("search_knowledge", { query: "nonexistent_term_xyz" }));
    expect(res.ok).toBe(true);
    expect(res.data.results).toHaveLength(0);
    expect(readRecentLookups(tmp.path)).toEqual([]);
  });
});

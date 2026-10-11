import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as path from "path";
import { makeTempDir, grantAdmin, writeFile } from "../test-helpers.js";
import { register as registerSearch } from "../tools/search.js";
import { register as registerTasks } from "../tools/tasks.js";
import { buildIndex, extractSnippet, type SqlJsDatabase } from "../shared/index.js";
import { mcpResponse, type McpContext } from "../tools/types.js";
import {
  DETAIL_PAGE_CHARS,
  LIST_RESPONSE_MAX_CHARS,
  LIST_TEXT_MAX_CHARS,
  MCP_RESPONSE_MAX_CHARS,
  SNIPPET_MAX_CHARS,
  SNIPPETS_TOTAL_CHARS,
} from "../response-budget.js";

type ToolResult = { content: { type: string; text: string }[] };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const filler = (n: number, seed: string) => `${seed} `.repeat(Math.ceil(n / (seed.length + 1))).slice(0, n);

describe("extractSnippet character budget", () => {
  it("centres a long matched line on the query term and stays within budget", () => {
    const line = `${filler(100_000, "alpha")} needle-term here ${filler(100_000, "omega")}`;
    const snippet = extractSnippet(`# Notes\n\n${line}\n`, "needle-term", 5, 800);
    expect(snippet.length).toBeLessThanOrEqual(800);
    expect(snippet).toContain("needle-term");
  });

  it("leaves a snippet that already fits unchanged", () => {
    const content = "# T\n\n- short needle line\n";
    expect(extractSnippet(content, "needle", 5, 800)).toBe(extractSnippet(content, "needle", 5));
  });
});

describe("tool responses stay within the client budget", () => {
  let tmp: { path: string; cleanup: () => void };
  let db: SqlJsDatabase;
  const tools = new Map<string, ToolHandler>();
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await tools.get(name)!(args);
    return { text: res.content[0].text, json: JSON.parse(res.content[0].text) };
  };

  beforeEach(async () => {
    tmp = makeTempDir("mcp-budget-");
    grantAdmin(tmp.path);
    // Recent dates, or the trust filter drops the findings as stale.
    const today = new Date().toISOString().slice(0, 10);
    // Twelve projects whose findings are single multi-KB lines, plus one
    // reference document that is one 300 KB line with the match in the middle.
    for (let i = 0; i < 12; i++) {
      writeFile(
        path.join(tmp.path, `proj-${i}`, "FINDINGS.md"),
        `# proj-${i} Findings\n\n## ${today}\n\n- Redis ${filler(20_000, `context${i}`)}\n- Redis ${filler(20_000, "more")}\n`,
      );
    }
    writeFile(
      path.join(tmp.path, "proj-0", "reference", "huge.md"),
      `# Huge\n\n## ${today}\n\n- ${filler(150_000, "lorem")} Redis eviction ${filler(150_000, "ipsum")}\n`,
    );
    const contextLog = Array.from({ length: 400 }, (_, i) => `note ${i} ${filler(40, "status")}`).join("; ");
    writeFile(
      path.join(tmp.path, "proj-1", "tasks.md"),
      `# proj-1 tasks\n\n## Active\n\n- [ ] Long running task <!-- bid:abcd1234 -->\n  Context: ${contextLog}; latest note\n\n## Queue\n\n## Done\n`,
    );
    db = await buildIndex(tmp.path);
    const ctx: McpContext = {
      phrenPath: tmp.path,
      profile: "",
      db: () => db,
      rebuildIndex: async () => {},
      updateFileInIndex: () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };
    const server = { registerTool: (name: string, _meta: unknown, handler: ToolHandler) => tools.set(name, handler) };
    registerSearch(server as never, ctx);
    registerTasks(server as never, ctx);
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it("search_knowledge bounds many large hits and points at the full text", async () => {
    const { text, json } = await call("search_knowledge", { query: "Redis", limit: 20 });
    expect(json.ok).toBe(true);
    expect(json.data.results.length).toBeGreaterThan(5);
    // Each snippet appears in both message and data.
    expect(text.length).toBeLessThan(2 * SNIPPETS_TOTAL_CHARS + 8000);
    for (const r of json.data.results) {
      expect(r.snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
      expect(r.snippet.toLowerCase()).toContain("redis");
      expect(r.truncated).toBe(true);
      expect(r.id).toBe(`mem:${r.project}/${r.filename === "huge.md" ? "reference/huge.md" : r.filename}`);
      expect(json.message).toContain(`get_memory_detail id="${r.id}"`);
    }
  });

  it("search_knowledge shows the match inside one huge line", async () => {
    const { json } = await call("search_knowledge", { query: "eviction", limit: 6 });
    const hit = json.data.results.find((r: { filename: string }) => r.filename === "huge.md");
    expect(hit.snippet).toContain("eviction");
    expect(hit.snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
  });

  it("get_memory_detail pages a document larger than one response", async () => {
    const first = (await call("get_memory_detail", { id: "mem:proj-0/reference/huge.md" })).json;
    expect(first.data.content.length).toBe(DETAIL_PAGE_CHARS);
    expect(first.data.next_offset).toBe(DETAIL_PAGE_CHARS);
    let content = first.data.content;
    let offset = first.data.next_offset;
    while (offset !== null) {
      const page = (await call("get_memory_detail", { id: "mem:proj-0/reference/huge.md", offset })).json;
      content += page.data.content;
      offset = page.data.next_offset;
    }
    // Reassembled pages give back the whole document, middle included.
    expect(content.length).toBe(first.data.total_chars);
    expect(content).toContain("Redis eviction");
    expect(content.startsWith("# Huge\n")).toBe(true);
  });

  it("get_tasks lists show the latest context and a single lookup returns it whole", async () => {
    const list = (await call("get_tasks", { project: "proj-1" })).json;
    const item = list.data.items.Active[0];
    expect(item.context.length).toBeLessThanOrEqual(LIST_TEXT_MAX_CHARS);
    expect(item.context.endsWith("latest note")).toBe(true);
    expect(item.contextTruncated).toBe(true);

    const one = (await call("get_tasks", { project: "proj-1", id: "bid:abcd1234" })).json;
    expect(one.data.context.endsWith("latest note")).toBe(true);
    expect(one.data.context.startsWith("note 0 ")).toBe(true);
  });

  it("get_tasks across projects stays under the list budget", async () => {
    const { text } = await call("get_tasks", { status: "all", limit: 200, done_limit: 200 });
    expect(text.length).toBeLessThanOrEqual(LIST_RESPONSE_MAX_CHARS);
  });
});

describe("mcpResponse safety net", () => {
  it("replaces an oversized payload with a short message that says how to narrow it", () => {
    const res = mcpResponse({ ok: true, message: "x".repeat(200_000), data: { rows: "y".repeat(200_000) } });
    const text = res.content[0].text;
    expect(text.length).toBeLessThanOrEqual(MCP_RESPONSE_MAX_CHARS);
    const json = JSON.parse(text);
    expect(json.ok).toBe(true);
    expect(json.data).toEqual({ truncated: true, originalChars: expect.any(Number) });
    expect(json.message).toContain("Narrow the request");
  });

  it("sends unbounded payloads whole", () => {
    const res = mcpResponse({ ok: true, data: { rows: "y".repeat(200_000) } }, { unbounded: true });
    expect(JSON.parse(res.content[0].text).data.rows.length).toBe(200_000);
  });
});

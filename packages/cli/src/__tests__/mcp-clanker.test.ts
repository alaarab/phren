import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as path from "path";
import { makeTempDir, grantAdmin, writeFile } from "../test-helpers.js";
import { register as registerSearch } from "../tools/search.js";
import { register as registerTasks } from "../tools/tasks.js";
import { buildIndex, type SqlJsDatabase } from "../shared/index.js";
import type { McpContext } from "../tools/types.js";
import { resolveClanker } from "../clanker.js";
import { writeInstallPreferences } from "../init/preferences.js";

type ToolResult = { content: { type: string; text: string }[] };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const EVICTION = "Redis eviction under memory pressure drops session keys first; set maxmemory-policy to volatile-lru so only keys with a TTL are evicted, and alert on evicted_keys above zero.";
const POOL = "Postgres pool exhaustion shows as request timeouts, not errors: cap the pool at 20 per pod.";

describe("clanker mode tools", () => {
  let tmp: { path: string; cleanup: () => void };
  let db: SqlJsDatabase;
  const tools = new Map<string, ToolHandler>();
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await tools.get(name)!(args);
    return { text: res.content[0].text, json: JSON.parse(res.content[0].text) };
  };

  beforeEach(async () => {
    tmp = makeTempDir("mcp-clanker-");
    grantAdmin(tmp.path);
    // Recent dates, or the trust filter drops the findings as stale.
    const today = new Date().toISOString().slice(0, 10);
    writeFile(
      path.join(tmp.path, "app", "FINDINGS.md"),
      `# app Findings\n\n## ${today}\n\n- ${EVICTION} <!-- fid:aaaa1111 --> <!-- created: ${today} -->\n  <!-- phren:cite {"file":"src/cache.ts"} -->\n\n- ${POOL} <!-- fid:bbbb2222 --> <!-- created: ${today} -->\n`,
    );
    writeFile(
      path.join(tmp.path, "app", "tasks.md"),
      "# app tasks\n\n## Active\n\n- [ ] Tune Redis eviction alerts <!-- bid:cccc3333 -->\n  Context: evicted_keys alert fired twice; threshold needs a floor\n\n## Queue\n\n- [ ] Split the worker pool <!-- bid:dddd4444 -->\n\n## Done\n",
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
    process.env.PHREN_CLANKER = "on";
  });

  afterEach(() => {
    delete process.env.PHREN_CLANKER;
    tmp.cleanup();
  });

  it("search returns a row per matching entry, and its id opens only that entry", async () => {
    const search = await call("search_knowledge", { query: "redis eviction", project: "app" });
    expect(search.json.ok).toBe(true);
    expect(search.json.data.ids).toContain("fid:aaaa1111");
    expect(search.json.data.ids).toContain("bid:cccc3333");
    // A title, not the whole finding: its tail stays out of the row.
    expect(search.text).not.toContain("alert on evicted_keys above zero");

    const finding = await call("get_memory_detail", { id: "fid:aaaa1111" });
    expect(finding.json.data.content).toContain(EVICTION);
    expect(finding.json.data.content).toContain("phren:cite");
    expect(finding.json.data.content).not.toContain("Postgres");

    const task = await call("get_memory_detail", { id: "bid:cccc3333" });
    expect(task.json.data.content).toContain("threshold needs a floor");
    expect(task.json.data.content).not.toContain("worker pool");

    const missing = await call("get_memory_detail", { id: "fid:eeee5555" });
    expect(missing.json.ok).toBe(false);
  });

  it("get_findings and get_tasks list ids and titles without the full text", async () => {
    const findings = await call("get_findings", { project: "app" });
    expect(findings.json.data.total).toBe(2);
    expect(findings.json.message).toMatch(/fid:aaaa1111 \S+ Redis eviction/);
    expect(findings.json.message).toContain("fid:bbbb2222");
    expect(findings.json.message).not.toContain("alert on evicted_keys above zero");

    const tasks = await call("get_tasks", { project: "app" });
    expect(tasks.json.message).toContain("bid:cccc3333 Tune Redis eviction alerts");
    expect(tasks.json.message).toContain("bid:dddd4444 Split the worker pool");
    expect(tasks.json.message).not.toContain("threshold needs a floor");
  });
});

describe("resolveClanker", () => {
  let tmp: { path: string; cleanup: () => void };
  beforeEach(() => { tmp = makeTempDir("clanker-pref-"); });
  afterEach(() => tmp.cleanup());

  it("reads PHREN_CLANKER, then the old progressive-disclosure flag, then install preferences, else off", () => {
    expect(resolveClanker(tmp.path, {})).toEqual({ on: false, source: "default" });
    writeInstallPreferences(tmp.path, { clanker: true });
    expect(resolveClanker(tmp.path, {})).toEqual({ on: true, source: "install preferences" });
    expect(resolveClanker(tmp.path, { PHREN_FEATURE_PROGRESSIVE_DISCLOSURE: "0" })).toEqual({ on: false, source: "PHREN_FEATURE_PROGRESSIVE_DISCLOSURE" });
    expect(resolveClanker(tmp.path, { PHREN_CLANKER: "off", PHREN_FEATURE_PROGRESSIVE_DISCLOSURE: "1" })).toEqual({ on: false, source: "PHREN_CLANKER" });
  });
});

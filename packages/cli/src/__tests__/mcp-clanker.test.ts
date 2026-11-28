import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as path from "path";
import { makeTempDir, grantAdmin, writeFile } from "../test-helpers.js";
import { register as registerSearch } from "../tools/search.js";
import { buildIndex, type SqlJsDatabase } from "../shared/index.js";
import type { McpContext } from "../tools/types.js";
import { resolveClanker } from "../clanker.js";
import { writeInstallPreferences } from "../init/preferences.js";
import { readMemoryOpens } from "../recall/trace.js";

type ToolResult = { content: { type: string; text: string }[] };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const EVICTION = "Redis eviction under memory pressure drops session keys first; set maxmemory-policy to volatile-lru so only keys with a TTL are evicted, and alert on evicted_keys above zero.";
const POOL = "Postgres max_connections exhaustion shows as request timeouts, not errors: cap the pool at 20 per pod.";

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
    // A title, not the whole finding: its tail stays out of the row.
    expect(search.text).not.toContain("alert on evicted_keys above zero");

    const finding = await call("get_memory_detail", { id: "fid:aaaa1111" });
    expect(finding.json.data.content).toContain(EVICTION);
    expect(finding.json.data.content).toContain("phren:cite");
    expect(finding.json.data.content).not.toContain("Postgres");


    const missing = await call("get_memory_detail", { id: "fid:eeee5555" });
    expect(missing.json.ok).toBe(false);
  });

  it("records each get_memory_detail id with the Claude Code session, and nothing without one", async () => {
    const saved = process.env.CLAUDE_CODE_SESSION_ID;
    try {
      delete process.env.CLAUDE_CODE_SESSION_ID;
      await call("get_memory_detail", { id: "fid:aaaa1111" });
      expect(readMemoryOpens(tmp.path)).toEqual([]);
      process.env.CLAUDE_CODE_SESSION_ID = "session-1";
      await call("get_memory_detail", { id: "FID:AAAA1111" });
      await call("get_memory_detail", { id: "mem:app/FINDINGS.md" });
      expect(readMemoryOpens(tmp.path).map(({ session, id }) => ({ session, id }))).toEqual([
        { session: "session-1", id: "fid:aaaa1111" },
        { session: "session-1", id: "mem:app/FINDINGS.md" },
      ]);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = saved;
    }
  });

  it("get_findings lists ids and titles without the full text", async () => {
    const findings = await call("get_findings", { project: "app" });
    expect(findings.json.data.total).toBe(2);
    expect(findings.json.message).toMatch(/fid:aaaa1111 \S+ Redis eviction/);
    // Identifiers survive the title cleanup.
    expect(findings.json.message).toContain("fid:bbbb2222 ");
    expect(findings.json.message).toContain("Postgres max_connections exhaustion");
    expect(findings.json.message).not.toContain("alert on evicted_keys above zero");

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

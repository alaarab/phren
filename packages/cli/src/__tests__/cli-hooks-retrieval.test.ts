import { describe, it, expect, afterEach, } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Set PHREN_PATH before importing cli-hooks
const tmpPhren = fs.mkdtempSync(path.join(os.tmpdir(), "phren-retrieval-test-"));
process.env.PHREN_PATH = tmpPhren;

import { rankResults, searchDocuments, applyRelevanceFloor, applyTrustFilter, selectSnippets } from "../cli/hooks.js";
import { sortScoreGroups } from "../shared/retrieval.js";
import type { DocRow } from "../shared/index.js";
import { buildRobustFtsQuery } from "../utils.js";

afterEach(() => {
  delete process.env.PHREN_ACTOR;
});

describe("rankResults", () => {
  function makeDocRow(project: string, filename: string, type: string, content: string): DocRow {
    return { project, filename, type, content, path: `/tmp/${project}/${filename}` };
  }

  it("prioritizes findings type over non-findings types", () => {
    const rows: DocRow[] = [
      makeDocRow("myapp", "FINDINGS.md", "findings", "## 2025-01-01\n- An insight"),
      makeDocRow("myapp", "AGENTS.md", "claude", "# myapp\nSetup instructions"),
    ];

    const ranked = rankResults(rows, "general", null, "myapp", tmpPhren, null);
    // findings should rank before claude/non-findings types
    const claudeIdx = ranked.findIndex(r => r.type === "claude");
    const learningsIdx = ranked.findIndex(r => r.type === "findings");
    if (claudeIdx !== -1 && learningsIdx !== -1) {
      expect(learningsIdx).toBeLessThan(claudeIdx);
    }
  });

  it("orders findings by score first, date only breaking a near-tie", () => {
    const newerWeak = makeDocRow("myapp", "FINDINGS.md", "findings",
      `## ${new Date().toISOString().slice(0, 10)}\n- The webhook retries three times before giving up.`);
    const olderStrong = makeDocRow("other", "FINDINGS.md", "findings",
      "## 2020-01-01\n- Slack alerts go through the webhook monitor at the queue.");
    const ranked = rankResults([newerWeak, olderStrong], "general", null, null, tmpPhren, null as any,
      undefined, "webhook slack alerts monitor");
    // A better match wins even when the other findings doc is newer.
    expect(ranked.map((row) => row.project)).toEqual(["other", "myapp"]);

    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);
    // The alphabetically earlier project holds the older date, so path order cannot stand in for
    // date. A wider cross-project decay makes the older doc's one extra matched word a lead under
    // 0.01: the date still has to win inside the score group.
    const olderLead = makeDocRow("a-older", "FINDINGS.md", "findings",
      `## ${yesterday}\n- Slack alerts go through the webhook monitor.`);
    const newerTie = makeDocRow("z-newer", "FINDINGS.md", "findings",
      `## ${today}\n- Slack alerts go through the webhook.`);
    const decay = process.env.PHREN_CROSS_PROJECT_DECAY_DAYS;
    process.env.PHREN_CROSS_PROJECT_DECAY_DAYS = "14";
    try {
      const scores = new Map<string, number>();
      const tied = rankResults([olderLead, newerTie], "general", null, "local", tmpPhren, null as any,
        undefined, "webhook slack alerts monitor", undefined,
        (row, score) => scores.set(row.project, score));
      const lead = (scores.get("a-older") ?? 0) - (scores.get("z-newer") ?? 0);
      expect(lead).toBeGreaterThan(0);
      expect(lead).toBeLessThanOrEqual(0.01);
      expect(tied.map((row) => row.project)).toEqual(["z-newer", "a-older"]);
    } finally {
      if (decay === undefined) delete process.env.PHREN_CROSS_PROJECT_DECAY_DAYS;
      else process.env.PHREN_CROSS_PROJECT_DECAY_DAYS = decay;
    }
  });

  it("dates settle each score group within 0.01, whatever the input order", () => {
    const items = [
      { name: "a-older", score: 3.85, date: "2020-01-01" },
      { name: "b-middle", score: 3.8438, date: "2020-03-01" },
      { name: "c-newest", score: 3.8375, date: "2020-06-01" },
    ];
    const order = (list: typeof items) => sortScoreGroups(
      list,
      (item) => item.score,
      (a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name),
    ).map((item) => item.name);
    // The first two are 62 units apart, one group that date settles; the third is 125 units below.
    expect(order(items)).toEqual(["b-middle", "a-older", "c-newest"]);
    expect(order([...items].reverse())).toEqual(["b-middle", "a-older", "c-newest"]);
  });

  it("keeps a single strong task result when it clearly beats non-task noise", () => {
    const longTaskPrefix = Array.from({ length: 28 }, (_, i) => `filler${i}`).join(" ");
    const rows: DocRow[] = [
      makeDocRow(
        "sampleatlas",
        "tasks.md",
        "task",
        `# task\n- ${longTaskPrefix}\n- Route alerts to an external webhook instead of Slack for monitors`
      ),
      makeDocRow(
        "sampleportal",
        "FINDINGS.md",
        "findings",
        "## 2025-06-01\n- Slack notifications exist for project reports"
      ),
      makeDocRow(
        "sampleops",
        "restart-renderer.md",
        "skill",
        "Restart the renderer when a preview session hangs"
      ),
    ];

    const ranked = rankResults(
      rows,
      "general",
      null,
      null,
      tmpPhren,
      null as any,
      undefined,
      "alerts to external webhook instead of slack"
    );

    expect(ranked.some((row) => row.type === "task")).toBe(true);
    expect(ranked.findIndex((row) => row.type === "task")).toBeLessThan(
      ranked.findIndex((row) => row.project === "sampleops")
    );
  });
});

describe("searchDocuments", () => {
  it("returns null for empty database", () => {
    // Mock db that returns empty results
    const mockDb = {
      exec: () => [],
    };
    const result = searchDocuments(mockDb, "test query", "test", "test", null);
    expect(result).toBeNull();
  });

  it("uses deterministic rowid windows for semantic fallback instead of ORDER BY RANDOM", () => {
    const sqlCalls: string[] = [];
    const row = [42, "proj", "FINDINGS.md", "findings", "retry transient failures in background jobs", "/tmp/proj/FINDINGS.md"];
    const mockDb = {
      exec: (sql: string, params: any[]) => {
        sqlCalls.push(sql);
        if (sql.includes("MATCH")) return [];
        if (sql.includes("MIN(rowid)")) {
          return [{ columns: ["min_rowid", "max_rowid", "count"], values: [[1, 500, 500]] }];
        }
        if (sql.includes("rowid >= ?")) {
          return [{ columns: ["rowid", "project", "filename", "type", "content", "path"], values: [row] }];
        }
        if (sql.includes("rowid < ?")) return [];
        return [];
      },
    };

    const result = searchDocuments(mockDb as any, "missing", "retry transient failures", "retry failures", null);
    expect(result).not.toBeNull();
    expect(result?.[0]?.path).toBe("/tmp/proj/FINDINGS.md");
    expect(sqlCalls.some((sql) => sql.includes("ORDER BY RANDOM"))).toBe(false);
    expect(sqlCalls.some((sql) => sql.includes("rowid >= ?"))).toBe(true);
  });

  it("retries with a relaxed FTS query when the strict lexical query misses", () => {
    const strictQuery = buildRobustFtsQuery("semantic search setup during init with ollama");
    const seenQueries: string[] = [];
    const row = ["phren", "FINDINGS.md", "findings", "Semantic opt-in during init should finish at the dependency level", "/tmpphren/FINDINGS.md"];
    const mockDb = {
      exec: (sql: string, params: any[]) => {
        if (sql.includes("MATCH")) {
          seenQueries.push(String(params[0]));
          if (seenQueries.length === 1) return [];
          return [{ columns: ["project", "filename", "type", "content", "path"], values: [row] }];
        }
        if (sql.includes("MIN(rowid)")) {
          return [{ columns: ["min_rowid", "max_rowid", "count"], values: [[1, 1, 0]] }];
        }
        return [];
      },
    };

    const result = searchDocuments(
      mockDb as any,
      strictQuery,
      "semantic search setup during init with ollama",
      "semantic search setup during init ollama",
      null
    );

    expect(result?.[0]?.path).toBe("/tmpphren/FINDINGS.md");
    expect(seenQueries).toHaveLength(2);
    expect(seenQueries[1]).toContain(" OR ");
  });
});

describe("applyRelevanceFloor", () => {
  function makeDocRow(project: string, filename: string, type: string, content: string): DocRow {
    return { project, filename, type, content, path: `/tmp/${project}/${filename}` };
  }

  const KEYWORDS = "webhook slack alerts monitor";

  it("drops a doc with zero query overlap (priors-only ranking noise)", () => {
    const rows = [makeDocRow("zeta", "notes.md", "findings", "The quick brown fox jumps over the lazy dog")];
    const kept = applyRelevanceFloor(rows, KEYWORDS, null, null);
    expect(kept).toHaveLength(0); // inject nothing rather than noise
  });

  it("keeps a doc whose text actually matches the prompt", () => {
    const rows = [
      makeDocRow("zeta", "notes.md", "findings", "Route alerts to an external webhook instead of slack for monitors"),
    ];
    const kept = applyRelevanceFloor(rows, KEYWORDS, null, null);
    expect(kept).toHaveLength(1);
  });

  it("keeps a structurally-relevant doc (changed file) even with no textual overlap", () => {
    const rows = [makeDocRow("myapp", "auth-config.md", "findings", "nothing lexically relevant here at all")];
    const gitCtx = { branch: "main", changedFiles: new Set(["auth-config.md"]) };
    const kept = applyRelevanceFloor(rows, KEYWORDS, gitCtx, "myapp");
    expect(kept).toHaveLength(1);
  });

  it("holds a canonical doc for the detected project to the same bar as any other", () => {
    const rows = [makeDocRow("myapp", "AGENTS.md", "canonical", "unrelated project overview text")];
    expect(applyRelevanceFloor(rows, KEYWORDS, null, "myapp")).toHaveLength(0);
    const matching = [makeDocRow("myapp", "AGENTS.md", "canonical", "- Alerts go to the slack webhook.")];
    expect(applyRelevanceFloor(matching, KEYWORDS, null, "myapp")).toHaveLength(1);
  });

  it("needs two keywords in one bullet, not scattered across a file", () => {
    const archive = makeDocRow("other", "reference/topics/ops.md", "reference",
      "- The webhook retries three times.\n- Slack rate limits bursts.\n- Alerts page the on-call.");
    expect(applyRelevanceFloor([archive], KEYWORDS, null, "myapp")).toHaveLength(0);
    const together = makeDocRow("other", "reference/topics/ops.md", "reference",
      "- Unrelated bullet.\n- Slack alerts go through the webhook proxy.");
    expect(applyRelevanceFloor([together], KEYWORDS, null, "myapp")).toHaveLength(1);
  });

  it("holds every row to the cross-project floor when no project is detected (a conductor session)", () => {
    const rows = [makeDocRow("zeta", "notes.md", "findings", "- Alpha beta ship together in the daily build.")];
    const rarity = new Map([["alpha", 0.7], ["beta", 0.7]]);
    // Two of nine prompt words: clears the plain floor, below the cross-project floor.
    const keywords = "alpha beta gamma delta epsilon zeta eta theta iota";
    expect(applyRelevanceFloor(rows, keywords, null, null, undefined, rarity)).toHaveLength(0);
    // The same overlap is enough beside the doc's own project.
    expect(applyRelevanceFloor(rows, keywords, null, "zeta", undefined, rarity)).toHaveLength(1);
  });

  it("weighs keywords by rarity: common words together clear nothing", () => {
    const doc = makeDocRow("max", "notes.md", "findings", "- Push the fix to main before the release.");
    const common = new Map([["push", 0.22], ["main", 0.18]]);
    expect(applyRelevanceFloor([doc], "push main", null, "max", undefined, common)).toHaveLength(0);
    const rare = new Map([["push", 0.22], ["main", 0.6]]);
    expect(applyRelevanceFloor([doc], "push main", null, "max", undefined, rare)).toHaveLength(1);
  });

  it("two matched keywords need one rare one: everyday pairs are coincidences", () => {
    const doc = makeDocRow("max", "notes.md", "findings", "- Be honest about what a good default is.");
    const decisions: string[] = [];
    const everyday = new Map([["honest", 0.44], ["good", 0.38]]);
    expect(applyRelevanceFloor([doc], "honest good", null, "max", undefined, everyday, (_row, d) => decisions.push(d.reason))).toHaveLength(0);
    expect(decisions).toEqual(["no-anchor"]);
    const pair = makeDocRow("max", "notes.md", "findings", "- The sso login fails behind the api proxy.");
    expect(applyRelevanceFloor([pair], "api sso", null, "max", undefined, new Map([["api", 0.13], ["sso", 0.57]]))).toHaveLength(1);
  });

  it("a word in most docs is no second match: a product name the store mentions in passing does not carry a bullet", () => {
    const doc = makeDocRow("max", "notes.md", "findings", "- Quillmark export stays out of scope while the work queue drains.");
    const reasons: string[] = [];
    const rarity = new Map([["quillmark", 0.75], ["pricing", 0.36], ["work", 0.06]]);
    expect(applyRelevanceFloor([doc], "quillmark pricing work", null, "max", undefined, rarity, (_row, d) => reasons.push(d.reason))).toHaveLength(0);
    expect(reasons).toEqual(["too-few-matches"]);
    expect(applyRelevanceFloor([doc], "quillmark pricing work", null, "max", undefined, new Map([...rarity, ["work", 0.2]]))).toHaveLength(1);
  });

  it("three matched everyday keywords still pass: more evidence, no rare word needed", () => {
    const doc = makeDocRow("max", "notes.md", "findings", "- Compile the private client without touching the live tree.");
    const rarity = new Map([["compile", 0.25], ["private", 0.19], ["client", 0.2], ["live", 0.08]]);
    expect(applyRelevanceFloor([doc], "compile private client live", null, "max", undefined, rarity)).toHaveLength(1);
  });

  it("drops a side match carrying under 60% of the strongest row's keyword rarity, which alone would pass", () => {
    const rarity = new Map([["ledger", 0.9], ["webhook", 0.6], ["hmac", 0.9], ["rotating", 0.5]]);
    const answer = makeDocRow("myapp", "FINDINGS.md", "findings", "- The ledger webhook signs each payload with the rotating hmac key.");
    const near = makeDocRow("myapp", "reference/topics/security.md", "reference", "- Rotating the hmac key breaks ledger replays.");
    const side = makeDocRow("myapp", "reference/topics/ops.md", "reference", "- The ledger export calls a webhook nightly.");
    const reasons: string[] = [];
    const kept = applyRelevanceFloor([answer, near, side], "ledger webhook hmac rotating", null, "myapp", undefined, rarity, (_row, d) => reasons.push(d.reason));
    expect(kept).toEqual([answer, near]);
    expect(reasons).toEqual(["pass", "pass", "below-best"]);
    expect(applyRelevanceFloor([side], "ledger webhook hmac rotating", null, "myapp", undefined, rarity)).toEqual([side]);
  });

  it("matches prompt words inside a bullet's joined names: flags, file names, identifiers", () => {
    const doc = makeDocRow("myapp", "FINDINGS.md", "findings",
      "- Run `tool --install-hooks` once; CI then fails on rules missing from `.github/lint-allowlist.txt` and writes audit_log rows.");
    const decisions: string[][] = [];
    const kept = applyRelevanceFloor([doc], "install-hooks allowlist audit", null, "myapp", undefined, undefined, (_row, d) => decisions.push(d.matched));
    expect(kept).toEqual([doc]);
    expect(decisions).toEqual([["install-hook", "allowlist", "audit"]]);
  });

  it("never matches the path: every store path contains .phren", () => {
    const doc = { ...makeDocRow("designstudio", "FINDINGS.md", "findings", "- Delegation notes for the studio."),
      path: "/home/sam/.phren/designstudio/FINDINGS.md" };
    expect(applyRelevanceFloor([doc], "phren delegation", null, null, undefined, new Map([["phren", 0.9], ["delegation", 0.9]]))).toHaveLength(0);
  });

  it("is a no-op when the floor is 0 (disabled)", () => {
    const rows = [makeDocRow("zeta", "notes.md", "findings", "totally unrelated content")];
    const kept = applyRelevanceFloor(rows, KEYWORDS, null, null, 0);
    expect(kept).toHaveLength(1);
  });

  it("injects nothing when the prompt has fewer keywords than a bullet must match (\"Yes\")", () => {
    const rows = [makeDocRow("zeta", "notes.md", "findings", "- yes, totally unrelated content")];
    expect(applyRelevanceFloor(rows, "", null, null)).toHaveLength(0);
    expect(applyRelevanceFloor(rows, "yes", null, null)).toHaveLength(0);
    // A changed file is still a tie to the work.
    const changed = makeDocRow("zeta", "auth-config.md", "findings", "anything");
    expect(applyRelevanceFloor([changed], "yes", { changedFiles: new Set(["auth-config.md"]) }, "zeta")).toHaveLength(1);
  });
});

describe("applyTrustFilter: retired bullets", () => {
  const today = new Date().toISOString().slice(0, 10);
  const topic = (bullets: string[]): DocRow => ({
    project: "zeta", filename: "auth.md", type: "reference", path: "/tmp/zeta/reference/topics/auth.md",
    content: `# auth\n\n## Archived ${today}\n\n${bullets.join("\n")}\n`,
  });
  const filter = (rows: DocRow[]) => applyTrustFilter(rows, 3650, 0, { enabled: false }).rows;

  it("never injects a superseded or retracted bullet from a topic archive", () => {
    const rows = filter([topic([
      `- Rotate the session token on every privilege change <!-- created: ${today} -->`,
      `- Rotate the session token weekly <!-- created: ${today} --> <!-- phren:status "superseded" -->`,
      `- Session tokens never expire <!-- created: ${today} --> <!-- phren:status "retracted" -->`,
      `- Rotate the session token hourly <!-- created: ${today} --> <!-- superseded_by: "Rotate the session token on every privilege change" -->`,
      `- Session tokens live in the keychain <!-- created: ${today} --> <!-- phren:status "contradicted" -->`,
    ])]);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toContain("on every privilege change");
    expect(rows[0].content).toContain("live in the keychain");
    expect(rows[0].content).not.toContain("weekly");
    expect(rows[0].content).not.toContain("never expire");
    expect(rows[0].content).not.toContain("hourly");
    const { selected } = selectSnippets(rows, "rotate session token", 2000, 10, 2000);
    expect(selected.map((s) => s.snippet).join("\n")).not.toMatch(/weekly|hourly|never expire/);
  });

  it("injects nothing from an archive whose matching bullets are all retired", () => {
    const rows = filter([topic([
      `- Rotate the session token weekly <!-- created: ${today} --> <!-- phren:status "superseded" -->`,
      `- Session tokens never expire <!-- created: ${today} --> <!-- phren:status "retracted" -->`,
    ])]);
    expect(rows.map((r) => r.content).join("\n")).not.toMatch(/weekly|never expire/);
    expect(applyRelevanceFloor(rows, "rotate session token", null, "zeta")).toHaveLength(0);
  });
});

describe("selectSnippets: the bullet the floor accepted", () => {
  const doc: DocRow = {
    project: "zeta", filename: "auth.md", type: "reference", path: "/tmp/zeta/reference/topics/auth.md",
    content: "# auth\n\n- Rotate the token weekly in staging.\n- The keychain holds the token on every laptop.\n",
  };

  it("shows the bullet with the rarer matched keywords, as the floor weighs them", () => {
    const rarity = new Map([["rotate", 0.1], ["keychain", 0.9], ["token", 0.1]]);
    const floorMatch = applyRelevanceFloor([doc], "rotate keychain token", null, "zeta", undefined, rarity);
    expect(floorMatch).toHaveLength(1);
    const { selected } = selectSnippets([doc], "rotate keychain token", 2000, 10, 2000, rarity);
    expect(selected[0].snippet).toContain("keychain holds the token");
    expect(selected[0].snippet).not.toContain("weekly");
  });

  it("without rarity keeps the first of equally matching, equally long bullets", () => {
    const { selected } = selectSnippets([doc], "rotate keychain token", 2000, 10, 2000);
    expect(selected[0].snippet).toContain("weekly");
  });

  it("of bullets matching the same keywords, shows the shorter: a long one mentions them in passing", () => {
    const archive: DocRow = { ...doc, content: "# auth\n\n"
      + "- Sync notes: since the last merge the token refresh, keychain migration, staging rollout and laptop setup live in the shared runbook.\n"
      + "- The keychain holds the refresh token.\n" };
    const { selected } = selectSnippets([archive], "keychain token", 2000, 10, 2000);
    expect(selected[0].snippet).toContain("keychain holds the refresh token");
  });
});

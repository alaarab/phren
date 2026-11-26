import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { makeTempDir, grantAdmin, writeFile } from "../test-helpers.js";
import { addFindingToFile, addFindingsToFile } from "../shared/content.js";

const PROJECT = "testapp";

let tmp: { path: string; cleanup: () => void };

function seedProject(phrenPath: string, project = PROJECT) {
  const dir = path.join(phrenPath, project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "summary.md"), `# ${project}\n`);
}

function findingsPath(project = PROJECT) {
  return path.join(tmp.path, project, "FINDINGS.md");
}

function writeSession(sessionId: string, project = PROJECT) {
  const dir = path.join(tmp.path, ".runtime", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `session-${sessionId}.json`),
    JSON.stringify({
      sessionId,
      project,
      startedAt: "2026-03-09T10:00:00.000Z",
      findingsAdded: 0,
    }),
  );
}

beforeEach(() => {
  tmp = makeTempDir("content-learning-test-");
  grantAdmin(tmp.path);
  seedProject(tmp.path);
});

afterEach(() => {
  delete process.env.PHREN_ACTOR;
  delete process.env.OPENAI_MODEL;
  tmp.cleanup();
});

// ── Q13: content-learning.ts tests ──────────────────────────────────────────

describe("addFinding happy path", () => {
  it("adds finding to FINDINGS.md with correct format", () => {
    const r = addFindingToFile(tmp.path, PROJECT, "Always use parameterized queries to prevent SQL injection");
    expect(r.ok).toBe(true);
    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toContain("Always use parameterized queries");
    expect(content).toContain("<!-- created:");
    // Should have the project heading
    expect(content).toContain(`# ${PROJECT} Findings`);
  });
});

describe("archived finding dedup", () => {
  function archive(line: string, name = "rules.md") {
    const file = path.join(tmp.path, PROJECT, "reference", "topics", name);
    writeFile(file, `## 2026-01-01\n\n${line}\n`);
    return file;
  }

  it.each(["rules.md", "rules.older.md"])("refuses exact normalized archive duplicates in %s and names their id", (name) => {
    archive('- [pattern] Use Redis   for session storage [confidence 0.8] <!-- fid:deadbeef -->', name);
    const result = addFindingToFile(tmp.path, PROJECT, "[decision] USE REDIS for session storage");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("skipped");
    expect(result.data.message).toContain("fid:deadbeef");
    expect(fs.existsSync(findingsPath())).toBe(false);
  });

  it("names the archive file when a duplicate has no id, including bulk adds", () => {
    const file = archive("- Use Redis for session storage");
    writeFile(findingsPath(), "# Findings\n");
    const result = addFindingToFile(tmp.path, PROJECT, "Use Redis for session storage");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("skipped");
    expect(result.data.message).toContain(file);
    const bulk = addFindingsToFile(tmp.path, PROJECT, ["Use Redis for session storage"]);
    expect(bulk.ok).toBe(true);
    if (!bulk.ok) return;
    expect(bulk.data.added).toEqual([]);
    expect(bulk.data.skipped).toEqual(["Use Redis for session storage"]);
    expect(bulk.data).toMatchObject({ duplicates: [{ text: "Use Redis for session storage", file }] });
  });

  it("allows near archive matches even when fuzzy dedup would reject them", () => {
    archive("- Use Redis for session storage");
    const result = addFindingToFile(tmp.path, PROJECT, "Use Redis for session storage with a five minute expiry");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.status).toBe("created");
    expect(fs.readFileSync(findingsPath(), "utf8")).toContain("five minute expiry");
  });

  it.each(["superseded", "retracted"])("allows an exact duplicate of a %s archive bullet", (status) => {
    archive(`- Use Redis for session storage <!-- fid:deadbeef --> <!-- phren:status "${status}" -->`);
    const result = addFindingToFile(tmp.path, PROJECT, "Use Redis for session storage");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.status).toBe("created");
    expect(fs.readFileSync(findingsPath(), "utf8")).toContain("Use Redis for session storage");
  });

  it("finds an exact duplicate among 2,000 archived bullets", () => {
    writeFile(findingsPath(), "# Findings\n");
    for (let topic = 0; topic < 20; topic++) {
      archive(Array.from({ length: 100 }, (_, i) => `- Session cache rule ${topic * 100 + i} uses Redis with explicit expiry <!-- fid:${(topic * 100 + i).toString(16).padStart(8, "0")} -->`).join("\n"), `topic-${String(topic).padStart(2, "0")}.md`);
    }
    const result = addFindingToFile(tmp.path, PROJECT, "Session cache rule 1999 uses Redis with explicit expiry");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe("skipped");
      expect(result.data.message).toContain("fid:000007cf");
    }
  });
});

describe("addFindings bulk", () => {
  it("adds 5 findings at once and all appear", () => {
    const findings = [
      "Redis caching strategy uses TTL of 300 seconds for session data",
      "Database migrations must be backward compatible for zero-downtime deploys",
      "API rate limiting uses token bucket algorithm with per-user quotas",
      "WebSocket connections require heartbeat every 30 seconds to avoid timeout",
      "File uploads are processed asynchronously via queue to prevent request timeout",
    ];
    const r = addFindingsToFile(tmp.path, PROJECT, findings);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.added).toHaveLength(5);
    expect(r.data.skipped).toHaveLength(0);

    const content = fs.readFileSync(findingsPath(), "utf-8");
    for (const finding of findings) {
      // Check that some significant portion of each finding appears
      expect(content).toContain(finding.slice(0, 30));
    }
  });

  it("persists extra conflict annotations passed by bulk callers", () => {
    const findings = [
      "Use Redis for session storage",
      "Prefer Postgres for transactional workloads",
    ];
    const r = addFindingsToFile(tmp.path, PROJECT, findings, {
      extraAnnotationsByFinding: [
        ['<!-- conflicts_with: "Never use Redis for sessions" (from project: global) -->'],
        [],
      ],
    });
    expect(r.ok).toBe(true);

    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toContain('conflicts_with: "Never use Redis for sessions"');
    expect(content).toContain("from project: global");
  });
});

describe("addFinding does not auto-mark heuristic conflicts", () => {
  it("keeps a conflicting finding active and writes no conflict marker (the agent decides instead)", () => {
    const r1 = addFindingToFile(tmp.path, PROJECT, "Always use Docker for build caching to speed up local development");
    expect(r1.ok).toBe(true);

    const r2 = addFindingToFile(tmp.path, PROJECT, "Never use Docker for build caching — bare metal is faster for our pipeline");
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.data.status).toBe("added");

    const content = fs.readFileSync(findingsPath(), "utf-8");
    // The stored finding is never silently demoted or annotated by the lexical heuristic —
    // contradiction handling is surfaced to the agent by the MCP tool, not written to disk here.
    expect(content).not.toContain('phren:status "contradicted"');
    expect(content).not.toContain("phren:contradicts");
    expect(content).not.toContain("phren:possible_conflict");
  });
});

describe("finding provenance", () => {
  it("writes scope comment instead of source comment on finding bullets", () => {
    const result = addFindingToFile(tmp.path, PROJECT, "Hook-generated context should be tracked", undefined, {
      scope: "builder",
    });
    expect(result.ok).toBe(true);

    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toContain("<!-- scope:builder -->");
    expect(content).not.toContain("<!-- source:");
  });

  it("omits scope comment when scope is shared or unset", () => {
    const result = addFindingToFile(tmp.path, PROJECT, "No scope comment needed for shared");
    expect(result.ok).toBe(true);

    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).not.toContain("<!-- scope:");
    expect(content).not.toContain("<!-- source:");
  });

  it("auto-stamps active task citation", () => {
    grantAdmin(tmp.path, "codex-worker");
    process.env.PHREN_ACTOR = "codex-worker";
    writeFile(
      path.join(tmp.path, PROJECT, "tasks.md"),
      `# ${PROJECT} tasks

## Active

- [ ] Finish phase seven [high] <!-- bid:deadbeef -->

## Queue

- [ ] Later item <!-- bid:cafebabe -->
`,
    );
    writeSession("session-1234");

    const result = addFindingToFile(tmp.path, PROJECT, "Operator-surface refactor is safe to continue in smaller slices");
    expect(result.ok).toBe(true);

    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toContain('"task_item":"deadbeef"');
    // Source metadata no longer written — only scope (if non-shared)
    expect(content).not.toContain("<!-- source:");
  });

  it("resolves explicit task_item references to the stable ID", () => {
    writeFile(
      path.join(tmp.path, PROJECT, "tasks.md"),
      `# ${PROJECT} tasks

## Active

- [ ] Finish phase seven [high] <!-- bid:deadbeef -->
`,
    );

    const result = addFindingToFile(tmp.path, PROJECT, "Task linkage should survive reordering", {
      task_item: "A1",
    });
    expect(result.ok).toBe(true);

    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toContain('"task_item":"deadbeef"');
  });

  it("rejects invalid task_item references", () => {
    writeFile(
      path.join(tmp.path, PROJECT, "tasks.md"),
      `# ${PROJECT} tasks

## Active

- [ ] Finish phase seven [high] <!-- bid:deadbeef -->
`,
    );

    const result = addFindingToFile(tmp.path, PROJECT, "This should not save", {
      task_item: "missing item",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("VALIDATION_ERROR");
  });

  it("does not infer citation repo metadata from the enclosing phren store", () => {
    execFileSync("git", ["init"], { cwd: tmp.path, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Vitest"], { cwd: tmp.path, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "vitest@example.com"], { cwd: tmp.path, stdio: "ignore" });
    writeFile(path.join(tmp.path, "notes.md"), "seed\n");
    execFileSync("git", ["add", "."], { cwd: tmp.path, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "seed"], { cwd: tmp.path, stdio: "ignore" });

    const result = addFindingToFile(tmp.path, PROJECT, "Synthesized findings should not cite the phren store repo by default");
    expect(result.ok).toBe(true);

    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toContain("<!-- phren:cite");
    expect(content).not.toContain(`"repo":"${tmp.path}"`);
    expect(content).not.toContain('"commit":');
    expect(content).not.toContain('"file":');
    expect(content).not.toContain('"line":');
  });
});

describe("portable citations", () => {
  let checkout: string;
  let head: string;
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: checkout, encoding: "utf8" }).trim();
  const lastCitation = () => {
    const line = fs.readFileSync(findingsPath(), "utf-8").split("\n").find(l => l.includes("phren:cite"))!;
    return JSON.parse(line.replace(/^\s*<!-- phren:cite /, "").replace(/ -->\s*$/, ""));
  };

  beforeEach(() => {
    checkout = path.join(tmp.path, "..", `${path.basename(tmp.path)}-checkout`);
    fs.mkdirSync(checkout);
    git("init", "-q");
    writeFile(path.join(checkout, "src", "net", "retry.ts"), "export const budget = 3;\n");
    writeFile(path.join(checkout, "src", "net", "index.ts"), "export {};\n");
    writeFile(path.join(checkout, "src", "ui", "index.ts"), "export {};\n");
    git("add", "-A");
    git("commit", "-qm", "seed");
    head = git("rev-parse", "HEAD");
    git("remote", "add", "origin", "https://x-access-token:not-a-real-token@github.com/Acme/Widgets.git");
    writeFile(path.join(tmp.path, PROJECT, "phren.project.yaml"), `sourcePath: ${checkout}\n`);
  });

  afterEach(() => fs.rmSync(checkout, { recursive: true, force: true }));

  it("cites the project's checkout by its remote and HEAD when the caller gives no citation", () => {
    expect(addFindingToFile(tmp.path, PROJECT, "Retries back off exponentially with jitter").ok).toBe(true);
    expect(lastCitation()).toEqual({ created_at: expect.any(String), remote: "github.com/Acme/Widgets", commit: head });
    expect(fs.readFileSync(findingsPath(), "utf-8")).not.toContain("not-a-real-token");
  });

  it("cites the one tracked file a finding names, and no line", () => {
    addFindingToFile(tmp.path, PROJECT, "The retry budget lives in src/net/retry.ts and nowhere else");
    expect(lastCitation()).toMatchObject({ remote: "github.com/Acme/Widgets", file: "src/net/retry.ts", commit: head });
    expect(lastCitation().line).toBeUndefined();
  });

  it("cites no file when the named path is ambiguous or more than one file is named", () => {
    addFindingToFile(tmp.path, PROJECT, "Every barrel file is called index.ts in this repo");
    expect(lastCitation().file).toBeUndefined();
    fs.rmSync(findingsPath());
    addFindingsToFile(tmp.path, PROJECT, ["Both net/retry.ts and ui/index.ts read the retry budget at start-up"]);
    expect(lastCitation()).toMatchObject({ remote: "github.com/Acme/Widgets", commit: head });
    expect(lastCitation().file).toBeUndefined();
  });

  it("makes a caller's absolute file repo-relative and keeps the caller's line and commit", () => {
    addFindingToFile(tmp.path, PROJECT, "The budget constant is read once", { file: path.join(checkout, "src", "net", "retry.ts"), line: 1, commit: "abc1234" });
    expect(lastCitation()).toEqual({ created_at: expect.any(String), remote: "github.com/Acme/Widgets", file: "src/net/retry.ts", line: 1, commit: "abc1234" });
  });

  it("keeps a local-only repo's path and never guesses a file from the commit", () => {
    git("remote", "remove", "origin");
    addFindingToFile(tmp.path, PROJECT, "The seed commit set up the network module", { repo: checkout, commit: head });
    expect(lastCitation()).toEqual({ created_at: expect.any(String), repo: checkout, commit: head });
  });
});

describe("error path: invalid project name", () => {
  it("bulk add returns error for invalid project name", () => {
    const r = addFindingsToFile(tmp.path, "../escape", ["Should fail"]);
    expect(r.ok).toBe(false);
  });
});

describe("supersession: failed add does not mutate original finding", () => {
  it("when new finding is a duplicate, old finding is NOT marked superseded", () => {
    const oldFinding = "Use connection pooling for database efficiency";
    addFindingToFile(tmp.path, PROJECT, oldFinding);

    const content1 = fs.readFileSync(findingsPath(), "utf-8");
    expect(content1).toContain("connection pooling");
    expect(content1).not.toContain("superseded_by");

    // Attempt to add the exact same finding as the new one — should be skipped as duplicate
    const r = addFindingToFile(tmp.path, PROJECT, oldFinding, {
      supersedes: oldFinding,
    });

    const content2 = fs.readFileSync(findingsPath(), "utf-8");
    // Old finding must NOT be marked superseded since the new one was rejected
    expect(content2).not.toContain("superseded_by");
    // The result should indicate skipped or ok (not an error crash)
    expect(r.ok).toBe(true);
  });

  it("when new finding targets nonexistent project, nothing is written", () => {
    const r = addFindingToFile(tmp.path, "nonexistent-proj", "Some insight", {
      supersedes: "An old insight",
    });
    expect(r.ok).toBe(false);
    expect(fs.existsSync(path.join(tmp.path, "nonexistent-proj"))).toBe(false);
  });
});

describe("consolidation semantics", () => {
  it("does not write implicit consolidation markers during addFinding", () => {
    const manyFindings = Array.from({ length: 160 }, (_, i) => `- Existing finding ${i + 1}`).join("\n");
    writeFile(
      findingsPath(),
      `# ${PROJECT} Findings\n\n## 2026-03-01\n\n${manyFindings}\n`
    );

    const r = addFindingToFile(tmp.path, PROJECT, "Newest finding after a large task");
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(tmp.path, ".runtime", "consolidation-needed.txt"))).toBe(false);
    if (r.ok && typeof r.data === "string") {
      expect(r.data.toLowerCase()).not.toContain("consolidation cap");
      expect(r.data.toLowerCase()).not.toContain("consider running consolidation");
    }
  });
});

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTestPhrenRoot, makeTempDir } from "../test-helpers.js";

type Actions = typeof import("./actions.js");

class ProcessExit extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

let tmp: { path: string; cleanup: () => void };
let phrenPath: string;
let actions: Actions;
let stdout: string[];
let stderr: string[];

async function exitCodeOf(run: () => unknown): Promise<number> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ProcessExit) return err.code;
    throw err;
  }
  throw new Error("expected process.exit to be called");
}

function project(name: string): string {
  const dir = path.join(phrenPath, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(async () => {
  tmp = makeTempDir("phren-actions-");
  phrenPath = tmp.path;
  initTestPhrenRoot(phrenPath);
  vi.stubEnv("PHREN_PATH", phrenPath);
  vi.resetModules();
  actions = await import("./actions.js");
  stdout = [];
  stderr = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.join(" "));
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
    throw new ProcessExit(typeof code === "number" ? code : 0);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  tmp.cleanup();
});

describe("handleTruths", () => {
  it("lists every pinned truth with its count", async () => {
    const dir = project("alpha");
    fs.writeFileSync(
      path.join(dir, "truths.md"),
      [
        "# alpha Truths",
        "",
        "## Truths",
        "",
        "- Deploy only from a green main branch",
        "- Never rewrite published history",
        "",
      ].join("\n"),
    );

    await actions.handleTruths("alpha");

    const out = stdout.join("\n");
    expect(out).toContain('2 truth(s) for "alpha":');
    expect(out).toContain("  - Deploy only from a green main branch");
    expect(out).toContain("  - Never rewrite published history");
    expect(stderr).toEqual([]);
  });

  it("points at the pin command when a project has no truths file", async () => {
    project("beta");

    await actions.handleTruths("beta");

    const out = stdout.join("\n");
    expect(out).toContain('No truths pinned for "beta" yet.');
    expect(out).toContain('phren pin beta "your truth here"');
  });
});

describe("handleAddFinding", () => {
  it("refuses an invalid project name and writes nothing", async () => {
    expect(await exitCodeOf(() => actions.handleAddFinding("BadName", "A saved insight"))).toBe(1);

    expect(stderr.join("\n")).toContain('Invalid project name: "BadName"');
    expect(fs.existsSync(path.join(phrenPath, "BadName"))).toBe(false);
  });

  it("writes a valid finding into the project's FINDINGS.md", async () => {
    const dir = project("gamma");

    await actions.handleAddFinding("gamma", "Never trust a green build you did not run");

    expect(stdout.join("\n")).toContain('Created FINDINGS.md for "gamma"');
    expect(fs.readFileSync(path.join(dir, "FINDINGS.md"), "utf8"))
      .toContain("Never trust a green build you did not run");
  });
});

describe("handleQualityFeedback", () => {
  it("flushes recorded feedback into the persisted memory scores", async () => {
    const key = "gamma/FINDINGS.md:abc123def456";

    await actions.handleQualityFeedback([`--key=${key}`, "--type=helpful"]);

    expect(stdout.join("\n")).toContain(`Recorded feedback: helpful for ${key}`);
    const scores = JSON.parse(fs.readFileSync(path.join(phrenPath, ".runtime", "memory-scores.json"), "utf8"));
    expect(scores.entries[key]).toMatchObject({ helpful: 1 });
  });

  it("rejects an unknown feedback type without touching the audit log", async () => {
    expect(await exitCodeOf(() =>
      actions.handleQualityFeedback(["--key=gamma/FINDINGS.md:abc", "--type=bogus"])
    )).toBe(1);

    expect(stderr.join("\n")).toContain("Usage: phren quality-feedback");
    expect(fs.existsSync(path.join(phrenPath, ".runtime", "audit.log"))).toBe(false);
  });
});

describe("handleReview", () => {
  it("prints each queued item with its confidence and risky flag", async () => {
    const dir = project("delta");
    fs.writeFileSync(
      path.join(dir, "review.md"),
      [
        "# delta Review Queue",
        "",
        "## Review",
        "",
        "- [2026-03-01] [confidence 0.92] Keep the cache warm",
        "",
        "## Stale",
        "",
        "- [2026-02-01] Old enough to drop",
        "",
        "## Conflicts",
        "",
      ].join("\n"),
    );

    await actions.handleReview(["delta"]);

    const out = stdout.join("\n");
    expect(out).toContain("Review queue: delta (2 item(s))");
    expect(out).toContain("[Review] 2026-03-01  Keep the cache warm [conf: 0.92]");
    expect(out).toContain("[Stale] 2026-02-01  Old enough to drop ⚠");
  });

  it("groups an all-project review by project name", async () => {
    fs.writeFileSync(
      path.join(project("alpha"), "review.md"),
      "# alpha Review Queue\n\n## Review\n\n- [2026-03-01] Alpha item\n",
    );
    fs.writeFileSync(
      path.join(project("delta"), "review.md"),
      "# delta Review Queue\n\n## Review\n\n- [2026-03-02] Delta item\n",
    );

    await actions.handleReview([]);

    const out = stdout.join("\n");
    expect(out).toContain("Review queue: 2 item(s) across all projects");
    expect(out).toContain("## alpha");
    expect(out).toContain("Alpha item");
    expect(out).toContain("## delta");
    expect(out).toContain("Delta item");
  });
});

describe("handleConsolidationStatus", () => {
  it("reports entries since the last consolidation and recommends one at the threshold", async () => {
    const dir = project("epsilon");
    const bullets = Array.from({ length: 25 }, (_, i) => `- Finding number ${i + 1}`).join("\n");
    fs.writeFileSync(
      path.join(dir, "FINDINGS.md"),
      `# epsilon FINDINGS\n\n## 2026-03-01\n\n${bullets}\n`,
    );

    await actions.handleConsolidationStatus(["epsilon"]);

    const out = stdout.join("\n");
    expect(out).toContain("Consolidation status:");
    expect(out).toContain("epsilon: 25/25 entries since never consolidated");
    expect(out).toContain("→ consolidation recommended");
  });
});

describe("handleSessionContext", () => {
  it("prints the active session's scope, counts and prior summary", async () => {
    fs.mkdirSync(path.join(phrenPath, ".runtime", "sessions"), { recursive: true });
    fs.writeFileSync(
      path.join(phrenPath, ".runtime", "sessions", "session-test.json"),
      JSON.stringify({
        sessionId: "abcdef12-3456-7890",
        project: "zeta",
        agentScope: "worker",
        startedAt: "2026-03-01T10:00:00.000Z",
        findingsAdded: 3,
        tasksCompleted: 2,
        summary: "Prior work",
      }),
    );

    actions.handleSessionContext();

    const out = stdout.join("\n");
    expect(out).toContain("Session:         abcdef12");
    expect(out).toContain("Project:         zeta");
    expect(out).toContain("Agent scope:     worker");
    expect(out).toContain("Started:         2026-03-01 10:00");
    expect(out).toContain("Findings added:  3");
    expect(out).toContain("Tasks completed: 2");
    expect(out).toContain("Prior summary:   Prior work");
  });
});

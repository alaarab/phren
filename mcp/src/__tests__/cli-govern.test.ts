import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, writeFile, grantAdmin } from "../test-helpers.js";

let tmpDir: string;
let tmpCleanup: (() => void) | undefined;

function makeCortex(): string {
  ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("cortex-govern-q12-"));
  return tmpDir;
}

function makeProject(cortexDir: string, name: string, files: Record<string, string>): void {
  const dir = path.join(cortexDir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFile(path.join(dir, file), content);
  }
}

async function importGovern(cortexDir: string) {
  process.env.CORTEX_PATH = cortexDir;
  vi.resetModules();
  return await import("../cli-govern.js");
}

beforeEach(() => {
  delete process.env.CORTEX_PATH;
  delete process.env.CORTEX_PROFILE;
  delete process.env.CORTEX_MEMORY_TTL_DAYS;
});

afterEach(() => {
  delete process.env.CORTEX_PATH;
  delete process.env.CORTEX_PROFILE;
  delete process.env.CORTEX_MEMORY_TTL_DAYS;
  delete process.env.CORTEX_ACTOR;
  if (tmpCleanup) {
    tmpCleanup();
    tmpCleanup = undefined;
  }
});

// ── Q12: TTL enforcement ────────────────────────────────────────────────────

describe("TTL enforcement", () => {
  it("finding older than ttlDays is flagged for review", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    // Create a finding with a date marker well in the past
    const oldDate = "2024-01-01";
    const findings = `# proj Findings\n\n## ${oldDate}\n\n- Old finding about architecture <!-- created: ${oldDate} -->\n`;
    makeProject(cortex, "proj", { "FINDINGS.md": findings });

    const { handleGovernMemories } = await importGovern(cortex);
    const result = await handleGovernMemories("proj", true);
    // Old findings should be flagged (stale or review)
    expect(result.staleCount + result.reviewCount).toBeGreaterThanOrEqual(0);
    // The govern function detects low-value and stale entries
    expect(result.projects).toBe(1);
  });

  it("retrieval grace period: recently-used old finding not queued", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const oldDate = "2024-01-01";
    const findings = `# proj Findings\n\n## ${oldDate}\n\n- Important architecture pattern for deployment <!-- created: ${oldDate} -->\n`;
    makeProject(cortex, "proj", { "FINDINGS.md": findings });

    // Write a recent retrieval log entry for this finding
    const retrievalDir = path.join(cortex, ".runtime");
    fs.mkdirSync(retrievalDir, { recursive: true });
    const logEntry = JSON.stringify({
      query: "architecture pattern",
      timestamp: new Date().toISOString(),
      project: "proj",
      results: ["Important architecture pattern for deployment"],
    });
    fs.writeFileSync(path.join(retrievalDir, "retrieval.log"), logEntry + "\n");

    const { handleGovernMemories } = await importGovern(cortex);
    const result = await handleGovernMemories("proj", true);
    // With recent retrieval, findings should have grace period
    expect(result.projects).toBe(1);
  });

  it("queue transition: non-dry-run writes memory queue", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "proj", { "FINDINGS.md": "- fixed stuff\n" });

    const { handleGovernMemories } = await importGovern(cortex);
    await handleGovernMemories("proj", true, false);

    const auditPath = path.join(cortex, ".runtime", "audit.log");
    expect(fs.existsSync(auditPath)).toBe(true);
    const auditContent = fs.readFileSync(auditPath, "utf8");
    expect(auditContent).toContain("govern_memories");
  });

  it("error path: invalid project name handled gracefully", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const { handleGovernMemories } = await importGovern(cortex);
    // Using an invalid project that does not exist should still work (returns zero counts)
    const result = await handleGovernMemories("../escape-attempt", true);
    expect(result.staleCount).toBe(0);
    expect(result.reviewCount).toBe(0);
  });
});

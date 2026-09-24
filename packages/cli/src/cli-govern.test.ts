import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, writeFile, grantAdmin, resetTestPhrenPath } from "./test-helpers.js";

let tmpDir: string;
let tmpCleanup: (() => void) | undefined;

function makePhren(): string {
  ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("phren-govern-test-"));
  return tmpDir;
}

function makeProject(phrenDir: string, name: string, files: Record<string, string>): void {
  const dir = path.join(phrenDir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFile(path.join(dir, file), content);
  }
}

// cli-govern.ts reads phrenPath at module top level via ensurePhrenPath(),
// so we must set PHREN_PATH before importing. We use dynamic import + vi.resetModules().
async function importGovern(phrenDir: string) {
  process.env.PHREN_PATH = phrenDir;
  vi.resetModules();
  return await import("./cli/govern.js");
}

beforeEach(() => {
  resetTestPhrenPath();
  delete process.env.PHREN_PROFILE;
  delete process.env.PHREN_MEMORY_TTL_DAYS;
});

afterEach(() => {
  resetTestPhrenPath();
  delete process.env.PHREN_PROFILE;
  delete process.env.PHREN_MEMORY_TTL_DAYS;
  delete process.env.PHREN_ACTOR;
  if (tmpCleanup) {
    tmpCleanup();
    tmpCleanup = undefined;
  }
});

// ── handleGovernMemories ─────────────────────────────────────────────────────

describe("handleGovernMemories", () => {
  it("returns zero counts when no projects exist", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    const { handleGovernMemories } = await importGovern(phren);
    const result = await handleGovernMemories(undefined, true);
    expect(result).toMatchObject({
      staleCount: 0,
      conflictCount: 0,
      reviewCount: 0,
    });
  });

  it("returns zero counts when FINDINGS.md does not exist", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "myproject", { "SUMMARY.md": "# Summary" });
    const { handleGovernMemories } = await importGovern(phren);
    const result = await handleGovernMemories("myproject", true);
    expect(result.staleCount).toBe(0);
    expect(result.conflictCount).toBe(0);
    expect(result.reviewCount).toBe(0);
  });

  it("detects low-value findings for review", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    const findings = [
      "- fixed stuff",
      "- This is a proper finding about architecture patterns",
      "- wip",
      "- temp",
      "- short",
      "- also tiny",
    ].join("\n");
    makeProject(phren, "testproj", { "FINDINGS.md": findings });
    const { handleGovernMemories } = await importGovern(phren);
    const result = await handleGovernMemories("testproj", true);
    // "fixed stuff", "wip", "temp" and the two short (<16 chars) entries are flagged
    expect(result.reviewCount).toBeGreaterThanOrEqual(5);
  });

  it("non-dry-run writes review queue and audit log", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "proj", { "FINDINGS.md": "- fixed stuff\n" });
    const { handleGovernMemories } = await importGovern(phren);
    await handleGovernMemories("proj", true, false);
    const auditPath = path.join(phren, ".runtime", "audit.log");
    expect(fs.existsSync(auditPath)).toBe(true);
    const auditContent = fs.readFileSync(auditPath, "utf8");
    expect(auditContent).toContain("govern_memories");
  });
});

// ── handleMaintain router ────────────────────────────────────────────────────

// ── handleBackgroundMaintenance ──────────────────────────────────────────────

describe("handleBackgroundMaintenance", () => {
  it("writes quality marker and runtime health on success", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "proj", { "FINDINGS.md": "- a finding\n" });
    const { handleBackgroundMaintenance } = await importGovern(phren);
    await handleBackgroundMaintenance("proj");
    // Check runtime health was updated
    const healthPath = path.join(phren, ".runtime", "runtime-health.json");
    expect(fs.existsSync(healthPath)).toBe(true);
    const health = JSON.parse(fs.readFileSync(healthPath, "utf8"));
    expect(health.lastGovernance).toBeDefined();
    expect(health.lastGovernance.status).toBe("ok");
    expect(fs.readFileSync(path.join(phren, ".runtime", "audit.log"), "utf8")).toContain("background_maintenance");
  });

  it("promotes TTL-expired findings to the Stale queue", async () => {
    // Regression: promotion used to live in handlePruneMemories, so nightly maintenance —
    // which calls pruneDeadMemories directly — never ran it and ## Stale stayed empty.
    const phren = makePhren();
    grantAdmin(phren);
    const today = new Date().toISOString().slice(0, 10);
    makeProject(phren, "proj", {
      "FINDINGS.md": `# proj Findings\n\n## ${today}\n\n- Deploy ordering rule nobody reads anymore <!-- created: 2020-01-01 -->\n`,
    });

    const { handleBackgroundMaintenance } = await importGovern(phren);
    await handleBackgroundMaintenance("proj");

    const queue = fs.readFileSync(path.join(phren, "proj", "review.md"), "utf8");
    const staleSection = queue.split("## Stale")[1] ?? "";
    expect(staleSection).toContain("[ttl-expired: 2020-01-01]");
    expect(staleSection).toContain("Deploy ordering rule nobody reads anymore");
  });

  it("cleans up lock file even on success", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    const { handleBackgroundMaintenance } = await importGovern(phren);
    await handleBackgroundMaintenance();
    // Lock file should not persist
    const runtimeDir = path.join(phren, ".runtime");
    if (fs.existsSync(runtimeDir)) {
      const files = fs.readdirSync(runtimeDir);
      const lockFiles = files.filter((f) => f.includes("quality-") && f.endsWith(".lock"));
      expect(lockFiles).toHaveLength(0);
    }
  });
});

// ── TTL enforcement ────────────────────────────────────────────────────

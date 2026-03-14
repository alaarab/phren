import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, writeFile, grantAdmin, suppressOutput } from "./test-helpers.js";

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
  return await import("./cli-govern.js");
}

beforeEach(() => {
  delete process.env.PHREN_PATH;
  delete process.env.PHREN_PROFILE;
  delete process.env.PHREN_MEMORY_TTL_DAYS;
});

afterEach(() => {
  delete process.env.PHREN_PATH;
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
    ].join("\n");
    makeProject(phren, "testproj", { "FINDINGS.md": findings });
    const { handleGovernMemories } = await importGovern(phren);
    const result = await handleGovernMemories("testproj", true);
    // "fixed stuff", "wip", "temp" should be flagged
    expect(result.reviewCount).toBeGreaterThanOrEqual(3);
  });

  it("detects short findings (<16 chars) for review", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "proj", { "FINDINGS.md": "- short\n- also tiny\n" });
    const { handleGovernMemories } = await importGovern(phren);
    const result = await handleGovernMemories("proj", true);
    expect(result.reviewCount).toBeGreaterThanOrEqual(1);
  });

  it("dry-run does not write audit log or review queue", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "proj", { "FINDINGS.md": "- fixed stuff\n" });
    const { handleGovernMemories } = await importGovern(phren);
    await handleGovernMemories("proj", true, true);
    const queuePath = path.join(phren, "proj", "review.md");
    expect(fs.existsSync(queuePath)).toBe(false);
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

  it("returns correct project count for single project", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "alpha", { "FINDINGS.md": "- good finding here about patterns\n" });
    const { handleGovernMemories } = await importGovern(phren);
    const result = await handleGovernMemories("alpha", true);
    expect(result.projects).toBe(1);
  });
});

// ── handleMaintain router ────────────────────────────────────────────────────

describe("handleMaintain", () => {
  it("routes govern subcommand", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "proj", { "FINDINGS.md": "- a valid finding line\n" });
    const { handleMaintain } = await importGovern(phren);
    // Should not throw
    await suppressOutput(() => handleMaintain(["govern", "proj", "--dry-run"]));
  });

  it("routes prune subcommand without error", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "proj", { "FINDINGS.md": "- a finding\n" });
    const { handleMaintain } = await importGovern(phren);
    await suppressOutput(() => handleMaintain(["prune", "proj", "--dry-run"]));
  });

  it("routes consolidate subcommand without error", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "proj", { "FINDINGS.md": "- a finding\n" });
    const { handleMaintain } = await importGovern(phren);
    await suppressOutput(() => handleMaintain(["consolidate", "proj", "--dry-run"]));
  });

  it("prints help for unknown subcommand and exits", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    const { handleMaintain } = await importGovern(phren);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await suppressOutput(() => handleMaintain(["unknown-sub"]));
    } catch (e: any) {
      expect(e.message).toBe("process.exit");
    }
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("prints help without error for no subcommand", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    const { handleMaintain } = await importGovern(phren);
    // undefined subcommand => prints help, no exit
    await suppressOutput(() => handleMaintain([]));
  });
});

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
  });

  it("writes audit log entry for background maintenance", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "proj", { "FINDINGS.md": "- finding\n" });
    const { handleBackgroundMaintenance } = await importGovern(phren);
    await handleBackgroundMaintenance("proj");
    const auditPath = path.join(phren, ".runtime", "audit.log");
    const auditContent = fs.readFileSync(auditPath, "utf8");
    expect(auditContent).toContain("background_maintenance");
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

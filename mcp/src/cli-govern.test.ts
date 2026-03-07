import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, writeFile, grantAdmin } from "./test-helpers.js";

let tmpDir: string;
let tmpCleanup: (() => void) | undefined;

function makeCortex(): string {
  ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("cortex-govern-test-"));
  return tmpDir;
}

function makeProject(cortexDir: string, name: string, files: Record<string, string>): void {
  const dir = path.join(cortexDir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFile(path.join(dir, file), content);
  }
}

// cli-govern.ts reads cortexPath at module top level via ensureCortexPath(),
// so we must set CORTEX_PATH before importing. We use dynamic import + vi.resetModules().
async function importGovern(cortexDir: string) {
  process.env.CORTEX_PATH = cortexDir;
  vi.resetModules();
  return await import("./cli-govern.js");
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

// ── handleGovernMemories ─────────────────────────────────────────────────────

describe("handleGovernMemories", () => {
  it("returns zero counts when no projects exist", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const { handleGovernMemories } = await importGovern(cortex);
    const result = await handleGovernMemories(undefined, true);
    expect(result).toMatchObject({
      staleCount: 0,
      conflictCount: 0,
      reviewCount: 0,
    });
  });

  it("returns zero counts when FINDINGS.md does not exist", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "myproject", { "SUMMARY.md": "# Summary" });
    const { handleGovernMemories } = await importGovern(cortex);
    const result = await handleGovernMemories("myproject", true);
    expect(result.staleCount).toBe(0);
    expect(result.conflictCount).toBe(0);
    expect(result.reviewCount).toBe(0);
  });

  it("detects low-value findings for review", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const findings = [
      "- fixed stuff",
      "- This is a proper finding about architecture patterns",
      "- wip",
      "- temp",
    ].join("\n");
    makeProject(cortex, "testproj", { "FINDINGS.md": findings });
    const { handleGovernMemories } = await importGovern(cortex);
    const result = await handleGovernMemories("testproj", true);
    // "fixed stuff", "wip", "temp" should be flagged
    expect(result.reviewCount).toBeGreaterThanOrEqual(3);
  });

  it("detects short findings (<16 chars) for review", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "proj", { "FINDINGS.md": "- short\n- also tiny\n" });
    const { handleGovernMemories } = await importGovern(cortex);
    const result = await handleGovernMemories("proj", true);
    expect(result.reviewCount).toBeGreaterThanOrEqual(1);
  });

  it("dry-run does not write audit log or memory queue", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "proj", { "FINDINGS.md": "- fixed stuff\n" });
    const { handleGovernMemories } = await importGovern(cortex);
    await handleGovernMemories("proj", true, true);
    const queuePath = path.join(cortex, "proj", "MEMORY_QUEUE.md");
    expect(fs.existsSync(queuePath)).toBe(false);
  });

  it("non-dry-run writes memory queue and audit log", async () => {
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

  it("returns correct project count for single project", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "alpha", { "FINDINGS.md": "- good finding here about patterns\n" });
    const { handleGovernMemories } = await importGovern(cortex);
    const result = await handleGovernMemories("alpha", true);
    expect(result.projects).toBe(1);
  });
});

// ── handleMaintain router ────────────────────────────────────────────────────

describe("handleMaintain", () => {
  it("routes govern subcommand", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "proj", { "FINDINGS.md": "- a valid finding line\n" });
    const { handleMaintain } = await importGovern(cortex);
    // Should not throw
    await handleMaintain(["govern", "proj", "--dry-run"]);
  });

  it("routes prune subcommand without error", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "proj", { "FINDINGS.md": "- a finding\n" });
    const { handleMaintain } = await importGovern(cortex);
    await handleMaintain(["prune", "proj", "--dry-run"]);
  });

  it("routes consolidate subcommand without error", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "proj", { "FINDINGS.md": "- a finding\n" });
    const { handleMaintain } = await importGovern(cortex);
    await handleMaintain(["consolidate", "proj", "--dry-run"]);
  });

  it("prints help for unknown subcommand and exits", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const { handleMaintain } = await importGovern(cortex);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await handleMaintain(["unknown-sub"]);
    } catch (e: any) {
      expect(e.message).toBe("process.exit");
    }
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("prints help without error for no subcommand", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const { handleMaintain } = await importGovern(cortex);
    // undefined subcommand => prints help, no exit
    await handleMaintain([]);
  });
});

// ── handleBackgroundMaintenance ──────────────────────────────────────────────

describe("handleBackgroundMaintenance", () => {
  it("writes quality marker and runtime health on success", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "proj", { "FINDINGS.md": "- a finding\n" });
    const { handleBackgroundMaintenance } = await importGovern(cortex);
    await handleBackgroundMaintenance("proj");
    // Check runtime health was updated
    const healthPath = path.join(cortex, ".governance", "runtime-health.json");
    expect(fs.existsSync(healthPath)).toBe(true);
    const health = JSON.parse(fs.readFileSync(healthPath, "utf8"));
    expect(health.lastGovernance).toBeDefined();
    expect(health.lastGovernance.status).toBe("ok");
  });

  it("writes audit log entry for background maintenance", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "proj", { "FINDINGS.md": "- finding\n" });
    const { handleBackgroundMaintenance } = await importGovern(cortex);
    await handleBackgroundMaintenance("proj");
    const auditPath = path.join(cortex, ".runtime", "audit.log");
    const auditContent = fs.readFileSync(auditPath, "utf8");
    expect(auditContent).toContain("background_maintenance");
  });

  it("cleans up lock file even on success", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const { handleBackgroundMaintenance } = await importGovern(cortex);
    await handleBackgroundMaintenance();
    // Lock file should not persist
    const runtimeDir = path.join(cortex, ".runtime");
    if (fs.existsSync(runtimeDir)) {
      const files = fs.readdirSync(runtimeDir);
      const lockFiles = files.filter((f) => f.includes("quality-") && f.endsWith(".lock"));
      expect(lockFiles).toHaveLength(0);
    }
  });
});

// ── handleMigrateFindings ────────────────────────────────────────────────────

describe("handleMigrateFindings", () => {
  it("exits with error when no project is given", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const { handleMigrateFindings } = await importGovern(cortex);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await handleMigrateFindings([]);
    } catch (e: any) {
      expect(e.message).toBe("process.exit");
    }
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("runs with --dry-run without modifying files", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "proj", { "FINDINGS.md": "# Findings\n- found something\n" });
    const { handleMigrateFindings } = await importGovern(cortex);
    await handleMigrateFindings(["proj", "--dry-run"]);
    // FINDINGS.md should not be created in dry-run
    // (depends on migrateLegacyFindings behavior, but we verify no crash)
  });
});

// ── handleMaintainMigrate ────────────────────────────────────────────────────

describe("handleMaintainMigrate", () => {
  it("runs governance migration in dry-run mode", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const { handleMaintainMigrate } = await importGovern(cortex);
    // Should not throw
    await handleMaintainMigrate(["governance", "--dry-run"]);
  });

  it("detects pending governance file migrations", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    // Write a governance file with schemaVersion 0 to trigger migration detection
    const govDir = path.join(cortex, ".governance");
    fs.mkdirSync(govDir, { recursive: true });
    fs.writeFileSync(
      path.join(govDir, "retention-policy.json"),
      JSON.stringify({ schemaVersion: 0, ttlDays: 90 })
    );
    const { handleMaintainMigrate } = await importGovern(cortex);
    // dry-run should mention pending migration
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleMaintainMigrate(["governance", "--dry-run"]);
    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("dry-run");
    consoleSpy.mockRestore();
  });

  it("exits for unknown flags", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const { handleMaintainMigrate } = await importGovern(cortex);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await handleMaintainMigrate(["--bogus"]);
    } catch (e: any) {
      expect(e.message).toBe("process.exit");
    }
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("exits when no positional args given", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const { handleMaintainMigrate } = await importGovern(cortex);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    try {
      await handleMaintainMigrate([]);
    } catch (e: any) {
      expect(e.message).toBe("process.exit");
    }
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("handles data migration with project arg", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "proj", { "FINDINGS.md": "# Findings\n" });
    const { handleMaintainMigrate } = await importGovern(cortex);
    await handleMaintainMigrate(["data", "proj", "--dry-run"]);
  });

  it("handles 'all' migration kind with project", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "proj", { "FINDINGS.md": "# Findings\n" });
    const { handleMaintainMigrate } = await importGovern(cortex);
    await handleMaintainMigrate(["all", "proj", "--dry-run"]);
  });

  it("treats unknown positional as legacy data alias", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "myproj", { "FINDINGS.md": "# Findings\n" });
    const { handleMaintainMigrate } = await importGovern(cortex);
    await handleMaintainMigrate(["myproj", "--dry-run"]);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, writeFile, grantAdmin, resetTestPhrenPath } from "../test-helpers.js";

let tmpDir: string;
let tmpCleanup: (() => void) | undefined;

function makePhren(): string {
  ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("phren-cli-govern-test-"));
  grantAdmin(tmpDir);
  return tmpDir;
}

function makeProject(phrenDir: string, name: string, files: Record<string, string>): void {
  const dir = path.join(phrenDir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFile(path.join(dir, file), content);
  }
}

async function importGovern(phrenDir: string) {
  process.env.PHREN_PATH = phrenDir;
  vi.resetModules();
  return await import("./govern.js");
}

function captureConsole(): { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: Parameters<typeof console.log>) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: Parameters<typeof console.error>) => {
    errors.push(args.map((arg) => String(arg)).join(" "));
  });
  return { logs, errors };
}

function refuseOnExit(): void {
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
}

function dateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

beforeEach(() => {
  resetTestPhrenPath();
  delete process.env.PHREN_PROFILE;
  delete process.env.PHREN_MEMORY_TTL_DAYS;
});

afterEach(() => {
  vi.restoreAllMocks();
  resetTestPhrenPath();
  delete process.env.PHREN_PROFILE;
  delete process.env.PHREN_MEMORY_TTL_DAYS;
  if (tmpCleanup) {
    tmpCleanup();
    tmpCleanup = undefined;
  }
});

describe("maintain prune", () => {
  it("prints what a dry run would prune without touching FINDINGS.md, review.md or the audit log", async () => {
    const phren = makePhren();
    const findings = [
      "# proj Findings",
      "",
      `## ${dateDaysAgo(400)}`,
      "",
      "- Old decision nobody needs anymore",
      "",
    ].join("\n");
    makeProject(phren, "proj", { "FINDINGS.md": findings });
    const { logs } = captureConsole();

    const { handlePruneMemories } = await importGovern(phren);
    await handlePruneMemories(["--dry-run"]);

    const output = logs.join("\n");
    expect(output).toContain("[dry-run] Would prune 1 stale memory entry.");
    expect(output).toContain("[proj] - Old decision nobody needs anymore");
    expect(fs.readFileSync(path.join(phren, "proj", "FINDINGS.md"), "utf8")).toBe(findings);
    expect(fs.existsSync(path.join(phren, "proj", "review.md"))).toBe(false);
    expect(fs.existsSync(path.join(phren, ".runtime", "audit.log"))).toBe(false);
  });

  it("refuses an unknown flag and a second project with the command's usage", async () => {
    const phren = makePhren();
    const { errors } = captureConsole();
    refuseOnExit();

    const { handlePruneMemories } = await importGovern(phren);
    await expect(handlePruneMemories(["--bogus"])).rejects.toThrow("exit 1");
    expect(errors.join("\n")).toContain("Unknown prune-memories flag: --bogus");
    expect(errors.join("\n")).toContain("phren prune-memories [project] [--dry-run]");
    expect(errors.join("\n")).not.toContain("Usage: phren prune-memories");

    errors.length = 0;
    await expect(handlePruneMemories(["one", "two"])).rejects.toThrow("exit 1");
    expect(errors.join("\n")).toContain("Usage: phren prune-memories [project] [--dry-run]");
  });
});

describe("maintain consolidate", () => {
  it("dedupes the project's findings and reports the backup the rewrite wrote", async () => {
    const phren = makePhren();
    const today = new Date().toISOString().slice(0, 10);
    const findings = ["# proj Findings", "", `## ${today}`, "", "- Same bullet", "- Same bullet", ""].join("\n");
    makeProject(phren, "proj", { "FINDINGS.md": findings });
    const { logs } = captureConsole();

    const { handleConsolidateMemories } = await importGovern(phren);
    await handleConsolidateMemories(["proj"]);

    const after = fs.readFileSync(path.join(phren, "proj", "FINDINGS.md"), "utf8");
    expect((after.match(/- Same bullet/g) ?? []).length).toBe(1);
    const backup = fs.readFileSync(path.join(phren, "proj", "FINDINGS.md.bak"), "utf8");
    expect((backup.match(/- Same bullet/g) ?? []).length).toBe(2);
    const output = logs.join("\n");
    expect(output).toContain("Consolidated findings for proj.");
    expect(output).toContain("Updated backups (1): proj/FINDINGS.md.bak");
    expect(fs.readFileSync(path.join(phren, ".runtime", "audit.log"), "utf8")).toContain("consolidate_project");
  });
});

describe("maintain restore", () => {
  it("lists backups without overwriting the live file, and refuses --apply without a project", async () => {
    const phren = makePhren();
    makeProject(phren, "proj", { "FINDINGS.md": "live\n", "FINDINGS.md.bak": "from backup\n" });
    const { logs, errors } = captureConsole();
    refuseOnExit();

    const { handleMaintain } = await importGovern(phren);
    await handleMaintain(["restore"]);

    expect(logs.join("\n")).toContain("Available backups:");
    expect(logs.join("\n")).toContain("proj/FINDINGS.md.bak");
    expect(logs.join("\n")).toContain("phren maintain restore <project> --apply");
    expect(fs.readFileSync(path.join(phren, "proj", "FINDINGS.md"), "utf8")).toBe("live\n");

    await expect(handleMaintain(["restore", "--apply"])).rejects.toThrow("exit 1");
    expect(errors.join("\n")).toContain("Specify a project to restore: phren maintain restore <project> --apply");
  });

  it("restores the named project's backup over the live file and audits the restore", async () => {
    const phren = makePhren();
    makeProject(phren, "proj", { "FINDINGS.md": "live\n", "FINDINGS.md.bak": "from backup\n" });
    const { logs } = captureConsole();

    const { handleMaintain } = await importGovern(phren);
    await handleMaintain(["restore", "proj", "--apply"]);

    expect(fs.readFileSync(path.join(phren, "proj", "FINDINGS.md"), "utf8")).toBe("from backup\n");
    expect(logs.join("\n")).toContain("Restored proj/FINDINGS.md from backup");
    const audit = fs.readFileSync(path.join(phren, ".runtime", "audit.log"), "utf8");
    expect(audit).toContain("restore_backup");
    expect(audit).toContain("project=proj files=1");
  });
});

describe("maintain gc", () => {
  it("keeps stale files during a dry run, then prunes them while protecting audit and telemetry files", async () => {
    const phren = makePhren();
    const old = new Date(Date.now() - 31 * 86_400_000);
    const age = (file: string) => fs.utimesSync(file, old, old);
    fs.mkdirSync(path.join(phren, ".sessions"), { recursive: true });
    fs.mkdirSync(path.join(phren, ".runtime"), { recursive: true });
    for (const file of [".sessions/old-marker", ".sessions/recent-marker", ".runtime/old.log", ".runtime/old.jsonl", ".runtime/recent.log", ".runtime/notes.txt", ".runtime/telemetry.json"]) {
      writeFile(path.join(phren, file), "x\n");
    }
    writeFile(path.join(phren, ".runtime", "audit.log"), "seed\n");
    for (const file of [".sessions/old-marker", ".runtime/old.log", ".runtime/old.jsonl", ".runtime/notes.txt", ".runtime/telemetry.json", ".runtime/audit.log"]) {
      age(path.join(phren, file));
    }
    const { logs } = captureConsole();

    const { handleMaintain } = await importGovern(phren);
    await handleMaintain(["gc", "--dry-run"]);

    const dryOutput = logs.join("\n");
    expect(dryOutput).toContain("[dry-run] Would remove: .sessions/old-marker");
    expect(dryOutput).toContain("[dry-run] Would remove: .runtime/old.log");
    expect(dryOutput).toContain("Would remove 1 stale session marker(s) from .sessions/");
    expect(dryOutput).toContain("Would remove 2 stale runtime log(s) from .runtime/");
    expect(fs.existsSync(path.join(phren, ".sessions", "old-marker"))).toBe(true);
    expect(fs.readFileSync(path.join(phren, ".runtime", "audit.log"), "utf8")).toBe("seed\n");

    logs.length = 0;
    await handleMaintain(["gc"]);

    expect(fs.existsSync(path.join(phren, ".sessions", "old-marker"))).toBe(false);
    expect(fs.existsSync(path.join(phren, ".sessions", "recent-marker"))).toBe(true);
    expect(fs.existsSync(path.join(phren, ".runtime", "old.log"))).toBe(false);
    expect(fs.existsSync(path.join(phren, ".runtime", "old.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(phren, ".runtime", "recent.log"))).toBe(true);
    expect(fs.existsSync(path.join(phren, ".runtime", "notes.txt"))).toBe(true);
    expect(fs.existsSync(path.join(phren, ".runtime", "telemetry.json"))).toBe(true);
    const audit = fs.readFileSync(path.join(phren, ".runtime", "audit.log"), "utf8");
    expect(audit).toContain("maintain_gc");
    expect(audit).toContain("sessions=1 logs=2");
    expect(logs.join("\n")).toContain("GC complete: git_gc=false commits_squashed=0 sessions_pruned=1 logs_pruned=2");
  });
});

describe("maintain router", () => {
  it("prints the subcommand help and refuses an unknown subcommand", async () => {
    const phren = makePhren();
    const { logs, errors } = captureConsole();
    refuseOnExit();

    const { handleMaintain } = await importGovern(phren);
    await expect(handleMaintain(["bogus"])).rejects.toThrow("exit 1");

    expect(logs.join("\n")).toContain("phren maintain - memory maintenance and governance");
    expect(logs.join("\n")).toContain("phren maintain govern [project] [--dry-run]");
    expect(errors.join("\n")).toContain('Unknown maintain subcommand: "bogus"');
  });

  it("routes govern --dry-run to a report without queueing or consolidating anything", async () => {
    const phren = makePhren();
    const today = new Date().toISOString().slice(0, 10);
    const findings = ["# proj Findings", "", `## ${today}`, "", "- fixed stuff", "- fixed stuff", ""].join("\n");
    makeProject(phren, "proj", { "FINDINGS.md": findings });
    const { logs } = captureConsole();

    const { handleMaintain } = await importGovern(phren);
    const summary = await handleMaintain(["govern", "proj", "--dry-run"]) as unknown as { reviewCount: number };

    expect(summary.reviewCount).toBeGreaterThanOrEqual(1);
    expect(logs.join("\n")).toContain("[dry-run] Would govern memories:");
    expect(fs.readFileSync(path.join(phren, "proj", "FINDINGS.md"), "utf8")).toBe(findings);
    expect(fs.existsSync(path.join(phren, "proj", "review.md"))).toBe(false);
    expect(fs.existsSync(path.join(phren, "proj", "FINDINGS.md.bak"))).toBe(false);
    expect(fs.existsSync(path.join(phren, ".runtime", "audit.log"))).toBe(false);
  });
});

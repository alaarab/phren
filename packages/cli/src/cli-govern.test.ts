import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
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
  vi.restoreAllMocks();
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

  it("queues no stale or low-value findings for a project whose review queue is over budget", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    writeFile(path.join(phren, ".config", "retention-policy.json"), JSON.stringify({ schemaVersion: 1, budgets: { reviewEntries: 1 } }));
    const today = new Date().toISOString().slice(0, 10);
    makeProject(phren, "proj", {
      "FINDINGS.md": `# proj Findings\n\n## ${today}\n\n- wip\n- Deploy ordering rule nobody reads anymore <!-- created: 2020-01-01 -->\n`,
      "review.md": "# proj Review Queue\n\n## Review\n\n- [2026-11-01] First held item\n- [2026-11-02] Second held item\n\n## Stale\n\n## Conflicts\n",
    });
    const before = fs.readFileSync(path.join(phren, "proj", "review.md"), "utf8");
    const { handleBackgroundMaintenance } = await importGovern(phren);
    await handleBackgroundMaintenance("proj");
    expect(fs.readFileSync(path.join(phren, "proj", "review.md"), "utf8")).toBe(before);
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

function makeStorePair() {
  const root = makePhren();
  const primary = path.join(root, "primary");
  const attached = path.join(root, "attached");
  grantAdmin(primary);
  grantAdmin(attached);
  execFileSync("git", ["init", "--quiet", attached]);
  const entry = { id: "22222222", name: "team", path: attached, role: "team", sync: "managed-git", projects: ["proj"] };
  writeFile(path.join(primary, "stores.yaml"), JSON.stringify({ version: 1, stores: [
    { id: "11111111", name: "personal", path: primary, role: "primary", sync: "managed-git" },
  ] }));
  const registry = path.join(primary, ".runtime", "attached-stores.yaml");
  writeFile(registry, JSON.stringify({ version: 1, stores: [entry] }));
  return { primary, attached, entry, registry };
}

function snapshotStore(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const relative = path.relative(root, file);
    if (relative.split(path.sep).includes(".git")) continue;
    files[relative] = fs.readFileSync(file, "utf8");
  }
  return files;
}

describe("maintenance of attached stores", () => {
  it("governs both stores with their own retention policy and review queue", async () => {
    const { primary, attached } = makeStorePair();
    const date = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    const findings = `# Findings\n\n## ${date}\n\n- Deployment requires the migrations to finish before restarting workers\n`;
    for (const store of [primary, attached]) makeProject(store, "proj", { "FINDINGS.md": findings });
    writeFile(path.join(primary, ".config", "retention-policy.json"), JSON.stringify({ ttlDays: 120 }));
    writeFile(path.join(attached, ".config", "retention-policy.json"), JSON.stringify({ ttlDays: 5 }));
    writeFile(path.join(primary, "profiles", "local.yaml"), "projects: [proj]\n");
    process.env.PHREN_PROFILE = "local";
    const { handleGovernMemories } = await importGovern(primary);

    const summary = await handleGovernMemories(undefined, true);

    expect(summary.projects).toBe(2);
    expect(summary.staleCount).toBe(1);
    const queue = fs.readFileSync(path.join(attached, "proj", "review.md"), "utf8");
    expect(queue.split("## Stale")[1]).toContain("Deployment requires the migrations");
    expect(fs.existsSync(path.join(primary, "proj", "review.md"))).toBe(false);
  });

  it.each([undefined, "proj"])("does not rewrite an attached store leased to another computer (project=%s)", async (project) => {
    const { primary, attached } = makeStorePair();
    const today = new Date().toISOString().slice(0, 10);
    makeProject(attached, "proj", {
      "FINDINGS.md": `# Findings\n\n## 2020-01-01\n\n- Old deployment advice that retention would delete\n\n## ${today}\n\n- fixed stuff\n- fixed stuff\n`,
      "reference/topics/deploy.md": "# Deploy\n\n## 2020-01-01\n\n- Archived deployment advice\n",
    });
    const leaseFile = path.join(attached, ".config", "maintenance-writer.json");
    writeFile(leaseFile, JSON.stringify({ computer: "other-computer", renewedAt: new Date().toISOString() }));
    const before = snapshotStore(attached);
    const { handleGovernMemories, handleBackgroundMaintenance } = await importGovern(primary);

    await handleGovernMemories(project, true);
    await handleBackgroundMaintenance(project);

    expect(snapshotStore(attached)).toEqual(before);
    expect(JSON.parse(fs.readFileSync(path.join(primary, ".runtime", "runtime-health.json"), "utf8")).lastGovernance.status).toBe("ok");
  });

  it.each(["missing", "readonly", "pull-only", "not-git"])("quietly skips an attached store that is %s", async (reason) => {
    const { primary, attached, entry, registry } = makeStorePair();
    makeProject(primary, "proj", { "FINDINGS.md": "- fixed stuff\n" });
    makeProject(attached, "proj", { "FINDINGS.md": "- fixed stuff\n" });
    if (reason === "missing") fs.rmSync(attached, { recursive: true });
    if (reason === "not-git") fs.rmSync(path.join(attached, ".git"), { recursive: true });
    if (reason === "readonly") entry.role = "readonly";
    if (reason === "pull-only") entry.sync = "pull-only";
    writeFile(registry, JSON.stringify({ version: 1, stores: [entry] }));
    const before = reason === "missing" ? undefined : snapshotStore(attached);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { handleBackgroundMaintenance } = await importGovern(primary);

    await handleBackgroundMaintenance();

    expect(fs.readFileSync(path.join(primary, "proj", "review.md"), "utf8")).toContain("fixed stuff");
    if (before) expect(snapshotStore(attached)).toEqual(before);
    else expect(fs.existsSync(attached)).toBe(false);
    expect(warnings).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("summarizes and prunes the attached store while the primary lease belongs to another computer", async () => {
    const { primary, attached } = makeStorePair();
    writeFile(path.join(primary, ".config", "maintenance-writer.json"), JSON.stringify({ computer: "other-computer", renewedAt: new Date().toISOString() }));
    writeFile(path.join(primary, ".config", "retention-policy.json"), JSON.stringify({ retentionDays: 3650 }));
    writeFile(path.join(attached, ".config", "retention-policy.json"), JSON.stringify({ retentionDays: 5 }));
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    makeProject(attached, "proj", {
      "FINDINGS.md": `# Findings\n\n## ${old}\n\n- Old deployment advice that retention should delete\n\n## ${today}\n\n- Keep database migrations ahead of the worker rollout\n- Keep database migrations ahead of the worker rollout\n`,
      "reference/topics/deploy.md": `# Deploy\n\n## ${old}\n\n- Archived deployment advice\n`,
    });
    makeProject(attached, "unsubscribed", { "FINDINGS.md": "- fixed stuff\n" });
    const unsubscribed = snapshotStore(path.join(attached, "unsubscribed"));
    const { handleBackgroundMaintenance } = await importGovern(primary);

    await handleBackgroundMaintenance();

    const findings = fs.readFileSync(path.join(attached, "proj", "FINDINGS.md"), "utf8");
    expect(findings).not.toContain("Old deployment advice");
    expect(findings.match(/Keep database migrations/g)).toHaveLength(1);
    expect(fs.readFileSync(path.join(attached, "proj", "reference", "topics", "deploy.md"), "utf8")).toContain("## Now");
    expect(fs.readFileSync(path.join(attached, "proj", "summary.md"), "utf8")).toContain("What phren knows");
    expect(snapshotStore(path.join(attached, "unsubscribed"))).toEqual(unsubscribed);
    expect(JSON.parse(fs.readFileSync(path.join(primary, ".runtime", "runtime-health.json"), "utf8")).lastGovernance.status).toBe("ok");
  });
});

describe("citation checks in governance", () => {
  function citedFindings(phren: string, citation: Record<string, unknown>) {
    const today = new Date().toISOString().slice(0, 10);
    makeProject(phren, "proj", {
      "FINDINGS.md": `# Findings\n\n## ${today}\n\n- Retry budget lives in the client wrapper module <!-- fid:abcd1234 -->\n  <!-- phren:cite ${JSON.stringify({ created_at: new Date().toISOString(), ...citation })} -->\n`,
    });
  }
  const conflicts = (phren: string) => {
    const queue = path.join(phren, "proj", "review.md");
    return fs.existsSync(queue) ? fs.readFileSync(queue, "utf8").split("## Conflicts")[1] ?? "" : "";
  };
  const states = (phren: string) => JSON.parse(fs.readFileSync(path.join(phren, ".runtime", "citation-states.json"), "utf8"));

  it("records a repo this computer lacks as unverifiable and queues nothing", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    citedFindings(phren, { repo: "/Users/someone-else/Projects/app", commit: "0123456789abcdef0123456789abcdef01234567", file: "src/client.ts", line: 4 });
    const { handleGovernMemories } = await importGovern(phren);

    const summary = await handleGovernMemories("proj", true);

    expect(summary.conflictCount).toBe(0);
    expect(conflicts(phren)).not.toContain("Retry budget");
    expect(states(phren)["fid:abcd1234"].state).toBe("unverifiable");
  });

  it("queues a broken citation as a conflict only on the store's lease holder", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    const repo = path.join(phren, "repo");
    fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q");
    fs.writeFileSync(path.join(repo, "a.ts"), "one\n");
    git("add", "-A");
    git("commit", "-qm", "first");
    citedFindings(phren, { repo, commit: git("rev-parse", "HEAD"), file: "src/client.ts", line: 4 });
    const lease = path.join(phren, ".config", "maintenance-writer.json");
    writeFile(lease, JSON.stringify({ computer: "other-computer", renewedAt: new Date().toISOString() }));
    const { handleGovernMemories } = await importGovern(phren);

    expect((await handleGovernMemories("proj", true)).conflictCount).toBe(0);
    expect(conflicts(phren)).not.toContain("Retry budget");
    expect(states(phren)["fid:abcd1234"].state).toBe("broken");

    fs.rmSync(lease);
    expect((await handleGovernMemories("proj", true)).conflictCount).toBe(1);
    expect(conflicts(phren)).toContain("Retry budget lives in the client wrapper module");
  });
});

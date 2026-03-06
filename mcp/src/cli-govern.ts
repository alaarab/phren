import {
  ensureCortexPath,
  filterTrustedLearningsDetailed,
  appendMemoryQueue,
  appendAuditLog,
  getMemoryPolicy,
  pruneDeadMemories,
  consolidateProjectLearnings,
  enforceCanonicalLocks,
  migrateLegacyFindings,
  migrateGovernanceFiles,
  updateRuntimeHealth,
  getProjectDirs,
  GOVERNANCE_SCHEMA_VERSION,
} from "./shared.js";
import * as fs from "fs";
import * as path from "path";
import { handleExtractMemories } from "./cli-extract.js";

const cortexPath = ensureCortexPath();
const profile = process.env.CORTEX_PROFILE || "";

// ── Shared helpers ───────────────────────────────────────────────────────────

function targetProjects(projectArg?: string): string[] {
  return projectArg
    ? [projectArg]
    : getProjectDirs(cortexPath, profile).map((p) => path.basename(p)).filter((p) => p !== "global");
}

function parseProjectDryRunArgs(
  args: string[],
  command: string,
  usage: string
): { projectArg?: string; dryRun: boolean } {
  let projectArg: string | undefined;
  let dryRun = false;
  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("-")) {
      console.error(`Unknown ${command} flag: ${arg}`);
      console.error(usage);
      process.exit(1);
    }
    if (projectArg) {
      console.error(`Usage: ${usage}`);
      process.exit(1);
    }
    projectArg = arg;
  }
  return { projectArg, dryRun };
}

function captureLearningBackups(projects: string[]): Map<string, number> {
  const snapshots = new Map<string, number>();
  for (const project of projects) {
    const backup = path.join(cortexPath, project, "LEARNINGS.md.bak");
    if (!fs.existsSync(backup)) continue;
    snapshots.set(backup, fs.statSync(backup).mtimeMs);
  }
  return snapshots;
}

function summarizeBackupChanges(before: Map<string, number>, projects: string[]): string[] {
  const changed: string[] = [];
  for (const project of projects) {
    const backup = path.join(cortexPath, project, "LEARNINGS.md.bak");
    if (!fs.existsSync(backup)) continue;
    const current = fs.statSync(backup).mtimeMs;
    const previous = before.get(backup);
    if (previous === undefined || current !== previous) {
      changed.push(path.relative(cortexPath, backup));
    }
  }
  return changed.sort();
}

function qualityMarkers(cortexPathLocal: string): { done: string; lock: string } {
  const today = new Date().toISOString().slice(0, 10);
  return {
    done: path.join(cortexPathLocal, `.quality-${today}`),
    lock: path.join(cortexPathLocal, `.quality-${today}.lock`),
  };
}

// ── Governance handlers ──────────────────────────────────────────────────────

interface GovernanceSummary {
  projects: number;
  staleCount: number;
  conflictCount: number;
  reviewCount: number;
}

export async function handleGovernMemories(projectArg?: string, silent: boolean = false): Promise<GovernanceSummary> {
  const policy = getMemoryPolicy(cortexPath);
  const ttlDays = Number.parseInt(process.env.CORTEX_MEMORY_TTL_DAYS || String(policy.ttlDays), 10);
  const projects = projectArg
    ? [projectArg]
    : getProjectDirs(cortexPath, profile).map((p) => path.basename(p)).filter((p) => p !== "global");

  let staleCount = 0;
  let conflictCount = 0;
  let reviewCount = 0;

  for (const project of projects) {
    const learningsPath = path.join(cortexPath, project, "LEARNINGS.md");
    if (!fs.existsSync(learningsPath)) continue;
    const content = fs.readFileSync(learningsPath, "utf8");
    const trust = filterTrustedLearningsDetailed(content, {
      ttlDays: Number.isNaN(ttlDays) ? policy.ttlDays : ttlDays,
      minConfidence: policy.minInjectConfidence,
      decay: policy.decay,
    });

    const stale = trust.issues.filter((i) => i.reason === "stale").map((i) => i.bullet);
    const conflicts = trust.issues.filter((i) => i.reason === "invalid_citation").map((i) => i.bullet);
    staleCount += appendMemoryQueue(cortexPath, project, "Stale", stale);
    conflictCount += appendMemoryQueue(cortexPath, project, "Conflicts", conflicts);

    const lowValue = content.split("\n")
      .filter((l) => l.startsWith("- "))
      .filter((l) => /(fixed stuff|updated things|misc|temp|wip|quick note)/i.test(l) || l.length < 16);
    reviewCount += appendMemoryQueue(cortexPath, project, "Review", lowValue);
  }

  appendAuditLog(
    cortexPath,
    "govern_memories",
    `projects=${projects.length} stale=${staleCount} conflicts=${conflictCount} review=${reviewCount}`
  );
  for (const project of projects) {
    consolidateProjectLearnings(cortexPath, project);
  }
  const lockSummary = enforceCanonicalLocks(cortexPath, projectArg);
  if (!silent) {
    console.log(`Governed memories: stale=${staleCount}, conflicts=${conflictCount}, review=${reviewCount}`);
    console.log(lockSummary);
  }
  return {
    projects: projects.length,
    staleCount,
    conflictCount,
    reviewCount,
  };
}

export async function handlePruneMemories(args: string[] = []) {
  const usage = "cortex prune-memories [project] [--dry-run]";
  const { projectArg, dryRun } = parseProjectDryRunArgs(args, "prune-memories", usage);
  const projects = targetProjects(projectArg);
  const beforeBackups = dryRun ? new Map<string, number>() : captureLearningBackups(projects);
  const result = pruneDeadMemories(cortexPath, projectArg, dryRun);
  console.log(result);
  if (dryRun || /^permission denied/i.test(result)) return;
  const backups = summarizeBackupChanges(beforeBackups, projects);
  if (!backups.length) return;
  console.log(`Updated backups (${backups.length}): ${backups.join(", ")}`);
}

export async function handleConsolidateMemories(args: string[] = []) {
  const usage = "cortex consolidate-memories [project] [--dry-run]";
  const { projectArg, dryRun } = parseProjectDryRunArgs(args, "consolidate-memories", usage);
  const projects = targetProjects(projectArg);
  const beforeBackups = dryRun ? new Map<string, number>() : captureLearningBackups(projects);
  const results = projects.map((p) => consolidateProjectLearnings(cortexPath, p, dryRun));
  console.log(results.join("\n"));
  if (dryRun) return;
  const backups = summarizeBackupChanges(beforeBackups, projects);
  if (!backups.length) return;
  console.log(`Updated backups (${backups.length}): ${backups.join(", ")}`);
}

export async function handleMigrateFindings(args: string[]) {
  const project = args.find((arg) => !arg.startsWith("-"));
  if (!project) {
    console.error("Usage: cortex migrate-findings <project> [--pin] [--dry-run]");
    process.exit(1);
  }
  const pinCanonical = args.includes("--pin");
  const dryRun = args.includes("--dry-run");
  const result = migrateLegacyFindings(cortexPath, project, { pinCanonical, dryRun });
  console.log(result);
}

// ── Maintain migrate ─────────────────────────────────────────────────────────

type MaintainMigrationKind = "governance" | "data" | "all";

interface ParsedMaintainMigrationArgs {
  kind: MaintainMigrationKind;
  project?: string;
  pinCanonical: boolean;
  dryRun: boolean;
}

function printMaintainMigrationUsage() {
  console.error("Usage:");
  console.error("  cortex maintain migrate governance [--dry-run]");
  console.error("  cortex maintain migrate data <project> [--pin] [--dry-run]");
  console.error("  cortex maintain migrate all <project> [--pin] [--dry-run]");
  console.error("  cortex maintain migrate <project> [--pin] [--dry-run]  # legacy data alias");
}

function parseMaintainMigrationArgs(args: string[]): ParsedMaintainMigrationArgs {
  let pinCanonical = false;
  let dryRun = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "--pin") {
      pinCanonical = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("-")) {
      console.error(`Unknown migrate flag: ${arg}`);
      printMaintainMigrationUsage();
      process.exit(1);
    }
    positional.push(arg);
  }

  if (!positional.length) {
    printMaintainMigrationUsage();
    process.exit(1);
  }

  const mode = positional[0].toLowerCase();
  if (mode === "governance") {
    if (pinCanonical) {
      console.error("--pin is only valid for data/all migrations.");
      process.exit(1);
    }
    if (positional.length !== 1) {
      printMaintainMigrationUsage();
      process.exit(1);
    }
    return { kind: "governance", pinCanonical, dryRun };
  }

  if (mode === "data" || mode === "all") {
    const project = positional[1];
    if (!project || positional.length !== 2) {
      printMaintainMigrationUsage();
      process.exit(1);
    }
    return { kind: mode, project, pinCanonical, dryRun };
  }

  if (positional.length !== 1) {
    printMaintainMigrationUsage();
    process.exit(1);
  }
  return { kind: "data", project: positional[0], pinCanonical, dryRun };
}

function describeGovernanceMigrationPlan(): Array<{ file: string; from: number; to: number }> {
  const govDir = path.join(cortexPath, ".governance");
  if (!fs.existsSync(govDir)) return [];
  const files = [
    "memory-policy.json",
    "access-control.json",
    "memory-workflow-policy.json",
    "index-policy.json",
  ];
  const pending: Array<{ file: string; from: number; to: number }> = [];
  for (const file of files) {
    const fullPath = path.join(govDir, file);
    if (!fs.existsSync(fullPath)) continue;
    try {
      const raw = fs.readFileSync(fullPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const fileVersion = typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 0;
      if (fileVersion < GOVERNANCE_SCHEMA_VERSION) {
        pending.push({ file, from: fileVersion, to: GOVERNANCE_SCHEMA_VERSION });
      }
    } catch {
      // Ignore malformed files here; shared migration API handles hard failures defensively.
    }
  }
  return pending;
}

function runGovernanceMigration(dryRun: boolean): string {
  if (dryRun) {
    const pending = describeGovernanceMigrationPlan();
    if (!pending.length) return "[dry-run] Governance files are already up to date.";
    const details = pending.map((entry) => `${entry.file} (${entry.from} -> ${entry.to})`).join(", ");
    return `[dry-run] Would migrate ${pending.length} governance file(s): ${details}`;
  }
  const migrated = migrateGovernanceFiles(cortexPath);
  if (!migrated.length) return "Governance files are already up to date.";
  return `Migrated ${migrated.length} governance file(s): ${migrated.join(", ")}`;
}

export async function handleMaintainMigrate(args: string[]) {
  const parsed = parseMaintainMigrationArgs(args);
  const lines: string[] = [];

  if (parsed.kind === "governance" || parsed.kind === "all") {
    lines.push(`Governance migration: ${runGovernanceMigration(parsed.dryRun)}`);
  }
  if (parsed.kind === "data" || parsed.kind === "all") {
    const result = migrateLegacyFindings(cortexPath, parsed.project!, {
      pinCanonical: parsed.pinCanonical,
      dryRun: parsed.dryRun,
    });
    lines.push(`Data migration (${parsed.project}): ${result}`);
  }

  console.log(lines.join("\n"));
}

// ── Maintain router ──────────────────────────────────────────────────────────

export async function handleMaintain(args: string[]) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "govern":
      return handleGovernMemories(rest[0]);
    case "prune":
      return handlePruneMemories(rest);
    case "consolidate":
      return handleConsolidateMemories(rest);
    case "migrate":
      return handleMaintainMigrate(rest);
    case "extract":
      return handleExtractMemories(rest[0]);
    default:
      console.log(`cortex maintain - memory maintenance and governance

Subcommands:
  cortex maintain govern [project]       Queue stale/conflicting/low-value memories for review
  cortex maintain prune [project] [--dry-run]
                                         Delete expired entries by retention policy
  cortex maintain consolidate [project] [--dry-run]
                                         Deduplicate LEARNINGS.md bullets
  cortex maintain migrate governance [--dry-run]
                                         Upgrade governance policy file schemas
  cortex maintain migrate data <project> [--pin] [--dry-run]
  cortex maintain migrate all <project> [--pin] [--dry-run]
  cortex maintain migrate <project> [--pin] [--dry-run]  (legacy alias)
                                         Promote legacy findings into LEARNINGS/CANONICAL
  cortex maintain extract [project]      Mine git/GitHub signals into memory candidates`);
      if (sub) {
        console.error(`\nUnknown maintain subcommand: "${sub}"`);
        process.exit(1);
      }
  }
}

// ── Background maintenance ───────────────────────────────────────────────────

export async function handleBackgroundMaintenance(projectArg?: string) {
  const markers = qualityMarkers(cortexPath);
  const startedAt = new Date().toISOString();
  try {
    const governance = await handleGovernMemories(projectArg, true);
    const pruneResult = pruneDeadMemories(cortexPath, projectArg);
    fs.writeFileSync(markers.done, new Date().toISOString() + "\n");
    updateRuntimeHealth(cortexPath, {
      lastGovernance: {
        at: startedAt,
        status: "ok",
        detail: `projects=${governance.projects} stale=${governance.staleCount} conflicts=${governance.conflictCount} review=${governance.reviewCount}; ${pruneResult}`,
      },
    });
    appendAuditLog(
      cortexPath,
      "background_maintenance",
      `status=ok projects=${governance.projects} stale=${governance.staleCount} conflicts=${governance.conflictCount} review=${governance.reviewCount}`
    );
  } catch (err: any) {
    updateRuntimeHealth(cortexPath, {
      lastGovernance: {
        at: startedAt,
        status: "error",
        detail: err?.message || String(err),
      },
    });
    appendAuditLog(cortexPath, "background_maintenance_failed", `error=${err?.message || String(err)}`);
  } finally {
    try { fs.unlinkSync(markers.lock); } catch { /* best effort */ }
  }
}

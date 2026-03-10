import {
  appendAuditLog,
  qualityMarkers,
  getProjectDirs,
  getCortexPath,
} from "./shared.js";
import {
  appendReviewQueue,
  getRetentionPolicy,
  consolidateProjectFindings,
  updateRuntimeHealth,
  pruneDeadMemories,
  enforceCanonicalLocks,
} from "./shared-governance.js";
import {
  filterTrustedFindingsDetailed,
} from "./shared-content.js";
import * as fs from "fs";
import * as path from "path";
import { handleExtractMemories } from "./cli-extract.js";
import { errorMessage } from "./utils.js";
import { compactFindingJournals } from "./finding-journal.js";
import { resolveRuntimeProfile } from "./runtime-profile.js";

// ── Shared helpers ───────────────────────────────────────────────────────────

function targetProjects(projectArg?: string): string[] {
  const profile = resolveRuntimeProfile(getCortexPath());
  return projectArg
    ? [projectArg]
    : getProjectDirs(getCortexPath(), profile).map((p) => path.basename(p)).filter((p) => p !== "global");
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

function captureFindingBackups(projects: string[]): Map<string, number> {
  const snapshots = new Map<string, number>();
  for (const project of projects) {
    const backup = path.join(getCortexPath(), project, "FINDINGS.md.bak");
    if (!fs.existsSync(backup)) continue;
    snapshots.set(backup, fs.statSync(backup).mtimeMs);
  }
  return snapshots;
}

function summarizeBackupChanges(before: Map<string, number>, projects: string[]): string[] {
  const changed: string[] = [];
  for (const project of projects) {
    const backup = path.join(getCortexPath(), project, "FINDINGS.md.bak");
    if (!fs.existsSync(backup)) continue;
    const current = fs.statSync(backup).mtimeMs;
    const previous = before.get(backup);
    if (previous === undefined || current !== previous) {
      // Normalize to forward slashes for consistent output across platforms
      changed.push(path.relative(getCortexPath(), backup).replace(/\\/g, "/"));
    }
  }
  return changed.sort();
}


// ── Governance handlers ──────────────────────────────────────────────────────

interface GovernanceSummary {
  projects: number;
  staleCount: number;
  conflictCount: number;
  reviewCount: number;
}

export async function handleGovernMemories(projectArg?: string, silent: boolean = false, dryRun: boolean = false): Promise<GovernanceSummary> {
  const profile = resolveRuntimeProfile(getCortexPath());
  const policy = getRetentionPolicy(getCortexPath());
  const ttlDays = Number.parseInt(process.env.CORTEX_MEMORY_TTL_DAYS || String(policy.ttlDays), 10);
  const projects = projectArg
    ? [projectArg]
    : getProjectDirs(getCortexPath(), profile).map((p) => path.basename(p)).filter((p) => p !== "global");

  let staleCount = 0;
  let conflictCount = 0;
  let reviewCount = 0;

  for (const project of projects) {
    const learningsPath = path.join(getCortexPath(), project, "FINDINGS.md");
    if (!fs.existsSync(learningsPath)) continue;
    const content = fs.readFileSync(learningsPath, "utf8");
    const trust = filterTrustedFindingsDetailed(content, {
      ttlDays: Number.isNaN(ttlDays) ? policy.ttlDays : ttlDays,
      minConfidence: policy.minInjectConfidence,
      decay: policy.decay,
    });

    const stale = trust.issues.filter((i) => i.reason === "stale").map((i) => i.bullet);
    const conflicts = trust.issues.filter((i) => i.reason === "invalid_citation").map((i) => i.bullet);
    staleCount += stale.length;
    conflictCount += conflicts.length;

    const lowValue = content.split("\n")
      .filter((l) => l.startsWith("- "))
      .filter((l) => /(fixed stuff|updated things|misc|temp|wip|quick note)/i.test(l) || l.length < 16);
    reviewCount += lowValue.length;

    if (!dryRun) {
      appendReviewQueue(getCortexPath(), project, "Stale", stale);
      appendReviewQueue(getCortexPath(), project, "Conflicts", conflicts);
      appendReviewQueue(getCortexPath(), project, "Review", lowValue);
    }
  }

  if (!dryRun) {
    appendAuditLog(
      getCortexPath(),
      "govern_memories",
      `projects=${projects.length} stale=${staleCount} conflicts=${conflictCount} review=${reviewCount}`
    );
    for (const project of projects) {
      consolidateProjectFindings(getCortexPath(), project);
    }
  }
  const lockSummary = dryRun ? "" : enforceCanonicalLocks(getCortexPath(), projectArg);
  if (!silent) {
    const prefix = dryRun ? "[dry-run] Would govern" : "Governed";
    console.log(`${prefix} memories: stale=${staleCount}, conflicts=${conflictCount}, review=${reviewCount}`);
    if (lockSummary) console.log(lockSummary);
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
  const beforeBackups = dryRun ? new Map<string, number>() : captureFindingBackups(projects);
  const result = pruneDeadMemories(getCortexPath(), projectArg, dryRun);
  if (!result.ok) {
    console.log(result.error);
    return;
  }
  console.log(result.data);

  // TTL enforcement: move entries older than ttlDays that haven't been retrieved recently
  const policy = getRetentionPolicy(getCortexPath());
  const ttlDays = policy.ttlDays;
  const retrievalGraceDays = Math.floor(ttlDays / 2);
  const now = Date.now();

  // Load retrieval log once for all projects
  const retrievalLogPath = path.join(getCortexPath(), ".runtime", "retrieval-log.jsonl");
  let retrievalEntries: Array<{ file: string; section: string; retrievedAt: string }> = [];
  if (fs.existsSync(retrievalLogPath)) {
    try {
      retrievalEntries = fs.readFileSync(retrievalLogPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } }) // null filtered below
        .filter((e): e is { file: string; section: string; retrievedAt: string } => e !== null);
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] cli-govern retrievalLog readParse: ${errorMessage(err)}\n`);
    }
  }

  // Build map of last retrieval date by file+bullet key
  const lastRetrievalByKey = new Map<string, number>();
  for (const entry of retrievalEntries) {
    const key = `${entry.file}:${entry.section}`;
    const ts = Date.parse(entry.retrievedAt);
    if (!Number.isNaN(ts)) {
      const existing = lastRetrievalByKey.get(key) || 0;
      if (ts > existing) lastRetrievalByKey.set(key, ts);
    }
  }

  let ttlExpired = 0;
  for (const project of projects) {
    const learningsPath = path.join(getCortexPath(), project, "FINDINGS.md");
    if (!fs.existsSync(learningsPath)) continue;
    const content = fs.readFileSync(learningsPath, "utf8");
    const lines = content.split("\n");
    const expiredEntries: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Look for entries with <!-- created: YYYY-MM-DD --> timestamps
      if (!line.startsWith("- ")) continue;
      const createdMatch = line.match(/<!--\s*created:\s*(\d{4}-\d{2}-\d{2})\s*-->/);
      if (!createdMatch) continue; // No timestamp, skip defensively

      const createdDate = createdMatch[1];
      const createdMs = Date.parse(`${createdDate}T00:00:00Z`);
      if (Number.isNaN(createdMs)) continue;

      const ageDays = Math.floor((now - createdMs) / 86400000);
      if (ageDays <= ttlDays) continue;

      // Check if retrieved within the grace period.
      // Retrieval is logged at document level (project/FINDINGS.md + doc.type), so look up
      // by the document-level key to match the format written by cli-hooks-output recordRetrieval.
      const retrievalKey = `${project}/FINDINGS.md:findings`;
      const lastRetrieval = lastRetrievalByKey.get(retrievalKey) || 0;
      const daysSinceRetrieval = lastRetrieval ? Math.floor((now - lastRetrieval) / 86400000) : Infinity;
      if (daysSinceRetrieval <= retrievalGraceDays) continue;

      expiredEntries.push(`[ttl-expired: ${createdDate}] ${line.slice(2).trim()}`);
      ttlExpired++;
    }

    if (expiredEntries.length > 0 && !dryRun) {
      appendReviewQueue(getCortexPath(), project, "Stale", expiredEntries);
    }
    if (expiredEntries.length > 0 && dryRun) {
      for (const entry of expiredEntries) {
        console.log(`[dry-run] [${project}] Would move to MEMORY_QUEUE: ${entry.slice(0, 120)}`);
      }
    }
  }

  if (ttlExpired > 0) {
    const verb = dryRun ? "Would move" : "Moved";
    console.log(`${verb} ${ttlExpired} TTL-expired entr${ttlExpired === 1 ? "y" : "ies"} to MEMORY_QUEUE.md`);
  }

  if (dryRun) return;
  const backups = summarizeBackupChanges(beforeBackups, projects);
  if (!backups.length) return;
  console.log(`Updated backups (${backups.length}): ${backups.join(", ")}`);
}

export async function handleConsolidateMemories(args: string[] = []) {
  const usage = "cortex consolidate-memories [project] [--dry-run]";
  const { projectArg, dryRun } = parseProjectDryRunArgs(args, "consolidate-memories", usage);
  const projects = targetProjects(projectArg);
  const beforeBackups = dryRun ? new Map<string, number>() : captureFindingBackups(projects);
  const results = projects.map((p) => consolidateProjectFindings(getCortexPath(), p, dryRun));
  console.log(results.map((r) => r.ok ? r.data : r.error).join("\n"));
  if (dryRun) return;
  const backups = summarizeBackupChanges(beforeBackups, projects);
  if (!backups.length) return;
  console.log(`Updated backups (${backups.length}): ${backups.join(", ")}`);
}

// ── Maintain router ──────────────────────────────────────────────────────────

export async function handleMaintain(args: string[]) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "govern": {
      const governDryRun = rest.includes("--dry-run");
      const governProject = rest.find((a) => !a.startsWith("-"));
      return handleGovernMemories(governProject, false, governDryRun);
    }
    case "prune":
      return handlePruneMemories(rest);
    case "consolidate":
      return handleConsolidateMemories(rest);
    case "extract":
      return handleExtractMemories(rest[0]);
    case "restore":
      return handleRestoreBackup(rest);
    default:
      console.log(`cortex maintain - memory maintenance and governance

Subcommands:
  cortex maintain govern [project] [--dry-run]
                                         Queue stale/conflicting/low-value memories for review.
                                         Run when search results feel noisy or after a long break.
  cortex maintain prune [project] [--dry-run]
                                         Delete expired entries by retention policy
  cortex maintain consolidate [project] [--dry-run]
                                         Deduplicate FINDINGS.md bullets. Run after a burst of work
                                         when findings feel repetitive, or monthly to keep things clean.
  cortex maintain extract [project]      Mine git/GitHub signals into memory candidates
  cortex maintain restore [project]      List and restore from .bak files`);
      if (sub) {
        console.error(`\nUnknown maintain subcommand: "${sub}"`);
        process.exit(1);
      }
  }
}

// ── Restore from backup ──────────────────────────────────────────────────────

function findBackups(projects: string[]): Array<{ project: string; file: string; fullPath: string; age: string }> {
  const results: Array<{ project: string; file: string; fullPath: string; age: string }> = [];
  const now = Date.now();
  for (const project of projects) {
    const dir = path.join(getCortexPath(), project);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".bak")) continue;
      const fullPath = path.join(dir, f);
      const stat = fs.statSync(fullPath);
      const ageMs = now - stat.mtimeMs;
      const ageHours = Math.floor(ageMs / 3600000);
      const age = ageHours < 24 ? `${ageHours}h ago` : `${Math.floor(ageHours / 24)}d ago`;
      results.push({ project, file: f, fullPath, age });
    }
  }
  return results.sort((a, b) => a.project.localeCompare(b.project) || a.file.localeCompare(b.file));
}

async function handleRestoreBackup(args: string[]) {
  const projectArg = args.find((a) => !a.startsWith("-"));
  const projects = targetProjects(projectArg);
  const backups = findBackups(projects);

  if (!backups.length) {
    console.log("No backup files found.");
    return;
  }

  if (args.includes("--list") || !args.includes("--apply")) {
    console.log("Available backups:");
    for (const b of backups) {
      console.log(`  ${b.project}/${b.file}  (${b.age})`);
    }
    console.log("\nTo restore, run: cortex maintain restore <project> --apply");
    return;
  }

  if (!projectArg) {
    console.error("Specify a project to restore: cortex maintain restore <project> --apply");
    process.exit(1);
  }

  const projectBackups = backups.filter((b) => b.project === projectArg);
  if (!projectBackups.length) {
    console.log(`No backup files found for "${projectArg}".`);
    return;
  }

  for (const b of projectBackups) {
    const target = b.fullPath.replace(/\.bak$/, "");
    fs.copyFileSync(b.fullPath, target);
    console.log(`Restored ${b.project}/${b.file.replace(/\.bak$/, "")} from backup`);
  }
  appendAuditLog(getCortexPath(), "restore_backup", `project=${projectArg} files=${projectBackups.length}`);
}

// ── Background maintenance ───────────────────────────────────────────────────

export async function handleBackgroundMaintenance(projectArg?: string) {
  const markers = qualityMarkers(getCortexPath());
  const startedAt = new Date().toISOString();
  try {
    const compacted = compactFindingJournals(getCortexPath(), projectArg);
    const governance = await handleGovernMemories(projectArg, true);
    const pruneResult = pruneDeadMemories(getCortexPath(), projectArg);
    const pruneMsg = pruneResult.ok ? pruneResult.data : pruneResult.error;
    if (!pruneResult.ok) {
      updateRuntimeHealth(getCortexPath(), {
        lastGovernance: {
          at: startedAt,
          status: "error",
          detail: `prune failed: ${pruneMsg}`,
        },
      });
      appendAuditLog(getCortexPath(), "background_maintenance_failed", `error=prune_failed: ${pruneMsg}`);
      return;
    }
    fs.writeFileSync(markers.done, new Date().toISOString() + "\n");
    updateRuntimeHealth(getCortexPath(), {
      lastGovernance: {
        at: startedAt,
        status: "ok",
        detail: `journal_added=${compacted.added} journal_skipped=${compacted.skipped} journal_failed=${compacted.failed}; projects=${governance.projects} stale=${governance.staleCount} conflicts=${governance.conflictCount} review=${governance.reviewCount}; ${pruneMsg}`,
      },
    });
    appendAuditLog(
      getCortexPath(),
      "background_maintenance",
      `status=ok journal_added=${compacted.added} journal_skipped=${compacted.skipped} journal_failed=${compacted.failed} projects=${governance.projects} stale=${governance.staleCount} conflicts=${governance.conflictCount} review=${governance.reviewCount}`
    );
  } catch (err: unknown) {
    const errMsg = errorMessage(err);
    updateRuntimeHealth(getCortexPath(), {
      lastGovernance: {
        at: startedAt,
        status: "error",
        detail: errMsg,
      },
    });
    appendAuditLog(getCortexPath(), "background_maintenance_failed", `error=${errMsg}`);
  } finally {
    try { fs.unlinkSync(markers.lock); } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] cli-govern backgroundMaintenance unlockFinal: ${errorMessage(err)}\n`);
    }
  }
}

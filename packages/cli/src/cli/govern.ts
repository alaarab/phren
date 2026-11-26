import { execFileSync } from "child_process";
import { getStoreProjectDirs, resolveAllStores } from "../store-registry.js";
import { storeAwareProjectPath } from "../store-routing.js";
import { nonInteractiveGitEnv } from "../utils-helpers.js";
import {
  appendAuditLog,
  qualityMarkers,
  getProjectDirs,
  getPhrenPath,
  runtimeFile,
} from "../shared.js";
import {
  appendReviewQueue,
  getRetentionPolicy,
  consolidateProjectFindings,
  updateRuntimeHealth,
  pruneDeadMemories,
} from "../shared/governance.js";
import {
  filterTrustedFindingsDetailed,
} from "../shared/content.js";
import { isLowValueFinding } from "../content/quality.js";
import * as fs from "fs";
import * as path from "path";
import { handleExtractMemories } from "./extract.js";
import { errorMessage } from "../utils.js";
import { FINDINGS_FILENAME } from "../data/access.js";
import { logger } from "../logger.js";
import { compactFindingJournals } from "../finding/journal.js";
import { resolveRuntimeProfile } from "../runtime-profile.js";
import { summarizeProject } from "../content/summarize.js";
import { claimMaintenanceWriter } from "../sync/maintenance-writer.js";
import { tidyDoneTasks } from "../data/tasks.js";
import { recordStoreHealth } from "../governance/store-health.js";
import { citationStateKey, sweepCitationStates } from "../content/citation-states.js";

// ── Shared helpers ───────────────────────────────────────────────────────────

function targetProjects(projectArg?: string): string[] {
  const profile = resolveRuntimeProfile(getPhrenPath());
  return projectArg
    ? [projectArg]
    : getProjectDirs(getPhrenPath(), profile).map((p) => path.basename(p)).filter((p) => p !== "global");
}

interface MaintenanceTarget {
  storePath: string;
  project: string;
}

function maintenanceTargets(projectArg?: string, dryRun = false): MaintenanceTarget[] {
  const primary = getPhrenPath();
  const primaryProject = projectArg ? storeAwareProjectPath(primary, projectArg) : null;
  const primaryMatch = primaryProject && path.resolve(path.dirname(primaryProject)) === path.resolve(primary);
  const targets: MaintenanceTarget[] = [];
  for (const store of resolveAllStores(primary)) {
    if (store.role === "primary") {
      if (primaryProject && !primaryMatch) continue;
      for (const project of targetProjects(projectArg)) targets.push({ storePath: primary, project });
      continue;
    }
    if (primaryMatch && fs.existsSync(primaryProject)) continue;
    try {
      if (store.role === "readonly" || store.sync === "pull-only") throw new Error("read-only");
      if (store.available === false) throw new Error("missing");
      fs.accessSync(store.path, fs.constants.W_OK);
      // Empty only at the checkout root. Comparing --show-toplevel with the store
      // path fails on Windows, where git prints the long form of an 8.3 name.
      const cdup = execFileSync("git", ["rev-parse", "--show-cdup"], {
        cwd: store.path, env: nonInteractiveGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
      }).trim();
      if (cdup) throw new Error("not a git checkout root");
      const projects = getStoreProjectDirs(store).map((dir) => path.basename(dir))
        .filter((project) => projectArg ? project === projectArg : project !== "global");
      if (!projects.length) continue;
      if (!dryRun) {
        const lease = claimMaintenanceWriter(store.path);
        if (!lease.writer) throw new Error(`${lease.holder} holds the maintenance lease`);
      }
      for (const project of projects) targets.push({ storePath: store.path, project });
    } catch (err: unknown) {
      logger.debug("maintenance", `skip store ${store.name}: ${errorMessage(err).replace(/\s+/g, " ")}`);
    }
  }
  return targets;
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
    const backup = path.join(getPhrenPath(), project, "FINDINGS.md.bak");
    if (!fs.existsSync(backup)) continue;
    snapshots.set(backup, fs.statSync(backup).mtimeMs);
  }
  return snapshots;
}

function summarizeBackupChanges(before: Map<string, number>, projects: string[]): string[] {
  const changed: string[] = [];
  for (const project of projects) {
    const backup = path.join(getPhrenPath(), project, "FINDINGS.md.bak");
    if (!fs.existsSync(backup)) continue;
    const current = fs.statSync(backup).mtimeMs;
    const previous = before.get(backup);
    if (previous === undefined || current !== previous) {
      // Normalize to forward slashes for consistent output across platforms
      changed.push(path.relative(getPhrenPath(), backup).replace(/\\/g, "/"));
    }
  }
  return changed.sort();
}


// ── Governance handlers ──────────────────────────────────────────────────────

export interface GovernanceSummary {
  projects: number;
  staleCount: number;
  conflictCount: number;
  reviewCount: number;
}

export async function handleGovernMemories(projectArg?: string, silent: boolean = false, dryRun: boolean = false): Promise<GovernanceSummary> {
  return governTargets(maintenanceTargets(projectArg, dryRun), silent, dryRun);
}

async function governTargets(projects: MaintenanceTarget[], silent: boolean, dryRun = false): Promise<GovernanceSummary> {
  let staleCount = 0;
  let conflictCount = 0;
  let reviewCount = 0;
  const storeSummaries = new Map<string, GovernanceSummary>([
    [getPhrenPath(), { projects: 0, staleCount: 0, conflictCount: 0, reviewCount: 0 }],
  ]);
  // Every computer records the citation states it can check; only a store's lease holder lets them
  // reach its review queue, so one computer's missing repo or drifted checkout never files a conflict.
  const citations = sweepCitationStates(getPhrenPath(), projects, { save: !dryRun });
  const leaseHolder = new Map<string, boolean>();
  const holdsLease = (storePath: string) => {
    if (dryRun) return true;
    if (!leaseHolder.has(storePath)) leaseHolder.set(storePath, claimMaintenanceWriter(storePath).writer);
    return leaseHolder.get(storePath)!;
  };

  for (const { storePath, project } of projects) {
    const summary = storeSummaries.get(storePath) ?? { projects: 0, staleCount: 0, conflictCount: 0, reviewCount: 0 };
    summary.projects++;
    storeSummaries.set(storePath, summary);
    const policy = getRetentionPolicy(storePath, storePath === getPhrenPath() ? undefined : project);
    const ttlDays = Number.parseInt(process.env.PHREN_MEMORY_TTL_DAYS || String(policy.ttlDays), 10);
    const learningsPath = path.join(storePath, project, FINDINGS_FILENAME);
    if (!fs.existsSync(learningsPath)) continue;
    const content = fs.readFileSync(learningsPath, "utf8");
    const holder = holdsLease(storePath);
    const trust = filterTrustedFindingsDetailed(content, {
      ttlDays: Number.isNaN(ttlDays) ? policy.ttlDays : ttlDays,
      minConfidence: policy.minInjectConfidence,
      decay: policy.decay,
      citationState: (_citation, bullet) => holder ? citations.states[citationStateKey(learningsPath, bullet)]?.state : undefined,
    });

    const stale = trust.issues.filter((i) => i.reason === "stale").map((i) => i.bullet);
    const conflicts = trust.issues.filter((i) => i.reason === "invalid_citation").map((i) => i.bullet);
    staleCount += stale.length;
    conflictCount += conflicts.length;

    const lowValue = content.split("\n")
      .filter((l) => l.startsWith("- "))
      .filter((l) => isLowValueFinding(l));
    reviewCount += lowValue.length;
    summary.staleCount += stale.length;
    summary.conflictCount += conflicts.length;
    summary.reviewCount += lowValue.length;

    if (!dryRun) {
      appendReviewQueue(storePath, project, "Stale", stale);
      appendReviewQueue(storePath, project, "Conflicts", conflicts);
      appendReviewQueue(storePath, project, "Review", lowValue);
    }
  }

  if (!dryRun) {
    for (const [storePath, summary] of storeSummaries) {
      appendAuditLog(
        storePath,
        "govern_memories",
        `projects=${summary.projects} stale=${summary.staleCount} conflicts=${summary.conflictCount} review=${summary.reviewCount}`
      );
    }
    for (const { storePath, project } of projects) {
      consolidateProjectFindings(storePath, project);
    }
  }
  if (!silent) {
    const prefix = dryRun ? "[dry-run] Would govern" : "Governed";
    console.log(`${prefix} memories: stale=${staleCount}, conflicts=${conflictCount}, review=${reviewCount}`);
  }
  return {
    projects: projects.length,
    staleCount,
    conflictCount,
    reviewCount,
  };
}

export async function handlePruneMemories(args: string[] = []) {
  const usage = "phren prune-memories [project] [--dry-run]";
  const { projectArg, dryRun } = parseProjectDryRunArgs(args, "prune-memories", usage);
  const projects = targetProjects(projectArg);
  const beforeBackups = dryRun ? new Map<string, number>() : captureFindingBackups(projects);
  const result = pruneDeadMemories(getPhrenPath(), projectArg, dryRun);
  if (!result.ok) {
    console.log(result.error);
    return;
  }
  // pruneDeadMemories owns TTL -> Stale promotion so nightly maintenance gets it too;
  // its message already reports how many entries moved.
  console.log(result.data.message);

  if (dryRun) return;
  const backups = summarizeBackupChanges(beforeBackups, projects);
  if (!backups.length) return;
  console.log(`Updated backups (${backups.length}): ${backups.join(", ")}`);
}

export async function handleConsolidateMemories(args: string[] = []) {
  const usage = "phren consolidate-memories [project] [--dry-run]";
  const { projectArg, dryRun } = parseProjectDryRunArgs(args, "consolidate-memories", usage);
  const projects = targetProjects(projectArg);
  const beforeBackups = dryRun ? new Map<string, number>() : captureFindingBackups(projects);
  const results = projects.map((p) => consolidateProjectFindings(getPhrenPath(), p, dryRun));
  console.log(results.map((r) => r.ok ? r.data : r.error).join("\n"));
  if (dryRun) return;
  const backups = summarizeBackupChanges(beforeBackups, projects);
  if (!backups.length) return;
  console.log(`Updated backups (${backups.length}): ${backups.join(", ")}`);
}

// ── GC (garbage collect) ─────────────────────────────────────────────────────

interface LogPruneReport {
  sessionsRemoved: number;
  runtimeLogsRemoved: number;
}

function pruneSessionLogs(phrenPath: string, dryRun = false): LogPruneReport {
  const cutoff = Date.now() - 30 * 86_400_000;

  function pruneStaleFiles(dir: string, label: string, filter?: (entry: string) => boolean): number {
    if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory()) return 0;
    let removed = 0;
    for (const entry of fs.readdirSync(dir)) {
      if (filter && !filter(entry)) continue;
      const fullPath = path.join(dir, entry);
      try {
        const stat = fs.lstatSync(fullPath);
        if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
        if (dryRun) {
          console.log(`[dry-run] Would remove: ${label}/${entry}`);
        } else {
          fs.unlinkSync(fullPath);
        }
        removed++;
      } catch (err: unknown) {
        logger.debug("maintenance", `session/log pruning ${label}/${entry}: ${errorMessage(err)}`);
      }
    }
    return removed;
  }

  const logExtensions = new Set([".log", ".jsonl", ".json"]);
  const protectedFiles = new Set(["audit.log", "telemetry.json"]);
  const isLog = (entry: string) => logExtensions.has(path.extname(entry)) && !protectedFiles.has(entry);
  return {
    sessionsRemoved: pruneStaleFiles(path.join(phrenPath, ".sessions"), ".sessions"),
    // Not .runtime/sessions: those are mirrored agent conversations the phone still reads.
    runtimeLogsRemoved: pruneStaleFiles(path.join(phrenPath, ".runtime"), ".runtime", isLog),
  };
}

function pruneSessionLogsDaily(phrenPath: string): void {
  try {
    const marker = runtimeFile(phrenPath, "session-log-prune.last-run");
    const now = Date.now();
    let lastAttempt = 0;
    try {
      lastAttempt = Number(fs.readFileSync(marker, "utf8"));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (now - lastAttempt < 86_400_000) return;
    // The scheduler's quality lock serializes maintenance; record the attempt before pruning so failures wait a day too.
    fs.writeFileSync(marker, `${now}\n`);
    const report = pruneSessionLogs(phrenPath);
    logger.debug("maintenance", `session/log pruning: sessions=${report.sessionsRemoved} logs=${report.runtimeLogsRemoved}`);
  } catch (err: unknown) {
    logger.debug("maintenance", `session/log pruning: ${errorMessage(err)}`);
  }
}

async function handleGcMaintain(args: string[] = []): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const phrenPath = getPhrenPath();
  let gitGcRan = false;

  if (dryRun) {
    console.log("[dry-run] Would run: git gc --aggressive");
  } else {
    try {
      execFileSync("git", ["gc", "--aggressive", "--quiet"], { env: nonInteractiveGitEnv(), cwd: phrenPath, stdio: "pipe" });
      gitGcRan = true;
      console.log("git gc --aggressive: done");
    } catch (err: unknown) {
      console.error(`git gc failed: ${errorMessage(err)}`);
    }
  }

  const report = pruneSessionLogs(phrenPath, dryRun);
  const verb = dryRun ? "Would remove" : "Removed";
  console.log(`${verb} ${report.sessionsRemoved} stale session marker(s) from .sessions/`);
  console.log(`${verb} ${report.runtimeLogsRemoved} stale runtime log(s) from .runtime/ (including sessions/)`);

  if (!dryRun) {
    appendAuditLog(
      phrenPath,
      "maintain_gc",
      `gitGc=${gitGcRan} sessions=${report.sessionsRemoved} logs=${report.runtimeLogsRemoved}`
    );
  }
  console.log(
    `\nGC complete:${dryRun ? " (dry-run)" : ""}` +
    ` git_gc=${gitGcRan}` +
    ` sessions_pruned=${report.sessionsRemoved}` +
    ` logs_pruned=${report.runtimeLogsRemoved}`
  );
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
    case "summarize":
      return handleSummarize(rest);
    case "consolidate":
      return handleConsolidateMemories(rest);
    case "extract":
      return handleExtractMemories(rest[0]);
    case "restore":
      return handleRestoreBackup(rest);
    case "gc":
      return handleGcMaintain(rest);
    default:
      console.log(`phren maintain - memory maintenance and governance

Subcommands:
  phren maintain govern [project] [--dry-run]
                                         Queue stale/conflicting/low-value memories for review.
                                         Run when search results feel noisy or after a long break.
  phren maintain prune [project] [--dry-run]
                                         Delete expired entries by retention policy
  phren maintain consolidate [project] [--dry-run]
                                         Deduplicate FINDINGS.md bullets. Run after a burst of work
                                         when findings feel repetitive, or monthly to keep things clean.
  phren maintain extract [project]      Mine git/GitHub signals into memory candidates
  phren maintain restore [project]      List and restore from .bak files
  phren maintain gc [--dry-run]         Run git gc and prune session files and runtime logs older
                                         than 30 days. Pruning also runs daily in background maintenance`);
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
    const dir = path.join(getPhrenPath(), project);
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
    console.log("\nTo restore, run: phren maintain restore <project> --apply");
    return;
  }

  if (!projectArg) {
    console.error("Specify a project to restore: phren maintain restore <project> --apply");
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
  appendAuditLog(getPhrenPath(), "restore_backup", `project=${projectArg} files=${projectBackups.length}`);
}

// ── Background maintenance ───────────────────────────────────────────────────

/**
 * `phren maintain summarize [project] [--llm] [--force]`: write the "## Now"
 * block at the top of every topic file and "What phren knows" in summary.md.
 */
export async function handleSummarize(args: string[]) {
  let projectArg: string | undefined;
  let llm = false;
  let force = false;
  for (const arg of args) {
    if (arg === "--llm") { llm = true; continue; }
    if (arg === "--force") { force = true; continue; }
    if (arg.startsWith("-")) { console.error(`Unknown summarize flag: ${arg}`); console.error("Usage: phren maintain summarize [project] [--llm] [--force]"); process.exit(1); }
    projectArg = arg;
  }
  const phrenPath = getPhrenPath();
  const projects = targetProjects(projectArg);
  let topics = 0;
  let updated = 0;
  for (const project of projects) {
    const result = await summarizeProject(phrenPath, project, { llm, force });
    topics += result.topics.length;
    updated += result.topics.filter((t) => t.updated).length + (result.summaryUpdated ? 1 : 0);
    const split = result.topics.filter((t) => t.split).map((t) => path.basename(t.split!));
    console.log(`${project}: ${result.topics.length} topic file(s), ${result.topics.filter((t) => t.updated).length} refreshed${result.summaryUpdated ? ", summary.md updated" : ""}${split.length ? `, split: ${split.join(", ")}` : ""}`);
  }
  console.log(`Summarized ${projects.length} project(s): ${topics} topic file(s), ${updated} file(s) written${llm ? " (LLM prose where a model answered)" : ""}.`);
  appendAuditLog(phrenPath, "summarize", `projects=${projects.length} topics=${topics} updated=${updated} llm=${llm}`);
}

export async function handleBackgroundMaintenance(projectArg?: string) {
  const markers = qualityMarkers(getPhrenPath());
  const startedAt = new Date().toISOString();
  try {
    pruneSessionLogsDaily(getPhrenPath());
    const projects = maintenanceTargets(projectArg);
    const compacted = compactFindingJournals(getPhrenPath(), projectArg);
    for (const { storePath, project } of projects) {
      if (storePath === getPhrenPath()) continue;
      const result = compactFindingJournals(storePath, project);
      compacted.added += result.added;
      compacted.skipped += result.skipped;
      compacted.failed += result.failed;
    }
    const governance = await governTargets(projects, true);
    // Done tasks past thirty move to .config/task-archive, and topic files get
    // their "## Now" block refreshed when they changed. Both structural and
    // cheap; a model is only consulted from `phren maintain summarize --llm`.
    let tidied = 0;
    let summarized = 0;
    // Attached targets already hold their store lease; the primary keeps its existing journal and governance behavior.
    const lease = claimMaintenanceWriter(getPhrenPath());
    for (const { storePath, project } of projects) {
      if (storePath === getPhrenPath() && !lease.writer) continue;
      try {
        const tidy = tidyDoneTasks(storePath, project, 30);
        if (tidy.ok && tidy.data.startsWith("Tidied")) tidied++;
      } catch (err: unknown) { logger.debug("maintenance", `tidy ${project}: ${errorMessage(err)}`); }
      try {
        const summary = await summarizeProject(storePath, project, {});
        if (summary.topics.some((t) => t.updated) || summary.summaryUpdated) summarized++;
      } catch (err: unknown) { logger.debug("maintenance", `summarize ${project}: ${errorMessage(err)}`); }
    }
    const primarySelected = !projectArg || projects.some((p) => p.storePath === getPhrenPath());
    const pruneResult = lease.writer && primarySelected
      ? pruneDeadMemories(getPhrenPath(), projectArg)
      : { ok: true as const, data: { message: primarySelected ? `prune skipped: ${lease.holder} maintains generated files` : "prune skipped: no primary project selected" } };
    const pruneMessages = [pruneResult.ok ? pruneResult.data.message : pruneResult.error];
    let pruneFailed = !pruneResult.ok;
    for (const { storePath, project } of projects) {
      if (storePath === getPhrenPath()) continue;
      const result = pruneDeadMemories(storePath, project);
      pruneMessages.push(`${storePath}/${project}: ${result.ok ? result.data.message : result.error}`);
      if (!result.ok) pruneFailed = true;
    }
    const pruneMsg = pruneMessages.join("; ").replace(/\n+/g, " ");
    if (pruneFailed) {
      updateRuntimeHealth(getPhrenPath(), {
        lastGovernance: {
          at: startedAt,
          status: "error",
          detail: `prune failed: ${pruneMsg}`,
        },
      });
      appendAuditLog(getPhrenPath(), "background_maintenance_failed", `error=prune_failed: ${pruneMsg}`);
      return;
    }
    fs.writeFileSync(markers.done, new Date().toISOString() + "\n");
    updateRuntimeHealth(getPhrenPath(), {
      lastGovernance: {
        at: startedAt,
        status: "ok",
        detail: `journal_added=${compacted.added} journal_skipped=${compacted.skipped} journal_failed=${compacted.failed}; projects=${governance.projects} stale=${governance.staleCount} conflicts=${governance.conflictCount} review=${governance.reviewCount}; ${pruneMsg}`,
      },
    });
    appendAuditLog(
      getPhrenPath(),
      "background_maintenance",
      `status=ok journal_added=${compacted.added} journal_skipped=${compacted.skipped} journal_failed=${compacted.failed} projects=${governance.projects} stale=${governance.staleCount} conflicts=${governance.conflictCount} review=${governance.reviewCount} tasks_tidied=${tidied} summarized=${summarized}`
    );
  } catch (err: unknown) {
    const errMsg = errorMessage(err);
    updateRuntimeHealth(getPhrenPath(), {
      lastGovernance: {
        at: startedAt,
        status: "error",
        detail: errMsg,
      },
    });
    appendAuditLog(getPhrenPath(), "background_maintenance_failed", `error=${errMsg}`);
  } finally {
    try { recordStoreHealth(getPhrenPath()); }
    catch (err: unknown) { logger.debug("maintenance", `store health: ${errorMessage(err)}`); }
    try { fs.unlinkSync(markers.lock); } catch (err: unknown) {
      if ((process.env.PHREN_DEBUG)) logger.debug("cli-govern", `backgroundMaintenance unlockFinal: ${errorMessage(err)}`);
    }
  }
}

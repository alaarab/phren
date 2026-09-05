import {
  appendAuditLog,
  qualityMarkers,
  getProjectDirs,
  getPhrenPath,
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
import { tidyDoneTasks } from "../data/tasks.js";

// ── Shared helpers ───────────────────────────────────────────────────────────

function targetProjects(projectArg?: string): string[] {
  const profile = resolveRuntimeProfile(getPhrenPath());
  return projectArg
    ? [projectArg]
    : getProjectDirs(getPhrenPath(), profile).map((p) => path.basename(p)).filter((p) => p !== "global");
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
  const profile = resolveRuntimeProfile(getPhrenPath());
  const policy = getRetentionPolicy(getPhrenPath());
  const ttlDays = Number.parseInt((process.env.PHREN_MEMORY_TTL_DAYS) || String(policy.ttlDays), 10);
  const projects = projectArg
    ? [projectArg]
    : getProjectDirs(getPhrenPath(), profile).map((p) => path.basename(p)).filter((p) => p !== "global");

  let staleCount = 0;
  let conflictCount = 0;
  let reviewCount = 0;

  for (const project of projects) {
    const learningsPath = path.join(getPhrenPath(), project, FINDINGS_FILENAME);
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
      .filter((l) => isLowValueFinding(l));
    reviewCount += lowValue.length;

    if (!dryRun) {
      appendReviewQueue(getPhrenPath(), project, "Stale", stale);
      appendReviewQueue(getPhrenPath(), project, "Conflicts", conflicts);
      appendReviewQueue(getPhrenPath(), project, "Review", lowValue);
    }
  }

  if (!dryRun) {
    appendAuditLog(
      getPhrenPath(),
      "govern_memories",
      `projects=${projects.length} stale=${staleCount} conflicts=${conflictCount} review=${reviewCount}`
    );
    for (const project of projects) {
      consolidateProjectFindings(getPhrenPath(), project);
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

interface GcReport {
  gitGcRan: boolean;
  commitsSquashed: number;
  sessionsRemoved: number;
  runtimeLogsRemoved: number;
}

async function handleGcMaintain(args: string[] = []): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const phrenPath = getPhrenPath();
  const { execFileSync } = await import("child_process");
  const report: GcReport = {
    gitGcRan: false,
    commitsSquashed: 0,
    sessionsRemoved: 0,
    runtimeLogsRemoved: 0,
  };

  // 1. Run git gc --aggressive on the ~/.phren repo
  if (dryRun) {
    console.log("[dry-run] Would run: git gc --aggressive");
  } else {
    try {
      execFileSync("git", ["gc", "--aggressive", "--quiet"], { cwd: phrenPath, stdio: "pipe" });
      report.gitGcRan = true;
      console.log("git gc --aggressive: done");
    } catch (err: unknown) {
      console.error(`git gc failed: ${errorMessage(err)}`);
    }
  }

  // 2. Squash old auto-save commits (older than 7 days) into weekly summaries
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  let oldCommits: string[] = [];
  try {
    const raw = execFileSync("git", ["log", `--before=${sevenDaysAgo}`, "--format=%H %ci %s"], {
      cwd: phrenPath,
      encoding: "utf8",
    }).trim();
    if (raw) {
      oldCommits = raw.split("\n").filter((l) => l.includes("auto-save:") || l.includes("[auto]"));
    }
  } catch {
    // Not a git repo or no commits — skip silently
  }

  if (oldCommits.length === 0) {
    console.log("Commit squash: no old auto-save commits to squash.");
  } else if (dryRun) {
    console.log(`[dry-run] Would squash ${oldCommits.length} auto-save commits older than 7 days into weekly summaries.`);
    report.commitsSquashed = oldCommits.length;
  } else {
    // Group by ISO week based on commit timestamp (already in the log output)
    const commitsByWeek = new Map<string, string[]>();
    for (const line of oldCommits) {
      const hash = line.split(" ")[0];
      // Format: "HASH YYYY-MM-DD HH:MM:SS +ZZZZ subject..."
      const dateMatch = line.match(/^[a-f0-9]+ (\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;
      const date = new Date(dateMatch[1]);
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay());
      const weekKey = weekStart.toISOString().slice(0, 10);
      if (!commitsByWeek.has(weekKey)) commitsByWeek.set(weekKey, []);
      commitsByWeek.get(weekKey)!.push(hash);
    }

    // For each week with multiple commits, soft-reset to oldest and amend into a summary
    for (const [weekKey, hashes] of commitsByWeek.entries()) {
      if (hashes.length < 2) continue;
      try {
        const oldest = hashes[hashes.length - 1];
        const newest = hashes[0];
        // Use git rev-parse to get the parent of the oldest commit
        const parentOfOldest = execFileSync("git", ["rev-parse", `${oldest}^`], {
          cwd: phrenPath,
          encoding: "utf8",
        }).trim();
        // Build rebase script via env variable to squash all but first to "squash"
        const rebaseScript = hashes
          .map((h, i) => `${i === hashes.length - 1 ? "pick" : "squash"} ${h} auto-save`)
          .reverse()
          .join("\n");
        const scriptPath = path.join(phrenPath, ".runtime", `gc-rebase-${weekKey}.sh`);
        fs.writeFileSync(scriptPath, rebaseScript);
        // Use GIT_SEQUENCE_EDITOR env var to feed our script to git rebase
        execFileSync("git", ["rebase", "-i", parentOfOldest], {
          cwd: phrenPath,
          stdio: "pipe",
          env: { ...process.env, GIT_SEQUENCE_EDITOR: `cat ${scriptPath} >` },
        });
        fs.unlinkSync(scriptPath);
        report.commitsSquashed += hashes.length - 1;
        console.log(`Squashed ${hashes.length} auto-save commits for week of ${weekKey} (${newest.slice(0, 7)}..${oldest.slice(0, 7)}).`);
      } catch {
        // Squashing is best-effort — log and continue
        console.warn(`  Could not squash auto-save commits for week ${weekKey} (possibly non-linear history). Skipping.`);
      }
    }

    if (report.commitsSquashed === 0) {
      console.log("Commit squash: all old auto-save weeks have only one commit, nothing to squash.");
    }
  }

  // 3–4. Prune stale files from .sessions/ and .runtime/
  const thirtyDaysAgo = Date.now() - 30 * 86400000;

  function pruneStaleFiles(
    dir: string,
    label: string,
    filter?: (entry: string) => boolean,
  ): number {
    let removed = 0;
    if (!fs.existsSync(dir)) return removed;
    for (const entry of fs.readdirSync(dir)) {
      if (filter && !filter(entry)) continue;
      const fullPath = path.join(dir, entry);
      try {
        if (fs.statSync(fullPath).mtimeMs < thirtyDaysAgo) {
          if (dryRun) {
            console.log(`[dry-run] Would remove: ${label}/${entry}`);
          } else {
            fs.unlinkSync(fullPath);
          }
          removed++;
        }
      } catch { /* skip unreadable */ }
    }
    return removed;
  }

  const logExtensions = new Set([".log", ".jsonl", ".json"]);
  const protectedFiles = new Set(["audit.log", "telemetry.json"]);

  report.sessionsRemoved = pruneStaleFiles(path.join(phrenPath, ".sessions"), ".sessions");
  report.runtimeLogsRemoved = pruneStaleFiles(
    path.join(phrenPath, ".runtime"),
    ".runtime",
    (entry) => logExtensions.has(path.extname(entry)) && !protectedFiles.has(entry),
  );

  const verb = dryRun ? "Would remove" : "Removed";
  console.log(`${verb} ${report.sessionsRemoved} stale session marker(s) from .sessions/`);
  console.log(`${verb} ${report.runtimeLogsRemoved} stale runtime log(s) from .runtime/`);

  // 5. Summary
  if (!dryRun) {
    appendAuditLog(
      phrenPath,
      "maintain_gc",
      `gitGc=${report.gitGcRan} squashed=${report.commitsSquashed} sessions=${report.sessionsRemoved} logs=${report.runtimeLogsRemoved}`
    );
  }
  console.log(
    `\nGC complete:${dryRun ? " (dry-run)" : ""}` +
    ` git_gc=${report.gitGcRan}` +
    ` commits_squashed=${report.commitsSquashed}` +
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
  phren maintain gc [--dry-run]         Garbage-collect the ~/.phren repo: git gc, squash old
                                         auto-save commits, prune stale session markers and runtime logs`);
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
    const compacted = compactFindingJournals(getPhrenPath(), projectArg);
    const governance = await handleGovernMemories(projectArg, true);
    // Done tasks past thirty move to .config/task-archive, and topic files get
    // their "## Now" block refreshed when they changed. Both structural and
    // cheap; a model is only consulted from `phren maintain summarize --llm`.
    let tidied = 0;
    let summarized = 0;
    for (const project of targetProjects(projectArg)) {
      try {
        const tidy = tidyDoneTasks(getPhrenPath(), project, 30);
        if (tidy.ok && tidy.data.startsWith("Tidied")) tidied++;
      } catch (err: unknown) { logger.debug("maintenance", `tidy ${project}: ${errorMessage(err)}`); }
      try {
        const summary = await summarizeProject(getPhrenPath(), project, {});
        if (summary.topics.some((t) => t.updated) || summary.summaryUpdated) summarized++;
      } catch (err: unknown) { logger.debug("maintenance", `summarize ${project}: ${errorMessage(err)}`); }
    }
    const pruneResult = pruneDeadMemories(getPhrenPath(), projectArg);
    const pruneMsg = pruneResult.ok ? pruneResult.data.message.replace(/\n+/g, " ") : pruneResult.error;
    if (!pruneResult.ok) {
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
    try { fs.unlinkSync(markers.lock); } catch (err: unknown) {
      if ((process.env.PHREN_DEBUG)) logger.debug("cli-govern", `backgroundMaintenance unlockFinal: ${errorMessage(err)}`);
    }
  }
}

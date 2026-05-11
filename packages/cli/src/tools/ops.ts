import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse } from "./types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { runtimeFile, getProjectDirs } from "../shared.js";
import { findFtsCacheForPath } from "../shared/index.js";
import { isValidProjectName, errorMessage } from "../utils.js";
import { readReviewQueue, readReviewQueueAcrossProjects, approveQueueItem, rejectQueueItem, editQueueItem } from "../data/access.js";
import { addProjectFromPath } from "../core/project.js";
import { PROJECT_OWNERSHIP_MODES, parseProjectOwnershipMode } from "../project-config.js";
import { resolveRuntimeProfile } from "../runtime-profile.js";
import { getMachineName } from "../machine-identity.js";
import { resolveAllStores } from "../store-registry.js";

import { getProjectConsolidationStatus, CONSOLIDATION_ENTRY_THRESHOLD } from "../content/validate.js";
import { logger } from "../logger.js";
import { getRuntimeHealth } from "../governance/policy.js";
import { countUnsyncedCommits } from "../cli-hooks-git.js";

// ── Handlers ─────────────────────────────────────────────────────────────────

async function handleAddProject(
  ctx: McpContext,
  { path: targetPath, profile: requestedProfile, ownership, store: storeName }: {
    path: string;
    profile?: string;
    ownership?: (typeof PROJECT_OWNERSHIP_MODES)[number];
    store?: string;
  },
) {
  const { phrenPath, profile, withWriteQueue } = ctx;
  return withWriteQueue(async () => {
    try {
      // Resolve the target store path: explicit store > auto-route by project claim > primary
      let targetPhrenPath = phrenPath;
      let storeRole = "primary";
      if (storeName) {
        const stores = resolveAllStores(phrenPath);
        const store = stores.find((s) => s.name === storeName);
        if (!store) {
          return mcpResponse({ ok: false, error: `Store "${storeName}" not found` });
        }
        if (store.role === "readonly") {
          return mcpResponse({ ok: false, error: `Store "${storeName}" is read-only` });
        }
        targetPhrenPath = store.path;
        storeRole = store.role;
      } else {
        // Check if any non-primary writable store claims this project
        const projectName = targetPath
          ? path.basename(path.resolve(targetPath)).toLowerCase().replace(/[^a-z0-9_-]/g, "-")
          : undefined;
        if (projectName) {
          const stores = resolveAllStores(phrenPath);
          for (const store of stores) {
            if (store.role !== "readonly" && store.role !== "primary" && store.projects?.includes(projectName)) {
              targetPhrenPath = store.path;
              storeRole = store.role;
              break;
            }
          }
        }
      }

      const added = addProjectFromPath(
        phrenPath,
        targetPath,
        requestedProfile || profile || undefined,
        parseProjectOwnershipMode(ownership) ?? undefined,
        { writeToPath: targetPhrenPath }
      );
      if (!added.ok) {
        return mcpResponse({
          ok: false,
          error: added.error,
        });
      }
      await ctx.rebuildIndex();
      return mcpResponse({
        ok: true,
        message: `Added project "${added.data.project}" (${added.data.ownership}) from ${added.data.path}` +
          (storeRole !== "primary" ? ` [store: ${storeName || storeRole}]` : "") +
          `.`,
        data: added.data,
      });
    } catch (err: unknown) {
      return mcpResponse({
        ok: false,
        error: errorMessage(err),
      });
    }
  });
}

async function handleHealthCheck(
  ctx: McpContext,
  { include_consolidation }: { include_consolidation?: boolean },
) {
  const { phrenPath, profile } = ctx;
  const activeProfile = (() => {
    try {
      return resolveRuntimeProfile(phrenPath);
    } catch {
      return profile || "";
    }
  })();

  // Version
  let version = "unknown";
  try {
    const pkgPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    version = pkg.version || "unknown";
  } catch (err: unknown) {
    logger.debug("healthCheck version", errorMessage(err));
  }

  // FTS index (lives in /tmpphren-fts-*/, not .runtime/)
  let indexStatus: { exists: boolean; sizeBytes?: number } = { exists: false };
  try {
    indexStatus = findFtsCacheForPath(phrenPath, activeProfile);
  } catch (err: unknown) {
    logger.debug("healthCheck ftsCacheCheck", errorMessage(err));
  }

  // Hook registration
  let hooksEnabled = false;
  try {
    const { getHooksEnabledPreference } = await import("../init/preferences.js");
    hooksEnabled = getHooksEnabledPreference(phrenPath);
  } catch (err: unknown) {
    logger.debug("healthCheck hooksEnabled", errorMessage(err));
  }

  let mcpEnabled = false;
  try {
    const { getMcpEnabledPreference } = await import("../init/preferences.js");
    mcpEnabled = getMcpEnabledPreference(phrenPath);
  } catch (err: unknown) {
    logger.debug("healthCheck mcpEnabled", errorMessage(err));
  }

  // Profile/machine info
  const machineName = (() => {
    try {
      return getMachineName();
    } catch (err: unknown) {
      logger.debug("healthCheck machineName", errorMessage(err));
    }
    return undefined;
  })();

  const projectCount = getProjectDirs(phrenPath, activeProfile).length;

  // Proactivity and taskMode
  let proactivity: string = "high";
  let taskMode: string = "auto";
  try {
    const { getWorkflowPolicy } = await import("../governance/policy.js");
    const workflowPolicy = getWorkflowPolicy(phrenPath);
    taskMode = workflowPolicy.taskMode;
  } catch (err: unknown) {
    logger.debug("healthCheck taskMode", errorMessage(err));
  }
  let syncIntent: string | undefined;
  try {
    const { readInstallPreferences } = await import("../init/preferences.js");
    const prefs = readInstallPreferences(phrenPath);
    proactivity = prefs.proactivity || "high";
    syncIntent = prefs.syncIntent;
  } catch (err: unknown) {
    logger.debug("healthCheck proactivity", errorMessage(err));
  }

  // Determine sync status from intent + git remote state
  let syncStatus: "synced" | "local-only" | "broken" = "local-only";
  let syncDetail = "no git remote configured";
  try {
    const { execFileSync } = await import("child_process");
    const remote = execFileSync("git", ["-C", phrenPath, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    if (remote) {
      try {
        execFileSync("git", ["-C", phrenPath, "ls-remote", "--exit-code", "origin"], {
          stdio: ["ignore", "ignore", "ignore"],
          timeout: 10_000,
        });
        syncStatus = "synced";
        syncDetail = `origin=${remote}`;
      } catch {
        syncStatus = syncIntent === "sync" ? "broken" : "local-only";
        syncDetail = `origin=${remote} (unreachable)`;
      }
    } else if (syncIntent === "sync") {
      syncStatus = "broken";
      syncDetail = "sync was configured but no remote found";
    }
  } catch {
    if (syncIntent === "sync") {
      syncStatus = "broken";
      syncDetail = "sync was configured but no remote found";
    }
  }

  // Consolidation status (opt-out via include_consolidation: false)
  type ConsolidationEntry = {
    project: string;
    entriesSince: number;
    threshold: number;
    daysSince: number | null;
    lastConsolidated: string | null;
    recommended: boolean;
  };
  let consolidation: ConsolidationEntry[] | null = null;

  if (include_consolidation !== false) {
    try {
      const projectDirsForConsol = getProjectDirs(phrenPath, activeProfile);
      const consolResults: ConsolidationEntry[] = [];
      for (const dir of projectDirsForConsol) {
        const status = getProjectConsolidationStatus(dir);
        if (!status) continue;
        consolResults.push({ ...status, threshold: CONSOLIDATION_ENTRY_THRESHOLD });
      }
      consolidation = consolResults;
    } catch (err: unknown) {
      logger.debug("healthCheck consolidation", errorMessage(err));
      consolidation = null;
    }
  }

  const consolSummary = consolidation && consolidation.length > 0
    ? consolidation.filter(r => r.recommended).length > 0
      ? `Consolidation: ${consolidation.filter(r => r.recommended).length} project(s) need consolidation`
      : `Consolidation: all projects OK`
    : null;

  // ── Surface RuntimeHealth warnings ────────────────────────────────────
  const warnings: string[] = [];
  try {
    const health = getRuntimeHealth(phrenPath);

    // Unsynced commits
    const unsynced = health.lastSync?.unsyncedCommits;
    if (typeof unsynced === "number" && unsynced > 0) {
      warnings.push(`Unsynced commits: ${unsynced} (last push: ${health.lastSync?.lastPushStatus ?? "unknown"})`);
    }

    // Last auto-save error
    if (health.lastAutoSave?.status === "error") {
      warnings.push(`Last auto-save failed: ${health.lastAutoSave.detail ?? "unknown error"}`);
    }

    // Last push error
    if (health.lastSync?.lastPushStatus === "error") {
      warnings.push(`Last push failed: ${health.lastSync.lastPushDetail ?? "unknown error"}`);
    }

    // Check live unsynced commit count (may differ from cached value)
    if (syncStatus === "synced" && (!unsynced || unsynced === 0)) {
      try {
        const liveUnsynced = await countUnsyncedCommits(phrenPath);
        if (liveUnsynced > 0) {
          warnings.push(`Unsynced commits: ${liveUnsynced} (not yet pushed to remote)`);
        }
      } catch (err: unknown) {
        logger.debug("healthCheck liveUnsyncedCount", errorMessage(err));
      }
    }
  } catch (err: unknown) {
    logger.debug("healthCheck runtimeHealth", errorMessage(err));
  }

  // Check recent sync warnings from background sync
  try {
    const syncWarningsPath = runtimeFile(phrenPath, "sync-warnings.jsonl");
    if (fs.existsSync(syncWarningsPath)) {
      const lines = fs.readFileSync(syncWarningsPath, "utf8").trim().split("\n").filter(Boolean);
      const recent = lines.slice(-3); // last 3 warnings
      for (const line of recent) {
        try {
          const entry = JSON.parse(line) as { at?: string; error?: string; unsyncedCommits?: number };
          if (entry.error) {
            warnings.push(`Background sync failed (${entry.at?.slice(0, 16) ?? "unknown"}): ${entry.error}`);
          }
        } catch { /* skip malformed lines */ }
      }
    }
  } catch (err: unknown) {
    logger.debug("healthCheck syncWarnings", errorMessage(err));
  }

  // Check embedding/LLM availability
  try {
    const { getOllamaUrl } = await import("../shared/ollama.js");
    const ollamaUrl = getOllamaUrl();
    const hasEmbeddingApi = !!process.env.PHREN_EMBEDDING_API_URL;
    if (!ollamaUrl && !hasEmbeddingApi) {
      warnings.push("Embeddings: unavailable (no Ollama or API endpoint configured)");
    }
    const hasLlmEndpoint = !!process.env.PHREN_LLM_ENDPOINT;
    const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
    const hasOpenAiKey = !!process.env.OPENAI_API_KEY;
    if (!hasLlmEndpoint && !hasAnthropicKey && !hasOpenAiKey) {
      warnings.push("LLM features: unavailable (no API key configured for semantic dedup/conflict detection)");
    }
  } catch (err: unknown) {
    logger.debug("healthCheck serviceAvailability", errorMessage(err));
  }

  const warningsSummary = warnings.length > 0
    ? `Warnings: ${warnings.length}\n  ${warnings.join("\n  ")}`
    : null;

  const lines = [
    `Phren v${version}`,
    `Profile: ${activeProfile || "(default)"}`,
    machineName ? `Machine: ${machineName}` : null,
    `Projects: ${projectCount}`,
    `FTS index: ${indexStatus.exists ? `ok (${Math.round((indexStatus.sizeBytes ?? 0) / 1024)} KB)` : "missing"}`,
    `MCP: ${mcpEnabled ? "enabled" : "disabled"}`,
    `Hooks: ${hooksEnabled ? "enabled" : "disabled"}`,
    `Proactivity: ${proactivity}`,
    `Task mode: ${taskMode}`,
    `Sync: ${syncStatus}${syncStatus !== "synced" ? ` (${syncDetail})` : ""}`,
    consolSummary,
    warningsSummary,
    `Path: ${phrenPath}`,
  ].filter(Boolean);

  return mcpResponse({
    ok: true,
    message: lines.join("\n"),
    data: {
      version,
      profile: activeProfile || "(default)",
      machine: machineName ?? null,
      projectCount,
      index: indexStatus,
      mcpEnabled,
      hooksEnabled,
      proactivity,
      taskMode,
      syncStatus,
      syncDetail,
      consolidation,
      warnings,
      phrenPath,
    },
  });
}

async function handleDoctorFix(
  _ctx: McpContext,
  { check_data }: { check_data?: boolean },
) {
  const { phrenPath } = _ctx;
  const { runDoctor } = await import("../link/doctor.js");
  const result = await runDoctor(phrenPath, true, check_data ?? false);
  const lines = result.checks.map((c) => `${c.ok ? "ok" : "FAIL"} ${c.name}: ${c.detail}`);
  const failCount = result.checks.filter((c) => !c.ok).length;
  return mcpResponse({
    ok: result.ok,
    ...(result.ok ? {} : { error: `${failCount} check(s) could not be auto-fixed: ${lines.filter((l) => l.startsWith("FAIL")).join("; ")}` }),
    message: result.ok
      ? `Doctor fix complete: all ${result.checks.length} checks passed`
      : `Doctor fix complete: ${failCount} issue(s) remain`,
    data: {
      machine: result.machine,
      profile: result.profile,
      checks: result.checks,
      summary: lines.join("\n"),
    },
  });
}

async function handleListHookErrors(
  ctx: McpContext,
  { limit }: { limit?: number },
) {
  const { phrenPath } = ctx;
  const maxEntries = limit ?? 20;

  const ERROR_PATTERNS = [
    /\berror\b/i,
    /\bfail(ed|ure|s)?\b/i,
    /\bcrash(ed)?\b/i,
    /\btimeout\b/i,
    /\bEXCEPTION\b/i,
    /\bEACCES\b/,
    /\bENOENT\b/,
    /\bEPERM\b/,
    /\bENOSPC\b/,
  ];

  function readErrorLines(filePath: string, filterPatterns: boolean): string[] {
    try {
      if (!fs.existsSync(filePath)) return [];
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n").filter(l => l.trim());
      if (!filterPatterns) return lines; // hook-errors.log: every line is an error
      return lines.filter(line => ERROR_PATTERNS.some(p => p.test(line)));
    } catch (err: unknown) {
      logger.debug("readErrorLines", errorMessage(err));
      return [];
    }
  }

  // hook-errors.log contains only hook failure lines (no filtering needed)
  const hookErrors = readErrorLines(runtimeFile(phrenPath, "hook-errors.log"), false);
  // debug.log may contain non-error lines, so filter
  const debugErrors = readErrorLines(runtimeFile(phrenPath, "debug.log"), true);

  const allErrors = [...hookErrors, ...debugErrors];

  if (allErrors.length === 0) {
    return mcpResponse({
      ok: true,
      message: "No error entries found. Hook errors go to hook-errors.log; general errors require PHREN_DEBUG=1.",
      data: { errors: [], total: 0 },
    });
  }

  const recent = allErrors.slice(-maxEntries);
  return mcpResponse({
    ok: true,
    message: `Found ${allErrors.length} error(s), showing last ${recent.length}:\n\n${recent.join("\n")}`,
    data: { errors: recent, total: allErrors.length, sources: { hookErrors: hookErrors.length, debugErrors: debugErrors.length } },
  });
}

async function handleGetReviewQueue(
  ctx: McpContext,
  { project }: { project?: string },
) {
  const { phrenPath, profile } = ctx;
  if (project && !isValidProjectName(project)) {
    return mcpResponse({ ok: false, error: `Invalid project name: "${project}".` });
  }
  if (project) {
    const result = readReviewQueue(phrenPath, project);
    if (!result.ok) {
      return mcpResponse({ ok: false, error: result.error, errorCode: result.code });
    }
    const items = result.data.map((item) => ({ ...item, project }));
    return mcpResponse({
      ok: true,
      message: `${items.length} queue item(s) for "${project}".`,
      data: { items },
    });
  }

  const result = readReviewQueueAcrossProjects(phrenPath, profile);
  if (!result.ok) {
    return mcpResponse({ ok: false, error: result.error, errorCode: result.code });
  }
  return mcpResponse({
    ok: true,
    message: `${result.data.length} queue item(s) across all projects.`,
    data: { items: result.data },
  });
}

async function handleManageReviewItem(
  ctx: McpContext,
  { project, line, action, new_text }: {
    project: string;
    line: string;
    action: "approve" | "reject" | "edit";
    new_text?: string;
  },
) {
  const { phrenPath, withWriteQueue } = ctx;
  if (!isValidProjectName(project)) {
    return mcpResponse({ ok: false, error: `Invalid project name: "${project}".` });
  }
  if (action === "edit" && !new_text) {
    return mcpResponse({ ok: false, error: "new_text is required when action is 'edit'." });
  }
  return withWriteQueue(async () => {
    let result;
    switch (action) {
      case "approve":
        result = approveQueueItem(phrenPath, project, line);
        break;
      case "reject":
        result = rejectQueueItem(phrenPath, project, line);
        break;
      case "edit":
        result = editQueueItem(phrenPath, project, line, new_text!);
        break;
    }
    if (!result.ok) {
      return mcpResponse({ ok: false, error: result.error, errorCode: result.code });
    }
    return mcpResponse({ ok: true, message: result.data });
  });
}

// ── Registration ─────────────────────────────────────────────────────────────

export function register(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    "add_project",
    {
      title: "◆ phren · add project",
      description:
        "Bootstrap a project into phren from a repo or working directory. " +
        "Copies or creates CLAUDE.md/summary/tasks/findings under ~/.phren/<project> and adds the project to the active profile.",
      inputSchema: z.object({
        path: z.string().describe("Project path to import. Pass the current repo path explicitly."),
        profile: z.string().optional().describe("Profile to update. Defaults to the active profile."),
        ownership: z.enum(PROJECT_OWNERSHIP_MODES).optional()
          .describe("How Phren should treat repo-facing instruction files: phren-managed, detached, or repo-managed."),
        store: z.string().optional()
          .describe("Target store name (from stores.yaml). If omitted, auto-routes to the store that claims this project, or falls back to the primary store."),
      }),
    },
    (params) => handleAddProject(ctx, params),
  );

  server.registerTool(
    "health_check",
    {
      title: "◆ phren · health",
      description:
        "Return phren health status: version, FTS index status, hook registration, profile/machine info, and consolidation status for all projects.",
      inputSchema: z.object({
        include_consolidation: z.boolean().optional()
          .describe("Include consolidation status for all projects (default true)."),
      }),
    },
    (params) => handleHealthCheck(ctx, params),
  );

  server.registerTool(
    "doctor_fix",
    {
      title: "◆ phren · doctor fix",
      description:
        "Run phren doctor with --fix: re-links hooks, symlinks, context, and memory pointers. " +
        "Returns the list of checks and repair actions taken.",
      inputSchema: z.object({
        check_data: z.boolean().optional()
          .describe("Also validate data files (tasks, findings, governance). Default false."),
      }),
    },
    (params) => handleDoctorFix(ctx, params),
  );

  server.registerTool(
    "list_hook_errors",
    {
      title: "◆ phren · hook errors",
      description:
        "List recent error entries from phren hook-errors.log and debug.log. " +
        "Useful for diagnosing hook or index failures.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).optional()
          .describe("Max error entries to return (default 20)."),
      }),
    },
    (params) => handleListHookErrors(ctx, params),
  );

  server.registerTool(
    "get_review_queue",
    {
      title: "◆ phren · get review queue",
      description:
        "List all items in a project's review queue (review.md), or across all projects when omitted. " +
        "Returns items with their id, section (Review/Stale/Conflicts), date, text, confidence, and risky flag.",
      inputSchema: z.object({
        project: z.string().optional().describe("Project name. Omit to read the review queue across all projects in the active profile."),
      }),
    },
    (params) => handleGetReviewQueue(ctx, params),
  );

  server.registerTool(
    "manage_review_item",
    {
      title: "◆ phren · manage review item",
      description:
        "Manage a review queue item: approve (removes from queue, finding stays), reject (removes from queue AND FINDINGS.md), or edit (updates text in both).",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        line: z.string().max(10000).describe("The raw queue line text (as returned by get_review_queue)."),
        action: z.enum(["approve", "reject", "edit"]).describe("Action to perform on the queue item."),
        new_text: z.string().max(10000).optional().describe("Required when action is 'edit'."),
      }),
    },
    (params) => handleManageReviewItem(ctx, params),
  );
}

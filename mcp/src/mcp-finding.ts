import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse } from "./mcp-types.js";
import { z } from "zod";
import * as path from "path";
import { isValidProjectName, safeProjectPath, errorMessage } from "./utils.js";
import {
  removeFinding as removeFindingCore,
  removeFindings as removeFindingsCore,
} from "./core-finding.js";
import {
  debugLog,
  EXEC_TIMEOUT_MS,
  FINDING_TYPES,
} from "./shared.js";
import {
  addFindingToFile,
  addFindingsToFile,
  checkSemanticDedup,
  checkSemanticConflicts,
  autoMergeConflicts,
} from "./shared-content.js";
import { runCustomHooks } from "./hooks.js";
import { incrementSessionFindings } from "./mcp-session.js";
import { extractEntityNames } from "./shared-entity-graph.js";
import { extractFactFromFinding } from "./mcp-extract-facts.js";



function extractConflictsWith(annotations: string[]): string[] {
  return annotations
    .map((annotation) => annotation.match(/<!--\s*conflicts_with:\s*"([^"]+)"/)?.[1])
    .filter((value): value is string => Boolean(value));
}

export function register(server: McpServer, ctx: McpContext): void {
  const { cortexPath, withWriteQueue, updateFileInIndex } = ctx;

  server.registerTool(
    "add_finding",
    {
      title: "◆ cortex · save finding",
      description:
        "Record a single insight to a project's FINDINGS.md. Call this the moment you discover " +
        "a non-obvious pattern, hit a subtle bug, find a workaround, or learn something that would " +
        "save time in a future session. Do not wait until the end of the session." +
        " Optionally classify with findingType: decision, pitfall, pattern, tradeoff, architecture, or bug.",
      inputSchema: z.object({
        project: z.string().describe("Project name (must match a directory in your cortex)."),
        finding: z.string().describe("The insight, written as a single bullet point. Be specific enough that someone could act on it without extra context."),
        citation: z.object({
          file: z.string().optional().describe("Source file path that supports this finding."),
          line: z.number().int().positive().optional().describe("1-based line number in file."),
          repo: z.string().optional().describe("Git repository root path for citation validation."),
          commit: z.string().optional().describe("Git commit SHA that supports this finding."),
          supersedes: z.string().optional().describe("First 60 chars of the old finding this one replaces. The old entry will be marked as superseded."),
          task_item: z.string().optional().describe("Task item stable ID like bid:abcd1234, positional ID like A1, or item text to link this finding to."),
        }).optional().describe("Optional source citation for traceability."),
        sessionId: z.string().optional().describe("Optional session ID from session_start. Pass this if you want session metrics to include this write."),
        findingType: z.enum(FINDING_TYPES)
          .optional()
          .describe("Classify this finding: 'decision' (architectural choice with rationale), 'pitfall' (bug or failure mode to avoid), 'pattern' (reusable approach that works well), 'tradeoff' (deliberate compromise), 'architecture' (structural design note), 'bug' (confirmed defect or failure)."),
      }),
    },
    async ({ project, finding, citation, sessionId, findingType }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      if (finding.length > 5000) return mcpResponse({ ok: false, error: "Finding text exceeds 5000 character limit." });
      return withWriteQueue(async () => {
        try {
          const taggedFinding = findingType ? `[${findingType}] ${finding}` : finding;
          // Semantic dedup pre-check (async, feature-flagged)
          if (await checkSemanticDedup(cortexPath, project, taggedFinding)) {
            return mcpResponse({ ok: true, message: `Skipped semantic duplicate finding for "${project}".` });
          }
          const semanticConflicts = await checkSemanticConflicts(cortexPath, project, taggedFinding);
          runCustomHooks(cortexPath, "pre-finding", { CORTEX_PROJECT: project });
          const result = addFindingToFile(cortexPath, project, taggedFinding, citation, {
            sessionId,
            extraAnnotations: semanticConflicts.checked ? semanticConflicts.annotations : undefined,
          });
          if (!result.ok) {
            return mcpResponse({ ok: false, error: result.error });
          }
          // Determine status from the returned message string
          const isSkipped = result.data.startsWith("Skipped duplicate");
          const isAdded = !isSkipped;

          if (isSkipped) {
            return mcpResponse({ ok: true, message: result.data, data: { project, finding: taggedFinding, status: "skipped" } });
          }

          updateFileInIndex(path.join(cortexPath, project, "FINDINGS.md"));
          if (isAdded) {
            runCustomHooks(cortexPath, "post-finding", { CORTEX_PROJECT: project });
            incrementSessionFindings(cortexPath, 1, sessionId, project);
            extractFactFromFinding(cortexPath, project, taggedFinding);
          }
          const conflictsWithList = semanticConflicts.checked
            ? extractConflictsWith(semanticConflicts.annotations)
            : (result.data.match(/<!--\s*conflicts_with:\s*"([^"]+)"/)?.[1] ? [result.data.match(/<!--\s*conflicts_with:\s*"([^"]+)"/)![1]] : []);
          const conflictsWith = conflictsWithList[0];

          // Extract entity hints synchronously from the finding text (regex only, no DB).
          // Full DB entity linking happens on the next index rebuild via updateFileInIndex →
          // extractAndLinkEntities. We surface hints here so callers can see what was detected.
          const detectedEntities = extractEntityNames(taggedFinding);

          return mcpResponse({
            ok: true,
            message: result.data,
            data: {
              project,
              finding: taggedFinding,
              status: "added",
              ...(conflictsWith ? { conflictsWith } : {}),
              ...(conflictsWithList.length > 0 ? { conflicts: conflictsWithList } : {}),
              ...(detectedEntities.length > 0 ? { detectedEntities } : {}),
            }
          });
        } catch (err: unknown) {
          if (err instanceof Error && err.message.includes("Rejected:")) {
            return mcpResponse({ ok: false, error: errorMessage(err), errorCode: "VALIDATION_ERROR" });
          }
          throw err;
        }
      });
    }
  );

  server.registerTool(
    "add_findings",
    {
      title: "◆ cortex · save findings (bulk)",
      description: "Record multiple insights to a project's FINDINGS.md in one call.",
      inputSchema: z.object({
        project: z.string().describe("Project name (must match a directory in your cortex)."),
        findings: z.array(z.string()).describe("List of insights to record."),
        sessionId: z.string().optional().describe("Optional session ID from session_start. Pass this if you want session metrics to include this write."),
      }),
    },
    async ({ project, findings, sessionId }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      if (findings.length > 100) return mcpResponse({ ok: false, error: "Bulk add limited to 100 findings per call." });
      if (findings.some((f) => f.length > 5000)) return mcpResponse({ ok: false, error: "One or more findings exceed 5000 character limit." });
      return withWriteQueue(async () => {
        runCustomHooks(cortexPath, "pre-finding", { CORTEX_PROJECT: project });

        // Run semantic quality gates (dedup + conflict) per finding before writing.
        // Use a per-item timeout so one slow LLM call doesn't stall the whole batch.
        const PER_ITEM_TIMEOUT_MS = 5_000;
        const semanticSkipped: string[] = [];
        const semanticConflicts: Array<{ finding: string; conflictsWith: string[] }> = [];
        const filteredFindings: string[] = [];
        const extraAnnotationsByFinding: string[][] = [];

        for (const f of findings) {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), PER_ITEM_TIMEOUT_MS);
          try {
            const isDup = await checkSemanticDedup(cortexPath, project, f, controller.signal);
            if (isDup) {
              clearTimeout(timeoutId);
              semanticSkipped.push(f);
              continue;
            }
          } catch (err: unknown) {
            // Semantic dedup failure is non-fatal — proceed with the finding
            if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] add_findings semanticDedup: ${errorMessage(err)}\n`);
          }

          try {
            const conflicts = await checkSemanticConflicts(cortexPath, project, f, controller.signal);
            if (conflicts.checked && conflicts.annotations.length > 0) {
              semanticConflicts.push({ finding: f, conflictsWith: extractConflictsWith(conflicts.annotations) });
              extraAnnotationsByFinding.push(conflicts.annotations);
            } else {
              extraAnnotationsByFinding.push([]);
            }
          } catch (err: unknown) {
            // Semantic conflict failure is non-fatal
            if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] add_findings semanticConflict: ${errorMessage(err)}\n`);
            extraAnnotationsByFinding.push([]);
          }
          clearTimeout(timeoutId);

          filteredFindings.push(f);
        }

        const result = addFindingsToFile(cortexPath, project, filteredFindings, {
          extraAnnotationsByFinding,
          sessionId,
        });
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        const { added, skipped, rejected } = result.data;
        // Include semantic skips in the total skipped count
        const allSkipped = [...skipped, ...semanticSkipped];
        if (added.length > 0) {
          runCustomHooks(cortexPath, "post-finding", { CORTEX_PROJECT: project });
          incrementSessionFindings(cortexPath, added.length, sessionId, project);
          updateFileInIndex(path.join(cortexPath, project, "FINDINGS.md"));
        }
        const rejectedMsg = rejected.length > 0 ? `, ${rejected.length} rejected` : "";
        const conflictMsg = semanticConflicts.length > 0 ? `, ${semanticConflicts.length} with conflicts` : "";
        // ok:true whenever the operation completed without error — use counts to distinguish outcomes.
        // Returning ok:false when all items are duplicates confuses callers into thinking a write failed.
        return mcpResponse({ ok: true, message: `Added ${added.length}/${findings.length} findings (${allSkipped.length} duplicates skipped${rejectedMsg}${conflictMsg})`, data: { project, added, skipped: allSkipped, rejected, ...(semanticConflicts.length > 0 ? { conflicts: semanticConflicts } : {}) } });
      });
    }
  );

  server.registerTool(
    "remove_finding",
    {
      title: "◆ cortex · remove finding",
      description:
        "Remove a finding from a project's FINDINGS.md by matching text. Use this when a " +
        "previously captured insight turns out to be wrong, outdated, or no longer relevant.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        finding: z.string().describe("Partial text to match against existing findings."),
      }),
    },
    async ({ project, finding }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const result = removeFindingCore(cortexPath, project, finding);
        if (result.ok) {
          const resolvedFindingsDir = safeProjectPath(cortexPath, project);
          if (resolvedFindingsDir) updateFileInIndex(path.join(resolvedFindingsDir, "FINDINGS.md"));
        }
        if (!result.ok) return mcpResponse({ ok: false, error: result.message });
        return mcpResponse({ ok: true, message: result.message, data: result.data });
      });
    }
  );

  server.registerTool(
    "remove_findings",
    {
      title: "◆ cortex · remove findings (bulk)",
      description: "Remove multiple findings from a project's FINDINGS.md in one call.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        findings: z.array(z.string()).describe("List of partial texts to match and remove."),
      }),
    },
    async ({ project, findings }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const result = removeFindingsCore(cortexPath, project, findings);
        if (result.ok) {
          const resolvedFindingsDir = safeProjectPath(cortexPath, project);
          if (resolvedFindingsDir) updateFileInIndex(path.join(resolvedFindingsDir, "FINDINGS.md"));
        }
        if (!result.ok) return mcpResponse({ ok: false, error: result.message });
        return mcpResponse({ ok: result.ok, message: result.message, data: result.data });
      });
    }
  );

  server.registerTool(
    "push_changes",
    {
      title: "◆ cortex · push",
      description:
        "Commit and push any changes in the cortex repo. Call this at the end of a session " +
        "or after adding multiple findings/tasks items. Commits all modified files in the " +
        "cortex directory and pushes if a remote is configured.",
      inputSchema: z.object({
        message: z.string().optional().describe("Commit message. Defaults to 'update cortex'."),
      }),
    },
    async ({ message }) => {
      return withWriteQueue(async () => {
        const { execFileSync } = await import("child_process");
        const runGit = (args: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}): string => execFileSync(
          "git",
          args,
          {
            cwd: cortexPath,
            encoding: "utf8",
            timeout: opts.timeout ?? EXEC_TIMEOUT_MS,
            env: opts.env,
            stdio: ["ignore", "pipe", "pipe"],
          }
        ).trim();

        try {
          const status = runGit(["status", "--porcelain"]);
          if (!status) return mcpResponse({ ok: true, message: "Nothing to save. Cortex is up to date.", data: { files: 0, pushed: false } });
          const files = status.split("\n").filter(Boolean);
          const projectNames = Array.from(
            new Set(
              files
                .map((line) => line.slice(3).trim().split("/")[0])
                .filter((name) => name && !name.startsWith(".") && name !== "profiles")
            )
          );
          const commitMsg = message || `cortex: save ${files.length} file(s) across ${projectNames.length} project(s)`;

          runCustomHooks(cortexPath, "pre-save");
          // Restrict to known cortex file types to avoid staging .env or credential files
          runGit(["add", "--", "*.md", "*.json", "*.yaml", "*.yml", "*.jsonl", "*.txt"]);
          runGit(["commit", "-m", commitMsg]);

          let hasRemote = false;
          try {
            const remotes = runGit(["remote"]);
            hasRemote = remotes.length > 0;
          } catch (err: unknown) {
            if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] push_changes remoteCheck: ${errorMessage(err)}\n`);
          }

          if (!hasRemote) {
            const changedFiles = status.split("\n").filter(Boolean).length;
            return mcpResponse({ ok: true, message: `Saved ${changedFiles} changed file(s). No remote configured, skipping push.`, data: { files: changedFiles, pushed: false } });
          }

          let pushed = false;
          let lastPushError = "";
          const delays = [2000, 4000, 8000];

          for (let attempt = 0; attempt <= 3; attempt++) {
            try {
              runGit(["push"], { timeout: 15000 });
              pushed = true;
              break;
            } catch (pushErr: unknown) {
              lastPushError = pushErr instanceof Error ? pushErr.message : String(pushErr);
              debugLog(`Push attempt ${attempt + 1} failed: ${lastPushError}`);

              if (attempt < 3) {
                try {
                  runGit(["pull", "--rebase", "--quiet"], { timeout: 15000 });
                } catch (pullErr: unknown) {
                  if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] push_changes pullRebase: ${pullErr instanceof Error ? pullErr.message : String(pullErr)}\n`);
                  const resolved = autoMergeConflicts(cortexPath);
                  if (resolved) {
                    try {
                      runGit(["rebase", "--continue"], {
                        timeout: 10000,
                        env: { ...process.env, GIT_EDITOR: "true" },
                      });
                    } catch (continueErr: unknown) {
                      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] push_changes rebaseContinue: ${continueErr instanceof Error ? continueErr.message : String(continueErr)}\n`);
                      try { runGit(["rebase", "--abort"]); } catch (abortErr: unknown) {
                        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] push_changes rebaseAbort: ${abortErr instanceof Error ? abortErr.message : String(abortErr)}\n`);
                      }
                      break;
                    }
                  } else {
                    try { runGit(["rebase", "--abort"]); } catch (abortErr: unknown) {
                      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] push_changes rebaseAbort2: ${abortErr instanceof Error ? abortErr.message : String(abortErr)}\n`);
                    }
                    break;
                  }
                }

                await new Promise(r => setTimeout(r, delays[attempt]));
              }
            }
          }

          const changedFiles = status.split("\n").filter(Boolean).length;
          runCustomHooks(cortexPath, "post-save", { CORTEX_FILES_CHANGED: String(changedFiles), CORTEX_PUSHED: String(pushed) });
          if (pushed) {
            return mcpResponse({ ok: true, message: `Saved ${changedFiles} changed file(s). Pushed to remote.`, data: { files: changedFiles, pushed: true } });
          } else {
            return mcpResponse({
              ok: true,
              message: `Changes were committed but push failed.\n\nGit error: ${lastPushError}\n\nRun 'git push' manually from your cortex directory.`,
              data: { files: changedFiles, pushed: false, pushError: lastPushError },
            });
          }
        } catch (err: unknown) {
          return mcpResponse({ ok: false, error: `Save failed: ${errorMessage(err)}`, errorCode: "INTERNAL_ERROR" });
        }
      });
    }
  );

}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse } from "./mcp-types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { isValidProjectName, safeProjectPath } from "./utils.js";
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
import { withFileLock } from "./shared-governance.js";
import { runCustomHooks } from "./hooks.js";
import { incrementSessionFindings } from "./mcp-session.js";



export function register(server: McpServer, ctx: McpContext): void {
  const { cortexPath, withWriteQueue, rebuildIndex, updateFileInIndex } = ctx;

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
        }).optional().describe("Optional source citation for traceability."),
        findingType: z.enum(FINDING_TYPES)
          .optional()
          .describe("Classify this finding: 'decision' (architectural choice with rationale), 'pitfall' (bug or failure mode to avoid), 'pattern' (reusable approach that works well), 'tradeoff' (deliberate compromise), 'architecture' (structural design note), 'bug' (confirmed defect or failure)."),
      }),
    },
    async ({ project, finding, citation, findingType }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      if (finding.length > 5000) return mcpResponse({ ok: false, error: "Finding text exceeds 5000 character limit." });
      return withWriteQueue(async () => {
        try {
          const taggedFinding = findingType ? `[${findingType}] ${finding}` : finding;
          // Semantic dedup pre-check (async, feature-flagged)
          if (await checkSemanticDedup(cortexPath, project, taggedFinding)) {
            return mcpResponse({ ok: true, message: `Skipped semantic duplicate finding for "${project}".` });
          }
          runCustomHooks(cortexPath, "pre-finding", { CORTEX_PROJECT: project });
          const result = addFindingToFile(cortexPath, project, taggedFinding, citation);
          if (!result.ok) {
            return mcpResponse({ ok: false, error: result.error });
          }
          // Determine status from the returned message string
          const isSkipped = result.data.startsWith("Skipped duplicate");
          const isAdded = !isSkipped;

          if (isSkipped) {
            return mcpResponse({ ok: true, message: result.data, data: { project, finding: taggedFinding, status: "skipped" } });
          }

          // Semantic conflict post-check (async, feature-flagged) — only for newly added findings
          const conflicts = await checkSemanticConflicts(cortexPath, project, taggedFinding);
          if (conflicts.checked && conflicts.annotations.length > 0) {
            // Append conflict annotations to the exact inserted bullet in the file.
            // Wrap in withFileLock so the read-modify-write is atomic with respect to
            // concurrent add_finding calls that also modify FINDINGS.md.
            const resolvedDir = safeProjectPath(cortexPath, project);
            if (resolvedDir) {
              const fp = path.join(resolvedDir, "FINDINGS.md");
              if (fs.existsSync(fp)) {
                withFileLock(fp, () => {
                  let content = fs.readFileSync(fp, "utf8");
                  // Build the full bullet prefix as it was written (with "- " prefix)
                  const bulletPrefix = taggedFinding.startsWith("- ") ? taggedFinding.slice(0, 60) : `- ${taggedFinding.slice(0, 60)}`;
                  // Find the last occurrence of this exact bullet (the one just inserted)
                  const idx = content.lastIndexOf(bulletPrefix);
                  if (idx >= 0) {
                    const lineEnd = content.indexOf("\n", idx);
                    const insertAt = lineEnd >= 0 ? lineEnd : content.length;
                    content = content.slice(0, insertAt) + " " + conflicts.annotations.join(" ") + " <!-- conflicts_checked: true -->" + content.slice(insertAt);
                    const tmpFp = fp + `.tmp-${crypto.randomUUID()}`;
                    fs.writeFileSync(tmpFp, content);
                    fs.renameSync(tmpFp, fp);
                  }
                });
              }
            }
          }
          const resolvedFindingsDir = safeProjectPath(cortexPath, project);
          if (resolvedFindingsDir) updateFileInIndex(path.join(resolvedFindingsDir, "FINDINGS.md"));
          if (isAdded) {
            runCustomHooks(cortexPath, "post-finding", { CORTEX_PROJECT: project });
            incrementSessionFindings(cortexPath);
          }
          return mcpResponse({ ok: true, message: result.data, data: { project, finding: taggedFinding, status: "added" } });
        } catch (err: unknown) {
          if (err instanceof Error && err.message.includes("Rejected:")) {
            return mcpResponse({ ok: false, error: err instanceof Error ? err.message : String(err), errorCode: "VALIDATION_ERROR" });
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
      }),
    },
    async ({ project, findings }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      if (findings.length > 100) return mcpResponse({ ok: false, error: "Bulk add limited to 100 findings per call." });
      if (findings.some((f) => f.length > 5000)) return mcpResponse({ ok: false, error: "One or more findings exceed 5000 character limit." });
      return withWriteQueue(async () => {
        runCustomHooks(cortexPath, "pre-finding", { CORTEX_PROJECT: project });
        const result = addFindingsToFile(cortexPath, project, findings);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        const { added, skipped, rejected } = result.data;
        if (added.length > 0) {
          runCustomHooks(cortexPath, "post-finding", { CORTEX_PROJECT: project });
          incrementSessionFindings(cortexPath, added.length);
          const resolvedFindingsDir = safeProjectPath(cortexPath, project);
          if (resolvedFindingsDir) updateFileInIndex(path.join(resolvedFindingsDir, "FINDINGS.md"));
        }
        const rejectedMsg = rejected.length > 0 ? `, ${rejected.length} rejected` : "";
        return mcpResponse({ ok: added.length > 0, message: `Added ${added.length}/${findings.length} findings (${skipped.length} duplicates skipped${rejectedMsg})`, data: { project, added, skipped, rejected } });
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
        "or after adding multiple findings/backlog items. Commits all modified files in the " +
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
          } catch { /* no remote */ }

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
                } catch {
                  const resolved = autoMergeConflicts(cortexPath);
                  if (resolved) {
                    try {
                      runGit(["rebase", "--continue"], {
                        timeout: 10000,
                        env: { ...process.env, GIT_EDITOR: "true" },
                      });
                    } catch {
                      try { runGit(["rebase", "--abort"]); } catch { /* ignore */ }
                      break;
                    }
                  } else {
                    try { runGit(["rebase", "--abort"]); } catch { /* ignore */ }
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
          return mcpResponse({ ok: false, error: `Save failed: ${err instanceof Error ? err.message : String(err)}`, errorCode: "INTERNAL_ERROR" });
        }
      });
    }
  );

}

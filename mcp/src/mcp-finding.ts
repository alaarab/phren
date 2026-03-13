import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse } from "./mcp-types.js";
import { z } from "zod";
import * as fs from "fs";
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
  normalizeMemoryScope,
} from "./shared.js";
import {
  addFindingToFile,
  addFindingsToFile,
  checkSemanticDedup,
  checkSemanticConflicts,
  autoMergeConflicts,
} from "./shared-content.js";
import { jaccardTokenize, jaccardSimilarity, stripMetadata } from "./content-dedup.js";
import { runCustomHooks } from "./hooks.js";
import { incrementSessionFindings } from "./mcp-session.js";
import { extractEntityNames } from "./shared-entity-graph.js";
import { extractFactFromFinding } from "./mcp-extract-facts.js";
import { appendChildFinding, readFindings } from "./data-access.js";
import { getActiveTaskForSession } from "./task-lifecycle.js";
import { FINDING_PROVENANCE_SOURCES } from "./content-citation.js";
import {
  isInactiveFindingLine,
  supersedeFinding,
  retractFinding as retractFindingLifecycle,
  resolveFindingContradiction,
} from "./finding-lifecycle.js";



const JACCARD_MAYBE_LOW = 0.30;
const JACCARD_MAYBE_HIGH = 0.55; // above this isDuplicateFinding already catches it
const RESERVED_PROJECT_DIRS = new Set(["global", ".runtime", ".sessions", ".governance"]);

interface PotentialDuplicate {
  existing: string;
  similarity: number;
}

function findJaccardCandidates(cortexPath: string, project: string, finding: string): PotentialDuplicate[] {
  try {
    const findingsPath = path.join(cortexPath, project, "FINDINGS.md");
    if (!fs.existsSync(findingsPath)) return [];
    const content = fs.readFileSync(findingsPath, "utf8");
    const newClean = stripMetadata(finding).trim();
    const newTokens = jaccardTokenize(newClean);
    if (newTokens.size < 3) return [];
    const candidates: PotentialDuplicate[] = [];
    for (const line of content.split("\n")) {
      if (!line.startsWith("- ") || isInactiveFindingLine(line)) continue;
      const existingClean = stripMetadata(line).replace(/^-\s+/, "").trim();
      const existingTokens = jaccardTokenize(existingClean);
      if (existingTokens.size < 3) continue;
      const sim = jaccardSimilarity(newTokens, existingTokens);
      if (sim >= JACCARD_MAYBE_LOW && sim < JACCARD_MAYBE_HIGH) {
        candidates.push({ existing: existingClean, similarity: Math.round(sim * 100) / 100 });
      }
    }
    return candidates;
  } catch {
    return [];
  }
}

function extractConflictsWith(annotations: string[]): string[] {
  return annotations
    .map((annotation) => annotation.match(/<!--\s*conflicts_with:\s*"([^"]+)"/)?.[1])
    .filter((value): value is string => Boolean(value));
}

function matchesFindingTextSelector(
  finding: { id: string; stableId?: string; text: string },
  selector: string
): boolean {
  const query = selector.trim().toLowerCase();
  if (!query) return true;

  const id = finding.id.toLowerCase();
  const stableId = finding.stableId?.toLowerCase();
  const text = finding.text.toLowerCase();

  if (query.startsWith("fid:")) {
    const normalizedFid = query.slice(4).trim();
    if (!normalizedFid) return false;
    return stableId === normalizedFid || id === query || id === normalizedFid;
  }

  return id === query || stableId === query || text === query || text.includes(query);
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
        source: z.enum(FINDING_PROVENANCE_SOURCES)
          .optional()
          .describe("Optional finding provenance source: human, agent, hook, extract, consolidation, or unknown."),
        findingType: z.enum(FINDING_TYPES)
          .optional()
          .describe("Classify this finding: 'decision' (architectural choice with rationale), 'pitfall' (bug or failure mode to avoid), 'pattern' (reusable approach that works well), 'tradeoff' (deliberate compromise), 'architecture' (structural design note), 'bug' (confirmed defect or failure)."),
        scope: z.string().optional().describe("Optional memory scope label. Defaults to 'shared'. Example: 'researcher' or 'builder'."),
      }),
    },
    async ({ project, finding, citation, sessionId, source, findingType, scope }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      if (finding.length > 5000) return mcpResponse({ ok: false, error: "Finding text exceeds 5000 character limit." });
      const normalizedScope = normalizeMemoryScope(scope ?? "shared");
      if (!normalizedScope) return mcpResponse({ ok: false, error: `Invalid scope: "${scope}". Use lowercase letters/numbers with '-' or '_' (max 64 chars), e.g. "researcher".` });
      return withWriteQueue(async () => {
        try {
          const taggedFinding = findingType ? `[${findingType}] ${finding}` : finding;
          // Jaccard "maybe zone" scan — free, no LLM call. Return candidates so the agent decides.
          const potentialDuplicates = findJaccardCandidates(cortexPath, project, taggedFinding);
          const semanticConflicts = await checkSemanticConflicts(cortexPath, project, taggedFinding);
          runCustomHooks(cortexPath, "pre-finding", { CORTEX_PROJECT: project });
          const result = addFindingToFile(cortexPath, project, taggedFinding, citation, {
            sessionId,
            source,
            scope: normalizedScope,
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
            // Bidirectional link: if there's an active task in this session, append this finding to it.
            if (sessionId) {
              const activeTask = getActiveTaskForSession(cortexPath, sessionId, project);
              if (activeTask) {
                const taskMatch = activeTask.stableId ? `bid:${activeTask.stableId}` : activeTask.line;
                // Extract fid from the last written line in FINDINGS.md
                try {
                  const findingsPath = path.join(cortexPath, project, "FINDINGS.md");
                  const findingsContent = fs.readFileSync(findingsPath, "utf8");
                  const lines = findingsContent.split("\n");
                  const taggedText = taggedFinding.replace(/^-\s+/, "").trim().slice(0, 60).toLowerCase();
                  for (let li = lines.length - 1; li >= 0; li--) {
                    const l = lines[li];
                    if (!l.startsWith("- ")) continue;
                    const lineText = l.replace(/<!--.*?-->/g, "").replace(/^-\s+/, "").trim().slice(0, 60).toLowerCase();
                    if (lineText === taggedText || l.toLowerCase().includes(taggedText.slice(0, 30))) {
                      const fidMatch = l.match(/<!--\s*fid:([a-z0-9]{8})\s*-->/);
                      if (fidMatch) {
                        appendChildFinding(cortexPath, project, taskMatch, `fid:${fidMatch[1]}`);
                      }
                      break;
                    }
                  }
                } catch {
                  // Non-fatal: task-finding linkage is best-effort
                }
              }
            }
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
              ...(potentialDuplicates.length > 0 ? { potentialDuplicates } : {}),
              scope: normalizedScope,
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

        // Jaccard "maybe zone" scan per finding — free, no LLM. Agent sees candidates and decides.
        const allPotentialDuplicates: Array<{ finding: string; candidates: PotentialDuplicate[] }> = [];
        const extraAnnotationsByFinding: string[][] = [];

        for (const f of findings) {
          const candidates = findJaccardCandidates(cortexPath, project, f);
          if (candidates.length > 0) allPotentialDuplicates.push({ finding: f, candidates });
          try {
            const conflicts = await checkSemanticConflicts(cortexPath, project, f);
            extraAnnotationsByFinding.push(conflicts.checked && conflicts.annotations.length > 0 ? conflicts.annotations : []);
          } catch (err: unknown) {
            if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] add_findings semanticConflict: ${errorMessage(err)}\n`);
            extraAnnotationsByFinding.push([]);
          }
        }

        const result = addFindingsToFile(cortexPath, project, findings, {
          extraAnnotationsByFinding,
          sessionId,
        });
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        const { added, skipped, rejected } = result.data;
        if (added.length > 0) {
          runCustomHooks(cortexPath, "post-finding", { CORTEX_PROJECT: project });
          incrementSessionFindings(cortexPath, added.length, sessionId, project);
          updateFileInIndex(path.join(cortexPath, project, "FINDINGS.md"));
        }
        const rejectedMsg = rejected.length > 0 ? `, ${rejected.length} rejected` : "";
        // ok:true whenever the operation completed without error — use counts to distinguish outcomes.
        return mcpResponse({
          ok: true,
          message: `Added ${added.length}/${findings.length} findings (${skipped.length} duplicates skipped${rejectedMsg})`,
          data: {
            project,
            added,
            skipped,
            rejected,
            ...(allPotentialDuplicates.length > 0 ? { potentialDuplicates: allPotentialDuplicates } : {}),
          },
        });
      });
    }
  );

  server.registerTool(
    "supersede_finding",
    {
      title: "◆ cortex · supersede finding",
      description: "Mark an existing finding as superseded and link it to the newer finding text.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        finding_text: z.string().describe("Finding to supersede (supports fid, exact text, or partial match)."),
        superseded_by: z.string().describe("Text of the new finding that supersedes this one."),
      }),
    },
    async ({ project, finding_text, superseded_by }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const result = supersedeFinding(cortexPath, project, finding_text, superseded_by);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        const resolvedFindingsDir = safeProjectPath(cortexPath, project);
        if (resolvedFindingsDir) updateFileInIndex(path.join(resolvedFindingsDir, "FINDINGS.md"));
        return mcpResponse({
          ok: true,
          message: `Marked finding as superseded in ${project}.`,
          data: {
            project,
            finding: result.data.finding,
            status: result.data.status,
            superseded_by: result.data.superseded_by,
          },
        });
      });
    }
  );

  server.registerTool(
    "retract_finding",
    {
      title: "◆ cortex · retract finding",
      description: "Mark an existing finding as retracted and store the reason in lifecycle metadata.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        finding_text: z.string().describe("Finding to retract (supports fid, exact text, or partial match)."),
        reason: z.string().describe("Reason for retraction."),
      }),
    },
    async ({ project, finding_text, reason }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const result = retractFindingLifecycle(cortexPath, project, finding_text, reason);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        const resolvedFindingsDir = safeProjectPath(cortexPath, project);
        if (resolvedFindingsDir) updateFileInIndex(path.join(resolvedFindingsDir, "FINDINGS.md"));
        return mcpResponse({
          ok: true,
          message: `Retracted finding in ${project}.`,
          data: {
            project,
            finding: result.data.finding,
            status: result.data.status,
            reason: result.data.reason,
          },
        });
      });
    }
  );

  server.registerTool(
    "resolve_contradiction",
    {
      title: "◆ cortex · resolve contradiction",
      description: "Resolve a contradiction between two findings and update lifecycle status based on the chosen resolution.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        finding_text: z.string().optional().describe("First finding (supports fid, exact text, or partial match)."),
        finding_text_other: z.string().optional().describe("Second finding (supports fid, exact text, or partial match)."),
        finding_a: z.string().optional().describe("Deprecated alias for finding_text."),
        finding_b: z.string().optional().describe("Deprecated alias for finding_text_other."),
        resolution: z.enum(["keep_a", "keep_b", "keep_both", "retract_both"]).describe("Resolution strategy."),
      }).superRefine((value, zodCtx) => {
        if (!(value.finding_text ?? value.finding_a)) {
          zodCtx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["finding_text"],
            message: "finding_text is required.",
          });
        }
        if (!(value.finding_text_other ?? value.finding_b)) {
          zodCtx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["finding_text_other"],
            message: "finding_text_other is required.",
          });
        }
      }),
    },
    async ({ project, finding_text, finding_text_other, finding_a, finding_b, resolution }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      const findingText = (finding_text ?? finding_a)?.trim();
      const findingTextOther = (finding_text_other ?? finding_b)?.trim();
      if (!findingText || !findingTextOther) {
        return mcpResponse({
          ok: false,
          error: "Both finding_text and finding_text_other are required.",
        });
      }
      return withWriteQueue(async () => {
        const result = resolveFindingContradiction(cortexPath, project, findingText, findingTextOther, resolution);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        const resolvedFindingsDir = safeProjectPath(cortexPath, project);
        if (resolvedFindingsDir) updateFileInIndex(path.join(resolvedFindingsDir, "FINDINGS.md"));
        return mcpResponse({
          ok: true,
          message: `Resolved contradiction in ${project} with "${resolution}".`,
          data: {
            project,
            resolution: result.data.resolution,
            finding_text: result.data.finding_a,
            finding_text_other: result.data.finding_b,
            finding_a: result.data.finding_a,
            finding_b: result.data.finding_b,
          },
        });
      });
    }
  );

  server.registerTool(
    "get_contradictions",
    {
      title: "◆ cortex · contradictions",
      description: "List unresolved contradictions (findings currently marked with status contradicted).",
      inputSchema: z.object({
        project: z.string().optional().describe("Optional project filter. When omitted, scans all projects."),
        finding_text: z.string().optional().describe("Optional finding selector (supports fid, exact text, or partial match)."),
      }),
    },
    async ({ project, finding_text }) => {
      if (project && !isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      const projects = project
        ? [project]
        : fs.readdirSync(cortexPath, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !RESERVED_PROJECT_DIRS.has(entry.name) && isValidProjectName(entry.name))
          .map((entry) => entry.name);

      const contradictions: Array<{
        project: string;
        id: string;
        stableId?: string;
        text: string;
        date: string;
        status_updated?: string;
        status_reason?: string;
        status_ref?: string;
      }> = [];

      for (const p of projects) {
        const result = readFindings(cortexPath, p);
        if (!result.ok) continue;
        for (const finding of result.data) {
          if (finding.status !== "contradicted") continue;
          if (finding_text && !matchesFindingTextSelector(finding, finding_text)) continue;
          contradictions.push({
            project: p,
            id: finding.id,
            stableId: finding.stableId,
            text: finding.text,
            date: finding.date,
            status_updated: finding.status_updated,
            status_reason: finding.status_reason,
            status_ref: finding.status_ref,
          });
        }
      }

      return mcpResponse({
        ok: true,
        message: contradictions.length
          ? `Found ${contradictions.length} unresolved contradiction${contradictions.length === 1 ? "" : "s"}.`
          : "No unresolved contradictions found.",
        data: {
          project: project ?? null,
          finding_text: finding_text ?? null,
          contradictions,
        },
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

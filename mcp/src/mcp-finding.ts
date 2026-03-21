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
  RESERVED_PROJECT_DIR_NAMES,
} from "./shared.js";
import {
  addFindingToFile,
  addFindingsToFile,
  checkSemanticConflicts,
  autoMergeConflicts,
} from "./shared-content.js";
import { logWarn } from "./logger.js";
import { jaccardTokenize, jaccardSimilarity, stripMetadata } from "./content-dedup.js";
import type { PhrenResult } from "./phren-core.js";
import { runCustomHooks } from "./hooks.js";
import { incrementSessionFindings } from "./mcp-session.js";
import { extractFragmentNames } from "./shared-fragment-graph.js";
import { extractFactFromFinding } from "./mcp-extract-facts.js";
import { appendChildFinding, editFinding as editFindingCore, readFindings } from "./data-access.js";
import { getActiveTaskForSession } from "./task-lifecycle.js";
import { FINDING_PROVENANCE_SOURCES } from "./content-citation.js";
import {
  isInactiveFindingLine,
  supersedeFinding,
  retractFinding as retractFindingLifecycle,
  resolveFindingContradiction,
} from "./finding-lifecycle.js";
import { permissionDeniedError } from "./governance-rbac.js";



const JACCARD_MAYBE_LOW = 0.30;
const JACCARD_MAYBE_HIGH = 0.55; // above this isDuplicateFinding already catches it

interface PotentialDuplicate {
  existing: string;
  similarity: number;
}

function findJaccardCandidates(phrenPath: string, project: string, finding: string): PotentialDuplicate[] {
  try {
    const findingsPath = path.join(phrenPath, project, "FINDINGS.md");
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

/** Shared boilerplate for lifecycle mutation tools: validate project → call core fn → update index → map response. */
function withLifecycleMutation<T>(
  phrenPath: string,
  project: string,
  writeQueue: McpContext["withWriteQueue"],
  updateIndex: McpContext["updateFileInIndex"],
  handler: () => PhrenResult<T>,
  mapResponse: (data: T) => { message: string; data: Record<string, unknown> },
) {
  if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
  return writeQueue(async () => {
    const result = handler();
    if (!result.ok) return mcpResponse({ ok: false, error: result.error });
    const resolvedFindingsDir = safeProjectPath(phrenPath, project);
    if (resolvedFindingsDir) updateIndex(path.join(resolvedFindingsDir, "FINDINGS.md"));
    const mapped = mapResponse(result.data);
    return mcpResponse({ ok: true, message: mapped.message, data: mapped.data });
  });
}

export function register(server: McpServer, ctx: McpContext): void {
  const { phrenPath, withWriteQueue, updateFileInIndex } = ctx;

  server.registerTool(
    "add_finding",
    {
      title: "◆ phren · save finding",
      description:
        "Tell phren a single insight for a project's FINDINGS.md. Call this the moment you discover " +
        "a non-obvious pattern, hit a subtle bug, find a workaround, or learn something that would " +
        "save time in a future session. Do not wait until the end of the session." +
        " Optionally classify with findingType: decision, pitfall, pattern, tradeoff, architecture, or bug.",
      inputSchema: z.object({
        project: z.string().describe("Project name (must match a directory in your phren store)."),
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
      const addFindingDenied = permissionDeniedError(phrenPath, "add_finding", project);
      if (addFindingDenied) return mcpResponse({ ok: false, error: addFindingDenied });
      if (finding.length > 5000) return mcpResponse({ ok: false, error: "Finding text exceeds 5000 character limit." });
      const normalizedScope = normalizeMemoryScope(scope ?? "shared");
      if (!normalizedScope) return mcpResponse({ ok: false, error: `Invalid scope: "${scope}". Use lowercase letters/numbers with '-' or '_' (max 64 chars), e.g. "researcher".` });
      return withWriteQueue(async () => {
        try {
          const taggedFinding = findingType ? `[${findingType}] ${finding}` : finding;
          // Jaccard "maybe zone" scan — free, no LLM call. Return candidates so the agent decides.
          const potentialDuplicates = findJaccardCandidates(phrenPath, project, taggedFinding);
          const semanticConflicts = await checkSemanticConflicts(phrenPath, project, taggedFinding);
          runCustomHooks(phrenPath, "pre-finding", { PHREN_PROJECT: project });
          const result = addFindingToFile(phrenPath, project, taggedFinding, citation, {
            sessionId,
            source,
            scope: normalizedScope,
            extraAnnotations: semanticConflicts.checked ? semanticConflicts.annotations : undefined,
          });
          if (!result.ok) {
            return mcpResponse({ ok: false, error: result.error });
          }
          if (result.data.status === "skipped") {
            return mcpResponse({ ok: true, message: result.data.message, data: { project, finding: taggedFinding, status: "skipped" } });
          }

          updateFileInIndex(path.join(phrenPath, project, "FINDINGS.md"));
          if (result.data.status === "added" || result.data.status === "created") {
            runCustomHooks(phrenPath, "post-finding", { PHREN_PROJECT: project });
            incrementSessionFindings(phrenPath, 1, sessionId, project);
            extractFactFromFinding(phrenPath, project, taggedFinding);
            // Bidirectional link: if there's an active task in this session, append this finding to it.
            if (sessionId) {
              const activeTask = getActiveTaskForSession(phrenPath, sessionId, project);
              if (activeTask) {
                const taskMatch = activeTask.stableId ? `bid:${activeTask.stableId}` : activeTask.line;
                // Extract fid from the last written line in FINDINGS.md
                try {
                  const findingsPath = path.join(phrenPath, project, "FINDINGS.md");
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
                        appendChildFinding(phrenPath, project, taskMatch, `fid:${fidMatch[1]}`);
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
            : (result.data.message.match(/<!--\s*conflicts_with:\s*"([^"]+)"/)?.[1] ? [result.data.message.match(/<!--\s*conflicts_with:\s*"([^"]+)"/)![1]] : []);
          const conflictsWith = conflictsWithList[0];

          // Extract fragment hints synchronously from the finding text (regex only, no DB).
          // Full DB fragment linking happens on the next index rebuild via updateFileInIndex →
          // extractAndLinkEntities. We surface hints here so callers can see what was detected.
          const detectedFragments = extractFragmentNames(taggedFinding);

          return mcpResponse({
            ok: true,
            message: result.data.message,
            data: {
              project,
              finding: taggedFinding,
              status: result.data.status,
              ...(conflictsWith ? { conflictsWith } : {}),
              ...(conflictsWithList.length > 0 ? { conflicts: conflictsWithList } : {}),
              ...(detectedFragments.length > 0 ? { detectedFragments } : {}),
              ...(potentialDuplicates.length > 0 ? { potentialDuplicates } : {}),
              scope: normalizedScope,
            }
          });
        } catch (err: unknown) {
          if (err instanceof Error && err.message.includes("Rejected:")) {
            return mcpResponse({ ok: false, error: errorMessage(err), errorCode: "VALIDATION_ERROR" });
          }
          return mcpResponse({ ok: false, error: `Unexpected error saving finding: ${errorMessage(err)}` });
        }
      });
    }
  );

  server.registerTool(
    "add_findings",
    {
      title: "◆ phren · save findings (bulk)",
      description: "Tell phren multiple insights for a project's FINDINGS.md in one call.",
      inputSchema: z.object({
        project: z.string().describe("Project name (must match a directory in your phren store)."),
        findings: z.array(z.string()).describe("List of insights to record."),
        sessionId: z.string().optional().describe("Optional session ID from session_start. Pass this if you want session metrics to include this write."),
      }),
    },
    async ({ project, findings, sessionId }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      const addFindingsDenied = permissionDeniedError(phrenPath, "add_finding", project);
      if (addFindingsDenied) return mcpResponse({ ok: false, error: addFindingsDenied });
      if (findings.length > 100) return mcpResponse({ ok: false, error: "Bulk add limited to 100 findings per call." });
      if (findings.some((f) => f.length > 5000)) return mcpResponse({ ok: false, error: "One or more findings exceed 5000 character limit." });
      return withWriteQueue(async () => {
        runCustomHooks(phrenPath, "pre-finding", { PHREN_PROJECT: project });

        // Jaccard "maybe zone" scan per finding — free, no LLM. Agent sees candidates and decides.
        const allPotentialDuplicates: Array<{ finding: string; candidates: PotentialDuplicate[] }> = [];
        const extraAnnotationsByFinding: string[][] = [];

        for (const f of findings) {
          const candidates = findJaccardCandidates(phrenPath, project, f);
          if (candidates.length > 0) allPotentialDuplicates.push({ finding: f, candidates });
          try {
            const conflicts = await checkSemanticConflicts(phrenPath, project, f);
            extraAnnotationsByFinding.push(conflicts.checked && conflicts.annotations.length > 0 ? conflicts.annotations : []);
          } catch (err: unknown) {
            if ((process.env.PHREN_DEBUG)) process.stderr.write(`[phren] add_findings semanticConflict: ${errorMessage(err)}\n`);
            extraAnnotationsByFinding.push([]);
          }
        }

        const result = addFindingsToFile(phrenPath, project, findings, {
          extraAnnotationsByFinding,
          sessionId,
        });
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        const { added, skipped, rejected } = result.data;
        if (added.length > 0) {
          runCustomHooks(phrenPath, "post-finding", { PHREN_PROJECT: project });
          incrementSessionFindings(phrenPath, added.length, sessionId, project);
          updateFileInIndex(path.join(phrenPath, project, "FINDINGS.md"));
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
      title: "◆ phren · supersede finding",
      description: "Mark an existing finding as superseded and link it to the newer finding text.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        finding_text: z.string().describe("Finding to supersede (supports fid, exact text, or partial match)."),
        superseded_by: z.string().describe("Text of the new finding that supersedes this one."),
      }),
    },
    async ({ project, finding_text, superseded_by }) => {
      return withLifecycleMutation(
        phrenPath, project, withWriteQueue, updateFileInIndex,
        () => supersedeFinding(phrenPath, project, finding_text, superseded_by),
        (data) => ({
          message: `Marked finding as superseded in ${project}.`,
          data: { project, finding: data.finding, status: data.status, superseded_by: data.superseded_by },
        }),
      );
    }
  );

  server.registerTool(
    "retract_finding",
    {
      title: "◆ phren · retract finding",
      description: "Mark an existing finding as retracted and store the reason in lifecycle metadata.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        finding_text: z.string().describe("Finding to retract (supports fid, exact text, or partial match)."),
        reason: z.string().describe("Reason for retraction."),
      }),
    },
    async ({ project, finding_text, reason }) => {
      return withLifecycleMutation(
        phrenPath, project, withWriteQueue, updateFileInIndex,
        () => retractFindingLifecycle(phrenPath, project, finding_text, reason),
        (data) => ({
          message: `Retracted finding in ${project}.`,
          data: { project, finding: data.finding, status: data.status, reason: data.reason },
        }),
      );
    }
  );

  server.registerTool(
    "resolve_contradiction",
    {
      title: "◆ phren · resolve contradiction",
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
      const findingText = (finding_text ?? finding_a)?.trim();
      const findingTextOther = (finding_text_other ?? finding_b)?.trim();
      if (!findingText || !findingTextOther) {
        return mcpResponse({
          ok: false,
          error: "Both finding_text and finding_text_other are required.",
        });
      }
      return withLifecycleMutation(
        phrenPath, project, withWriteQueue, updateFileInIndex,
        () => resolveFindingContradiction(phrenPath, project, findingText, findingTextOther, resolution),
        (data) => ({
          message: `Resolved contradiction in ${project} with "${resolution}".`,
          data: {
            project,
            resolution: data.resolution,
            finding_text: data.finding_a,
            finding_text_other: data.finding_b,
            finding_a: data.finding_a,
            finding_b: data.finding_b,
          },
        }),
      );
    }
  );

  server.registerTool(
    "get_contradictions",
    {
      title: "◆ phren · contradictions",
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
        : fs.readdirSync(phrenPath, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !RESERVED_PROJECT_DIR_NAMES.has(entry.name) && isValidProjectName(entry.name))
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
        const result = readFindings(phrenPath, p);
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
    "edit_finding",
    {
      title: "◆ phren · edit finding",
      description: "Edit a finding in place while preserving its metadata and history.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        old_text: z.string().describe("Existing finding text to match."),
        new_text: z.string().describe("Replacement finding text."),
      }),
    },
    async ({ project, old_text, new_text }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      const editDenied = permissionDeniedError(phrenPath, "edit_finding", project);
      if (editDenied) return mcpResponse({ ok: false, error: editDenied });
      return withWriteQueue(async () => {
        const result = editFindingCore(phrenPath, project, old_text, new_text);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        const resolvedFindingsDir = safeProjectPath(phrenPath, project);
        if (resolvedFindingsDir) updateFileInIndex(path.join(resolvedFindingsDir, "FINDINGS.md"));
        return mcpResponse({
          ok: true,
          message: result.data,
          data: { project, old_text, new_text },
        });
      });
    }
  );

  server.registerTool(
    "remove_finding",
    {
      title: "◆ phren · remove finding",
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
      const removeDenied = permissionDeniedError(phrenPath, "remove_finding", project);
      if (removeDenied) return mcpResponse({ ok: false, error: removeDenied });
      return withWriteQueue(async () => {
        const result = removeFindingCore(phrenPath, project, finding);
        if (result.ok) {
          const resolvedFindingsDir = safeProjectPath(phrenPath, project);
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
      title: "◆ phren · remove findings (bulk)",
      description: "Remove multiple findings from a project's FINDINGS.md in one call.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        findings: z.array(z.string()).describe("List of partial texts to match and remove."),
      }),
    },
    async ({ project, findings }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      const removeFindingsDenied = permissionDeniedError(phrenPath, "remove_finding", project);
      if (removeFindingsDenied) return mcpResponse({ ok: false, error: removeFindingsDenied });
      return withWriteQueue(async () => {
        const result = removeFindingsCore(phrenPath, project, findings);
        if (result.ok) {
          const resolvedFindingsDir = safeProjectPath(phrenPath, project);
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
      title: "◆ phren · push",
      description:
        "Commit and push any changes in the phren store. Call this at the end of a session " +
        "or after adding multiple findings/tasks items. Commits all modified files in the " +
        "phren directory and pushes if a remote is configured.",
      inputSchema: z.object({
        message: z.string().optional().describe("Commit message. Defaults to 'update phren'."),
      }),
    },
    async ({ message }) => {
      return withWriteQueue(async () => {
        const { execFileSync } = await import("child_process");
        const runGit = (args: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}): string => execFileSync(
          "git",
          args,
          {
            cwd: phrenPath,
            encoding: "utf8",
            timeout: opts.timeout ?? EXEC_TIMEOUT_MS,
            env: opts.env,
            stdio: ["ignore", "pipe", "pipe"],
          }
        ).trim();

        try {
          const status = runGit(["status", "--porcelain"]);
          if (!status) return mcpResponse({ ok: true, message: "Nothing to save. Phren is up to date.", data: { files: 0, pushed: false } });
          const files = status.split("\n").filter(Boolean);
          const projectNames = Array.from(
            new Set(
              files
                .map((line) => line.slice(3).trim().split("/")[0])
                .filter((name) => name && !name.startsWith(".") && name !== "profiles")
            )
          );
          const commitMsg = message || `phren: save ${files.length} file(s) across ${projectNames.length} project(s)`;

          runCustomHooks(phrenPath, "pre-save");
          // Stage all files including untracked (new project dirs, first FINDINGS.md, etc.)
          runGit(["add", "-A"]);
          runGit(["commit", "-m", commitMsg]);

          let hasRemote = false;
          try {
            const remotes = runGit(["remote"]);
            hasRemote = remotes.length > 0;
          } catch (err: unknown) {
            logWarn("push_changes", `remoteCheck: ${errorMessage(err)}`);
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
                  logWarn("push_changes", `pullRebase: ${pullErr instanceof Error ? pullErr.message : String(pullErr)}`);
                  const resolved = autoMergeConflicts(phrenPath);
                  if (resolved) {
                    try {
                      runGit(["rebase", "--continue"], {
                        timeout: 10000,
                        env: { ...process.env, GIT_EDITOR: "true" },
                      });
                    } catch (continueErr: unknown) {
                      logWarn("push_changes", `rebaseContinue: ${continueErr instanceof Error ? continueErr.message : String(continueErr)}`);
                      try { runGit(["rebase", "--abort"]); } catch (abortErr: unknown) {
                        logWarn("push_changes", `rebaseAbort: ${abortErr instanceof Error ? abortErr.message : String(abortErr)}`);
                      }
                      break;
                    }
                  } else {
                    try { runGit(["rebase", "--abort"]); } catch (abortErr: unknown) {
                      logWarn("push_changes", `rebaseAbort2: ${abortErr instanceof Error ? abortErr.message : String(abortErr)}`);
                    }
                    break;
                  }
                }

                await new Promise(r => setTimeout(r, delays[attempt]));
              }
            }
          }

          const changedFiles = status.split("\n").filter(Boolean).length;
          runCustomHooks(phrenPath, "post-save", { PHREN_FILES_CHANGED: String(changedFiles), PHREN_PUSHED: String(pushed) });
          if (pushed) {
            return mcpResponse({ ok: true, message: `Saved ${changedFiles} changed file(s). Pushed to remote.`, data: { files: changedFiles, pushed: true } });
          } else {
            return mcpResponse({
              ok: true,
              message: `Changes were committed but push failed.\n\nGit error: ${lastPushError}\n\nRun 'git push' manually from your phren directory.`,
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

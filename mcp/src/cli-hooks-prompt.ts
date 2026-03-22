/**
 * handleHookContext (SessionStart context injection) and handleHookTool (PostToolUse)
 * with tool finding extraction helpers.
 * Extracted from cli-hooks-session.ts for modularity.
 */
import {
  buildHookContext,
  debugLog,
  runtimeFile,
  sessionMarker,
  getPhrenPath,
  appendAuditLog,
  appendReviewQueue,
  detectProject,
  isProjectHookEnabled,
  getProactivityLevelForFindings,
  errorMessage,
} from "./cli-hooks-context.js";
import * as fs from "fs";
import * as path from "path";
import {
  buildIndex,
  queryRows,
} from "./shared-index.js";
import { filterTaskByPriority } from "./shared-retrieval.js";
import { readStdinJson, getSessionCap } from "./cli-hooks-stop.js";
import { logDebug } from "./logger.js";

export async function handleHookContext() {
  const ctx = buildHookContext();
  if (!ctx.hooksEnabled) {
    process.exit(0);
  }

  let cwd = ctx.cwd;
  const ctxStdin = readStdinJson<{ cwd?: string }>();
  if (ctxStdin?.cwd) cwd = ctxStdin.cwd;

  const project = cwd !== ctx.cwd ? detectProject(ctx.phrenPath, cwd, ctx.profile) : ctx.activeProject;
  if (!isProjectHookEnabled(ctx.phrenPath, project, "UserPromptSubmit")) {
    process.exit(0);
  }

  const db = await buildIndex(ctx.phrenPath, ctx.profile);
  const contextLabel = project ? `\u25c6 phren \u00b7 ${project} \u00b7 context` : `\u25c6 phren \u00b7 context`;
  const parts: string[] = [contextLabel, "<phren-context>"];

  if (project) {
    const summaryRow = queryRows(db, "SELECT content FROM docs WHERE project = ? AND type = 'summary'", [project]);
    if (summaryRow) {
      parts.push(`# ${project}`);
      parts.push(summaryRow[0][0] as string);
      parts.push("");
    }

    const findingsRow = queryRows(
      db,
      "SELECT content FROM docs WHERE project = ? AND type = 'findings'",
      [project]
    );
    if (findingsRow) {
      const content = findingsRow[0][0] as string;
      const bullets = content.split("\n").filter(l => l.startsWith("- ")).slice(0, 10);
      if (bullets.length > 0) {
        parts.push("## Recent findings");
        parts.push(bullets.join("\n"));
        parts.push("");
      }
    }

    const taskRow = queryRows(
      db,
      "SELECT content FROM docs WHERE project = ? AND type = 'task'",
      [project]
    );
    if (taskRow) {
      const content = taskRow[0][0] as string;
      const activeItems = content.split("\n").filter(l => l.startsWith("- "));
      const filtered = filterTaskByPriority(activeItems);
      const trimmed = filtered.slice(0, 5);
      if (trimmed.length > 0) {
        parts.push("## Active tasks");
        parts.push(trimmed.join("\n"));
        parts.push("");
      }
    }
  } else {
    const projectRows = queryRows(db, "SELECT DISTINCT project FROM docs ORDER BY project", []);
    if (projectRows) {
      parts.push("# Phren projects");
      parts.push(projectRows.map(r => `- ${r[0]}`).join("\n"));
      parts.push("");
    }
  }

  parts.push("</phren-context>");

  if (parts.length > 2) {
    console.log(parts.join("\n"));
  }
}

// ── PostToolUse hook ─────────────────────────────────────────────────────────

const INTERESTING_TOOLS = new Set(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]);
const COOLDOWN_MS = parseInt(process.env.PHREN_AUTOCAPTURE_COOLDOWN_MS ?? "30000", 10);

interface ToolLogEntry {
  at: string;
  session_id?: string;
  tool: string;
  file?: string;
  command?: string;
  error?: string;
}

function flattenToolResponseText(value: unknown, maxChars = 4000): string {
  if (typeof value === "string") return value;
  const queue: unknown[] = [value];
  const parts: string[] = [];
  let length = 0;

  while (queue.length > 0 && length < maxChars) {
    const current = queue.shift();
    if (typeof current === "string") {
      const trimmed = current.trim();
      if (!trimmed) continue;
      parts.push(trimmed);
      length += trimmed.length + 1;
      continue;
    }
    if (Array.isArray(current)) {
      queue.unshift(...current);
      continue;
    }
    if (current && typeof current === "object") {
      queue.unshift(...Object.values(current as Record<string, unknown>));
    }
  }

  if (parts.length > 0) return parts.join("\n").slice(0, maxChars);
  return JSON.stringify(value ?? "").slice(0, maxChars);
}

export async function handleHookTool() {
  const ctx = buildHookContext();
  if (!ctx.hooksEnabled) {
    process.exit(0);
  }

  try {
    const start = Date.now();

    let raw = "";
    if (!process.stdin.isTTY) {
      try {
        raw = fs.readFileSync(0, "utf-8");
      } catch (err: unknown) {
        logDebug("hookTool stdinRead", errorMessage(err));
        process.exit(0);
      }
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch (err: unknown) {
      logDebug("hookTool stdinParse", errorMessage(err));
      process.exit(0);
    }

    const toolName: string = String(data.tool_name ?? data.tool ?? "");
    if (!INTERESTING_TOOLS.has(toolName)) {
      process.exit(0);
    }

    const sessionId: string | undefined = data.session_id as string | undefined;
    const input: Record<string, unknown> = (data.tool_input ?? {}) as Record<string, unknown>;

    const entry: ToolLogEntry = {
      at: new Date().toISOString(),
      session_id: sessionId,
      tool: toolName,
    };

    if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
      const filePath = input.file_path ?? input.path ?? undefined;
      if (filePath) entry.file = String(filePath);
    } else if (toolName === "Bash") {
      const cmd = input.command ?? undefined;
      if (cmd) entry.command = String(cmd).slice(0, 200);
    } else if (toolName === "Glob") {
      const pattern = input.pattern ?? undefined;
      if (pattern) entry.file = String(pattern);
    } else if (toolName === "Grep") {
      const pattern = input.pattern ?? undefined;
      const searchPath = input.path ?? undefined;
      if (pattern) entry.command = `grep ${pattern}${searchPath ? ` in ${searchPath}` : ""}`.slice(0, 200);
    }

    const responseStr = flattenToolResponseText(data.tool_response ?? "");
    if (/(error|exception|failed|no such file|ENOENT)/i.test(responseStr)) {
      entry.error = responseStr.slice(0, 300);
    }

    const cwd: string | undefined = (data.cwd ?? input.cwd ?? undefined) as string | undefined;
    let activeProject = cwd ? detectProject(ctx.phrenPath, cwd, ctx.profile) : null;
    if (!isProjectHookEnabled(ctx.phrenPath, activeProject, "PostToolUse")) {
      appendAuditLog(ctx.phrenPath, "hook_tool", `status=project_disabled project=${activeProject}`);
      process.exit(0);
    }

    try {
      const logFile = runtimeFile(ctx.phrenPath, "tool-log.jsonl");
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
    } catch (err: unknown) {
      logDebug("hookTool toolLog", errorMessage(err));
    }

    const cooldownFile = runtimeFile(ctx.phrenPath, "hook-tool-cooldown");
    try {
      if (fs.existsSync(cooldownFile)) {
        const age = Date.now() - fs.statSync(cooldownFile).mtimeMs;
        if (age < COOLDOWN_MS) {
          debugLog(`hook-tool: cooldown active (${Math.round(age / 1000)}s < ${Math.round(COOLDOWN_MS / 1000)}s), skipping extraction`);
          activeProject = null;
        }
      }
    } catch (err: unknown) {
      logDebug("hookTool cooldownStat", errorMessage(err));
    }

    if (activeProject && sessionId) {
      try {
        const capFile = sessionMarker(ctx.phrenPath, `tool-findings-${sessionId}`);
        let count = 0;
        if (fs.existsSync(capFile)) {
          count = Number.parseInt(fs.readFileSync(capFile, "utf8").trim(), 10) || 0;
        }
        const sessionCap = getSessionCap();
        if (count >= sessionCap) {
          debugLog(`hook-tool: session cap reached (${count}/${sessionCap}), skipping extraction`);
          activeProject = null;
        }
      } catch (err: unknown) {
        logDebug("hookTool sessionCapCheck", errorMessage(err));
      }
    }

    const findingsLevelForTool = getProactivityLevelForFindings(ctx.phrenPath);
    if (activeProject && findingsLevelForTool !== "low") {
      try {
        const candidates = filterToolFindingsForProactivity(
          extractToolFindings(toolName, input, responseStr),
          findingsLevelForTool
        );
        for (const { text, confidence } of candidates) {
          appendReviewQueue(ctx.phrenPath, activeProject, "Review", [text]);
          debugLog(`hook-tool: queued candidate for review (conf=${confidence}): ${text.slice(0, 60)}`);
        }

        if (candidates.length > 0) {
          try { fs.writeFileSync(cooldownFile, Date.now().toString()); } catch (err: unknown) {
            logDebug("hookTool cooldownWrite", errorMessage(err));
          }
          if (sessionId) {
            try {
              const capFile = sessionMarker(ctx.phrenPath, `tool-findings-${sessionId}`);
              let count = 0;
              try { count = Number.parseInt(fs.readFileSync(capFile, "utf8").trim(), 10) || 0; } catch (err: unknown) {
                logDebug("hookTool capFileRead", errorMessage(err));
              }
              count += candidates.length;
              fs.writeFileSync(capFile, count.toString());
            } catch (err: unknown) {
              logDebug("hookTool capFileWrite", errorMessage(err));
            }
          }
        }
      } catch (err: unknown) {
        debugLog(`hook-tool: finding extraction failed: ${errorMessage(err)}`);
      }
    } else if (activeProject) {
      debugLog("hook-tool: skipped because findings proactivity is low");
    }

    const elapsed = Date.now() - start;
    debugLog(`hook-tool: ${toolName} logged in ${elapsed}ms`);
    process.exit(0);
  } catch (err: unknown) {
    debugLog(`hook-tool: unhandled error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(0);
  }
}

// ── Tool finding extraction ──────────────────────────────────────────────────

interface LearningCandidate {
  text: string;
  confidence: number;
  explicit?: boolean;
}

const EXPLICIT_TAG_PATTERN = /\[(pitfall|decision|pattern|tradeoff|architecture|bug)\]\s*(.+)/i;

export function filterToolFindingsForProactivity(
  candidates: Array<{ text: string; confidence: number; explicit?: boolean }>,
  level = getProactivityLevelForFindings(getPhrenPath())
): Array<{ text: string; confidence: number; explicit?: boolean }> {
  if (level === "high") return candidates;
  if (level === "low") return [];
  return candidates.filter((candidate) => candidate.explicit === true);
}

export function extractToolFindings(
  toolName: string,
  input: Record<string, unknown>,
  responseStr: string
): LearningCandidate[] {
  const candidates: LearningCandidate[] = [];
  const changedContent = (toolName === "Edit" || toolName === "Write")
    ? String(input.new_string ?? input.content ?? "")
    : "";
  const explicitSource = changedContent || responseStr;

  const tagMatches = explicitSource.matchAll(new RegExp(EXPLICIT_TAG_PATTERN.source, "gi"));
  for (const m of tagMatches) {
    const tag = m[1].toLowerCase();
    const content = m[2].replace(/\s+/g, " ").trim().slice(0, 200);
    if (content) {
      candidates.push({ text: `[${tag}] ${content}`, confidence: 0.85, explicit: true });
    }
  }

  if (toolName === "Edit" || toolName === "Write") {
    const filePath = String(input.file_path ?? input.path ?? "unknown");
    const filename = path.basename(filePath);
    if (/\b(TODO|FIXME)\b/.test(changedContent)) {
      const firstLine = changedContent.split("\n").find((l) => /\b(TODO|FIXME)\b/.test(l));
      if (firstLine) {
        candidates.push({
          text: `[pitfall] ${filename}: ${firstLine.trim().slice(0, 150)}`,
          confidence: 0.45,
          explicit: false,
        });
      }
    }
    if (/\btry\s*\{[\s\S]*?\bcatch\b/.test(changedContent)) {
      const meaningfulLine = changedContent.split("\n").find(
        (l) => l.trim().length > 10 && !/^\s*(try|catch|\{|\})/.test(l)
      );
      if (meaningfulLine) {
        candidates.push({
          text: `[pitfall] ${filename}: error handling added near "${meaningfulLine.trim().slice(0, 100)}"`,
          confidence: 0.45,
          explicit: false,
        });
      }
    }
  }

  if (toolName === "Bash") {
    const cmd = String(input.command ?? "").slice(0, 30);
    const hasError = /(error|exception|failed|ENOENT|command not found|permission denied)/i.test(responseStr);
    if (hasError && cmd) {
      const firstErrorLine = responseStr.split("\n").find(
        (l) => /(error|exception|failed|ENOENT|command not found|permission denied)/i.test(l)
      );
      if (firstErrorLine) {
        candidates.push({
          text: `[bug] command '${cmd}' failed: ${firstErrorLine.trim().slice(0, 150)}`,
          confidence: 0.55,
          explicit: false,
        });
      }
    }
  }

  return candidates;
}

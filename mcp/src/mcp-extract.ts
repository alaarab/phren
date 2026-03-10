import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse } from "./mcp-types.js";
import { z } from "zod";
import { isValidProjectName, safeProjectPath } from "./utils.js";
import { addFindingsToFile } from "./shared-content.js";
import { checkOllamaAvailable, checkModelAvailable, generateText, getOllamaUrl, getExtractModel } from "./shared-ollama.js";
import { debugLog } from "./shared.js";
import { getProactivityLevelForFindings, shouldAutoCaptureFindingsForLevel } from "./proactivity.js";
import * as path from "path";

const EXTRACT_PROMPT = `You are extracting non-obvious engineering insights from text.
Output ONLY a JSON array of strings. Each string is a specific, actionable finding.

Rules:
- Only extract non-obvious patterns, bugs, decisions, pitfalls, or workarounds
- Do NOT extract obvious facts or things any developer would know
- Do NOT extract credentials, API keys, or personal information
- Each finding must be self-contained (understandable without seeing the source text)
- Prefix each finding with its type in brackets: [decision], [pitfall], [pattern], [tradeoff], [bug], or [architecture]
- Maximum 10 findings
- If nothing is worth extracting, return []
- Return ONLY the JSON array, no explanation, no markdown

Text to analyze:
`;

function parseFindings(raw: string): string[] {
  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
        .map(f => f.trim())
        .slice(0, 10);
    }
  } catch (err: unknown) {
    debugLog(`auto_extract: failed to parse LLM output as JSON: ${cleaned.slice(0, 200)} (${err instanceof Error ? err.message : String(err)})`);
  }
  return [];
}

export function register(server: McpServer, ctx: McpContext): void {
  const { cortexPath, withWriteQueue, updateFileInIndex } = ctx;

  server.registerTool(
    "auto_extract_findings",
    {
      title: "◆ cortex · auto-extract findings",
      description:
        "Use a local Ollama LLM to automatically extract non-obvious findings from text. " +
        "Pass conversation snippets, code review notes, error logs, or any engineering text. " +
        "The model identifies patterns, pitfalls, decisions, and bugs worth remembering. " +
        "Requires Ollama running locally. Set CORTEX_EXTRACT_MODEL env var to choose model (default: llama3.2). " +
        "Set CORTEX_OLLAMA_URL=off to disable.",
      inputSchema: z.object({
        project: z.string().describe("Project name to save extracted findings to."),
        text: z.string().describe("Text to extract findings from (conversation, code review, error log, etc.). Max 10000 chars."),
        model: z.string().optional().describe("Ollama model to use (overrides CORTEX_EXTRACT_MODEL env var)."),
        dryRun: z.boolean().optional().describe("If true, return what would be extracted without saving."),
      }),
    },
    async ({ project, text, model, dryRun }) => {
      if (!isValidProjectName(project)) {
        return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      }
      if (text.length > 10000) {
        text = text.slice(0, 10000);
      }

      const findingsLevel = getProactivityLevelForFindings();
      if (!dryRun && !shouldAutoCaptureFindingsForLevel(findingsLevel, text)) {
        const error = findingsLevel === "low"
          ? 'Findings auto-extraction is disabled when CORTEX_PROACTIVITY_FINDINGS is "low". Use add_finding for manual saves.'
          : 'Findings auto-extraction at "medium" requires an explicit signal like "add finding" or "worth remembering".';
        return mcpResponse({ ok: false, error });
      }

      const ollamaUrl = getOllamaUrl();
      if (!ollamaUrl) {
        return mcpResponse({
          ok: false,
          error: "Ollama is disabled (CORTEX_OLLAMA_URL=off). Set CORTEX_OLLAMA_URL=http://localhost:11434 to enable auto-extraction.",
        });
      }

      const available = await checkOllamaAvailable(ollamaUrl);
      if (!available) {
        return mcpResponse({
          ok: false,
          error: `Ollama not running at ${ollamaUrl}. Start Ollama first: https://ollama.com`,
        });
      }

      const extractModel = model ?? getExtractModel();
      const modelAvailable = await checkModelAvailable(extractModel, ollamaUrl);
      if (!modelAvailable) {
        return mcpResponse({
          ok: false,
          error: `Model "${extractModel}" not found. Pull it with: ollama pull ${extractModel}`,
        });
      }

      const prompt = EXTRACT_PROMPT + text;
      const raw = await generateText(prompt, extractModel, ollamaUrl);
      if (!raw) {
        return mcpResponse({ ok: false, error: "Ollama returned no response. Try again or check model availability." });
      }

      const findings = parseFindings(raw);
      if (findings.length === 0) {
        return mcpResponse({
          ok: true,
          message: "No findings worth extracting from the provided text.",
          data: { project, extracted: [], added: [], skipped: [], dryRun: dryRun ?? false },
        });
      }

      if (dryRun) {
        return mcpResponse({
          ok: true,
          message: `Would extract ${findings.length} finding(s) (dry run, nothing saved).`,
          data: { project, extracted: findings, added: [], skipped: [], dryRun: true },
        });
      }

      return withWriteQueue(async () => {
        // Use addFindingsToFile so extracted findings go through the full pipeline:
        // secret scan, dedup check, validation, and index update.
        const result = addFindingsToFile(cortexPath, project, findings);
        if (!result.ok) {
          return mcpResponse({ ok: false, error: result.error });
        }
        const { added, skipped, rejected } = result.data;
        const allSkipped = [...skipped, ...rejected.map(r => r.text)];

        // Update index for the findings file
        const resolvedDir = safeProjectPath(cortexPath, project);
        if (resolvedDir) {
          updateFileInIndex(path.join(resolvedDir, "FINDINGS.md"));
        }

        return mcpResponse({
          ok: added.length > 0,
          message: `Extracted ${findings.length} finding(s): ${added.length} added, ${allSkipped.length} skipped (duplicates or errors).`,
          data: { project, extracted: findings, added, skipped: allSkipped, dryRun: false },
        });
      });
    }
  );
}

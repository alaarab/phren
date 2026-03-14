import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse } from "./mcp-types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { runtimeDir } from "./shared.js";
import {
  recordFeedback,
  flushEntryScores,
} from "./shared-governance.js";
import { upsertCanonical } from "./shared-content.js";
import { isValidProjectName } from "./utils.js";



export function register(server: McpServer, ctx: McpContext): void {
  const { phrenPath, withWriteQueue, updateFileInIndex } = ctx;

  server.registerTool(
    "pin_memory",
    {
      title: "◆ phren · pin memory",
      description:
        "Write a truth — a high-confidence, always-inject entry in truths.md that never decays.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        memory: z.string().describe("Truth text."),
      }),
    },
    async ({ project, memory }) => {
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const result = upsertCanonical(phrenPath, project, memory);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        // Update FTS index so newly pinned memory is immediately searchable
        const canonicalPath = path.join(phrenPath, project, "truths.md");
        updateFileInIndex(canonicalPath);
        return mcpResponse({ ok: true, message: result.data, data: { project, memory } });
      });
    }
  );

  server.registerTool(
    "memory_feedback",
    {
      title: "◆ phren · feedback",
      description: "Record feedback on whether an injected memory was helpful or noisy/regressive.",
      inputSchema: z.object({
        key: z.string().describe("Memory key to score."),
        feedback: z.enum(["helpful", "reprompt", "regression"]).describe("Feedback type."),
      }),
    },
    async ({ key, feedback }) => {
      return withWriteQueue(async () => {
        recordFeedback(phrenPath, key, feedback);
        flushEntryScores(phrenPath);

        const feedbackWeights: Record<string, number> = {
          helpful: 1.0,
          not_helpful: -0.3,
          reprompt: -0.5,
          regression: -1.0,
        };
        const weight = feedbackWeights[feedback] ?? 0;
        // Write feedback audit to a dedicated file — NOT to scores.jsonl, which uses a
        // different schema ({key, delta, at}) and would crash readScoreJournal if polluted.
        const auditFile = path.join(runtimeDir(phrenPath), "feedback-audit.jsonl");
        fs.mkdirSync(path.dirname(auditFile), { recursive: true });
        const entry = { key, feedback, weight, timestamp: new Date().toISOString() };
        fs.appendFileSync(auditFile, JSON.stringify(entry) + "\n");

        return mcpResponse({ ok: true, message: `Recorded feedback ${feedback} for ${key} (weight: ${weight})`, data: { key, feedback, weight } });
      });
    }
  );
}

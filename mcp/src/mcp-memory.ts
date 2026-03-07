import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "./mcp-types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { runtimeDir } from "./shared.js";
import {
  recordFeedback,
  flushEntryScores,
} from "./shared-governance.js";
import { upsertCanonical } from "./shared-content.js";

function jsonResponse(payload: { ok: boolean; data?: unknown; error?: string; message?: string }) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

export function register(server: McpServer, ctx: McpContext): void {
  const { cortexPath, withWriteQueue } = ctx;

  server.registerTool(
    "pin_memory",
    {
      title: "◆ cortex · pin memory",
      description:
        "Promote an important memory into CANONICAL_MEMORIES.md so retrieval prioritizes it.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
        memory: z.string().describe("Canonical memory text to pin."),
      }),
    },
    async ({ project, memory }) => {
      return withWriteQueue(async () => {
        const result = upsertCanonical(cortexPath, project, memory);
        if (!result.ok) return jsonResponse({ ok: false, error: result.error });
        return jsonResponse({ ok: true, message: result.data, data: { project, memory } });
      });
    }
  );

  server.registerTool(
    "memory_feedback",
    {
      title: "◆ cortex · feedback",
      description: "Record feedback on whether an injected memory was helpful or noisy/regressive.",
      inputSchema: z.object({
        key: z.string().describe("Memory key to score."),
        feedback: z.enum(["helpful", "reprompt", "regression"]).describe("Feedback type."),
      }),
    },
    async ({ key, feedback }) => {
      return withWriteQueue(async () => {
        recordFeedback(cortexPath, key, feedback);
        flushEntryScores(cortexPath);

        const feedbackWeights: Record<string, number> = {
          helpful: 1.0,
          not_helpful: -0.3,
          reprompt: -0.5,
          regression: -1.0,
        };
        const weight = feedbackWeights[feedback] ?? 0;
        const scoresFile = path.join(runtimeDir(cortexPath), "scores.jsonl");
        fs.mkdirSync(path.dirname(scoresFile), { recursive: true });
        const entry = { key, feedback, weight, timestamp: new Date().toISOString() };
        fs.appendFileSync(scoresFile, JSON.stringify(entry) + "\n");

        return jsonResponse({ ok: true, message: `Recorded feedback ${feedback} for ${key} (weight: ${weight})`, data: { key, feedback, weight } });
      });
    }
  );
}

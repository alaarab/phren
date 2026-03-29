import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext, mcpResponse, resolveStoreForProject } from "./types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { runtimeDir } from "../shared.js";
import {
  recordFeedback,
  flushEntryScores,
} from "../shared/governance.js";
import { upsertCanonical } from "../shared/content.js";
import { isValidProjectName } from "../utils.js";



export function register(server: McpServer, ctx: McpContext): void {
  const { withWriteQueue, updateFileInIndex } = ctx;

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
    async ({ project: projectInput, memory }) => {
      let phrenPath: string;
      let project: string;
      try {
        const resolved = resolveStoreForProject(ctx, projectInput);
        phrenPath = resolved.phrenPath;
        project = resolved.project;
      } catch (err: unknown) {
        return mcpResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      return withWriteQueue(async () => {
        const result = upsertCanonical(phrenPath, project, memory);
        if (!result.ok) return mcpResponse({ ok: false, error: result.error });
        const canonicalPath = path.join(phrenPath, project, "truths.md");
        updateFileInIndex(canonicalPath);
        return mcpResponse({ ok: true, message: result.data, data: { project, memory } });
      });
    }
  );

  server.registerTool(
    "get_truths",
    {
      title: "◆ phren · truths",
      description:
        "Read all pinned truths for a project. Truths are high-confidence entries in truths.md that never decay.",
      inputSchema: z.object({
        project: z.string().describe("Project name."),
      }),
    },
    async ({ project: projectInput }) => {
      let phrenPath: string;
      let project: string;
      try {
        const resolved = resolveStoreForProject(ctx, projectInput);
        phrenPath = resolved.phrenPath;
        project = resolved.project;
      } catch (err: unknown) {
        return mcpResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      if (!isValidProjectName(project)) return mcpResponse({ ok: false, error: `Invalid project name: "${project}"` });
      const truthsPath = path.join(phrenPath, project, "truths.md");
      if (!fs.existsSync(truthsPath)) {
        return mcpResponse({ ok: true, message: `No truths pinned for "${project}" yet.`, data: { project, truths: [], count: 0 } });
      }
      const content = fs.readFileSync(truthsPath, "utf8");
      const truths = content.split("\n")
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2).trim());
      return mcpResponse({
        ok: true,
        message: truths.length > 0
          ? `${truths.length} truth(s) pinned for "${project}".`
          : `No truths pinned for "${project}" yet.`,
        data: { project, truths, count: truths.length },
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
      const phrenPath = ctx.phrenPath;
      return withWriteQueue(async () => {
        recordFeedback(phrenPath, key, feedback);
        flushEntryScores(phrenPath);

        const feedbackWeights: Record<string, number> = {
          helpful: 1.0,
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

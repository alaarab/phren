import * as fs from "fs";
import * as path from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { detectProject } from "../shared/index.js";
import { HELPER_TIMEOUT_DEFAULT_S, HELPER_TIMEOUT_MAX_S, helperFor, runHelper } from "../bridge/helper.js";
import { type McpContext, mcpResponse, resolveStoreForProject } from "./types.js";

export function register(server: McpServer, ctx: McpContext): void {
  server.registerTool("helper", {
    title: "◆ phren · helper",
    description: `Run one small, self-contained task as a headless Claude Code run (claude -p) under the project's helper account and model (phren.project.yaml helper: { account, model }, model haiku by default), in your folder, and return its reply. Use it for narrow work you can describe fully in one prompt (summarize a file, draft a test, look something up); the helper sees no conversation, only the prompt and the folder. It bills the helper account, not yours: Claude Code's own subagents always run under your login. Read-only unless allowEdits. Stops after timeoutSeconds (default ${HELPER_TIMEOUT_DEFAULT_S}, at most ${HELPER_TIMEOUT_MAX_S}). Refused when the project has no helper account, the account's role is off, or its pool is not allowed for the project or this computer.`,
    inputSchema: {
      prompt: z.string().min(1).max(100_000).describe("The whole task: what to do, which files, what to return."),
      project: z.string().optional().describe("Project whose helper setting applies; default: the project of cwd."),
      cwd: z.string().optional().describe("Absolute folder the helper runs in (your worktree); default: this server's folder."),
      timeoutSeconds: z.number().int().min(1).max(HELPER_TIMEOUT_MAX_S).optional(),
      allowEdits: z.boolean().optional().describe("Let the helper edit files in cwd (acceptEdits). Default false."),
    },
  }, async input => {
    try {
      if (input.cwd !== undefined && !path.isAbsolute(input.cwd)) throw new Error("cwd is an absolute path.");
      const cwd = path.resolve(input.cwd ?? process.cwd());
      if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${cwd} is not a folder.`);
      const named = input.project ?? detectProject(ctx.phrenPath, cwd, ctx.profile);
      if (!named) throw new Error("No project for this folder: pass project.");
      const { phrenPath, project } = resolveStoreForProject(ctx, named, "read");
      const choice = helperFor(phrenPath, project);
      const result = await runHelper(choice, { prompt: input.prompt, cwd, timeoutSeconds: input.timeoutSeconds, allowEdits: input.allowEdits });
      const spent = result.costUSD !== undefined ? `, $${result.costUSD.toFixed(4)}` : "";
      // The reply is in data.output; a failure's reason is also the error.
      return mcpResponse({ ok: result.ok, data: result, ...(result.ok ? {} : { error: result.output.slice(0, 2000) }),
        message: `${result.ok ? "Helper replied" : "Helper failed"} (${result.account}, ${result.model}, ${Math.round(result.durationMs / 1000)}s${spent}).` });
    } catch (error) {
      return mcpResponse({ ok: false, error: error instanceof Error ? error.message : "The helper could not run." });
    }
  });
}

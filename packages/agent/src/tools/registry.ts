import * as path from "node:path";
import { flushTelemetry, traceOperation } from "../telemetry.js";
import { LspDiagnostics } from "../lsp/diagnostics.js";
import type { AgentTool, AgentToolResult } from "./types.js";
import { DIFF_MARKER } from "../multi/diff-renderer.js";
import type { AgentToolDef } from "../providers/types.js";
import type { PermissionConfig } from "../permissions/types.js";
import { checkPermission } from "../permissions/checker.js";
import { askUser as defaultAskUser } from "../permissions/prompt.js";
import {
  runPreToolUseHooks,
  runPostToolUseHooks,
  type HooksConfig,
  type HookExecutor,
} from "../user-hooks.js";

/** Signature for the permission prompt function. */
export type AskUserFn = (toolName: string, input: Record<string, unknown>, reason: string) => Promise<boolean>;

export class ToolRegistry {
  private diagnostics = new LspDiagnostics(() => this.permissionConfig, async (argv, signal) => {
    const input = { command: argv.map(arg => "'" + arg.replace(/'/g, "'\\''") + "'").join(" "), cwd: this.permissionConfig.projectRoot };
    const pre = await runPreToolUseHooks(this.hookConfig, "shell", input, { cwd: this.permissionConfig.projectRoot, executor: this.hookExecutor });
    if (this.closed || pre.denied || signal?.aborted) return false;
    const rule = checkPermission(this.permissionConfig, "shell", input);
    return rule.verdict === "allow" || (rule.verdict === "ask" && await this.askUser("shell", input, rule.reason));
  }, async (file, signal) => {
    const input = { path: file };
    const pre = await runPreToolUseHooks(this.hookConfig, "read_file", input, { cwd: this.permissionConfig.projectRoot, executor: this.hookExecutor });
    if (this.closed || pre.denied || signal?.aborted) return false;
    const rule = checkPermission(this.permissionConfig, "read_file", input);
    return rule.verdict === "allow" || (rule.verdict === "ask" && await this.askUser("read_file", input, rule.reason));
  });
  private closed = false;
  close(): void { this.closed = true; this.diagnostics.close(); }
  private tools = new Map<string, AgentTool>();
  /** Override the default permission prompt (e.g. for Ink TUI). */
  askUser: AskUserFn = defaultAskUser;
  permissionConfig: PermissionConfig = {
    mode: "suggest",
    projectRoot: process.cwd(),
    allowedPaths: [],
  };
  hookConfig: HooksConfig | null = null;
  hookExecutor?: HookExecutor;

  registerDiagnosticsTool(): void {
    this.register({
      name: "lsp_diagnostics",
      description: "Get diagnostics for a file using an installed language server. Requires read and server-launch authorization; never installs a server or downloads dependencies.",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: async (input, signal) => {
        if (typeof input.path !== "string" || !input.path.trim()) return { output: "A file path is required.", is_error: true };
        const file = path.resolve(this.permissionConfig.projectRoot, input.path);
        const output = await this.diagnostics.afterEdit([file], signal);
        return { output: output || "No authorized installed language-server result is available; no clean result claimed." };
      },
    });
  }

  register(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  remove(name: string): boolean {
    return this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  toolNames(): string[] {
    return [...this.tools.keys()];
  }

  setPermissions(config: PermissionConfig): void {
    this.diagnostics.close();
    this.permissionConfig = config;
    if (config.network === "off") void flushTelemetry(false);
  }

  getDefinitions(): AgentToolDef[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  }

  async execute(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult> {
    if (this.closed || signal?.aborted) return { output: "Cancelled by user.", is_error: true };
    if (this.permissionConfig.network === "off" && (name === "web_search" || name === "web_fetch")) return { output: "Network tools are disabled by --no-network.", is_error: true, permissionDenied: true };
    const tool = this.tools.get(name);
    if (!tool) return { output: `Unknown tool: ${name}`, is_error: true };

    const config = this.permissionConfig;
    const hookOptions = { cwd: config.projectRoot, executor: this.hookExecutor };
    const pre = await runPreToolUseHooks(this.hookConfig, name, input, hookOptions);
    if (pre.denied) {
      return { output: pre.message, is_error: true, permissionDenied: true };
    }

    if (this.closed || signal?.aborted) return { output: "Cancelled by user.", is_error: true };

    // Permission check — always enforced
    const rule = checkPermission(this.permissionConfig, name, input);
    if (rule.verdict === "deny") {
      return { output: `Permission denied: ${rule.reason}`, is_error: true, permissionDenied: true };
    }
    if (rule.verdict === "ask") {
      const allowed = await this.askUser(name, input, rule.reason);
      if (!allowed) {
        return { output: "User denied permission.", is_error: true, permissionDenied: true };
      }
    }

    // An approval may arrive after the turn was cancelled or this call timed out.
    // Recheck here: tools such as synchronous file writes cannot observe abort later.
    if (this.closed || signal?.aborted) return { output: "Cancelled by user.", is_error: true };
    if (this.permissionConfig !== config) return { output: "Permissions changed while this call was awaiting authorization; request it again.", is_error: true, permissionDenied: true };

    let result: AgentToolResult;
    try {
      result = await traceOperation("agent.tool", { "tool.name": name }, () => tool.execute(input, signal), this.permissionConfig.network !== "off");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { output: `Tool error: ${msg}`, is_error: true };
    }

    if (!this.closed && !result.is_error && result.changedFiles?.length) {
      let diagnostics = "";
      try { diagnostics = await this.diagnostics.afterEdit(result.changedFiles, signal); }
      catch { diagnostics = "Language-server diagnostics unavailable; the edit succeeded."; }
      if (diagnostics) {
        const at = result.output.indexOf(DIFF_MARKER), note = `\n\n${diagnostics}`;
        result = { ...result, output: at === -1 ? result.output + note : result.output.slice(0, at) + note + result.output.slice(at) };
      }
    }
    if (this.closed || signal?.aborted) return result;
    const feedback = await runPostToolUseHooks(this.hookConfig, name, input, result.output, !!result.is_error, hookOptions);
    if (feedback) {
      // Before the TUI's diff payload, which the model never sees.
      const note = `\n\nPostToolUse hook: ${feedback}`;
      const at = result.output.indexOf(DIFF_MARKER);
      result = { ...result, output: at === -1 ? result.output + note : result.output.slice(0, at) + note + result.output.slice(at) };
    }
    return result;
  }
}

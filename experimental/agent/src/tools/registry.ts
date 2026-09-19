import type { AgentTool, AgentToolResult } from "./types.js";
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
    this.permissionConfig = config;
  }

  getDefinitions(): AgentToolDef[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  }

  async execute(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult> {
    if (signal?.aborted) return { output: "Cancelled by user.", is_error: true };
    const tool = this.tools.get(name);
    if (!tool) return { output: `Unknown tool: ${name}`, is_error: true };

    const hookOptions = { cwd: this.permissionConfig.projectRoot, executor: this.hookExecutor };
    const pre = await runPreToolUseHooks(this.hookConfig, name, input, hookOptions);
    if (pre.denied) {
      return { output: pre.message, is_error: true };
    }

    if (signal?.aborted) return { output: "Cancelled by user.", is_error: true };

    // Permission check — always enforced
    const rule = checkPermission(this.permissionConfig, name, input);
    if (rule.verdict === "deny") {
      return { output: `Permission denied: ${rule.reason}`, is_error: true };
    }
    if (rule.verdict === "ask") {
      const allowed = await this.askUser(name, input, rule.reason);
      if (!allowed) {
        return { output: "User denied permission.", is_error: true };
      }
    }

    // An approval may arrive after the turn was cancelled or this call timed out.
    // Recheck here: tools such as synchronous file writes cannot observe abort later.
    if (signal?.aborted) return { output: "Cancelled by user.", is_error: true };

    let result: AgentToolResult;
    try {
      result = await tool.execute(input, signal);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { output: `Tool error: ${msg}`, is_error: true };
    }

    await runPostToolUseHooks(this.hookConfig, name, input, result.output, !!result.is_error, hookOptions);
    return result;
  }
}

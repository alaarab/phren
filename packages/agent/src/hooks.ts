/**
 * Agent-loop hooks system — user-configurable callbacks for agent events.
 *
 * Hooks fire at key points in the agent loop:
 * - PreToolUse: before a tool is executed (can block or modify)
 * - PostToolUse: after a tool completes (for side effects like formatting)
 * - PreCompact: before context compaction (for custom preservation)
 * - Stop: when agent finishes a turn with no tool calls
 *
 * Hooks are shell commands configured in ~/.phren-agent/hooks.json or
 * passed via --hooks-config CLI flag.
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { scrubEnv } from "./permissions/shell-safety.js";

export type HookEvent = "PreToolUse" | "PostToolUse" | "PreCompact" | "Stop";

export interface HookDefinition {
  event: HookEvent;
  command: string;
  /** Timeout in ms. Default: 5000. */
  timeout?: number;
  /** If true, hook can block the action (PreToolUse only). */
  blocking?: boolean;
}

export interface HookResult {
  /** Whether the hook allowed the action to proceed. Only relevant for blocking PreToolUse hooks. */
  allowed: boolean;
  /** Hook stdout output, if any. */
  output?: string;
  /** Error message if hook failed. */
  error?: string;
  /** If true, the agent should NOT stop (Stop hook exit code 2). The output/error is injected as a user message. */
  preventStop?: boolean;
}

export interface HookContext {
  event: HookEvent;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  isError?: boolean;
  /** Files modified in this turn (for PostToolUse / Stop). */
  filesModified?: string[];
}

export class HookManager {
  private hooks: HookDefinition[] = [];

  constructor(hooks?: HookDefinition[]) {
    if (hooks) {
      this.hooks = hooks;
    }
  }

  /** Load hooks from config file. */
  static fromConfigFile(configPath?: string): HookManager {
    const path = configPath ?? join(homedir(), ".phren-agent", "hooks.json");
    if (!existsSync(path)) return new HookManager();

    try {
      const raw = readFileSync(path, "utf-8");
      const data = JSON.parse(raw);
      if (Array.isArray(data.hooks)) {
        return new HookManager(data.hooks);
      }
      return new HookManager();
    } catch {
      return new HookManager();
    }
  }

  /** Run all hooks for an event. Returns combined result. */
  async runHooks(ctx: HookContext): Promise<HookResult> {
    const matching = this.hooks.filter(h => h.event === ctx.event);
    if (matching.length === 0) return { allowed: true };

    for (const hook of matching) {
      const result = this.executeHook(hook, ctx);
      // For blocking PreToolUse hooks, stop on first deny
      if (hook.blocking && ctx.event === "PreToolUse" && !result.allowed) {
        return result;
      }
    }

    return { allowed: true };
  }

  /** Check if any hooks are registered for an event. */
  hasHooks(event: HookEvent): boolean {
    return this.hooks.some(h => h.event === event);
  }

  /** Get registered hooks (for display). */
  getHooks(): ReadonlyArray<HookDefinition> {
    return this.hooks;
  }

  private executeHook(hook: HookDefinition, ctx: HookContext): HookResult {
    const timeout = hook.timeout ?? 5000;
    const env: Record<string, string> = {
      ...scrubEnv() as Record<string, string>,
      PHREN_HOOK_EVENT: ctx.event,
    };

    if (ctx.toolName) env.PHREN_HOOK_TOOL_NAME = ctx.toolName;
    if (ctx.toolInput) {
      const json = JSON.stringify(ctx.toolInput);
      env.PHREN_HOOK_TOOL_INPUT = json.slice(0, 10_000);
    }
    if (ctx.toolOutput) env.PHREN_HOOK_TOOL_OUTPUT = ctx.toolOutput.slice(0, 10_000);
    if (ctx.isError !== undefined) env.PHREN_HOOK_IS_ERROR = String(ctx.isError);
    if (ctx.filesModified) env.PHREN_HOOK_FILES_MODIFIED = ctx.filesModified.join(",");

    try {
      const output = execSync(hook.command, {
        timeout,
        env,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        cwd: process.cwd(),
      });

      return { allowed: true, output: output.trim() };
    } catch (err: unknown) {
      const exitCode = (err as { status?: number }).status ?? 1;
      const stderr = (err as { stderr?: string }).stderr ?? "";

      // Exit code 1 from a blocking hook means "deny"
      if (hook.blocking && exitCode === 1) {
        return {
          allowed: false,
          error: stderr.trim() || `Hook denied: ${hook.command}`,
        };
      }

      // Exit code 2 from a Stop hook means "don't stop, keep going"
      if (ctx.event === "Stop" && exitCode === 2) {
        return {
          allowed: true,
          preventStop: true,
          output: stderr.trim() || "Stop hook requested continuation.",
        };
      }

      // Other errors are logged but don't block
      return {
        allowed: true,
        error: `Hook error (${hook.command}): ${stderr.trim() || String(err)}`,
      };
    }
  }
}

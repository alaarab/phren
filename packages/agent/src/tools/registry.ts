import type { AgentTool, AgentToolResult } from "./types.js";
import type { AgentToolDef } from "../providers/types.js";
import type { PermissionConfig } from "../permissions/types.js";
import { checkPermission } from "../permissions/checker.js";
import { askUser } from "../permissions/prompt.js";

/**
 * Deferred tool entry — only the schema is loaded initially.
 * The full tool (with execute) is resolved on first use.
 */
interface DeferredToolEntry {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Lazy loader that returns the full tool on first call. */
  resolve: () => Promise<AgentTool>;
  resolved?: AgentTool;
}

export class ToolRegistry {
  private tools = new Map<string, AgentTool>();
  private deferred = new Map<string, DeferredToolEntry>();
  permissionConfig: PermissionConfig = {
    mode: "suggest",
    projectRoot: process.cwd(),
    allowedPaths: [],
  };

  register(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Register a deferred tool — only the schema is sent to the LLM.
   * The full tool is resolved on first execute().
   * Use this for expensive-to-initialize tools (MCP servers, LSP, etc.)
   */
  registerDeferred(entry: DeferredToolEntry): void {
    this.deferred.set(entry.name, entry);
  }

  setPermissions(config: PermissionConfig): void {
    this.permissionConfig = config;
  }

  /**
   * Get tool definitions for the LLM.
   * If deferredMode is "names_only", deferred tools return only name+description (no schema).
   * This keeps the system prompt smaller.
   */
  getDefinitions(deferredMode: "full" | "names_only" = "full"): AgentToolDef[] {
    const defs: AgentToolDef[] = [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));

    for (const [, entry] of this.deferred) {
      if (deferredMode === "names_only") {
        // Minimal definition — just enough for the LLM to know the tool exists
        defs.push({
          name: entry.name,
          description: entry.description + " [deferred — call to load full schema]",
          input_schema: entry.input_schema,
        });
      } else {
        defs.push({
          name: entry.name,
          description: entry.description,
          input_schema: entry.input_schema,
        });
      }
    }

    return defs;
  }

  async execute(name: string, input: Record<string, unknown>): Promise<AgentToolResult> {
    let tool = this.tools.get(name);

    // Check deferred tools if not found in regular tools
    if (!tool) {
      const entry = this.deferred.get(name);
      if (entry) {
        // Resolve the deferred tool on first use
        if (!entry.resolved) {
          try {
            entry.resolved = await entry.resolve();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { output: `Failed to load tool "${name}": ${msg}`, is_error: true };
          }
        }
        tool = entry.resolved;
      }
    }

    if (!tool) return { output: `Unknown tool: ${name}`, is_error: true };

    // Permission check — always enforced
    const rule = checkPermission(this.permissionConfig, name, input);
    if (rule.verdict === "deny") {
      return { output: `Permission denied: ${rule.reason}`, is_error: true };
    }
    if (rule.verdict === "ask") {
      const allowed = await askUser(name, input, rule.reason);
      if (!allowed) {
        return { output: "User denied permission.", is_error: true };
      }
    }

    try {
      return await tool.execute(input);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `Tool error: ${msg}`, is_error: true };
    }
  }
}

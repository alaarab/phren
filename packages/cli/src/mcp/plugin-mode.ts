/**
 * `phren mcp`: the MCP server as the Claude Code plugin starts it.
 *
 * The plugin cannot pass a store path (it does not know one), so `phren mcp`
 * finds the store itself. Two cases then need something other than the full
 * server:
 *
 * - no store yet (a plugin-only user on first run): a small server whose one
 *   tool explains setup and, once the user agrees, runs `phren init --yes`;
 * - `phren init` already registered its own `phren` server for Claude Code and
 *   the plugin launched this one (PHREN_MCP_OWNER=plugin): an empty server, so
 *   the user does not see every phren tool twice.
 */
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { findPhrenPath, homePath } from "../phren-paths.js";

export type PluginSetupReason = "no-store" | "stand-down";

function hasPhrenServer(filePath: string): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as { mcpServers?: Record<string, unknown> };
    return Boolean(data?.mcpServers && typeof data.mcpServers === "object" && data.mcpServers.phren);
  } catch {
    return false;
  }
}

/**
 * True when Claude Code will also load a user-level `phren` server that
 * `phren init` registered. Claude Code reads user MCP servers from
 * `.claude.json` (inside CLAUDE_CONFIG_DIR when set), not from settings.json,
 * so an entry only in settings.json does not count.
 */
export function userLevelPhrenMcpConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return hasPhrenServer(configDir ? path.join(configDir, ".claude.json") : homePath(".claude.json"));
}

/** Why `phren mcp` should not start the full server, or null when it should. */
export function pluginSetupReason(env: NodeJS.ProcessEnv = process.env): PluginSetupReason | null {
  if (env.PHREN_MCP_OWNER === "plugin" && userLevelPhrenMcpConfigured(env)) return "stand-down";
  return findPhrenPath() ? null : "no-store";
}

const NO_STORE_INSTRUCTIONS =
  "phren gives this agent memory across sessions (findings, tasks, project context), but it has no store on this machine yet. " +
  "When the user asks about phren or memory, call phren_setup to explain setup, and only call it with confirm=true after they agree.";

const STAND_DOWN_INSTRUCTIONS =
  "phren is already registered as its own MCP server by `phren init`; use that server's tools. This plugin copy stays empty so nothing appears twice.";

export function setupMessage(): string {
  return [
    "phren has no memory store on this machine yet.",
    "",
    "Setup runs `phren init --yes`, which:",
    "- creates the store at ~/.phren (a local git repo; nothing leaves the machine unless you add a remote)",
    "- registers phren's MCP server and memory hooks in ~/.claude/settings.json (the plugin's own copies then stand down)",
    "- wires any other agents it detects (Codex, Copilot CLI, Cursor, VS Code)",
    "",
    "Ask the user before running it. Afterwards, Claude Code needs a restart to load the memory tools.",
  ].join("\n");
}

export function runInitForPlugin(): { ok: boolean; output: string } {
  const entry = process.argv[1];
  const result = spawnSync(process.execPath, [entry, "init", "--yes"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 180_000,
    env: { ...process.env, PHREN_MCP_OWNER: "" },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const tail = output.split("\n").slice(-25).join("\n");
  return { ok: result.status === 0, output: tail || (result.error ? String(result.error) : "") };
}

export async function runPluginSetupServer(reason: PluginSetupReason): Promise<void> {
  const [{ McpServer }, { StdioServerTransport }, { z }, { VERSION }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("zod"),
    import("../package-metadata.js"),
  ]);
  const server = new McpServer(
    { name: "phren-mcp", version: VERSION },
    { instructions: reason === "no-store" ? NO_STORE_INSTRUCTIONS : STAND_DOWN_INSTRUCTIONS },
  );

  if (reason === "no-store") {
    server.registerTool(
      "phren_setup",
      {
        title: "◆ phren · set up memory",
        description:
          "phren has no memory store on this machine yet. Call without arguments to get what setup does; " +
          "call with confirm=true, only after the user agrees, to run `phren init --yes` (creates ~/.phren and wires Claude Code). Restart Claude Code afterwards.",
        inputSchema: z.object({
          confirm: z.boolean().optional().describe("true runs setup now. Only after the user agreed."),
        }),
      },
      async ({ confirm }) => {
        if (!confirm) return { content: [{ type: "text" as const, text: setupMessage() }] };
        const result = runInitForPlugin();
        const next = result.ok
          ? "\n\nphren is set up. Restart Claude Code so its memory tools and hooks load."
          : "\n\nSetup failed. The user can run `npx -y @phren/cli init` in a terminal instead.";
        return { content: [{ type: "text" as const, text: `${result.output}${next}` }], isError: !result.ok };
      },
    );
  } else {
    // An empty but well-formed tool list, so clients that list tools
    // regardless of capabilities get [] rather than "method not found".
    const { ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
    server.server.registerCapabilities({ tools: {} });
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`phren-mcp running in plugin ${reason} mode`);
}

/**
 * MCP client — connects to MCP servers, discovers tools, wraps them as AgentTools.
 * Uses stdio transport (spawns server as child process).
 */
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as readline from "readline";
import type { AgentTool, AgentToolResult } from "./tools/types.js";
import { VERSION } from "./package-metadata.js";
import { scrubEnv } from "./permissions/shell-safety.js";

/** JSON-RPC 2.0 message types for MCP protocol. */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpResourceDef {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** Active MCP server connection. */
export class McpConnection {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private rl: readline.Interface;
  readonly name: string;

  constructor(name: string, config: McpServerConfig) {
    this.name = name;
    const env = { ...scrubEnv(), ...config.env };
    this.proc = spawn(config.command, config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    this.rl = readline.createInterface({ input: this.proc.stdout! });
    this.rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject, timer } = this.pending.get(msg.id)!;
          clearTimeout(timer);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(`MCP error: ${msg.error.message}`));
          else resolve(msg.result);
        }
      } catch { /* ignore non-JSON lines */ }
    });

    this.proc.on("error", (err) => {
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(err); }
      this.pending.clear();
    });
  }

  private send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP call ${method} timed out (30s)`));
        }
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin!.write(JSON.stringify(msg) + "\n");
    });
  }

  async initialize(): Promise<void> {
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "phren-agent", version: VERSION },
    });
    // Send initialized notification (no id)
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }

  async listTools(): Promise<McpToolDef[]> {
    const result = await this.send("tools/list") as { tools?: McpToolDef[] };
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text?: string }> }> {
    return await this.send("tools/call", { name, arguments: args }) as {
      content: Array<{ type: string; text?: string }>;
    };
  }

  async listResources(): Promise<McpResourceDef[]> {
    const result = await this.send("resources/list") as { resources?: McpResourceDef[] };
    return result?.resources ?? [];
  }

  async readResource(uri: string): Promise<string> {
    const result = await this.send("resources/read", { uri }) as {
      contents?: Array<{ uri: string; text?: string; mimeType?: string }>;
    };
    const contents = result?.contents ?? [];
    return contents.map((c) => c.text ?? "").join("\n") || "(empty)";
  }

  close(): void {
    try { this.proc.stdin!.end(); } catch { /* ignore */ }
    try { this.proc.kill(); } catch { /* ignore */ }
    this.rl.close();
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error("Connection closed")); }
    this.pending.clear();
  }
}

/** Wrap an MCP tool as an AgentTool. */
function wrapMcpTool(conn: McpConnection, def: McpToolDef): AgentTool {
  return {
    name: `mcp_${conn.name}_${def.name}`,
    description: `[${conn.name}] ${def.description ?? def.name}`,
    input_schema: def.inputSchema ?? { type: "object", properties: {} },
    async execute(input: Record<string, unknown>): Promise<AgentToolResult> {
      try {
        const result = await conn.callTool(def.name, input);
        const text = result.content
          ?.map((c) => c.text ?? JSON.stringify(c))
          .join("\n") ?? "OK";
        return { output: text };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `MCP error: ${msg}`, is_error: true };
      }
    },
  };
}

export interface McpConfigEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Connect to MCP servers and return their tools as AgentTools. */
export async function connectMcpServers(
  servers: Record<string, McpConfigEntry>,
  verbose = false,
): Promise<{ tools: AgentTool[]; connections: McpConnection[]; cleanup: () => void }> {
  const connections: McpConnection[] = [];
  const tools: AgentTool[] = [];

  for (const [name, config] of Object.entries(servers)) {
    try {
      if (verbose) process.stderr.write(`Connecting to MCP server: ${name}...\n`);
      const conn = new McpConnection(name, config);
      await conn.initialize();
      const mcpTools = await conn.listTools();

      for (const def of mcpTools) {
        tools.push(wrapMcpTool(conn, def));
      }

      connections.push(conn);
      if (verbose) process.stderr.write(`  ${name}: ${mcpTools.length} tools\n`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Failed to connect to MCP server "${name}": ${msg}\n`);
    }
  }

  return {
    tools,
    connections,
    cleanup: () => { for (const conn of connections) conn.close(); },
  };
}

/** Load MCP server config from a JSON file (same format as Claude Code's mcpServers). */
export function loadMcpConfig(configPath: string): Record<string, McpConfigEntry> {
  if (!fs.existsSync(configPath)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    // Support both { mcpServers: {...} } and direct { serverName: {...} } formats
    const servers = raw.mcpServers ?? raw;
    const result: Record<string, McpConfigEntry> = {};
    for (const [name, entry] of Object.entries(servers)) {
      const e = entry as Record<string, unknown>;
      if (e.command && typeof e.command === "string") {
        result[name] = {
          command: e.command,
          args: Array.isArray(e.args) ? e.args : undefined,
          env: typeof e.env === "object" && e.env !== null ? e.env as Record<string, string> : undefined,
        };
      }
    }
    return result;
  } catch {
    return {};
  }
}

/** Parse --mcp "command args..." into an McpConfigEntry. */
export function parseMcpInline(spec: string): McpConfigEntry {
  const parts = spec.split(/\s+/);
  return { command: parts[0], args: parts.slice(1) };
}

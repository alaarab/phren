/**
 * MCP client — connects to MCP servers, discovers tools, wraps them as AgentTools.
 * Supports stdio, streamable HTTP, and legacy HTTP+SSE transports.
 */

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { type ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as readline from "readline";
import { type McpOAuthOptions, McpOAuthProvider } from "./mcp-oauth.js";
import { VERSION } from "./package-metadata.js";
import { scrubEnv } from "./permissions/shell-safety.js";
import type { AgentTool, AgentToolResult } from "./tools/types.js";

/** JSON-RPC 2.0 message types for MCP protocol. */
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcIncoming = JsonRpcResponse | JsonRpcNotification;

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
}

interface McpToolResult {
  content?: McpContentBlock[];
  isError?: boolean;
}

interface McpResourceDef {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

interface McpResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

interface McpPromptDef {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

interface McpPromptResult {
  description?: string;
  messages?: Array<{ role: string; content: McpContentBlock | McpContentBlock[] }>;
}

export interface McpConfigEntry {
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  oauth?: boolean | McpOAuthOptions;
}

interface McpTransport {
  post(message: Record<string, unknown>, signal?: AbortSignal, expectedId?: number): Promise<void>;
  close(): void;
}

const STDERR_BUFFER_LINES = 200;
const REQUEST_TIMEOUT_MS = 30_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseServerType(value: unknown): "stdio" | "http" | "sse" | undefined {
  if (value === "stdio" || value === "http" || value === "sse") return value;
  return undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

class StdioTransport implements McpTransport {
  private proc: ChildProcess;
  private rl: readline.Interface | undefined;
  private stderrRl: readline.Interface | undefined;
  private stderrLines: string[] = [];
  private closed = false;

  constructor(
    config: McpConfigEntry,
    onMessage: (msg: JsonRpcIncoming) => void,
    onError: (err: Error) => void,
  ) {
    const env = { ...scrubEnv(), ...config.env };
    this.proc = spawn(config.command!, config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    if (this.proc.stdout) {
      this.rl = readline.createInterface({ input: this.proc.stdout });
      this.rl.on("line", (line) => {
        try {
          onMessage(JSON.parse(line) as JsonRpcIncoming);
        } catch {
          /* ignore non-JSON lines */
        }
      });
    }

    if (this.proc.stderr) {
      this.stderrRl = readline.createInterface({ input: this.proc.stderr });
      this.stderrRl.on("line", (line) => {
        this.stderrLines.push(line);
        if (this.stderrLines.length > STDERR_BUFFER_LINES) this.stderrLines.shift();
      });
    }

    this.proc.on("error", (err) => {
      if (!this.closed) onError(err);
    });
    this.proc.on("exit", (code, signal) => {
      if (!this.closed) {
        onError(new Error(`MCP server exited (code ${code ?? "null"}, signal ${signal ?? "none"})`));
      }
    });
  }

  async post(message: Record<string, unknown>): Promise<void> {
    if (this.closed) throw new Error("MCP connection closed");
    const stdin = this.proc.stdin;
    if (!stdin || stdin.destroyed) throw new Error("MCP server stdin unavailable");
    await new Promise<void>((resolve, reject) => {
      try {
        stdin.write(JSON.stringify(message) + "\n", (err) => (err ? reject(err) : resolve()));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  getStderr(): string[] {
    return this.stderrLines;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.proc.stdin?.end();
    } catch {
      /* ignore */
    }
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
    this.rl?.close();
    this.stderrRl?.close();
  }
}

class RemoteTransport implements McpTransport {
  private transport: StreamableHTTPClientTransport | SSEClientTransport;
  private oauth?: McpOAuthProvider;
  private ready: Promise<void>;
  private closed = false;
  private accepted = new Set<number>();

  constructor(config: McpConfigEntry, onMessage: (msg: JsonRpcIncoming) => void, onError: (err: Error) => void) {
    const url = new URL(config.url!);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid MCP server URL");
    if (config.oauth) {
      if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("MCP OAuth requires HTTPS except on loopback");
      this.oauth = new McpOAuthProvider(url.href, typeof config.oauth === "object" ? config.oauth : {});
    }
    const options = { authProvider: this.oauth, requestInit: { headers: config.headers },
      fetch: async (input: string | URL, init?: RequestInit) => {
        const response = await fetch(input, { ...init, redirect: "error" });
        if (response.status === 202 && init?.method === "POST" && typeof init.body === "string") {
          const message = JSON.parse(init.body);
          if (typeof message.id === "number") this.accepted.add(message.id);
        }
        return response;
      } };
    this.transport = config.type === "sse" ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options);
    this.transport.onmessage = message => onMessage(message as JsonRpcIncoming);
    this.transport.onerror = error => { if (!(error instanceof UnauthorizedError) && !this.closed) onError(error); };
    this.transport.onclose = () => { if (!this.closed) onError(new Error("MCP stream closed")); };
    this.ready = this.withAuth(() => this.transport.start());
    this.ready.catch(() => {});
  }

  private async withAuth(operation: () => Promise<void>): Promise<void> {
    try { await operation(); }
    catch (error) {
      if (!(error instanceof UnauthorizedError) || !this.oauth || this.closed) throw error;
      const code = await this.oauth.authorizationCode();
      if (this.closed) throw new Error("MCP connection closed");
      await this.transport.finishAuth(code);
      await operation();
    }
  }

  async post(message: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    await this.ready;
    if (this.closed || signal?.aborted) throw new Error("MCP call aborted");
    await this.withAuth(() => this.transport.send(message as JSONRPCMessage));
    if (typeof message.id === "number" && this.accepted.delete(message.id) && message.method === "initialize"
        && this.transport instanceof StreamableHTTPClientTransport) {
      // Some older servers accept initialization itself and answer on GET SSE.
      await this.transport.resumeStream("");
    }
  }
  setProtocolVersion(version: string): void { this.transport.setProtocolVersion?.(version); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.oauth?.close();
    void this.transport.close().catch(() => {});
  }
}

/** Active MCP server connection. */
class McpConnection {
  readonly name: string;
  private readonly transport: McpTransport;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private tools: McpToolDef[] = [];
  private notificationHandlers = new Set<(method: string, params?: Record<string, unknown>) => void>();
  private closed = false;

  constructor(name: string, config: McpConfigEntry) {
    this.name = name;
    const onMessage = (msg: JsonRpcIncoming) => this.handleMessage(msg);
    const onError = (err: Error) => this.failAll(err);
    const type = config.type ?? (config.url ? "http" : "stdio");

    if (type === "http" || type === "sse") {
      if (!config.url) throw new Error(`MCP server "${name}" has type ${type} but no url`);
      this.transport = new RemoteTransport({ ...config, type }, onMessage, onError);
    } else {
      if (!config.command) throw new Error(`MCP server "${name}" has type stdio but no command`);
      this.transport = new StdioTransport(config, onMessage, onError);
    }
  }

  private handleMessage(msg: JsonRpcIncoming): void {
    if ("id" in msg && msg.id !== undefined && msg.id !== null) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if ("error" in msg && msg.error) pending.reject(new Error(`MCP error: ${msg.error.message}`));
      else pending.resolve((msg as JsonRpcResponse).result);
      return;
    }
    const method = (msg as JsonRpcNotification).method;
    if (!method) return;
    if (method === "notifications/tools/list_changed") {
      void this.refreshTools();
    }
    for (const handler of this.notificationHandlers) {
      handler(method, (msg as JsonRpcNotification).params);
    }
  }

  private failAll(err: Error): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  private send(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("MCP connection closed"));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`MCP call ${method} timed out`));
      }, method === "initialize" ? 330_000 : REQUEST_TIMEOUT_MS);
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`MCP call ${method} aborted`));
      };
      if (signal) {
        if (signal.aborted) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`MCP call ${method} aborted`));
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.set(id, {
        resolve: (value) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (err) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
        timer,
      });
      this.transport
        .post({ jsonrpc: "2.0", id, method, params }, signal, id)
        .catch((err: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.pending.delete(id);
          signal?.removeEventListener("abort", onAbort);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  private async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (this.closed) return;
    await this.transport.post({ jsonrpc: "2.0", method, params });
  }

  async initialize(): Promise<void> {
    const result = await this.send("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "phren-agent", version: VERSION },
    });
    if (this.transport instanceof RemoteTransport && isPlainObject(result) && typeof result.protocolVersion === "string") this.transport.setProtocolVersion(result.protocolVersion);
    await this.notify("notifications/initialized");
  }

  async listTools(): Promise<McpToolDef[]> {
    const result = (await this.send("tools/list")) as { tools?: McpToolDef[] };
    this.tools = result?.tools ?? [];
    return this.tools;
  }

  async refreshTools(): Promise<void> {
    try {
      const result = (await this.send("tools/list")) as { tools?: McpToolDef[] };
      this.tools = result?.tools ?? [];
    } catch {
      return;
    }
  }

  getTools(): McpToolDef[] {
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    return (await this.send("tools/call", { name, arguments: args }, signal)) as McpToolResult;
  }

  async listResources(): Promise<McpResourceDef[]> {
    const result = (await this.send("resources/list")) as { resources?: McpResourceDef[] };
    return result?.resources ?? [];
  }

  async readResource(uri: string): Promise<McpResourceContents[]> {
    const result = (await this.send("resources/read", { uri })) as { contents?: McpResourceContents[] };
    return result?.contents ?? [];
  }

  async listPrompts(): Promise<McpPromptDef[]> {
    const result = (await this.send("prompts/list")) as { prompts?: McpPromptDef[] };
    return result?.prompts ?? [];
  }

  async getPrompt(name: string, args?: Record<string, unknown>): Promise<McpPromptResult> {
    return (await this.send("prompts/get", { name, arguments: args })) as McpPromptResult;
  }

  onNotification(handler: (method: string, params?: Record<string, unknown>) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  getStderr(): string[] {
    return this.transport instanceof StdioTransport ? this.transport.getStderr() : [];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.transport.close();
    this.failAll(new Error("Connection closed"));
  }
}

function normalizeInputSchema(schema?: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  return schema;
}

function formatToolResult(result: McpToolResult): string {
  const content = result?.content;
  if (!content || content.length === 0) return result?.isError ? "MCP tool reported an error" : "OK";
  return content
    .map((block) => {
      if (typeof block.text === "string") return block.text;
      if (block.type === "image" && block.data) return `[image ${block.mimeType ?? "image"}]`;
      if (block.type === "resource" && block.uri) return `[resource ${block.uri}]`;
      return JSON.stringify(block);
    })
    .join("\n");
}

/** Wrap an MCP tool as an AgentTool. */
function wrapMcpTool(conn: McpConnection, def: McpToolDef): AgentTool {
  return {
    name: `mcp_${conn.name}_${def.name}`,
    description: `[${conn.name}] ${def.description ?? def.name}`,
    input_schema: normalizeInputSchema(def.inputSchema),
    async execute(input: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult> {
      try {
        const result = await conn.callTool(def.name, input, signal);
        const text = formatToolResult(result);
        return result?.isError ? { output: text, is_error: true } : { output: text };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `MCP error: ${msg}`, is_error: true };
      }
    },
  };
}

export interface McpResourceListing extends McpResourceDef {
  server: string;
}

export interface McpPromptListing extends McpPromptDef {
  server: string;
}

const mcpConnections = new Map<string, McpConnection>();

export const mcpRegistry = {
  listServers(): string[] {
    return [...mcpConnections.keys()];
  },
  getConnection(name: string): McpConnection | undefined {
    return mcpConnections.get(name);
  },
  async listResources(server?: string): Promise<McpResourceListing[]> {
    const names = server ? [server] : [...mcpConnections.keys()];
    const out: McpResourceListing[] = [];
    for (const name of names) {
      const conn = mcpConnections.get(name);
      if (!conn) continue;
      const resources = await conn.listResources();
      for (const resource of resources) out.push({ server: name, ...resource });
    }
    return out;
  },
  async readResource(server: string, uri: string): Promise<McpResourceContents[]> {
    const conn = mcpConnections.get(server);
    if (!conn) throw new Error(`MCP server not connected: ${server}`);
    return conn.readResource(uri);
  },
  async listPrompts(server?: string): Promise<McpPromptListing[]> {
    const names = server ? [server] : [...mcpConnections.keys()];
    const out: McpPromptListing[] = [];
    for (const name of names) {
      const conn = mcpConnections.get(name);
      if (!conn) continue;
      const prompts = await conn.listPrompts();
      for (const prompt of prompts) out.push({ server: name, ...prompt });
    }
    return out;
  },
  async getPrompt(server: string, name: string, args?: Record<string, unknown>): Promise<McpPromptResult> {
    const conn = mcpConnections.get(server);
    if (!conn) throw new Error(`MCP server not connected: ${server}`);
    return conn.getPrompt(name, args);
  },
};

/** Connect to MCP servers and return their tools as AgentTools. */
export async function connectMcpServers(
  servers: Record<string, McpConfigEntry>,
  verbose = false,
): Promise<{ tools: AgentTool[]; cleanup: () => void }> {
  const connections: McpConnection[] = [];
  const tools: AgentTool[] = [];

  for (const [name, config] of Object.entries(servers)) {
    let conn: McpConnection | undefined;
    try {
      if (verbose) process.stderr.write(`Connecting to MCP server: ${name}...\n`);
      conn = new McpConnection(name, config);
      await conn.initialize();
      const mcpTools = await conn.listTools();

      for (const def of mcpTools) {
        tools.push(wrapMcpTool(conn, def));
      }

      connections.push(conn);
      mcpConnections.set(name, conn);
      if (verbose) process.stderr.write(`  ${name}: ${mcpTools.length} tools\n`);
    } catch (err: unknown) {
      conn?.close();
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Failed to connect to MCP server "${name}": ${msg}\n`);
    }
  }

  return {
    tools,
    cleanup: () => {
      for (const conn of connections) {
        conn.close();
        mcpConnections.delete(conn.name);
      }
    },
  };
}

/** Load MCP server config from a JSON file (same format as Claude Code's mcpServers). */
export function loadMcpConfig(configPath: string): Record<string, McpConfigEntry> {
  if (!fs.existsSync(configPath)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const servers = raw.mcpServers ?? raw;
    if (!isPlainObject(servers)) return {};
    const result: Record<string, McpConfigEntry> = {};
    for (const [name, entry] of Object.entries(servers)) {
      if (!isPlainObject(entry)) continue;
      const explicitType = parseServerType(entry.type);
      const url = typeof entry.url === "string" ? entry.url : undefined;
      const command = typeof entry.command === "string" ? entry.command : undefined;
      const args = Array.isArray(entry.args) ? entry.args.map(String) : undefined;
      const env = asStringRecord(entry.env);
      const headers = asStringRecord(entry.headers);

      const type = explicitType ?? (command ? "stdio" : url ? "http" : undefined);
      if (type === "stdio") {
        if (!command) continue;
        result[name] = { command, args, env };
      } else if (type === "http" || type === "sse") {
        if (!url) continue;
        const oauth = entry.oauth === true ? true : isPlainObject(entry.oauth) ? {
          clientId: typeof entry.oauth.clientId === "string" ? entry.oauth.clientId : undefined,
          clientSecret: typeof entry.oauth.clientSecret === "string" ? entry.oauth.clientSecret : undefined,
          scope: typeof entry.oauth.scope === "string" ? entry.oauth.scope : undefined,
          callbackPort: typeof entry.oauth.callbackPort === "number" ? entry.oauth.callbackPort : undefined,
        } : undefined;
        result[name] = { type, url, headers, ...(oauth ? { oauth } : {}) };
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

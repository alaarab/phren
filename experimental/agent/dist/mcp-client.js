/**
 * MCP client — connects to MCP servers, discovers tools, wraps them as AgentTools.
 * Uses stdio transport (spawns server as child process).
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as readline from "readline";
import { VERSION } from "./package-metadata.js";
import { scrubEnv } from "./permissions/shell-safety.js";
/** Active MCP server connection. */
class McpConnection {
    proc;
    nextId = 1;
    pending = new Map();
    rl;
    name;
    constructor(name, config) {
        this.name = name;
        const env = { ...scrubEnv(), ...config.env };
        this.proc = spawn(config.command, config.args ?? [], {
            stdio: ["pipe", "pipe", "pipe"],
            env,
        });
        this.rl = readline.createInterface({ input: this.proc.stdout });
        this.rl.on("line", (line) => {
            try {
                const msg = JSON.parse(line);
                if (msg.id !== undefined && this.pending.has(msg.id)) {
                    const { resolve, reject, timer } = this.pending.get(msg.id);
                    clearTimeout(timer);
                    this.pending.delete(msg.id);
                    if (msg.error)
                        reject(new Error(`MCP error: ${msg.error.message}`));
                    else
                        resolve(msg.result);
                }
            }
            catch { /* ignore non-JSON lines */ }
        });
        this.proc.on("error", (err) => {
            for (const { reject, timer } of this.pending.values()) {
                clearTimeout(timer);
                reject(err);
            }
            this.pending.clear();
        });
    }
    send(method, params) {
        return new Promise((resolve, reject) => {
            const id = this.nextId++;
            const msg = { jsonrpc: "2.0", id, method, params };
            const timer = setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`MCP call ${method} timed out (30s)`));
                }
            }, 30_000);
            this.pending.set(id, { resolve, reject, timer });
            this.proc.stdin.write(JSON.stringify(msg) + "\n");
        });
    }
    async initialize() {
        await this.send("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "phren-agent", version: VERSION },
        });
        // Send initialized notification (no id)
        this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    }
    async listTools() {
        const result = await this.send("tools/list");
        return result?.tools ?? [];
    }
    async callTool(name, args) {
        return await this.send("tools/call", { name, arguments: args });
    }
    close() {
        try {
            this.proc.stdin.end();
        }
        catch { /* ignore */ }
        try {
            this.proc.kill();
        }
        catch { /* ignore */ }
        this.rl.close();
        for (const { reject, timer } of this.pending.values()) {
            clearTimeout(timer);
            reject(new Error("Connection closed"));
        }
        this.pending.clear();
    }
}
/** Wrap an MCP tool as an AgentTool. */
function wrapMcpTool(conn, def) {
    return {
        name: `mcp_${conn.name}_${def.name}`,
        description: `[${conn.name}] ${def.description ?? def.name}`,
        input_schema: def.inputSchema ?? { type: "object", properties: {} },
        async execute(input) {
            try {
                const result = await conn.callTool(def.name, input);
                const text = result.content
                    ?.map((c) => c.text ?? JSON.stringify(c))
                    .join("\n") ?? "OK";
                return { output: text };
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { output: `MCP error: ${msg}`, is_error: true };
            }
        },
    };
}
/** Connect to MCP servers and return their tools as AgentTools. */
export async function connectMcpServers(servers, verbose = false) {
    const connections = [];
    const tools = [];
    for (const [name, config] of Object.entries(servers)) {
        try {
            if (verbose)
                process.stderr.write(`Connecting to MCP server: ${name}...\n`);
            const conn = new McpConnection(name, config);
            await conn.initialize();
            const mcpTools = await conn.listTools();
            for (const def of mcpTools) {
                tools.push(wrapMcpTool(conn, def));
            }
            connections.push(conn);
            if (verbose)
                process.stderr.write(`  ${name}: ${mcpTools.length} tools\n`);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`Failed to connect to MCP server "${name}": ${msg}\n`);
        }
    }
    return {
        tools,
        cleanup: () => { for (const conn of connections)
            conn.close(); },
    };
}
/** Load MCP server config from a JSON file (same format as Claude Code's mcpServers). */
export function loadMcpConfig(configPath) {
    if (!fs.existsSync(configPath))
        return {};
    try {
        const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        // Support both { mcpServers: {...} } and direct { serverName: {...} } formats
        const servers = raw.mcpServers ?? raw;
        const result = {};
        for (const [name, entry] of Object.entries(servers)) {
            const e = entry;
            if (e.command && typeof e.command === "string") {
                result[name] = {
                    command: e.command,
                    args: Array.isArray(e.args) ? e.args : undefined,
                    env: typeof e.env === "object" && e.env !== null ? e.env : undefined,
                };
            }
        }
        return result;
    }
    catch {
        return {};
    }
}
/** Parse --mcp "command args..." into an McpConfigEntry. */
export function parseMcpInline(spec) {
    const parts = spec.split(/\s+/);
    return { command: parts[0], args: parts.slice(1) };
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CortexClient = void 0;
const child_process_1 = require("child_process");
const DEFAULT_TIMEOUT_MS = 15000;
class CortexClient {
    constructor(options) {
        this.pending = new Map();
        this.buffer = Buffer.alloc(0);
        this.nextId = 1;
        this.disposed = false;
        this.initialized = false;
        this.options = options;
        this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.process = (0, child_process_1.spawn)(options.nodePath ?? process.execPath, [options.mcpServerPath, options.storePath], {
            stdio: "pipe",
        });
        this.process.stdout.on("data", (chunk) => {
            this.handleStdoutData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
        });
        this.process.stderr.on("data", (chunk) => {
            const message = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
            console.error(`[cortex-mcp] ${message.trim()}`);
        });
        this.process.on("exit", (code, signal) => {
            if (this.disposed) {
                return;
            }
            this.rejectPending(new Error(`cortex MCP process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`));
        });
        this.process.on("error", (error) => {
            this.rejectPending(error);
        });
    }
    async searchKnowledge(query) {
        return this.callTool("search_knowledge", { query });
    }
    async getMemoryDetail(id) {
        return this.callTool("get_memory_detail", { id });
    }
    async getFindings(project) {
        return this.callTool("get_findings", { project });
    }
    async getTasks(project) {
        return this.callTool("get_tasks", { project });
    }
    async addFinding(project, insight) {
        return this.callTool("add_finding", { project, finding: insight });
    }
    async listProjects() {
        return this.callTool("list_projects", {});
    }
    async getProjectSummary(project) {
        return this.callTool("get_project_summary", { name: project });
    }
    async listSkills() {
        return this.callTool("list_skills", {});
    }
    async readSkill(name, project) {
        return this.callTool("read_skill", project ? { name, project } : { name });
    }
    async writeSkill(name, content, scope) {
        return this.callTool("write_skill", { name, content, scope });
    }
    async enableSkill(name, project) {
        return this.callTool("enable_skill", project ? { name, project } : { name });
    }
    async disableSkill(name, project) {
        return this.callTool("disable_skill", project ? { name, project } : { name });
    }
    async listHooks() {
        return this.callTool("list_hooks", {});
    }
    async toggleHooks(enabled, tool) {
        return this.callTool("toggle_hooks", tool ? { enabled, tool } : { enabled });
    }
    async memoryFeedback(key, feedback) {
        return this.callTool("memory_feedback", { key, feedback });
    }
    async updateTask(project, item, updates) {
        return this.callTool("update_task", { project, item, updates });
    }
    async completeTask(project, item) {
        return this.callTool("complete_task", { project, item });
    }
    async removeFinding(project, text) {
        return this.callTool("remove_finding", { project, finding: text });
    }
    async dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.rejectPending(new Error("Cortex client disposed."));
        if (!this.process.killed) {
            this.process.kill();
        }
    }
    async callTool(toolName, args) {
        await this.ensureInitialized();
        const result = await this.sendRequest("tools/call", {
            name: toolName,
            arguments: args,
        });
        return this.parseToolCallResult(result);
    }
    async ensureInitialized() {
        if (this.initialized) {
            return;
        }
        if (!this.initializePromise) {
            this.initializePromise = this.initialize();
        }
        await this.initializePromise;
    }
    async initialize() {
        const versionsToTry = ["2025-06-18", "2025-03-26", "2024-11-05"];
        let lastError;
        for (const protocolVersion of versionsToTry) {
            try {
                await this.sendRequest("initialize", {
                    protocolVersion,
                    capabilities: {},
                    clientInfo: {
                        name: "cortex-vscode",
                        version: this.options.clientVersion ?? "0.0.0",
                    },
                });
                this.sendNotification("notifications/initialized", {});
                this.initialized = true;
                return;
            }
            catch (error) {
                lastError = error;
            }
        }
        throw new Error(`Failed to initialize MCP session with ${this.options.mcpServerPath}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    }
    sendNotification(method, params) {
        if (this.disposed) {
            return;
        }
        const message = JSON.stringify({
            jsonrpc: "2.0",
            method,
            ...(params ? { params } : {}),
        });
        this.process.stdin.write(message + "\n", "utf8");
    }
    async sendRequest(method, params) {
        if (this.disposed) {
            throw new Error("Cortex client has been disposed.");
        }
        const id = this.nextId++;
        const message = JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            params,
        });
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP request timed out: ${method}`));
            }, this.timeoutMs);
            this.pending.set(id, {
                resolve: resolve,
                reject,
                timeout,
            });
            this.process.stdin.write(message + "\n", "utf8", (error) => {
                if (!error) {
                    return;
                }
                const pending = this.pending.get(id);
                if (!pending) {
                    return;
                }
                clearTimeout(pending.timeout);
                this.pending.delete(id);
                reject(error);
            });
        });
    }
    handleStdoutData(chunk) {
        if (this.disposed) {
            return;
        }
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (true) {
            const newlineIndex = this.buffer.indexOf(0x0a); // \n
            if (newlineIndex === -1) {
                return;
            }
            const line = this.buffer.subarray(0, newlineIndex).toString("utf8").replace(/\r$/, "");
            this.buffer = this.buffer.subarray(newlineIndex + 1);
            if (line.length === 0) {
                continue;
            }
            try {
                const message = JSON.parse(line);
                this.handleMessage(message);
            }
            catch (error) {
                console.error(`[cortex-mcp] Failed to parse JSON-RPC line: ${String(error)}`);
            }
        }
    }
    handleMessage(message) {
        if (typeof message !== "object" || message === null || !("id" in message)) {
            return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) {
            return;
        }
        clearTimeout(pending.timeout);
        this.pending.delete(message.id);
        if ("error" in message) {
            pending.reject(new Error(message.error.message));
            return;
        }
        pending.resolve(message.result);
    }
    parseToolCallResult(result) {
        const content = Array.isArray(result.content) ? result.content : [];
        const textBlock = content.find((item) => item.type === "text" && typeof item.text === "string");
        if (!textBlock?.text) {
            return result;
        }
        try {
            return this.unwrapToolResponse(JSON.parse(textBlock.text));
        }
        catch {
            return textBlock.text;
        }
    }
    unwrapToolResponse(value) {
        const response = asRecord(value);
        if (response?.ok === false) {
            throw new Error(response.error ?? response.message ?? "Cortex tool call failed.");
        }
        return value;
    }
    rejectPending(error) {
        for (const [, pending] of this.pending) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pending.clear();
    }
}
exports.CortexClient = CortexClient;
function asRecord(value) {
    return typeof value === "object" && value !== null ? value : undefined;
}
//# sourceMappingURL=cortexClient.js.map
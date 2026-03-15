"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PhrenClient = void 0;
const child_process_1 = require("child_process");
const DEFAULT_TIMEOUT_MS = 15000;
class PhrenClient {
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
            console.error(`[phren-mcp] ${message.trim()}`);
        });
        this.process.on("exit", (code, signal) => {
            if (this.disposed) {
                return;
            }
            this.rejectPending(new Error(`phren MCP process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`));
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
    async getTasks(project, options = {}) {
        return this.callTool("get_tasks", { project, ...options });
    }
    async sessionHistory(options = {}) {
        return this.callTool("session_history", { ...options });
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
    async listHooks(project) {
        return this.callTool("list_hooks", project ? { project } : {});
    }
    async toggleHooks(enabled, tool, project, event) {
        const args = { enabled };
        if (tool)
            args.tool = tool;
        if (project)
            args.project = project;
        if (event)
            args.event = event;
        return this.callTool("toggle_hooks", args);
    }
    async addCustomHook(event, command, timeout) {
        const args = { event, command };
        if (timeout !== undefined)
            args.timeout = timeout;
        return this.callTool("add_custom_hook", args);
    }
    async removeCustomHook(event, command) {
        const args = { event };
        if (command)
            args.command = command;
        return this.callTool("remove_custom_hook", args);
    }
    async listHookErrors() {
        return this.callTool("list_hook_errors", {});
    }
    async memoryFeedback(key, feedback) {
        return this.callTool("memory_feedback", { key, feedback });
    }
    async updateTask(project, item, updates) {
        return this.callTool("update_task", { project, item, updates });
    }
    async addTask(project, item) {
        return this.callTool("add_task", { project, item });
    }
    async completeTask(project, item) {
        return this.callTool("complete_task", { project, item });
    }
    async removeTask(project, item) {
        return this.callTool("remove_task", { project, item });
    }
    async pinTask(project, item) {
        return this.callTool("pin_task", { project, item });
    }
    async pinMemory(project, memory) {
        return this.callTool("pin_memory", { project, memory });
    }
    async editFinding(project, oldText, newText) {
        return this.callTool("edit_finding", { project, old_text: oldText, new_text: newText });
    }
    async removeFinding(project, text) {
        return this.callTool("remove_finding", { project, finding: text });
    }
    async getReviewQueue(project) {
        return this.callTool("get_review_queue", project ? { project } : {});
    }
    async searchFragments(query, project) {
        const args = { query };
        if (project)
            args.project = project;
        return this.callTool("search_fragments", args);
    }
    async getRelatedDocs(entity, project) {
        const args = { entity };
        if (project)
            args.project = project;
        return this.callTool("get_related_docs", args);
    }
    async readGraph(project) {
        const args = {};
        if (project)
            args.project = project;
        return this.callTool("read_graph", args);
    }
    async crossProjectFragments() {
        return this.callTool("cross_project_fragments", {});
    }
    async pushChanges(message) {
        const args = {};
        if (message)
            args.message = message;
        return this.callTool("push_changes", args);
    }
    async manageProject(project, action) {
        return this.callTool("manage_project", { project, action });
    }
    async healthCheck() {
        return this.callTool("health_check", {});
    }
    async doctorFix() {
        return this.callTool("doctor_fix", {});
    }
    async sessionStart(project) {
        const args = {};
        if (project)
            args.project = project;
        return this.callTool("session_start", args);
    }
    async sessionEnd(summary) {
        const args = {};
        if (summary)
            args.summary = summary;
        return this.callTool("session_end", args);
    }
    async supersedeFinding(project, finding_text, superseded_by) {
        return this.callTool("supersede_finding", { project, finding_text, superseded_by });
    }
    async retractFinding(project, finding_text, reason) {
        return this.callTool("retract_finding", { project, finding_text, reason });
    }
    async resolveContradiction(project, finding_text, finding_text_other, resolution) {
        return this.callTool("resolve_contradiction", { project, finding_text, finding_text_other, resolution });
    }
    async linkTaskIssue(project, item, issue_number, issue_url, unlink) {
        const args = { project, item };
        if (issue_number !== undefined)
            args.issue_number = issue_number;
        if (issue_url)
            args.issue_url = issue_url;
        if (unlink)
            args.unlink = unlink;
        return this.callTool("link_task_issue", args);
    }
    async promoteTaskToIssue(project, item, repo, title, body, mark_done) {
        const args = { project, item };
        if (repo)
            args.repo = repo;
        if (title)
            args.title = title;
        if (body)
            args.body = body;
        if (mark_done !== undefined)
            args.mark_done = mark_done;
        return this.callTool("promote_task_to_issue", args);
    }
    async dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.rejectPending(new Error("Phren client disposed."));
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
                        name: "phren-vscode",
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
            throw new Error("Phren client has been disposed.");
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
                console.error(`[phren-mcp] Failed to parse JSON-RPC line: ${String(error)}`);
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
            throw new Error(response.error ?? response.message ?? "Phren tool call failed.");
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
exports.PhrenClient = PhrenClient;
function asRecord(value) {
    return typeof value === "object" && value !== null ? value : undefined;
}
//# sourceMappingURL=phrenClient.js.map
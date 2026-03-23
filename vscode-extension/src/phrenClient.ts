import { spawn, type ChildProcessWithoutNullStreams } from "child_process";

interface JsonRpcSuccess<T> {
  jsonrpc: "2.0";
  id: number;
  result: T;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number;
  error: JsonRpcError;
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcFailure;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
}

interface McpTextContent {
  type: string;
  text?: string;
}

interface McpToolCallResult {
  content?: McpTextContent[];
  [key: string]: unknown;
}

interface PhrenToolResponse {
  ok?: boolean;
  error?: string;
  message?: string;
  data?: unknown;
  [key: string]: unknown;
}

export interface PhrenClientOptions {
  mcpServerPath: string;
  storePath: string;
  nodePath?: string;
  clientVersion?: string;
  requestTimeoutMs?: number;
}

export interface GetTasksOptions {
  status?: "all" | "active" | "queue" | "done" | "active+queue";
  limit?: number;
  done_limit?: number;
}

export interface SessionHistoryOptions {
  limit?: number;
  sessionId?: string;
  project?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class PhrenClient {
  private readonly options: PhrenClientOptions;
  private process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly timeoutMs: number;

  private static readonly MAX_RECONNECT_RETRIES = 3;
  private static readonly RECONNECT_DELAY_MS = 2000;

  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private disposed = false;
  private initialized = false;
  private initializePromise?: Promise<void>;
  private reconnectRetries = 0;
  private reconnecting = false;
  private reconnectPromise?: Promise<void>;

  constructor(options: PhrenClientOptions) {
    this.options = options;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    this.process = this.spawnProcess();
  }

  private spawnProcess(): ChildProcessWithoutNullStreams {
    const child = spawn(this.options.nodePath ?? process.execPath, [this.options.mcpServerPath, this.options.storePath], {
      stdio: "pipe",
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      this.handleStdoutData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const message = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      console.error(`[phren-mcp] ${message.trim()}`);
    });

    child.on("exit", (code, signal) => {
      if (this.disposed) {
        return;
      }
      const exitError = new Error(`phren MCP process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
      this.rejectPending(exitError);
      this.scheduleReconnect();
    });

    child.on("error", (error: Error) => {
      this.rejectPending(error);
    });

    return child;
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnecting) {
      return;
    }
    if (this.reconnectRetries >= PhrenClient.MAX_RECONNECT_RETRIES) {
      console.error(`[phren-mcp] All ${PhrenClient.MAX_RECONNECT_RETRIES} reconnect retries exhausted.`);
      return;
    }
    this.reconnecting = true;
    this.reconnectRetries++;
    const attempt = this.reconnectRetries;
    console.error(`[phren-mcp] Scheduling reconnect attempt ${attempt}/${PhrenClient.MAX_RECONNECT_RETRIES} in ${PhrenClient.RECONNECT_DELAY_MS}ms...`);

    this.reconnectPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (this.disposed) {
          resolve();
          return;
        }
        try {
          this.buffer = Buffer.alloc(0);
          this.initialized = false;
          this.initializePromise = undefined;
          this.process = this.spawnProcess();
          this.reconnecting = false;
          console.error(`[phren-mcp] Reconnect attempt ${attempt} spawned successfully.`);
          resolve();
        } catch (error) {
          this.reconnecting = false;
          console.error(`[phren-mcp] Reconnect attempt ${attempt} failed to spawn: ${String(error)}`);
          resolve();
        }
      }, PhrenClient.RECONNECT_DELAY_MS);
    });
  }

  async searchKnowledge(query: string): Promise<unknown> {
    return this.callTool("search_knowledge", { query });
  }

  async getMemoryDetail(id: string): Promise<unknown> {
    return this.callTool("get_memory_detail", { id });
  }

  async getFindings(project: string): Promise<unknown> {
    return this.callTool("get_findings", { project });
  }

  async getTasks(project: string, options: GetTasksOptions = {}): Promise<unknown> {
    return this.callTool("get_tasks", { project, ...options });
  }

  async sessionHistory(options: SessionHistoryOptions = {}): Promise<unknown> {
    return this.callTool("session_history", { ...options });
  }

  async addFinding(project: string, insight: string): Promise<unknown> {
    return this.callTool("add_finding", { project, finding: insight });
  }

  async listProjects(): Promise<unknown> {
    return this.callTool("list_projects", {});
  }

  async getProjectSummary(project: string): Promise<unknown> {
    return this.callTool("get_project_summary", { name: project });
  }

  async getTopicConfig(project: string): Promise<unknown> {
    return this.callTool("get_config", { domain: "topic", project });
  }

  async listSkills(): Promise<unknown> {
    return this.callTool("list_skills", {});
  }

  async readSkill(name: string, project?: string): Promise<unknown> {
    return this.callTool("read_skill", project ? { name, project } : { name });
  }

  async writeSkill(name: string, content: string, scope: string): Promise<unknown> {
    return this.callTool("write_skill", { name, content, scope });
  }

  async toggleSkill(name: string, enabled: boolean, project?: string): Promise<unknown> {
    return this.callTool("toggle_skill", project ? { name, enabled, project } : { name, enabled });
  }

  async listHooks(project?: string): Promise<unknown> {
    return this.callTool("list_hooks", project ? { project } : {});
  }

  async toggleHooks(enabled: boolean, tool?: string, project?: string, event?: string): Promise<unknown> {
    const args: Record<string, unknown> = { enabled };
    if (tool) args.tool = tool;
    if (project) args.project = project;
    if (event) args.event = event;
    return this.callTool("toggle_hooks", args);
  }

  async listHookErrors(): Promise<unknown> {
    return this.callTool("list_hook_errors", {});
  }

  async updateTask(project: string, item: string, updates: Record<string, unknown>): Promise<unknown> {
    return this.callTool("update_task", { project, item, updates });
  }

  async addTask(project: string, item: string): Promise<unknown> {
    return this.callTool("add_task", { project, item });
  }

  async completeTask(project: string, item: string): Promise<unknown> {
    return this.callTool("complete_task", { project, item });
  }

  async removeTask(project: string, item: string): Promise<unknown> {
    return this.callTool("remove_task", { project, item });
  }

  async pinTask(project: string, item: string): Promise<unknown> {
    return this.callTool("update_task", { project, item, updates: { pin: true } });
  }

  async promoteTaskToIssue(project: string, item: string): Promise<unknown> {
    return this.callTool("update_task", { project, item, updates: { create_issue: true } });
  }

  async pinMemory(project: string, memory: string): Promise<unknown> {
    return this.callTool("pin_memory", { project, memory });
  }

  async editFinding(project: string, oldText: string, newText: string): Promise<unknown> {
    return this.callTool("edit_finding", { project, old_text: oldText, new_text: newText });
  }

  async removeFinding(project: string, text: string): Promise<unknown> {
    return this.callTool("remove_finding", { project, finding: text });
  }

  async getReviewQueue(project?: string): Promise<unknown> {
    return this.callTool("get_review_queue", project ? { project } : {});
  }

  async readGraph(project?: string): Promise<unknown> {
    const args: Record<string, unknown> = {};
    if (project) args.project = project;
    return this.callTool("read_graph", args);
  }

  async pushChanges(message?: string): Promise<unknown> {
    const args: Record<string, unknown> = {};
    if (message) args.message = message;
    return this.callTool("push_changes", args);
  }

  async manageProject(project: string, action: "archive" | "unarchive"): Promise<unknown> {
    return this.callTool("manage_project", { project, action });
  }

  async addProject(targetPath: string, profile?: string, ownership?: string): Promise<unknown> {
    const args: Record<string, unknown> = { path: targetPath };
    if (profile) args.profile = profile;
    if (ownership) args.ownership = ownership;
    return this.callTool("add_project", args);
  }

  async healthCheck(): Promise<unknown> {
    return this.callTool("health_check", {});
  }

  async doctorFix(): Promise<unknown> {
    return this.callTool("doctor_fix", {});
  }

  async sessionStart(project?: string): Promise<unknown> {
    const args: Record<string, unknown> = {};
    if (project) args.project = project;
    return this.callTool("session_start", args);
  }

  async sessionEnd(summary?: string): Promise<unknown> {
    const args: Record<string, unknown> = {};
    if (summary) args.summary = summary;
    return this.callTool("session_end", args);
  }

  async supersedeFinding(project: string, finding_text: string, superseded_by: string): Promise<unknown> {
    return this.callTool("supersede_finding", { project, finding_text, superseded_by });
  }

  async retractFinding(project: string, finding_text: string, reason: string): Promise<unknown> {
    return this.callTool("retract_finding", { project, finding_text, reason });
  }

  async manageReviewItem(project: string, line: string, action: "approve" | "reject" | "edit", newText?: string): Promise<unknown> {
    return this.callTool("manage_review_item", { project, line, action, ...(newText !== undefined && { new_text: newText }) });
  }

  async resolveContradiction(
    project: string,
    finding_text: string,
    finding_text_other: string,
    resolution: string,
  ): Promise<unknown> {
    return this.callTool("resolve_contradiction", { project, finding_text, finding_text_other, resolution });
  }

  async linkTaskIssue(
    project: string,
    item: string,
    issue_number?: number,
    issue_url?: string,
    unlink?: boolean,
  ): Promise<unknown> {
    const updates: Record<string, unknown> = {};
    if (issue_number !== undefined) updates.github_issue = issue_number;
    if (issue_url) updates.github_url = issue_url;
    if (unlink) updates.unlink_github = unlink;
    return this.callTool("update_task", { project, item, updates });
  }

  async getConfig(domain?: string, project?: string): Promise<unknown> {
    const args: Record<string, unknown> = { domain: domain ?? "all" };
    if (project) args.project = project;
    return this.callTool("get_config", args);
  }

  async setConfig(domain: string, settings: Record<string, unknown>, project?: string): Promise<unknown> {
    const args: Record<string, unknown> = { domain, settings };
    if (project) args.project = project;
    return this.callTool("set_config", args);
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    this.rejectPending(new Error("Phren client disposed."));

    if (!this.process.killed) {
      this.process.kill();
    }
  }

  private async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.reconnecting && this.reconnectPromise) {
      await this.reconnectPromise;
    }
    if (!this.disposed && !this.reconnecting && this.reconnectRetries >= PhrenClient.MAX_RECONNECT_RETRIES) {
      throw new Error("Phren MCP process exited and all reconnect attempts failed.");
    }
    await this.ensureInitialized();
    const result = await this.sendRequest<McpToolCallResult>("tools/call", {
      name: toolName,
      arguments: args,
    });
    return this.parseToolCallResult(result);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!this.initializePromise) {
      this.initializePromise = this.initialize();
    }

    await this.initializePromise;
  }

  private async initialize(): Promise<void> {
    const versionsToTry = ["2025-06-18", "2025-03-26", "2024-11-05"];
    let lastError: unknown;

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
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(
      `Failed to initialize MCP session with ${this.options.mcpServerPath}: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
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

  private async sendRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
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

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
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

  private handleStdoutData(chunk: Buffer): void {
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
        const message = JSON.parse(line) as JsonRpcResponse<unknown>;
        this.handleMessage(message);
      } catch (error) {
        console.error(`[phren-mcp] Failed to parse JSON-RPC line: ${String(error)}`);
      }
    }
  }

  private handleMessage(message: JsonRpcResponse<unknown>): void {
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

  private parseToolCallResult(result: McpToolCallResult): unknown {
    const content = Array.isArray(result.content) ? result.content : [];
    const textBlock = content.find((item) => item.type === "text" && typeof item.text === "string");

    if (!textBlock?.text) {
      return result;
    }

    try {
      return this.unwrapToolResponse(JSON.parse(textBlock.text) as unknown);
    } catch {
      return textBlock.text;
    }
  }

  private unwrapToolResponse(value: unknown): unknown {
    const response = asRecord(value) as PhrenToolResponse | undefined;
    if (response?.ok === false) {
      throw new Error(response.error ?? response.message ?? "Phren tool call failed.");
    }
    return value;
  }

  private rejectPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

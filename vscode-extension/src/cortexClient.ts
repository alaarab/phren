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

interface CortexToolResponse {
  ok?: boolean;
  error?: string;
  message?: string;
  data?: unknown;
  [key: string]: unknown;
}

export interface CortexClientOptions {
  mcpServerPath: string;
  storePath: string;
  nodePath?: string;
  clientVersion?: string;
  requestTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class CortexClient {
  private readonly options: CortexClientOptions;
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly timeoutMs: number;

  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private disposed = false;
  private initialized = false;
  private initializePromise?: Promise<void>;

  constructor(options: CortexClientOptions) {
    this.options = options;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    this.process = spawn(options.nodePath ?? process.execPath, [options.mcpServerPath, options.storePath], {
      stdio: "pipe",
    });

    this.process.stdout.on("data", (chunk: Buffer | string) => {
      this.handleStdoutData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
    });

    this.process.stderr.on("data", (chunk: Buffer | string) => {
      const message = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      console.error(`[cortex-mcp] ${message.trim()}`);
    });

    this.process.on("exit", (code, signal) => {
      if (this.disposed) {
        return;
      }
      this.rejectPending(new Error(`cortex MCP process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`));
    });

    this.process.on("error", (error: Error) => {
      this.rejectPending(error);
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

  async getTasks(project: string): Promise<unknown> {
    return this.callTool("get_tasks", { project });
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

  async listSkills(): Promise<unknown> {
    return this.callTool("list_skills", {});
  }

  async readSkill(name: string, project?: string): Promise<unknown> {
    return this.callTool("read_skill", project ? { name, project } : { name });
  }

  async writeSkill(name: string, content: string, scope: string): Promise<unknown> {
    return this.callTool("write_skill", { name, content, scope });
  }

  async enableSkill(name: string, project?: string): Promise<unknown> {
    return this.callTool("enable_skill", project ? { name, project } : { name });
  }

  async disableSkill(name: string, project?: string): Promise<unknown> {
    return this.callTool("disable_skill", project ? { name, project } : { name });
  }

  async listHooks(): Promise<unknown> {
    return this.callTool("list_hooks", {});
  }

  async toggleHooks(enabled: boolean, tool?: string): Promise<unknown> {
    return this.callTool("toggle_hooks", tool ? { enabled, tool } : { enabled });
  }

  async memoryFeedback(key: string, feedback: string): Promise<unknown> {
    return this.callTool("memory_feedback", { key, feedback });
  }

  async updateTask(project: string, item: string, updates: Record<string, unknown>): Promise<unknown> {
    return this.callTool("update_task", { project, item, updates });
  }

  async completeTask(project: string, item: string): Promise<unknown> {
    return this.callTool("complete_task", { project, item });
  }

  async removeFinding(project: string, text: string): Promise<unknown> {
    return this.callTool("remove_finding", { project, finding: text });
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    this.rejectPending(new Error("Cortex client disposed."));

    if (!this.process.killed) {
      this.process.kill();
    }
  }

  private async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
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
            name: "cortex-vscode",
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
      throw new Error("Cortex client has been disposed.");
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
        console.error(`[cortex-mcp] Failed to parse JSON-RPC line: ${String(error)}`);
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
    const response = asRecord(value) as CortexToolResponse | undefined;
    if (response?.ok === false) {
      throw new Error(response.error ?? response.message ?? "Cortex tool call failed.");
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

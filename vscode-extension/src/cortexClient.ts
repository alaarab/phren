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

export interface CortexClientOptions {
  mcpServerPath: string;
  storePath: string;
  nodePath?: string;
  requestTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const HEADER_SEPARATOR = "\r\n\r\n";

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
            version: "0.0.1",
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

    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      ...(params ? { params } : {}),
    });
    const message = `Content-Length: ${Buffer.byteLength(payload, "utf8")}${HEADER_SEPARATOR}${payload}`;
    this.process.stdin.write(message, "utf8");
  }

  private async sendRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.disposed) {
      throw new Error("Cortex client has been disposed.");
    }

    const id = this.nextId++;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });
    const message = `Content-Length: ${Buffer.byteLength(payload, "utf8")}${HEADER_SEPARATOR}${payload}`;

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

      this.process.stdin.write(message, "utf8", (error) => {
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
      const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd === -1) {
        return;
      }

      const headerText = this.buffer.subarray(0, headerEnd).toString("utf8");
      const contentLengthMatch = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!contentLengthMatch) {
        this.buffer = this.buffer.subarray(headerEnd + HEADER_SEPARATOR.length);
        continue;
      }

      const contentLength = Number.parseInt(contentLengthMatch[1], 10);
      const bodyStart = headerEnd + HEADER_SEPARATOR.length;
      const bodyEnd = bodyStart + contentLength;

      if (this.buffer.length < bodyEnd) {
        return;
      }

      const bodyText = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);

      try {
        const message = JSON.parse(bodyText) as JsonRpcResponse<unknown>;
        this.handleMessage(message);
      } catch (error) {
        console.error(`[cortex-mcp] Failed to parse JSON-RPC payload: ${String(error)}`);
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
      return JSON.parse(textBlock.text) as unknown;
    } catch {
      return textBlock.text;
    }
  }

  private rejectPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

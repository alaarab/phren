/**
 * LSP integration tool — Language Server Protocol for structured code navigation.
 *
 * Provides go-to-definition, find-references, and hover info via LSP servers.
 * Auto-detects language servers for common languages (TypeScript, Python, Go, Rust).
 */
import type { AgentTool } from "./types.js";
import { spawn, type ChildProcess } from "node:child_process";

interface LspServer {
  process: ChildProcess;
  language: string;
  requestId: number;
  pendingRequests: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  initialized: boolean;
  buffer: string;
}

const servers = new Map<string, LspServer>();

/** Detect which LSP servers are available. */
function detectLspServers(): Array<{ language: string; command: string; args: string[] }> {
  const detected: Array<{ language: string; command: string; args: string[] }> = [];

  // TypeScript — typescript-language-server (most common)
  detected.push({
    language: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
  });

  // Python — pyright or pylsp
  detected.push({
    language: "python",
    command: "pyright-langserver",
    args: ["--stdio"],
  });

  // Go — gopls
  detected.push({
    language: "go",
    command: "gopls",
    args: ["serve", "-listen", "stdio"],
  });

  // Rust — rust-analyzer
  detected.push({
    language: "rust",
    command: "rust-analyzer",
    args: [],
  });

  return detected;
}

function languageForFile(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts": case "tsx": case "js": case "jsx": case "mjs": case "cjs":
      return "typescript";
    case "py": case "pyi":
      return "python";
    case "go":
      return "go";
    case "rs":
      return "rust";
    default:
      return null;
  }
}

async function getOrStartServer(language: string): Promise<LspServer | null> {
  if (servers.has(language)) return servers.get(language)!;

  const serverConfigs = detectLspServers();
  const config = serverConfigs.find(s => s.language === language);
  if (!config) return null;

  try {
    const proc = spawn(config.command, config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
    });

    const server: LspServer = {
      process: proc,
      language,
      requestId: 0,
      pendingRequests: new Map(),
      initialized: false,
      buffer: "",
    };

    // Handle incoming messages
    proc.stdout!.on("data", (data: Buffer) => {
      server.buffer += data.toString();
      processBuffer(server);
    });

    proc.on("error", () => {
      servers.delete(language);
    });

    proc.on("exit", () => {
      servers.delete(language);
    });

    servers.set(language, server);

    // Send initialize request
    await sendRequest(server, "initialize", {
      processId: process.pid,
      rootUri: `file://${process.cwd()}`,
      capabilities: {
        textDocument: {
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          hover: { dynamicRegistration: false, contentFormat: ["plaintext", "markdown"] },
        },
      },
    });

    // Send initialized notification
    sendNotification(server, "initialized", {});
    server.initialized = true;

    return server;
  } catch {
    return null;
  }
}

function processBuffer(server: LspServer): void {
  while (true) {
    const headerEnd = server.buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;

    const header = server.buffer.slice(0, headerEnd);
    const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);
    if (!contentLengthMatch) {
      server.buffer = server.buffer.slice(headerEnd + 4);
      continue;
    }

    const contentLength = parseInt(contentLengthMatch[1], 10);
    const bodyStart = headerEnd + 4;
    if (server.buffer.length < bodyStart + contentLength) break;

    const body = server.buffer.slice(bodyStart, bodyStart + contentLength);
    server.buffer = server.buffer.slice(bodyStart + contentLength);

    try {
      const msg = JSON.parse(body);
      if (msg.id !== undefined && server.pendingRequests.has(msg.id)) {
        const pending = server.pendingRequests.get(msg.id)!;
        server.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message));
        } else {
          pending.resolve(msg.result);
        }
      }
    } catch { /* skip malformed */ }
  }
}

function sendRequest(server: LspServer, method: string, params: unknown): Promise<unknown> {
  const id = ++server.requestId;
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const packet = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
  server.process.stdin!.write(packet);

  return new Promise((resolve, reject) => {
    server.pendingRequests.set(id, { resolve, reject });
    setTimeout(() => {
      if (server.pendingRequests.has(id)) {
        server.pendingRequests.delete(id);
        reject(new Error("LSP request timed out"));
      }
    }, 10_000);
  });
}

function sendNotification(server: LspServer, method: string, params: unknown): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
  const packet = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
  server.process.stdin!.write(packet);
}

function formatLocation(loc: { uri: string; range: { start: { line: number; character: number } } }): string {
  const path = loc.uri.replace("file://", "");
  return `${path}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
}

export const lspTool: AgentTool = {
  name: "lsp",
  description:
    "Use Language Server Protocol for structured code navigation. " +
    "Supports: 'definition' (go to definition), 'references' (find all references), 'hover' (type info). " +
    "More reliable than grep for navigating code structure. " +
    "Requires a language server to be installed (typescript-language-server, pyright, gopls, rust-analyzer).",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["definition", "references", "hover"],
        description: "LSP action to perform.",
      },
      file: {
        type: "string",
        description: "Absolute path to the file.",
      },
      line: {
        type: "number",
        description: "Line number (1-based).",
      },
      character: {
        type: "number",
        description: "Column number (1-based).",
      },
    },
    required: ["action", "file", "line", "character"],
  },
  async execute(input) {
    const action = input.action as string;
    const file = input.file as string;
    const line = (input.line as number) - 1; // LSP uses 0-based
    const character = (input.character as number) - 1;

    const language = languageForFile(file);
    if (!language) {
      return { output: `No LSP support for file: ${file}`, is_error: true };
    }

    const server = await getOrStartServer(language);
    if (!server) {
      return {
        output: `No LSP server available for ${language}. Install one of: typescript-language-server, pyright-langserver, gopls, rust-analyzer`,
        is_error: true,
      };
    }

    const textDocumentPosition = {
      textDocument: { uri: `file://${file}` },
      position: { line, character },
    };

    try {
      switch (action) {
        case "definition": {
          const result = await sendRequest(server, "textDocument/definition", textDocumentPosition) as
            | { uri: string; range: { start: { line: number; character: number } } }
            | Array<{ uri: string; range: { start: { line: number; character: number } } }>
            | null;

          if (!result) return { output: "No definition found." };
          const locations = Array.isArray(result) ? result : [result];
          if (locations.length === 0) return { output: "No definition found." };

          const formatted = locations.map(formatLocation).join("\n");
          return { output: `Definition:\n${formatted}` };
        }

        case "references": {
          const result = await sendRequest(server, "textDocument/references", {
            ...textDocumentPosition,
            context: { includeDeclaration: true },
          }) as Array<{ uri: string; range: { start: { line: number; character: number } } }> | null;

          if (!result || result.length === 0) return { output: "No references found." };

          const formatted = result.slice(0, 20).map(formatLocation).join("\n");
          const suffix = result.length > 20 ? `\n... and ${result.length - 20} more` : "";
          return { output: `References (${result.length}):\n${formatted}${suffix}` };
        }

        case "hover": {
          const result = await sendRequest(server, "textDocument/hover", textDocumentPosition) as
            | { contents: string | { value: string } | Array<string | { value: string }> }
            | null;

          if (!result) return { output: "No hover info available." };

          let content: string;
          if (typeof result.contents === "string") {
            content = result.contents;
          } else if (Array.isArray(result.contents)) {
            content = result.contents.map(c => typeof c === "string" ? c : c.value).join("\n");
          } else {
            content = result.contents.value;
          }

          return { output: `Hover:\n${content}` };
        }

        default:
          return { output: `Unknown LSP action: ${action}`, is_error: true };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `LSP error: ${msg}`, is_error: true };
    }
  },
};

/** Cleanup all LSP servers. Call on agent shutdown. */
export function shutdownLspServers(): void {
  for (const [, server] of servers) {
    try {
      sendNotification(server, "shutdown", null);
      server.process.kill();
    } catch { /* best effort */ }
  }
  servers.clear();
}

/** Lazy local LSP diagnostics. Server launches retain shell permissions and sandboxing. */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { scrubEnv } from "../permissions/shell-safety.js";
import { wrapWithSandbox } from "../permissions/kernel-sandbox.js";
import type { PermissionConfig } from "../permissions/types.js";

type Diagnostic = { severity?: number; message?: string; source?: string; range?: { start?: { line?: number; character?: number } } };
type Rpc = { id?: number | string; method?: string; params?: any; result?: any; error?: { message?: string } };
const LIMIT = 8 * 1024 * 1024;
const SERVERS: Record<string, { command: string; args: string[]; language: string }> = {
  ts: { command: "typescript-language-server", args: ["--stdio"], language: "typescript" },
  tsx: { command: "typescript-language-server", args: ["--stdio"], language: "typescriptreact" },
  js: { command: "typescript-language-server", args: ["--stdio"], language: "javascript" },
  jsx: { command: "typescript-language-server", args: ["--stdio"], language: "javascriptreact" },
  py: { command: "pyright-langserver", args: ["--stdio"], language: "python" },
  rs: { command: "rust-analyzer", args: [], language: "rust" },
  go: { command: "gopls", args: [], language: "go" },
  c: { command: "clangd", args: [], language: "c" },
  cpp: { command: "clangd", args: [], language: "cpp" },
};

export class LspConnection {
  private buffer = Buffer.alloc(0);
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private documents = new Map<string, number>();
  private listeners = new Set<(params: any) => void>();
  private dead = false;
  private closed = false;
  readonly ready: Promise<void>;
  private pull = false;
  constructor(private child: ChildProcessWithoutNullStreams, root: string) {
    child.stdout.on("data", chunk => { try { this.receive(chunk); } catch { this.close(); } });
    child.stdin.on("error", () => this.close());
    // Drain stderr; its arbitrary server text is never inserted into model context.
    child.stderr.resume();
    child.on("error", () => this.fail());
    child.on("exit", () => this.fail());
    this.ready = this.request("initialize", { processId: process.pid, rootUri: pathToFileURL(root).href,
      workspaceFolders: [{ uri: pathToFileURL(root).href, name: path.basename(root) }],
      capabilities: { workspace: { applyEdit: false, configuration: true }, textDocument: { publishDiagnostics: { versionSupport: true }, diagnostic: {} } },
    }).then(result => { this.pull = !!result?.capabilities?.diagnosticProvider; this.send({ method: "initialized", params: {} }); });
    // A failed initialization is handled when diagnostics are requested.
    void this.ready.catch(() => this.close());
  }
  private fail() {
    this.dead = true;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("Language server stopped.")); }
    this.pending.clear();
  }
  private send(message: Rpc) {
    if (this.dead) throw new Error("Language server stopped.");
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }
  request(method: string, params: unknown): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); try { this.send({ method: "$/cancelRequest", params: { id } }); } catch {} reject(new Error("Language server request timed out.")); }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private receive(chunk: Buffer) {
    if (this.buffer.length + chunk.length > LIMIT) { this.close(); return; }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, end).toString())?.[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > LIMIT) { this.close(); return; }
      if (this.buffer.length < end + 4 + length) return;
      const body = this.buffer.subarray(end + 4, end + 4 + length);
      this.buffer = this.buffer.subarray(end + 4 + length);
      let message: Rpc;
      try { message = JSON.parse(body.toString()); } catch { this.close(); return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) { this.close(); return; }
      if (message.method) {
        if (message.id !== undefined) {
          // Servers never gain an implicit write permission through workspace/applyEdit.
          const result = message.method === "workspace/configuration" ? (Array.isArray(message.params?.items) ? message.params.items : []).map(() => null)
            : message.method === "workspace/applyEdit" ? { applied: false, failureReason: "Use an approved editing tool." } : null;
          this.send({ id: message.id, result });
        } else if (message.method === "textDocument/publishDiagnostics") {
          for (const listener of this.listeners) listener(message.params);
        }
      } else if (typeof message.id === "number") {
        const waiter = this.pending.get(message.id);
        if (!waiter) continue;
        this.pending.delete(message.id); clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error("Language server rejected the request.")); else waiter.resolve(message.result);
      }
    }
  }
  async diagnostics(file: string, language: string, signal?: AbortSignal): Promise<Diagnostic[] | undefined> {
    await this.ready;
    if (signal?.aborted) return undefined;
    const uri = pathToFileURL(file).href, oldVersion = this.documents.get(uri), version = (oldVersion ?? 0) + 1;
    const text = fs.readFileSync(file, "utf8");
    this.documents.set(uri, version);
    let listener: (params: any) => void = () => {};
    let timeout: NodeJS.Timeout | undefined;
    let finish: (value: Diagnostic[] | undefined) => void = () => {};
    const published = new Promise<Diagnostic[] | undefined>(resolve => {
      finish = resolve;
      listener = params => { if (params?.uri === uri && params.version === version && Array.isArray(params.diagnostics)) resolve(params.diagnostics); };
      this.listeners.add(listener);
      timeout = setTimeout(() => resolve(undefined), 2000);
    });
    const cancel = () => finish(undefined);
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (oldVersion === undefined) this.send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: language, version, text } } });
      else this.send({ method: "textDocument/didChange", params: { textDocument: { uri, version }, contentChanges: [{ text }] } });
      this.send({ method: "textDocument/didSave", params: { textDocument: { uri } } });
      let result: Diagnostic[] | undefined;
      if (this.pull) {
        const response = await this.request("textDocument/diagnostic", { textDocument: { uri } });
        result = response?.kind === "full" && Array.isArray(response.items) ? response.items : undefined;
      } else result = await published;
      // Concurrent edits invalidate this result even when a server omits versioning.
      return !signal?.aborted && this.documents.get(uri) === version && fs.readFileSync(file, "utf8") === text ? result : undefined;
    } finally { this.listeners.delete(listener); if (timeout) clearTimeout(timeout); signal?.removeEventListener("abort", cancel); }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.send({ method: "exit" }); } catch {}
    this.fail(); this.child.stdin.end();
    // Only this manager's own child is stopped, never an existing server/process.
    this.child.kill();
  }
}

export class LspDiagnostics {
  private servers = new Map<string, { connection: LspConnection; idle: NodeJS.Timeout }>();
  private denied = new Set<string>();
  constructor(private config: () => PermissionConfig, private authorize: (argv: string[], signal?: AbortSignal) => Promise<boolean>) {}
  close() { for (const server of this.servers.values()) { clearTimeout(server.idle); server.connection.close(); } this.servers.clear(); this.denied.clear(); }
  async afterEdit(files: string[], signal?: AbortSignal): Promise<string> {
    if (process.env.PHREN_AGENT_LSP === "off" || signal?.aborted) return "";
    const notes: string[] = [];
    for (const file of [...new Set(files)].slice(0, 20)) {
      if (signal?.aborted) break;
      const spec = SERVERS[path.extname(file).slice(1)], config = this.config();
      let root: string; try { root = fs.realpathSync(config.projectRoot); } catch { notes.push("Language-server diagnostics unavailable: project root cannot be resolved."); continue; }
      if (!spec) continue;
      let resolved: string;
      try { resolved = fs.realpathSync(file); if (fs.statSync(resolved).size > 2 * 1024 * 1024) continue; } catch { continue; }
      const relative = path.relative(root, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      const candidates = [path.join(root, "node_modules/.bin", spec.command), ...(process.env.PATH ?? "").split(path.delimiter).map(dir => path.join(dir, spec.command))];
      const executable = candidates.find(candidate => { try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; } });
      if (!executable) continue; // Installed servers only; never an implicit install.
      const key = `${root}/${executable}`;
      if (this.denied.has(key)) continue;
      try {
        let server = this.servers.get(key);
        if (!server) {
          if (this.servers.size >= 5) { notes.push("Language-server diagnostics unavailable: server limit reached."); continue; }
          const argv = [executable, ...spec.args];
          if (!await this.authorize(argv, signal) || signal?.aborted) { this.denied.add(key); notes.push("Language-server diagnostics were not authorized."); continue; }
          const wrapped = wrapWithSandbox(argv, { mode: config.sandboxMode ?? "auto", workspaceRoot: root, extraWritable: config.allowedPaths, network: config.network !== "off" });
          if (wrapped.notice) notes.push(wrapped.notice);
          const connection = new LspConnection(spawn(wrapped.argv[0], wrapped.argv.slice(1), { cwd: root, env: scrubEnv(), stdio: "pipe" }), root);
          server = { connection, idle: setTimeout(() => { connection.close(); this.servers.delete(key); }, 60_000) };
          server.idle.unref(); this.servers.set(key, server);
        }
        server.idle.refresh();
        const diagnostics = await server.connection.diagnostics(resolved, spec.language, signal);
        if (!diagnostics) notes.push(`LSP ${relative}: diagnostics pending or unavailable; no clean result claimed.`);
        else if (!diagnostics.length) notes.push(`LSP ${relative}: no diagnostics for this file version.`);
        else notes.push(`LSP ${relative}:\n${diagnostics.slice(0, 20).map(d => `${(d.range?.start?.line ?? 0) + 1}:${(d.range?.start?.character ?? 0) + 1} ${d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info"}: ${(d.message ?? "Diagnostic").replace(/[\x00-\x1f]/g, " ").slice(0, 1000)}`).join("\n")}`);
      } catch { notes.push(`LSP ${relative}: diagnostics unavailable; no clean result claimed.`); const server = this.servers.get(key); if (server) { clearTimeout(server.idle); server.connection.close(); this.servers.delete(key); } }
    }
    return notes.join("\n\n");
  }
}

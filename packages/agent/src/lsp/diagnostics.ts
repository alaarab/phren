/** Lazy local LSP diagnostics. Server launches retain shell permissions and sandboxing. */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { scrubEnv } from "../permissions/shell-safety.js";
import { wrapWithSandbox } from "../permissions/kernel-sandbox.js";
import { checkSensitivePath } from "../permissions/sandbox.js";
import type { PermissionConfig } from "../permissions/types.js";

type Diagnostic = { severity?: number; message?: string; source?: string; range?: { start?: { line?: number; character?: number } } };
function readDocument(file: string): string {
  // Recheck the resolved path at the read boundary, and enforce the size cap
  // again because the file may have changed since authorization.
  if (fs.realpathSync(file) !== file || checkSensitivePath(file).sensitive) throw new Error("Diagnostic file changed after authorization.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("Diagnostic file exceeds the size limit.");
    const text = fs.readFileSync(fd, "utf8");
    if (Buffer.byteLength(text) > 2 * 1024 * 1024 || fs.realpathSync(file) !== file) throw new Error("Diagnostic file changed during the read.");
    return text;
  } finally { fs.closeSync(fd); }
}
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
  private lifetime = new AbortController();
  private queries: Promise<unknown> = Promise.resolve();
  private dead = false;
  private closed = false;
  readonly ready: Promise<void>;
  private pull = false;
  constructor(private child: ChildProcessWithoutNullStreams, root: string, private ownsProcessGroup = false) {
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
    this.lifetime.abort();
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("Language server stopped.")); }
    this.pending.clear();
  }
  private send(message: Rpc) {
    if (this.dead) throw new Error("Language server stopped.");
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }
  request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted || this.dead) return Promise.reject(new Error("Language server request cancelled."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); this.pending.delete(id); };
      const cancel = () => {
        cleanup();
        try { this.send({ method: "$/cancelRequest", params: { id } }); } catch {}
        reject(new Error("Language server request cancelled."));
      };
      const timer = setTimeout(cancel, 5000);
      this.pending.set(id, {
        resolve: value => { cleanup(); resolve(value); },
        reject: error => { cleanup(); reject(error); }, timer,
      });
      signal?.addEventListener("abort", cancel, { once: true });
      try { this.send({ id, method, params }); } catch (error) { cleanup(); reject(error); }
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
  diagnostics(file: string, language: string, signal?: AbortSignal): Promise<Diagnostic[] | undefined> {
    // One document transaction at a time: versionless publications cannot be
    // attributed safely to overlapping didChange requests.
    const run = this.queries.then(() => this.readDiagnostics(file, language, signal));
    this.queries = run.catch(() => undefined);
    return run;
  }
  private async readDiagnostics(file: string, language: string, signal?: AbortSignal): Promise<Diagnostic[] | undefined> {
    signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    if (signal.aborted) return undefined;
    let stop: (() => void) | undefined;
    try {
      await Promise.race([this.ready, new Promise<never>((_, reject) => {
        stop = () => reject(new Error("Language server request cancelled."));
        signal!.addEventListener("abort", stop, { once: true });
      })]);
    } finally { if (stop) signal.removeEventListener("abort", stop); }
    if (signal?.aborted) return undefined;
    const uri = pathToFileURL(file).href, oldVersion = this.documents.get(uri), version = (oldVersion ?? 0) + 1;
    const text = readDocument(file);
    this.documents.set(uri, version);
    let listener: (params: any) => void = () => {};
    let timeout: NodeJS.Timeout | undefined;
    let finish: (value: Diagnostic[] | undefined) => void = () => {};
    const published = new Promise<Diagnostic[] | undefined>(resolve => {
      finish = resolve;
      listener = params => { if (params?.uri === uri && (params.version === version || (params.version === undefined && oldVersion === undefined)) && Array.isArray(params.diagnostics)) resolve(params.diagnostics); };
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
        const response = await this.request("textDocument/diagnostic", { textDocument: { uri } }, signal);
        result = response?.kind === "full" && Array.isArray(response.items) ? response.items : undefined;
      } else result = await published;
      // Concurrent edits invalidate this result even when a server omits versioning.
      return !signal?.aborted && this.documents.get(uri) === version && readDocument(file) === text ? result : undefined;
    } finally { this.listeners.delete(listener); if (timeout) clearTimeout(timeout); signal?.removeEventListener("abort", cancel); }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.send({ method: "exit" }); } catch {}
    this.fail(); this.child.stdin.end();
    // The session may exit immediately after close. Stop the exact group we
    // created, including server helpers; no delayed timer can outlive its owner.
    try {
      if (this.ownsProcessGroup && process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, "SIGKILL");
      else this.child.kill("SIGKILL");
    } catch { this.child.kill("SIGKILL"); }
  }
}

export class LspDiagnostics {
  private servers = new Map<string, { connection: LspConnection; idle: NodeJS.Timeout; active: number }>();
  private denied = new Set<string>();
  private starts = new Map<string, Promise<LspConnection | undefined>>();
  private generation = 0;
  constructor(
    private config: () => PermissionConfig,
    private authorize: (argv: string[], signal?: AbortSignal) => Promise<boolean>,
    private authorizeRead: (file: string, signal?: AbortSignal) => Promise<boolean>,
  ) {}
  close() { this.generation++; this.starts.clear(); for (const server of this.servers.values()) { clearTimeout(server.idle); server.connection.close(); } this.servers.clear(); this.denied.clear(); }
  async afterEdit(files: string[], signal?: AbortSignal): Promise<string> {
    if (process.env.PHREN_AGENT_LSP === "off" || signal?.aborted) return "";
    const generation = this.generation;
    const notes: string[] = [];
    for (const file of [...new Set(files)].slice(0, 20)) {
      if (signal?.aborted || generation !== this.generation) break;
      const spec = SERVERS[path.extname(file).slice(1)], config = this.config();
      let root: string; try { root = fs.realpathSync(config.projectRoot); } catch { notes.push("Language-server diagnostics unavailable: project root cannot be resolved."); continue; }
      if (!spec) continue;
      let resolved: string;
      try { resolved = fs.realpathSync(file); if (fs.statSync(resolved).size > 2 * 1024 * 1024) continue; } catch { continue; }
      const relative = path.relative(root, resolved);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || checkSensitivePath(resolved).sensitive) continue;
      // Diagnostics read the entire file and must pass the normal read gate,
      // even when a prior edit was allowed under a different tool rule.
      if (!await this.authorizeRead(resolved, signal) || signal?.aborted || generation !== this.generation) continue;
      if (this.config() !== config) continue;
      const candidates = [path.join(root, "node_modules/.bin", spec.command), ...(process.env.PATH ?? "").split(path.delimiter).filter(dir => path.isAbsolute(dir)).map(dir => path.join(dir, spec.command))];
      const candidate = candidates.find(candidate => { try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; } });
      if (!candidate) continue;
      const executable = fs.realpathSync(candidate); // Installed servers only; never an implicit install.
      const key = `${root}/${executable}`;
      if (this.denied.has(key)) continue;
      let usedConnection: LspConnection | undefined;
      try {
        let server = this.servers.get(key);
        if (!server) {
          let starting = this.starts.get(key);
          if (!starting) {
            starting = (async () => {
              if (this.servers.size + this.starts.size >= 5) return undefined;
              const argv = [executable, ...spec.args];
              const allowed = await this.authorize(argv, signal);
              if (signal?.aborted || generation !== this.generation || this.config() !== config) return undefined;
              if (!allowed) { this.denied.add(key); return undefined; }
              // Installed servers may otherwise fetch dependencies/plugins.
              // Diagnostics never grant network access, even in an online turn.
              const wrapped = wrapWithSandbox(argv, { mode: config.sandboxMode ?? "auto", workspaceRoot: root, extraWritable: config.allowedPaths, network: false });
              if (generation !== this.generation || signal?.aborted) return undefined;
              if (wrapped.notice) notes.push(wrapped.notice);
              const connection = new LspConnection(spawn(wrapped.argv[0], wrapped.argv.slice(1), { cwd: root, env: scrubEnv(), stdio: "pipe", detached: process.platform !== "win32" }), root, process.platform !== "win32");
              const idle = setTimeout(() => {
                const current = this.servers.get(key);
                if (current?.connection !== connection) return;
                if (current.active) { idle.refresh(); return; }
                this.servers.delete(key); connection.close();
              }, 60_000);
              idle.unref(); this.servers.set(key, { connection, idle, active: 0 });
              return connection;
            })();
            this.starts.set(key, starting);
            void starting.finally(() => { if (this.starts.get(key) === starting) this.starts.delete(key); }).catch(() => {});
          }
          await starting;
          if (signal?.aborted || generation !== this.generation || this.config() !== config) break;
          server = this.servers.get(key);
          if (!server) { notes.push("Language-server diagnostics were not authorized or available."); continue; }
        }
        server.idle.refresh(); server.active++;
        const connection = server.connection; usedConnection = connection;
        const cancel = () => {
          if (this.servers.get(key)?.connection === connection) { clearTimeout(server!.idle); this.servers.delete(key); }
          connection.close();
        };
        signal?.addEventListener("abort", cancel, { once: true });
        let diagnostics: Diagnostic[] | undefined;
        try { diagnostics = await connection.diagnostics(resolved, spec.language, signal); }
        finally { server.active--; server.idle.refresh(); signal?.removeEventListener("abort", cancel); }
        if (signal?.aborted || generation !== this.generation) break;
        if (!diagnostics) notes.push(`LSP ${relative}: diagnostics pending or unavailable; no clean result claimed.`);
        else if (!diagnostics.length) notes.push(`LSP ${relative}: no diagnostics for this file version.`);
        else notes.push(`LSP ${relative}:\n${diagnostics.slice(0, 20).map(d => `${(d.range?.start?.line ?? 0) + 1}:${(d.range?.start?.character ?? 0) + 1} ${d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info"}: ${(d.message ?? "Diagnostic").replace(/[\x00-\x1f]/g, " ").slice(0, 1000)}`).join("\n")}`);
      } catch { if (signal?.aborted || generation !== this.generation) break; notes.push(`LSP ${relative}: diagnostics unavailable; no clean result claimed.`); const server = this.servers.get(key); if (server && server.connection === usedConnection) { clearTimeout(server.idle); server.connection.close(); this.servers.delete(key); } }
    }
    return notes.join("\n\n");
  }
}

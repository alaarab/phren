import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import { codexExecutable } from "./codex-binary.js";
import { object } from "./protocol.js";
/** A Phren-owned `codex app-server` and its WebSocket-on-UDS client. The
 * visible pane is a second client (`codex resume <threadId> --remote
 * unix://<sock>`); turns and approvals from either side reach both. Protocol
 * and transport follow `.scratch/ref/codex-daemon-spike.md`. */
const STARTUP_TIMEOUT_MS = 15_000;
const STARTUP_POLL_MS = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2_000;
/** A JSON-RPC error reply, carrying the server's `code` beside the message. */
export class AppServerRpcError extends Error {
    code;
    method;
    constructor(code, message, method) {
        super(message);
        this.code = code;
        this.method = method;
        this.name = "AppServerRpcError";
    }
}
/** Start one `codex app-server --listen unix://<socketPath>` and wait until its
 * socket accepts WebSocket connections. The server is the worker's; `stop()`
 * is the only owner. Extra `env` is layered over the current process's. */
export async function spawnAppServer(options) {
    const env = { ...(options.replaceEnv ? {} : process.env), ...(options.env ?? {}), ...(options.codexHome ? { CODEX_HOME: options.codexHome } : {}) };
    // The merged environment's PATH, so a caller's partial `env` still finds codex.
    const codexBin = options.codexBin ?? codexExecutable(env);
    await mkdir(path.dirname(options.socketPath), { recursive: true, mode: 0o700 });
    // A socket file left by a dead server would pass the stat below and block the bind.
    await rm(options.socketPath, { force: true });
    const log = options.logFile ? await open(options.logFile, "a", 0o600) : undefined;
    let child;
    try {
        child = spawn(codexBin, ["app-server", ...(options.config ?? []).flatMap(value => ["-c", value]), "--listen", `unix://${options.socketPath}`], {
            cwd: options.cwd,
            env,
            detached: options.detached === true,
            // No stdin: the app-server is reached over its socket, never over stdio.
            // stderr is kept (bounded) so a failed start can say why.
            stdio: ["ignore", "ignore", log ? log.fd : "pipe"],
        });
    }
    finally {
        await log?.close();
    }
    // A missing binary is an `error` event, not an exit: without a listener
    // it would take the Hook down.
    let failure;
    child.once("error", error => { failure = error; });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-2_000); });
    const why = async () => {
        const text = options.logFile ? (await readFile(options.logFile, "utf8").catch(() => "")).slice(-2_000) : stderr;
        return text.trim() ? `: ${text.trim().split("\n").slice(-3).join(" | ")}` : "";
    };
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (true) {
        if (failure)
            throw new Error(`codex app-server could not start: ${failure.message}`);
        if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`codex app-server exited before ${options.socketPath} was ready (${child.exitCode ?? child.signalCode})${await why()}`);
        }
        if (await socketAccepts(options.socketPath))
            break;
        if (Date.now() > deadline) {
            child.kill("SIGKILL");
            throw new Error(`Timed out waiting for codex app-server at ${options.socketPath}${await why()}`);
        }
        await delay(STARTUP_POLL_MS);
    }
    // Once ready, stop reading stderr so a detached server doesn't hold the Hook open.
    child.stderr?.destroy();
    if (options.detached)
        child.unref();
    return { child, socketPath: options.socketPath, stop: () => stopChild(child) };
}
function stopChild(child) {
    return new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
        }
        // A SIGKILL that leaves no exit event (the process died in the window
        // above) still resolves, so stop() cannot hang on a dead server.
        const kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL"); resolve(); }, KILL_GRACE_MS);
        kill.unref();
        child.once("exit", () => { clearTimeout(kill); resolve(); });
        child.kill("SIGTERM");
    });
}
async function socketAccepts(socketPath) {
    try {
        await stat(socketPath);
    }
    catch {
        return false;
    }
    return new Promise(resolve => {
        const ws = new WebSocket(socketUrl(socketPath), { perMessageDeflate: false });
        let settled = false;
        const finish = (ok) => { if (settled)
            return; settled = true; ws.close(); resolve(ok); };
        ws.once("open", () => finish(true));
        ws.once("error", () => finish(false));
    });
}
/** `perMessageDeflate: false` is required: offering compression makes the
 * server reject the handshake with "socket hang up" (spike, Transport). */
function socketUrl(socketPath) { return `ws+unix://${socketPath}:/`; }
/** Connect and complete `initialize` + `initialized` (spike client.mjs,
 * transcript-turn.jsonl ids 1 and the notification). */
export async function connectAppServer(socketPath, options) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const ws = new WebSocket(socketUrl(socketPath), { perMessageDeflate: false });
    await opened(ws, timeoutMs);
    const client = new AppServerConnection(ws);
    try {
        await client.request("initialize", {
            clientInfo: { name: options.clientName, title: options.clientTitle ?? options.clientName, version: options.clientVersion ?? "0.0.1" },
            capabilities: { experimentalApi: true },
        }, timeoutMs);
    }
    catch (error) {
        client.close();
        throw error;
    }
    client.notify("initialized");
    return client;
}
function opened(ws, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error("Timed out connecting to codex app-server")); }, timeoutMs);
        const onOpen = () => { cleanup(); resolve(); };
        const onError = (error) => { cleanup(); reject(error); };
        const cleanup = () => { clearTimeout(timer); ws.off("open", onOpen); ws.off("error", onError); };
        ws.once("open", onOpen);
        ws.once("error", onError);
    });
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
class AppServerConnection {
    ws;
    pending = new Map();
    nextId = 1;
    waiters = new Map();
    listeners = new Set();
    closeListeners = new Set();
    constructor(ws) {
        this.ws = ws;
        ws.on("message", data => this.handle(data));
        ws.on("close", () => {
            this.failAll(new Error("codex app-server connection closed"));
            for (const listener of [...this.closeListeners])
                listener();
            this.closeListeners.clear();
        });
        ws.on("error", () => this.failAll(new Error("codex app-server connection error")));
    }
    request(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiters.delete(id);
                reject(new Error(`Timed out waiting for codex app-server ${method}`));
            }, timeoutMs);
            this.waiters.set(id, { method, resolve, reject, timer });
            this.write({ id, method, ...(params === undefined ? {} : { params }) });
        });
    }
    notify(method, params) {
        this.write({ method, ...(params === undefined ? {} : { params }) });
    }
    async threadStart(params) { return object(await this.request("thread/start", params)); }
    async threadResume(params) {
        return object(await this.request("thread/resume", { excludeTurns: true, ...params }));
    }
    async threadLoadedList() {
        const result = object(await this.request("thread/loaded/list", {}));
        return Array.isArray(result.data) ? result.data.filter((id) => typeof id === "string") : [];
    }
    async turnStart(params) {
        const result = object(await this.request("turn/start", params));
        const turnId = object(result.turn).id;
        if (typeof turnId !== "string")
            throw new Error("codex app-server turn/start returned no turn id");
        return { turnId };
    }
    async turnSteer(params) {
        const turnId = object(await this.request("turn/steer", params)).turnId;
        if (typeof turnId !== "string")
            throw new Error("codex app-server turn/steer returned no turn id");
        return { turnId };
    }
    turnInterrupt(params) {
        return this.request("turn/interrupt", { threadId: params.threadId, turnId: params.turnId });
    }
    async interruptTurn(threadId, turnId) {
        for (const request of [...this.pending.values()]) {
            // Elicitations may carry no threadId; they still belong to this client
            // and would keep blocking the turn, so settle them too.
            if (request.threadId !== undefined && request.threadId !== threadId)
                continue;
            this.respond(request.requestId, declineResult(request.method));
        }
        await this.turnInterrupt({ threadId, turnId });
    }
    respond(requestId, result) {
        if (!this.pending.delete(requestId))
            return;
        this.write({ id: requestId, result });
    }
    respondError(requestId, code, message) {
        if (!this.pending.delete(requestId))
            return;
        this.write({ id: requestId, error: { code, message } });
    }
    on(listener) {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }
    onClose(listener) {
        this.closeListeners.add(listener);
        return () => { this.closeListeners.delete(listener); };
    }
    close() {
        this.failAll(new Error("codex app-server client closed"));
        this.listeners.clear();
        try {
            this.ws.close();
        }
        catch { /* already closed */ }
    }
    write(message) {
        if (this.ws.readyState !== WebSocket.OPEN)
            throw new Error("codex app-server connection is not open");
        this.ws.send(JSON.stringify(message));
    }
    handle(raw) {
        let message;
        try {
            message = object(JSON.parse(String(raw)));
        }
        catch {
            return;
        }
        const id = message.id;
        const method = message.method;
        if (typeof method === "string" && id !== undefined) {
            const params = object(message.params);
            const request = { requestId: id, method, params,
                ...(typeof params.threadId === "string" ? { threadId: params.threadId } : {}) };
            this.pending.set(request.requestId, request);
            this.emit({ kind: "request", ...request });
            return;
        }
        if (typeof method === "string") {
            const params = object(message.params);
            if (method === "serverRequest/resolved") {
                const requestId = params.requestId;
                this.pending.delete(requestId);
                this.emit({ kind: "resolved", requestId, ...(typeof params.threadId === "string" ? { threadId: params.threadId } : {}) });
                return;
            }
            this.emit({ kind: "notification", method, params });
            return;
        }
        if (id === undefined)
            return;
        const waiter = this.waiters.get(id);
        if (!waiter)
            return;
        this.waiters.delete(id);
        clearTimeout(waiter.timer);
        const error = object(message.error);
        if (message.error !== undefined) {
            waiter.reject(new AppServerRpcError(Number(error.code), String(error.message ?? `codex app-server ${waiter.method} failed`), waiter.method));
        }
        else {
            waiter.resolve(message.result);
        }
    }
    failAll(error) {
        for (const waiter of this.waiters.values()) {
            clearTimeout(waiter.timer);
            waiter.reject(error);
        }
        this.waiters.clear();
        this.pending.clear();
    }
    emit(event) {
        for (const listener of this.listeners)
            listener(event);
    }
}
/** The shape that declines one server request so the turn can be torn down.
 * T3 `settlePendingApprovals("cancel")` / `settlePendingUserInputs({})` and the
 * per-method responses in its `handleServerRequest` blocks. */
export function declineResult(method) {
    switch (method) {
        case "item/commandExecution/requestApproval":
        case "item/fileChange/requestApproval":
            return { decision: "cancel" };
        case "item/permissions/requestApproval":
            // `scope` is required (PermissionsRequestApprovalResponse, 0.155.1).
            return { permissions: {}, scope: "turn" };
        case "item/tool/requestUserInput":
            return { answers: {} };
        case "mcpServer/elicitation/request":
            return { action: "cancel" };
        default:
            return {};
    }
}

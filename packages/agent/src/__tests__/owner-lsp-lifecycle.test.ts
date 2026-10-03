// RC regression source only. UNRUN: no installed server or sandbox is executed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { LspConnection } from "../lsp/diagnostics.js";
import { ToolRegistry } from "../tools/registry.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../permissions/kernel-sandbox.js", () => ({ wrapWithSandbox: (argv: string[], options: { network: boolean }) => {
  if (options.network !== false) throw new Error("Diagnostic launch must forbid downloads.");
  return { argv, sandboxed: true };
} }));

const roots: string[] = [], registries: ToolRegistry[] = [], connections: LspConnection[] = [];
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-owner-lsp-"))); roots.push(root);
  fs.mkdirSync(path.join(root, "node_modules/.bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules/.bin/typescript-language-server"), "installed fixture", { mode: 0o755 });
  fs.writeFileSync(path.join(root, "a.ts"), "const n: number = 1;");
  const registry = new ToolRegistry(); registry.registerDiagnosticsTool(); registries.push(registry);
  registry.setPermissions({ mode: "full-auto", projectRoot: root, allowedPaths: [] });
  return { root, file: path.join(root, "a.ts"), registry };
}
function server(pull = true) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  child.kill = vi.fn(() => { Object.assign(child, { exitCode: 0 }); child.emit("exit", 0); return true; });
  const received: any[] = [];
  const publish = (message: unknown) => {
    const body = JSON.stringify({ jsonrpc: "2.0", ...message as object });
    child.stdout.emit("data", Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
  };
  child.stdin.on("data", bytes => {
    const frame = JSON.parse(bytes.toString().split("\r\n\r\n")[1]); received.push(frame);
    if (frame.method === "initialize") queueMicrotask(() => publish({ id: frame.id, result: { capabilities: { diagnosticProvider: pull } } }));
    if (frame.method === "textDocument/diagnostic") queueMicrotask(() => publish({ id: frame.id, result: { kind: "full", items: [] } }));
  });
  return { child, received, publish };
}
afterEach(() => {
  for (const registry of registries.splice(0)) registry.close();
  for (const connection of connections.splice(0)) connection.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks(); vi.unstubAllEnvs();
});

describe("installed diagnostics ownership", () => {
  it("never queries or launches when read permission or the shell hook denies", async () => {
    const { registry } = fixture(); vi.mocked(spawn).mockImplementation(() => server().child);
    registry.setPermissions({ ...registry.permissionConfig, rules: { allow: [], ask: [], deny: ["read_file"] } });
    await registry.execute("lsp_diagnostics", { path: "a.ts" });
    expect(spawn).not.toHaveBeenCalled();
    registry.setPermissions({ ...registry.permissionConfig, rules: undefined });
    registry.hookConfig = { PreToolUse: [{ matcher: "shell", command: "deny-server" }] };
    registry.hookExecutor = async () => ({ exitCode: 2, stdout: "", stderr: "policy", timedOut: false });
    await registry.execute("lsp_diagnostics", { path: "a.ts" });
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each(["close", "permissions", "cancel"])("does not launch after %s invalidates an outstanding approval", async change => {
    const { registry } = fixture(); registry.setPermissions({ ...registry.permissionConfig, mode: "suggest" });
    let approve!: (value: boolean) => void, asked!: () => void;
    const waiting = new Promise<void>(resolve => { asked = resolve; });
    registry.askUser = async name => name === "lsp_diagnostics" ? true : new Promise<boolean>(resolve => { approve = resolve; asked(); });
    const abort = new AbortController();
    const result = registry.execute("lsp_diagnostics", { path: "a.ts" }, abort.signal);
    await waiting;
    if (change === "close") registry.close();
    else if (change === "permissions") registry.setPermissions({ ...registry.permissionConfig, mode: "plan" });
    else abort.abort();
    approve(true); await result;
    expect(spawn).not.toHaveBeenCalled();
    if (change === "close") expect((await registry.execute("lsp_diagnostics", { path: "a.ts" })).is_error).toBe(true);
  });
  it("shares an installed server across simultaneous queries and stops only that child", async () => {
    const { registry } = fixture(), owned = server(); vi.mocked(spawn).mockReturnValue(owned.child);
    const results = await Promise.all([registry.execute("lsp_diagnostics", { path: "a.ts" }), registry.execute("lsp_diagnostics", { path: "a.ts" })]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(results.every(result => result.output.includes("no diagnostics for this file version"))).toBe(true);
    registry.close(); expect(owned.child.kill).toHaveBeenCalled();
  });
  it("does not attempt an install when no server is installed", async () => {
    const { registry, root } = fixture(); fs.unlinkSync(path.join(root, "node_modules/.bin/typescript-language-server")); vi.stubEnv("PATH", "");
    const result = await registry.execute("lsp_diagnostics", { path: "a.ts" });
    expect(spawn).not.toHaveBeenCalled(); expect(result.output).toContain("no clean result claimed");
  });
  it("blocks symlink escapes before launching any server", async () => {
    const { registry, root } = fixture(); const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-owner-outside-"))); roots.push(outside); fs.writeFileSync(path.join(outside, "secret.ts"), "private"); fs.symlinkSync(path.join(outside, "secret.ts"), path.join(root, "escape.ts"));
    await registry.execute("lsp_diagnostics", { path: "escape.ts" });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("LSP protocol cancellation", () => {
  it("cancels an outstanding RPC immediately and never sends a pre-aborted request", async () => {
    const { root } = fixture(), wire = server(); const connection = new LspConnection(wire.child, root); connections.push(connection); await connection.ready;
    const abort = new AbortController(), request = connection.request("workspace/symbol", { query: "q" }, abort.signal);
    const rejected = expect(request).rejects.toThrow("cancelled"); abort.abort(); await rejected;
    expect(wire.received.some(message => message.method === "$/cancelRequest")).toBe(true);
    const count = wire.received.length;
    await expect(connection.request("workspace/symbol", {}, abort.signal)).rejects.toThrow("cancelled");
    expect(wire.received).toHaveLength(count);
  });
  it("refuses server-requested edits and malformed frames instead of granting implicit writes", async () => {
    const { root } = fixture(), wire = server(); const connection = new LspConnection(wire.child, root); connections.push(connection); await connection.ready;
    wire.publish({ id: "edit", method: "workspace/applyEdit", params: { edit: { changes: {} } } });
    expect(wire.received.find(message => message.id === "edit").result.applied).toBe(false);
    wire.child.stdout.emit("data", Buffer.from("Content-Length: 9000000\r\n\r\n"));
    expect(wire.child.kill).toHaveBeenCalled();
  });
});

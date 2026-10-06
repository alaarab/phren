import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHooks } from "./agent-hooks.js";
import { localSocket } from "./agent-hook-stores.js";
import { autoApproveByRule, approvalRuleContext, type ApprovalRuleDraft } from "./approval-rules.js";
import { createRouteHandler, type RouteContext } from "./server-routes.js";
import { snapshot, rpc } from "./herdr.js";

const state = vi.hoisted(() => ({ home: "" }));
vi.mock("../home-paths.js", async original => ({ ...await original<object>(), homeDir: () => state.home }));
vi.mock("./herdr.js", async original => ({ ...await original<object>(), snapshot: vi.fn(), rpc: vi.fn() }));
const session = "aaaaaaaa-1111-4111-8111-111111111111";
const target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "claude", session };
const phone = generateKeyPairSync("ed25519");
const publicKey = phone.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
const foreign = generateKeyPairSync("ed25519");
function envelope(fields: object, key = phone, at = new Date().toISOString(), nonce = randomUUID()) {
  const bytes = Buffer.from(JSON.stringify({ domain: "phren-approval-rules-v1", ...fields, at, nonce }));
  return { payload: bytes.toString("base64"), signature: sign(null, bytes, key.privateKey).toString("base64"),
    publicKey: key.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64") };
}
function sshKey() {
  const size = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  return Buffer.concat([size(11), Buffer.from("ssh-ed25519"), size(32), publicKey]).toString("base64");
}

// Policy needs POSIX private files and real local callback sockets.
describe.skipIf(process.platform === "win32")("owner approval rules through HTTP and a live PermissionRequest", () => {
  let home: string, root: string, project: string, other: string, hooks: AgentHooks, server: Server, port: number;
  let previousBridge: string | undefined;
  const context = () => ({ project, harness: "claude" as const, session, computer: hostname() });
  const draft = (overrides: Partial<ApprovalRuleDraft> = {}): ApprovalRuleDraft => ({
    tool: "Bash", command: "git status", match: "exact", effect: "allow", projectName: "app", scope: { project }, ...overrides,
  });
  function http(method: string, url = "/v1/approval-rules", body?: unknown, socket = false): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
      const bytes = body === undefined ? undefined : JSON.stringify(body);
      const req = request({ headers: bytes ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bytes) } : {}, ...(socket ? { socketPath: localSocket() } : { host: "127.0.0.1", port }), method, path: url }, res => {
        let raw = ""; res.on("data", chunk => { raw += chunk; }); res.on("end", () => { try { resolve({ status: res.statusCode!, data: JSON.parse(raw) }); } catch (error) { reject(error); } });
      });
      req.on("error", reject); req.end(bytes);
    });
  }
  const add = (rule: ApprovalRuleDraft) => http("POST", undefined, envelope({ operation: "add", rule }));
  const list = async () => (await http("GET")).data.rules;
  const audit = async () => (await http("GET", "/v1/approval-rules/audit")).data.audit;
  const callback = (command: string, extra: object = {}) => http("POST", "/hook", { target, event: "PermissionRequest", cwd: project, tool: "Bash", input: { command }, ...extra }, true);
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "approval-rules-")); state.home = home;
    root = path.join(home, "bridge"); project = path.join(home, "app"); other = path.join(home, "other");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await mkdir(path.join(home, ".ssh"), { recursive: true });
    await writeFile(path.join(home, ".ssh", "authorized_keys"), `restrict,pty,command="sh ~/.local/share/phren/bridge/dispatch" ssh-ed25519 ${sshKey()} phren-iphone\n`, { mode: 0o600 });
    for (const dir of [project, other]) { await mkdir(dir); execFileSync("git", ["init", "-q", dir]); }
    previousBridge = process.env.PHREN_BRIDGE_HOME; process.env.PHREN_BRIDGE_HOME = root;
    vi.mocked(snapshot).mockReset().mockResolvedValue({ panes: [{ pane_id: target.pane, workspace_id: target.workspace, tab_id: target.tab, agent: "claude", terminal_id: "term-1", foreground_cwd: project }] });
    vi.mocked(rpc).mockReset().mockImplementation(async (_server, method) => {
      if (method === "pane.process_info") return { process_info: { foreground_processes: [{ pid: process.pid }] } };
      throw new Error(`Unexpected RPC ${method}`);
    });
    hooks = new AgentHooks(); await hooks.start();
    server = createServer(createRouteHandler({ modules: { has: () => true, modules: [], store: home }, streams: {}, agentHooks: hooks } as unknown as RouteContext));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); port = (server.address() as { port: number }).port;
  });
  afterEach(async () => {
    hooks?.close(); if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousBridge === undefined) delete process.env.PHREN_BRIDGE_HOME; else process.env.PHREN_BRIDGE_HOME = previousBridge;
    await rm(home, { recursive: true, force: true });
  });


  it("REPRO: an agent-enrolled key can create its own policy", async () => {
    const raw = foreign.publicKey.export({type: "spki", format: "der"}).subarray(-32);
    const wire = Buffer.from(sshKey(), "base64"); raw.copy(wire, 19);
    await writeFile(path.join(home, ".ssh", "authorized_keys"), `restrict,pty,command="sh ~/.local/share/phren/bridge/dispatch" ssh-ed25519 ${wire.toString("base64")} phren-iphone\n`, {mode: 0o600});
    expect((await http("POST", undefined, envelope({operation: "add", rule: draft()}, foreign))).status).toBe(200);
    expect((await callback("git status")).data.hookSpecificOutput.decision.behavior).toBe("allow");
  });
  it("REPRO: reordering signed operations restores a revoked rule", async () => {
    await add(draft()); const [rule] = await list();
    expect((await http("DELETE", undefined, envelope({operation: "revoke", id: rule.id}))).status).toBe(200);
    expect((await callback("git status")).data).toEqual({});
    const file = path.join(root, "approval-rules.json");
    const policy = JSON.parse(await readFile(file, "utf8")); policy.operations.reverse();
    await writeFile(file, JSON.stringify(policy));
    expect((await callback("git status")).data.hookSpecificOutput.decision.behavior).toBe("allow");
  });
  it("REPRO: deleting audit history silently resets the ledger", async () => {
    await add(draft()); await callback("git status"); expect(await audit()).toHaveLength(1);
    await rm(path.join(root, "approval-rules-audit.json")); expect(await audit()).toEqual([]);
    expect((await callback("git status")).data.hookSpecificOutput.decision.behavior).toBe("allow");
    expect(await audit()).toHaveLength(1);
  });
  it("REPRO: an unregistered directory inherits project scope through a forged gitfile", async () => {
    await add(draft({command: "npm test"}));
    expect((await callback("npm test", {cwd: other})).data).toEqual({});
    await rm(path.join(other, ".git"), {recursive: true, force: true});
    await writeFile(path.join(other, ".git"), `gitdir: ${project}/.git\n`);
    expect(await approvalRuleContext(other, "claude", session)).toEqual(context());
    expect((await callback("npm test", {cwd: other})).data.hookSpecificOutput.decision.behavior).toBe("allow");
  });
  it("REPRO: git status runs repository-configured arbitrary code after auto-allow", async () => {
    const script = path.join(home, "fsmonitor"), marker = path.join(home, "executed");
    await writeFile(script, `#!/bin/sh\nprintf executed > '${marker}'\nprintf '\\0'\n`, {mode: 0o700});
    execFileSync("git", ["-C", project, "config", "core.fsmonitor", script]);
    await add(draft());
    expect((await callback("git status")).data.hookSpecificOutput.decision.behavior).toBe("allow");
    execFileSync("git", ["status"], {cwd: project, stdio: "pipe"});
    expect(await readFile(marker, "utf8")).toBe("executed");
  });
  it("REPRO: clock rollback revives an expired rule", async () => {
    const now = Date.now(); await add(draft({until: new Date(now - 1000).toISOString()}));
    expect(await autoApproveByRule("Bash", {command: "git status"}, context())).toBe(false);
    const clock = vi.spyOn(Date, "now").mockReturnValue(now - 2000);
    try { expect(await autoApproveByRule("Bash", {command: "git status"}, context())).toBe(true); }
    finally { clock.mockRestore(); }
  });
  it("rejects additional shell, path and Git option tricks", async () => {
    await add(draft({command: "*", match: "glob"}));
    for (const command of ["./npm test", "/usr/bin/npm test", "X=1 npm test", "git status && npm test", "git status | cat", "`npm test`", "(npm test)", "'npm' test", '"npm" test', "git status -c core.fsmonitor=x", "git -c core.fsmonitor=x status", "npm test;git status"]) {
      expect((await callback(command)).data, command).toEqual({});
    }
  });
  it("REPRO: a previously approved test command executes changed project scripts", async () => {
    const marker = path.join(home, "npm-executed");
    await writeFile(path.join(project, "package.json"), JSON.stringify({scripts: {test: "true"}}));
    await add(draft({command: "npm test"}));
    await writeFile(path.join(project, "package.json"), JSON.stringify({scripts: {test: `printf executed > '${marker}'`}}));
    expect((await callback("npm test")).data.hookSpecificOutput.decision.behavior).toBe("allow");
    execFileSync("/home/alaarab/.local/share/mise/installs/node/26.7.0/bin/npm", ["test"], {cwd: project, stdio: "pipe"});
    expect(await readFile(marker, "utf8")).toBe("executed");
  });
  it("REPRO: bare command matching cannot detect an inherited shell function", async () => {
    const marker = path.join(home, "function-executed");
    await add(draft());
    expect((await callback("git status")).data.hookSpecificOutput.decision.behavior).toBe("allow");
    execFileSync("/bin/bash", ["-c", "git status"], {cwd: project, env: {...process.env, "BASH_FUNC_git%%": `() { printf executed > '${marker}'; }`}, stdio: "pipe"});
    expect(await readFile(marker, "utf8")).toBe("executed");
  });

});

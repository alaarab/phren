import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHooks } from "./agent-hooks.js";
import { localSocket } from "./agent-hook-stores.js";
import { approvalRuleEffect, approvalRuleContext, type ApprovalRuleDraft } from "./approval-rules.js";
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
    tool: "Bash", command: "git status", match: "exact", effect: "deny", projectName: "app", scope: { project }, ...overrides,
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
      if (method === "session.snapshot") return { snapshot: await vi.mocked(snapshot)() };
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

  it("denies a signed matching rule without creating a pending approval", async () => {
    expect((await add(draft())).status).toBe(200);
    expect((await callback("git status")).data).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: "Denied by an owner approval rule." } } });
    expect(hooks.approval(target)).toBeUndefined();
    const saved = JSON.parse(await readFile(path.join(root, "approval-rules.json"), "utf8"));
    expect(saved.operations[0]).toHaveProperty("signature");
  });

  it("rejects unsigned, foreign, forged, wrong-operation, stale and replayed owner mutations", async () => {
    expect((await http("POST", undefined, draft())).status).toBe(400);
    expect((await http("POST", undefined, envelope({ operation: "add", rule: draft() }, foreign))).status).toBe(403);
    const signed = envelope({ operation: "add", rule: draft() });
    const tampered = { ...signed, payload: Buffer.from(JSON.stringify({ operation: "add", rule: draft({ command: "npm test" }) })).toString("base64") };
    expect((await http("POST", undefined, tampered)).status).toBe(403);
    expect((await http("DELETE", undefined, signed)).status).toBe(403);
    expect((await http("POST", undefined, envelope({ operation: "add", rule: draft() }, phone, "2000-01-01T00:00:00.000Z"))).status).toBe(403);
    expect((await http("POST", undefined, signed)).status).toBe(200);
    expect((await http("POST", undefined, signed)).status).toBe(409);
    expect(await list()).toHaveLength(1);
  });

  it.each(["missing", "empty", "malformed", "missing operations", "forged", "insecure"])(
    "preserves the ordinary phone PermissionRequest path with %s policy", async kind => {
      const file = path.join(root, "approval-rules.json");
      if (kind === "empty") await writeFile(file, '{"operations":[]}', { mode: 0o600 });
      if (kind === "malformed") await writeFile(file, '{broken', { mode: 0o600 });
      if (kind === "missing operations") await writeFile(file, '{}', { mode: 0o600 });
      if (kind === "forged" || kind === "insecure") {
        await add(draft());
        if (kind === "insecure") await chmod(file, 0o644);
        else {
          const policy = JSON.parse(await readFile(file, "utf8"));
          policy.operations[0].signature = Buffer.alloc(64).toString("base64");
          await writeFile(file, JSON.stringify(policy));
        }
      }
      const settings = await http("GET");
      expect(settings.status).toBe(["missing", "empty"].includes(kind) ? 200 : 409);
      // Without an active phone, preserve the legacy terminal fallback.
      expect((await callback("git status")).data).toEqual({});
      hooks.overview.renew("default");
      let completed = false;
      const held = callback("git status").then(reply => { completed = true; return reply; });
      await vi.waitFor(() => expect(hooks.approval(target)?.toolName).toBe("Bash"));
      expect(completed).toBe(false);
      const approval = hooks.approval(target)!;
      expect(approval.message).toContain("git status");
      await hooks.answer(target, approval.actionId, "approve");
      expect((await held).data).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
      expect(hooks.approval(target)).toBeUndefined();
    });

  it("rejects the removed allow effect, including signed legacy grants", async () => {
    const legacy = { ...draft(), effect: "allow" };
    expect((await http("POST", undefined, envelope({ operation: "add", rule: legacy }))).status).toBe(400);
    await writeFile(path.join(root, "approval-rules.json"), JSON.stringify({ operations: [envelope({ operation: "add", rule: legacy })] }), { mode: 0o600 });
    expect((await http("GET")).status).toBe(409);
    expect((await callback("git status")).data).toEqual({});
  });

  it("intersects scopes and exact tools, and preserves baseline for unknown context", async () => {
    expect((await add(draft({ scope: context() }))).status).toBe(200);
    expect(await approvalRuleEffect("Bash", { command: "git status" }, context())).toBe("deny");
    for (const changed of [{ project: other }, { harness: "codex" }, { session: "new" }, { computer: "other" }]) {
      expect(await approvalRuleEffect("Bash", { command: "git status" }, { ...context(), ...changed } as never)).toBeUndefined();
    }
    expect(await approvalRuleEffect("shell", { command: "git status" }, context())).toBeUndefined();
    expect(await approvalRuleEffect("Bash", { command: "git status" }, undefined)).toBeUndefined();
  });

  it("anchors exact, prefix and glob matches without interpreting regex syntax", async () => {
    for (const [match, command, expected] of [
      ["exact", "git status", undefined], ["prefix", "git status", "deny"],
      ["glob", "git sta?us*", "deny"], ["glob", "git [s]tatus*", undefined],
    ] as const) {
      await add(draft({ match, command }));
      expect(await approvalRuleEffect("Bash", { command: "git status --short" }, context()), `${match} ${command}`).toBe(expected);
      expect(await approvalRuleEffect("Bash", { command: "npm test" }, context())).toBeUndefined();
      const [rule] = await list(); await http("DELETE", undefined, envelope({ operation: "revoke", id: rule.id }));
    }
  });

  it("lets the owner toggle and revoke individual rules, with deny preceding ask", async () => {
    await add(draft({ effect: "always-ask" })); await add(draft());
    const [ask, deny] = await list();
    expect(ask.enabled).toBe(true); expect(deny.enabled).toBe(true);
    expect(await approvalRuleEffect("Bash", { command: "git status" }, context())).toBe("deny");
    for (const enabled of [false, true, false]) {
      const change = { operation: "set-enabled", id: deny.id, enabled };
      expect((await http("POST", undefined, envelope(change, foreign))).status).toBe(403);
      expect((await http("POST", undefined, envelope(change))).status).toBe(200);
      expect(await approvalRuleEffect("Bash", { command: "git status" }, context())).toBe(enabled ? "deny" : "always-ask");
      expect((await list()).find((r: any) => r.id === ask.id).enabled).toBe(true);
    }
    hooks.overview.renew("default");
    const held = callback("git status");
    await vi.waitFor(() => expect(hooks.approval(target)).toBeDefined());
    await hooks.answer(target, hooks.approval(target)!.actionId, "deny");
    expect((await held).data.hookSpecificOutput.decision.behavior).toBe("deny");
    expect((await http("DELETE", undefined, envelope({ operation: "revoke", id: ask.id }))).status).toBe(200);
    expect(await approvalRuleEffect("Bash", { command: "git status" }, context())).toBeUndefined();
  });

  it("saving an ask rule leaves the existing request pending until a separate answer", async () => {
    hooks.overview.renew("default");
    const held = callback("git status");
    await vi.waitFor(() => expect(hooks.approval(target)).toBeDefined());
    const id = hooks.approval(target)!.actionId;
    expect((await add(draft({ effect: "always-ask", command: "another command" }))).status).toBe(200);
    expect(hooks.approval(target)?.actionId).toBe(id);
    await hooks.answer(target, id, "deny");
    expect((await held).data.hookSpecificOutput.decision.behavior).toBe("deny");
  });

  it("checks expiry at enforcement time and keeps expired rules visible", async () => {
    await add(draft({ until: "2000-01-01T00:00:00.000Z" }));
    expect(await list()).toHaveLength(1); expect((await callback("git status")).data).toEqual({});
  });

  it("applies deny to composed commands without an auto-allow eligibility grammar", async () => {
    await add(draft({ command: "*", match: "glob" }));
    for (const command of ["rm -rf /tmp/x", "npm test && rm -rf x", "git status; sudo x", "$(npm test)"]) {
      expect((await callback(command)).data.hookSpecificOutput.decision.behavior, command).toBe("deny");
    }
  });

  it("does not enforce rules on other harnesses or pre-execution callbacks", async () => {
    await add(draft());
    for (const source of ["codex", "copilot", "opencode", "phren"]) {
      vi.mocked(snapshot).mockResolvedValue({ panes: [{ pane_id: target.pane, workspace_id: target.workspace, tab_id: target.tab,
        agent: source, terminal_id: "term-1", foreground_cwd: project }] });
      expect((await callback("git status", { target: { ...target, source } })).data).toEqual({});
    }
    vi.mocked(snapshot).mockResolvedValue({ panes: [{ pane_id: target.pane, workspace_id: target.workspace, tab_id: target.tab,
      agent: "claude", terminal_id: "term-1", foreground_cwd: project }] });
    expect((await callback("git status", { event: "PreToolUse" })).data).toEqual({});
  });

  it("rejects forged gitdir scope and shares legitimate linked-worktree scope", async () => {
    await add(draft());
    const foreignCheckout = path.join(home, "foreign-checkout"); await mkdir(foreignCheckout);
    await writeFile(path.join(foreignCheckout, ".git"), `gitdir: ${path.join(project, ".git")}\n`);
    expect(await approvalRuleContext(foreignCheckout, "claude", session)).toBeUndefined();
    expect((await callback("git status", { cwd: foreignCheckout })).data).toEqual({});
    execFileSync("git", ["-C", project, "config", "core.worktree", project]);
    expect((await callback("git status", { cwd: foreignCheckout })).data).toEqual({});
    expect((await callback("git status", { cwd: other })).data).toEqual({});
    execFileSync("git", ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial"]);
    const worktree = path.join(home, "worktree"); execFileSync("git", ["-C", project, "worktree", "add", "-qb", "test", worktree]);
    expect(await approvalRuleContext(worktree, "claude", session)).toEqual(context());
    expect((await callback("git status", { cwd: worktree })).data.hookSpecificOutput.decision.behavior).toBe("deny");
  });
});

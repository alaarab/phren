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

  it("auto-allows a signed rule on the callback and records the exact owner and rule", async () => {
    expect((await add(draft())).status).toBe(200);
    const [rule] = await list();
    expect((await callback("git status")).data).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    expect(await audit()).toEqual([expect.objectContaining({ ruleId: rule.id, tool: "Bash", command: "git status", context: context(),
      owner: createHash("sha256").update(publicKey).digest("hex") })]);
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

  it("intersects every scope and exact tool without accepting an unknown context", async () => {
    expect((await add(draft({ scope: context() }))).status).toBe(200);
    expect(await autoApproveByRule("Bash", { command: "git status" }, context())).toBe(true);
    for (const changed of [{ project: other }, { harness: "codex" }, { session: "new" }, { computer: "other" }]) {
      expect(await autoApproveByRule("Bash", { command: "git status" }, { ...context(), ...changed } as never)).toBe(false);
    }
    expect(await autoApproveByRule("shell", { command: "git status" }, context())).toBe(false);
    expect(await autoApproveByRule("Bash", { command: "git status" }, undefined)).toBe(false);
    expect(await audit()).toHaveLength(1);
  });

  it("anchors exact, prefix and glob matches without interpreting regex syntax", async () => {
    for (const [match, command, expected] of [
      ["exact", "git status", false], ["prefix", "git status", true],
      ["glob", "git sta?us*", true], ["glob", "git [s]tatus*", false],
    ] as const) {
      await add(draft({ match, command }));
      expect(await autoApproveByRule("Bash", { command: "git status --short" }, context()), `${match} ${command}`).toBe(expected);
      expect(await autoApproveByRule("Bash", { command: "npm test" }, context())).toBe(false);
      const [rule] = await list(); await http("DELETE", undefined, envelope({ operation: "revoke", id: rule.id }));
    }
    expect(await audit()).toHaveLength(2);
  });

  it("always-ask beats allow until the owner revokes that rule by stable ID", async () => {
    await add(draft()); await add(draft({ effect: "always-ask", command: "git *", match: "glob" }));
    expect((await callback("git status")).data).toEqual({}); expect(await audit()).toEqual([]);
    const rules = await list(), ask = rules.find((rule: any) => rule.effect === "always-ask");
    expect((await http("DELETE", undefined, envelope({ operation: "revoke", id: ask.id }))).status).toBe(200);
    expect((await callback("git status")).data.hookSpecificOutput.decision.behavior).toBe("allow");
    expect((await list()).map((rule: any) => rule.id)).toEqual([rules[0].id]);
    await http("DELETE", undefined, envelope({ operation: "revoke", id: rules[0].id }));
    expect((await callback("git status")).data).toEqual({});
  });

  it("checks expiry at enforcement time and preserves expired rules for review", async () => {
    await add(draft({ until: "2000-01-01T00:00:00.000Z" }));
    expect(await list()).toHaveLength(1); expect((await callback("git status")).data).toEqual({}); expect(await audit()).toEqual([]);
  });

  it("never lets a broad glob allow shell composition, risky commands, wrappers or sandbox widening", async () => {
    await add(draft({ command: "*", match: "glob" }));
    expect((await callback("git status")).data.hookSpecificOutput.decision.behavior).toBe("allow");
    for (const command of ["rm -rf /tmp/x", "git push --force", "sudo npm test", "npm run deploy", "npm test && rm -rf x", "git status; sudo x", "git status\nrm x", "npm test | sh", "npm test > x", "$(npm test)", "bash -c npm", "env npm test", "git -c alias.x=!sh status", "git diff --output=x", "git status -C /other", "npm test --prefix /other"]) {
      expect((await callback(command)).data, command).toEqual({});
    }
    expect((await callback("npm test", { input: { command: "npm test", sandbox_permissions: "require_escalated" } })).data).toEqual({});
    expect(await audit()).toHaveLength(1);
  });

  it("fails closed on policy forgery, insecure files and unwritable audit", async () => {
    await add(draft());
    const file = path.join(root, "approval-rules.json"), original = await readFile(file, "utf8");
    const forged = JSON.parse(original); forged.operations[0].payload = envelope({ operation: "add", rule: draft({ command: "npm test" }) }).payload;
    await writeFile(file, JSON.stringify(forged));
    expect((await callback("npm test")).data).toEqual({});
    await writeFile(file, original); await chmod(file, 0o644);
    expect((await callback("git status")).data).toEqual({});
    await chmod(file, 0o600); await mkdir(path.join(root, "approval-rules-audit.json"));
    expect((await callback("git status")).data).toEqual({});
  });

  it("rejects a foreign checkout that forges a gitdir pointer to the granted repository", async () => {
    await add(draft({ command: "npm test" }));
    expect((await callback("npm test")).data.hookSpecificOutput.decision.behavior).toBe("allow");
    const foreignCheckout = path.join(home, "foreign-checkout"); await mkdir(foreignCheckout);
    await writeFile(path.join(foreignCheckout, ".git"), `gitdir: ${path.join(project, ".git")}\n`);
    vi.mocked(snapshot).mockResolvedValue({ panes: [{ pane_id: target.pane, workspace_id: target.workspace, tab_id: target.tab,
      agent: "claude", terminal_id: "term-1", foreground_cwd: foreignCheckout }] });
    expect((await callback("npm test", { cwd: foreignCheckout })).data).toEqual({});
    expect(await audit()).toHaveLength(1);
  });

  it("offers the exact project-scoped rule on a held approval card without creating a grant", async () => {
    hooks.overview.renew("default");
    const held = callback("npm test");
    for (let i = 0; i < 100 && !hooks.approval(target); i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(hooks.approval(target)?.ruleSuggestion).toEqual({ tool: "Bash", command: "npm test", match: "exact", effect: "allow", projectName: "app", scope: { project, harness: "claude" } });
    expect(await list()).toEqual([]);
    hooks.close(); expect((await held).data).toEqual({});
  });

  it("binds callback project to the live pane, rejects changed cwd, and shares scope across linked worktrees", async () => {
    await add(draft());
    expect((await callback("git status", { cwd: other })).data).toEqual({});
    expect((await callback("git status", { cwd: undefined })).data).toEqual({});
    execFileSync("git", ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial"]);
    const worktree = path.join(home, "worktree"); execFileSync("git", ["-C", project, "worktree", "add", "-qb", "test", worktree]);
    expect(await approvalRuleContext("", "claude", session)).toBeUndefined();
    expect(await approvalRuleContext(worktree, "claude", session)).toEqual(context());
    expect((await callback("git status", { cwd: worktree })).data.hookSpecificOutput.decision.behavior).toBe("allow");
  });
});

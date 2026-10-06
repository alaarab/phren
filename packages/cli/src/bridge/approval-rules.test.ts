import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
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

const state = vi.hoisted(() => ({ home: "", spawns: [] as string[] }));
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const tracked = Object.assign((...args: any[]) => {
    state.spawns.push(args[0]); return (actual.execFile as any)(...args);
  }, { [promisify.custom]: (...args: any[]) => {
    state.spawns.push(args[0]); return (actual.execFile as any)[promisify.custom](...args);
  } });
  return { ...actual, execFile: tracked };
});
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
function sshKey(raw = publicKey) {
  const size = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  return Buffer.concat([size(11), Buffer.from("ssh-ed25519"), size(32), raw]).toString("base64");
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
      // No-rule callbacks must add no subprocesses to either legacy approval path.
      state.spawns = [];
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
      expect(state.spawns).toEqual([]);
    });

  it("rejects commandless and MCP tool rule creation, leaving conductor grants independent", async () => {
    for (const tool of ["mcp__phren__dispatch", "dispatch", "Read", "shell"]) {
      expect((await add(draft({ tool } as never))).status).toBe(400);
    }
    const { command: _command, ...commandless } = draft();
    expect((await http("POST", undefined, envelope({ operation: "add", rule: commandless }))).status).toBe(400);
    await add(draft({ command: "*", match: "glob" }));
    await writeFile(path.join(root, "conductor.yaml"), "grants:\n  - scope: global\n    actions: [dispatch]\n", { mode: 0o600 });
    state.spawns = [];
    expect((await callback("", { tool: "mcp__phren__dispatch", input: { project: "app", prompt: "work" } })).data
      .hookSpecificOutput.decision.behavior).toBe("allow");
    expect(state.spawns).toEqual([]);
  });

  it("discloses the original signer relative to each phone and lets this phone revoke an agent-enrolled deny", async () => {
    const foreignRaw = foreign.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
    await writeFile(path.join(home, ".ssh", "authorized_keys"),
      `restrict,pty,command="sh ~/.local/share/phren/bridge/dispatch" ssh-ed25519 ${sshKey()} phren-iphone\n` +
      `restrict,pty,command="sh ~/.local/share/phren/bridge/dispatch" ssh-ed25519 ${sshKey(foreignRaw)} phren-iphone\n`);
    await add(draft({ effect: "always-ask" }));
    expect((await http("POST", undefined, envelope({ operation: "add", rule: draft() }, foreign))).status).toBe(200);
    const listed = (key: Buffer) => http("GET", "/v1/approval-rules?pairedKey=" + encodeURIComponent(key.toString("base64")));
    const [own, agent] = (await listed(publicKey)).data.rules;
    expect(own.matchesPairedKey).toBe(true);
    expect(agent.matchesPairedKey).toBe(false);
    expect(agent.signerFingerprint).toBe("SHA256:" + createHash("sha256").update(foreignRaw).digest("base64").replace(/=+$/, ""));
    expect((await listed(foreignRaw)).data.rules.map((rule: any) => rule.matchesPairedKey)).toEqual([false, true]);
    expect((await callback("git status")).data.hookSpecificOutput.decision.behavior).toBe("deny");
    // Toggling with this phone must not relabel who created the rule.
    await http("POST", undefined, envelope({ operation: "set-enabled", id: agent.id, enabled: false }));
    expect((await listed(publicKey)).data.rules[1].matchesPairedKey).toBe(false);
    expect((await http("DELETE", undefined, envelope({ operation: "revoke", id: agent.id }))).status).toBe(200);
    expect((await listed(publicKey)).data.rules.map((rule: any) => rule.id)).toEqual([own.id]);
    expect((await callback("git status")).data).toEqual({});
  });

  it.each(["disabled", "expired", "command", "session", "harness", "computer"])(
    "skips subprocesses for an inapplicable %s rule", async kind => {
      const rule = draft(kind === "expired" ? { until: "2000-01-01T00:00:00.000Z" }
        : kind === "command" ? { command: "npm test" }
        : ["session", "harness", "computer"].includes(kind) ? { scope: { project, [kind]: kind === "harness" ? "codex" : "other" } } : {});
      await add(rule);
      if (kind === "disabled") await http("POST", undefined, envelope({ operation: "set-enabled", id: (await list())[0].id, enabled: false }));
      state.spawns = [];
      expect((await callback("git status")).data).toEqual({});
      expect(state.spawns).toEqual([]);
    });

  it("falls back promptly to ordinary approval when Git context times out", async () => {
    await add(draft());
    const bin = path.join(home, "bin"); await mkdir(bin);
    await writeFile(path.join(bin, "git"), "#!/bin/sh\nexec /bin/sleep 5\n", { mode: 0o700 });
    const previousPath = process.env.PATH;
    process.env.PATH = bin + path.delimiter + previousPath;
    try {
      const start = Date.now();
      expect((await callback("git status")).data).toEqual({});
      expect(Date.now() - start).toBeLessThan(2000);
      expect(hooks.approval(target)).toBeUndefined();
    } finally { process.env.PATH = previousPath; }
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

  it.each(["missing", "empty", "malformed"])("VERIFY: %s policy avoids the prior delayed-Git regression", async kind => {
    if (kind !== "missing") await writeFile(path.join(root, "approval-rules.json"), kind === "empty" ? '{"operations":[]}' : '{broken', { mode: 0o600 });
    const bin = path.join(home, "bin"), log = path.join(home, "git-probe.log");
    await mkdir(bin);
    // Log BEFORE sleeping so a timeout cannot hide an attempted subprocess.
    await writeFile(path.join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n/usr/bin/sleep 0.15\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
    const oldPath = process.env.PATH;
    const ordinary: number[] = [], delayed: number[] = [];
    try {
      await callback("git status");
      state.spawns = [];
      for (let i = 0; i < 10; i++) {
        process.env.PATH = oldPath;
        let start = performance.now();
        expect((await callback("git status")).data).toEqual({});
        ordinary.push(performance.now() - start);
        process.env.PATH = `${bin}:${oldPath}`;
        start = performance.now();
        expect((await callback("git status")).data).toEqual({});
        delayed.push(performance.now() - start);
      }
      expect(state.spawns).toEqual([]);
      expect(await readFile(log, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; })).toBe("");
      expect(Math.max(...delayed)).toBeLessThan(150);
      const median = (values: number[]) => [...values].sort((a, b) => a - b)[5].toFixed(2);
      console.log(`VERIFY ${kind}: 0 subprocesses; median ordinary=${median(ordinary)}ms delayed=${median(delayed)}ms; delayed max=${Math.max(...delayed).toFixed(2)}ms`);
    } finally { process.env.PATH = oldPath; }
  });

  it("VERIFY: an enrolled agent cannot forge phone attribution or overwrite its creator with metadata", async () => {
    const foreignRaw = foreign.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
    await writeFile(path.join(home, ".ssh", "authorized_keys"),
      `restrict,pty,command="sh ~/.local/share/phren/bridge/dispatch" ssh-ed25519 ${sshKey()} phren-iphone\n` +
      `restrict,pty,command="sh ~/.local/share/phren/bridge/dispatch" ssh-ed25519 ${sshKey(foreignRaw)} phren-iphone\n`);
    const forged = envelope({ operation: "add", rule: draft() }, foreign);
    forged.publicKey = publicKey.toString("base64");
    expect((await http("POST", undefined, forged)).status).toBe(403);
    for (const fields of [{ owner: createHash("sha256").update(publicKey).digest("hex") }, { matchesPairedKey: true }, { signerFingerprint: "phone" }]) {
      expect((await http("POST", undefined, envelope({ operation: "add", rule: { ...draft(), ...fields } }, foreign))).status).toBe(400);
    }
    expect((await http("POST", undefined, envelope({ operation: "add", rule: draft() }, foreign))).status).toBe(200);
    const readForPhone = () => http("GET", "/v1/approval-rules?pairedKey=" + encodeURIComponent(publicKey.toString("base64")));
    const [agent] = (await readForPhone()).data.rules;
    expect(agent.matchesPairedKey).toBe(false);
    // An agent's own GET query affects only that response, never the phone's later GET.
    await http("GET", "/v1/approval-rules?pairedKey=" + encodeURIComponent(foreignRaw.toString("base64")));
    expect((await readForPhone()).data.rules[0].matchesPairedKey).toBe(false);
    expect((await http("POST", undefined, envelope({ operation: "set-enabled", id: agent.id, enabled: true }))).status).toBe(200);
    expect((await readForPhone()).data.rules[0]).toMatchObject({ matchesPairedKey: false, signerFingerprint: agent.signerFingerprint });
  });

  it.each(["always-ask", "deny"] as const)("VERIFY: saving a matching %s rule never answers the held request", async effect => {
    hooks.overview.renew("default");
    let completed = false;
    const held = callback("git status").then(result => { completed = true; return result; });
    await vi.waitFor(() => expect(hooks.approval(target)).toBeDefined());
    const id = hooks.approval(target)!.actionId;
    expect((await add(draft({ effect }))).status).toBe(200);
    expect(hooks.approval(target)?.actionId).toBe(id);
    expect(completed).toBe(false);
    await hooks.answer(target, id, "deny");
    expect((await held).data.hookSpecificOutput.decision.behavior).toBe("deny");
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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer as createNetServer, type Server } from "node:net";
import { request } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { planAgentHooks, upgradeKeys } from "./install.js";
import { TranscriptReader, transcriptPath, visibleEvent, historicalImage } from "./transcripts.js";
import { dispatch } from "./transport.js";

const session = "aaaaaaaa-1111-4111-8111-111111111111";
const target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "codex", session };
const row = (text: string) => ({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("Phren Hook boundaries", () => {
  it("migrates only recognized Phren keys and preserves unrelated restrictions", () => {
    const key = 'restrict,port-forwarding,permitopen="127.0.0.1:*",command="python3 ~/.local/share/phren/chat-progress.py" ssh-ed25519 AAAA phren-iphone\n';
    const other = key.replace("phren-iphone", "personal");
    const custom = key.replace("python3 ~/.local/share/phren/chat-progress.py", "/custom/policy");
    const result = upgradeKeys(key + other + custom);
    expect(result.changed).toBe(1);
    expect(result.text).toContain('restrict,pty,port-forwarding,permitopen="127.0.0.1:*",command="sh ~/.local/share/phren/bridge/dispatch"');
    expect(result.text).toContain(other + custom);
    expect(upgradeKeys(result.text).changed).toBe(0);
  });
  it("rejects arbitrary commands, shells, and malformed terminal destinations", async () => {
    for (const command of ["", "sh", "phren-hook v1 pipe; id", "phren-hook v1 terminal ../../work", "phren-hook v1 terminal work\necho secret", "phren-hook v2 pipe"]) {
      await expect(dispatch(command)).rejects.toThrow("only permits");
    }
  });
  it("excludes private reasoning and sidechain events", () => {
    expect(visibleEvent({ type: "response_item", payload: { type: "reasoning", text: "private" } }, "codex")).toBeUndefined();
    expect(visibleEvent({ type: "assistant", isSidechain: true, message: {} }, "claude")).toBeUndefined();
    expect(visibleEvent({ type: "assistant.message", agentId: "subagent", data: { content: "private" } }, "copilot")).toBeUndefined();
    expect(JSON.stringify(visibleEvent({ type: "assistant", message: { content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Visible" }] } }, "claude"))).not.toContain("private");
  });
});

describe.skipIf(process.platform === "win32")("standalone Phren service", () => {
  let root: string, hook: ChildProcess, herdr: Server, log: string, record: string, commands: { method: string; params: Record<string, unknown> }[];
  let current = session;
  function api(url: string, body?: unknown): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request({ socketPath: path.join(root, "bridge/hook.sock"), path: url, method: payload === undefined ? "GET" : "POST",
        headers: payload ? { "Content-Length": Buffer.byteLength(payload), "Content-Type": "application/json" } : {} }, res => {
        let data = ""; res.on("data", bytes => data += bytes); res.on("end", () => resolve({ status: res.statusCode!, data: JSON.parse(data) }));
      });
      req.on("error", reject); req.end(payload);
    });
  }
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "phren-hook-"));
    // Darwin's Unix socket paths are limited to 104 bytes.
    root = await import("node:fs/promises").then(fs => fs.realpath(root));
    if (root.length > 55) {
      const short = await mkdtemp("/tmp/phren-hook-"); await rm(root, { recursive: true }); root = short;
    }
    commands = []; current = session; log = "";
    await mkdir(path.join(root, "herdr"));
    await mkdir(path.join(root, "codex/sessions/2026/09/10"), { recursive: true });
    record = path.join(root, `codex/sessions/2026/09/10/rollout-2026-09-10T00-00-00-${session}.jsonl`);
    await writeFile(record, JSON.stringify({ type: "session_meta", payload: { id: session } }) + "\n" + JSON.stringify(row("First message")) + "\n");
    herdr = createNetServer(socket => {
      socket.on("error", () => { /* A cancelled client may close before the fixture's reply. */ });
      let pending = ""; socket.on("data", bytes => {
        pending += bytes;
        if (!pending.includes("\n")) return;
        const req = JSON.parse(pending.split("\n")[0]); commands.push(req);
        const pane = { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", terminal_id: "term-one", agent: "codex", agent_status: "working",
          agent_session: { kind: "id", agent: "codex", value: current }, cwd: root };
        const snapshot = { panes: [pane], workspaces: [{ workspace_id: "w1", label: "Project" }], tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1" }] };
        socket.end(JSON.stringify({ id: req.id, result: req.method === "session.snapshot" ? { snapshot }
          : req.method === "pane.process_info" ? { process_info: { foreground_processes: [{ pid: process.pid }] } } : { ok: true } }) + "\n");
      });
    });
    await new Promise<void>(resolve => herdr.listen(path.join(root, "herdr/herdr.sock"), resolve));
    hook = spawn(process.execPath, [path.resolve("packages/cli/dist/bridge-hook.mjs"), "serve"], { env: { ...process.env,
      PHREN_BRIDGE_HOME: path.join(root, "bridge"), PHREN_HERDR_HOME: path.join(root, "herdr"), CODEX_HOME: path.join(root, "codex") }, stdio: ["ignore", "ignore", "pipe"] });
    hook.stderr!.on("data", bytes => log += bytes);
    let ready = false;
    for (let i = 0; i < 80; i++) { try { ready = (await api("/v1/health")).status === 200; } catch { /* startup */ } if (ready) break; await sleep(25); }
    expect(ready, log).toBe(true);
  });
  afterEach(async () => {
    if (hook && hook.exitCode === null) { hook.kill("SIGTERM"); await once(hook, "exit"); }
    if (herdr) await new Promise<void>(resolve => herdr.close(() => resolve()));
    if (root) await rm(root, { recursive: true, force: true });
  });
  it("discovers workspaces through a private protocol without any TCP helper", async () => {
    const health = await api("/v1/health");
    expect(health.data.product).toBe("phren-hook"); expect(health.data.protocol).toBe(1);
    const workspaces = await api("/v1/workspaces?mux=herdr:default");
    expect(workspaces.data.groups[0].children[0].id).toBe("w1:t1");
    expect((await api("/v1/workspaces/panes?groupId=w1&childId=w1:t1")).data.panes[0].sessionId).toBe(session);
    expect((await api("/v1/activity")).data.events[0].directory).toBe(root);
    const permissions = await import("node:fs/promises").then(fs => fs.stat(path.join(root, "bridge/hook.sock")));
    expect(permissions.mode & 0o777).toBe(0o600);
  });
  it("validates the full destination at send time and never retries uncertain delivery", async () => {
    expect((await api("/v1/prompt", { target, text: "one message" })).status).toBe(200);
    expect(commands.filter(c => c.method === "agent.prompt")).toHaveLength(1);
    current = "bbbbbbbb-1111-4111-8111-111111111111";
    for (const wrong of [target, { ...target, workspace: "w2" }, { ...target, tab: "w2:t1" }, { ...target, source: "claude" }]) {
      expect((await api("/v1/prompt", { target: wrong, text: "must not send" })).status).toBe(409);
    }
    expect(commands.filter(c => c.method === "agent.prompt")).toHaveLength(1);
    expect((await api("/v1/prompt", { target: { ...target, server: "../default" }, text: "must not send" })).status).toBe(400);
  });
  it("streams incremental transcript and real usage frames, then closes after a conversation replacement", async () => {
    const query = new URLSearchParams(target).toString();
    const socket = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/transcripts?${query}`);
    const frames: any[] = []; socket.on("message", data => frames.push(JSON.parse(data.toString())));
    await once(socket, "open");
    for (let i = 0; i < 60 && !frames.length; i++) await sleep(25);
    expect(frames[0].type).toBe("backlog"); expect(JSON.stringify(frames[0])).toContain("First message");
    await appendFile(record, JSON.stringify(row("Second message")) + "\n");
    for (let i = 0; i < 60 && frames.length < 2; i++) await sleep(25);
    expect(frames[1].type).toBe("append"); expect(JSON.stringify(frames[1])).toContain("Second message"); expect(JSON.stringify(frames[1])).not.toContain("First message");
    await appendFile(record, JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 9, output_tokens: 3 } } } }) + "\n");
    for (let i = 0; i < 60 && frames.length < 3; i++) await sleep(25);
    expect(JSON.stringify(frames[2])).toContain('"output_tokens":3');
    const closed = once(socket, "close"); current = "bbbbbbbb-1111-4111-8111-111111111111"; await closed;
  });
  it("rejects stale actions and prevents phone requests from registering agent hooks", async () => {
    expect((await api("/v1/approvals/answer", { target, actionId: "bbbbbbbb-1111-4111-8111-111111111111", decision: "approve" })).status).toBe(409);
    expect((await api("/hook", { target, event: "PermissionRequest" })).status).toBe(404);
    expect(commands.some(c => c.method === "agent.send_keys")).toBe(false);
  });
  it("stores images privately and rejects traversal filenames", async () => {
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=", "base64");
    const response = await api("/v1/upload", { target, name: "fixture.png", data: bytes.toString("base64") });
    expect(response.status).toBe(200);
    expect(response.data.ok).toBe(true);
    expect(await readFile(response.data.path)).toEqual(bytes);
    expect((await api("/v1/upload", { target, name: "../../settings.json", data: "AAAA" })).status).toBe(400);
    expect((await api("/v1/upload", { target, name: "script.png", data: Buffer.from("#!/bin/sh").toString("base64") })).status).toBe(400);
  });
  it("only resolves the live approval on an explicitly watched conversation", async () => {
    const socket = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/status?${new URLSearchParams(target)}`);
    const frames: any[] = []; socket.on("message", bytes => frames.push(JSON.parse(bytes.toString())));
    await once(socket, "open");
    for (let i = 0; i < 60 && !frames.length; i++) await sleep(25);
    const reply = new Promise<any>((resolve, reject) => {
      const payload = JSON.stringify({ target, event: "PermissionRequest", tool: "Bash", input: { command: "fixture-command" } });
      const req = request({ socketPath: path.join(root, "bridge/agent.sock"), path: "/hook", method: "POST",
        headers: { "Content-Length": Buffer.byteLength(payload) } }, res => {
        let data = ""; res.on("data", bytes => data += bytes); res.on("end", () => resolve(JSON.parse(data)));
      }); req.on("error", reject); req.end(payload);
    });
    for (let i = 0; i < 100 && !frames.some(f => f.agentStatus.pendingApproval); i++) await sleep(25);
    const approval = frames.find(f => f.agentStatus.pendingApproval)?.agentStatus.pendingApproval;
    expect(approval?.message).toContain("fixture-command");
    const wrong = await api("/v1/approvals/answer", { target: { ...target, session: "bbbbbbbb-1111-4111-8111-111111111111" }, actionId: approval.actionId, decision: "approve" });
    expect(wrong.status).toBe(409);
    expect((await api("/v1/approvals/answer", { target, actionId: approval.actionId, decision: "deny" })).status).toBe(200);
    expect((await reply).hookSpecificOutput.decision.behavior).toBe("deny");
    expect((await api("/v1/approvals/answer", { target, actionId: approval.actionId, decision: "approve" })).status).toBe(409);
    socket.close(); await once(socket, "close");
  });
  it("preserves large images as references and retrieves their original bytes", async () => {
    const image = Buffer.alloc(3_000_000, 37);
    const event = { type: "response_item", payload: { type: "message", role: "user", content: [
      { type: "input_text", text: "Inspect this image" }, { type: "input_image", image_url: "data:image/png;base64," + image.toString("base64") },
    ] } };
    await writeFile(record, JSON.stringify(event) + "\n");
    const page = await new TranscriptReader(record, "codex").read();
    expect(JSON.stringify(page)).not.toContain(image.toString("base64").slice(0, 300));
    expect((page.entries[0].raw.payload as any).content[1]).toEqual({ type: "input_image" });
    const downloaded = await historicalImage(record, 0, 1, "codex");
    expect(downloaded.length).toBe(image.length);
    expect(createHash("sha256").update(downloaded).digest("hex")).toBe(createHash("sha256").update(image).digest("hex"));
  });
  it("skips an oversized old row without blocking newer messages or changing line IDs", async () => {
    await writeFile(record, "");
    const block = Buffer.alloc(1_048_576, 65);
    for (let i = 0; i < 65; i++) await appendFile(record, block);
    await appendFile(record, "\n" + JSON.stringify(row("Still readable")) + "\n");
    const page = await new TranscriptReader(record, "codex").read();
    expect(page.entries).toHaveLength(1); expect(page.entries[0].line).toBe(1);
    expect(JSON.stringify(page.entries)).toContain("Still readable");
  });
  it("reads Claude strings and Copilot public messages while excluding reasoning", async () => {
    for (const [source, event, expected] of [
      ["claude", { type: "user", message: { role: "user", content: "Claude user message" } }, "Claude user message"],
      ["copilot", { type: "assistant.message", data: { content: "Copilot visible", reasoningText: "never-export-this" } }, "Copilot visible"],
    ] as const) {
      await writeFile(record, JSON.stringify(event) + "\n");
      const page = await new TranscriptReader(record, source).read();
      expect(JSON.stringify(page)).toContain(expected);
      expect(JSON.stringify(page)).not.toContain("never-export-this");
    }
  });
  it("preflights all agent configs without changing them and preserves other callbacks", async () => {
    const previous = [process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR, process.env.COPILOT_HOME];
    const keys = ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "COPILOT_HOME"];
    keys.forEach((key, i) => process.env[key] = path.join(root, "settings-" + i));
    try {
      const file = path.join(process.env.CODEX_HOME!, "hooks.json");
      await mkdir(path.dirname(file));
      const original = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "other-provider-hook" }] }] } });
      await writeFile(file, original);
      const changes = await planAgentHooks("/private/phren/current/bridge-hook.mjs");
      expect(changes).toHaveLength(3);
      expect(changes[0].after).toContain("other-provider-hook");
      expect(changes[0].after).toContain("PermissionRequest");
      expect(await readFile(file, "utf8")).toBe(original);
      await writeFile(file, changes[0].after);
      expect((await planAgentHooks("/private/phren/current/bridge-hook.mjs")).some(c => c.file === file)).toBe(false);
      await mkdir(process.env.CLAUDE_CONFIG_DIR!);
      await writeFile(path.join(process.env.CLAUDE_CONFIG_DIR!, "settings.json"), "malformed");
      await expect(planAgentHooks("/private/phren/current/bridge-hook.mjs")).rejects.toThrow();
      expect(await readFile(file, "utf8")).toBe(changes[0].after);
    } finally { keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }); }
  });

  it("rejects transcript symlinks that escape the provider folder", async () => {
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(root, "codex");
    try {
      await rm(record); await writeFile(path.join(root, "outside.jsonl"), "{}\n");
      await symlink(path.join(root, "outside.jsonl"), record);
      await expect(transcriptPath("codex", session)).rejects.toThrow("outside");
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    }
  });
  it("does not emit incomplete rows and resets a truncated transcript", async () => {
    const reader = new TranscriptReader(record, "codex");
    expect((await reader.read()).entries).toHaveLength(1);
    const next = JSON.stringify(row("Completed later")); await appendFile(record, next.slice(0, 30));
    expect((await reader.read()).entries).toHaveLength(0);
    await appendFile(record, next.slice(30) + "\n"); expect((await reader.read()).entries[0].line).toBe(2);
    await writeFile(record, JSON.stringify(row("Reset")) + "\n");
    const reset = await reader.read(); expect(reset.reset).toBe(true); expect(reset.entries[0].line).toBe(0);
  });
});

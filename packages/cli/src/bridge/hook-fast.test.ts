import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FAST_HOOK_SOURCE, fastHookPath, fastHookSource, TOOL_HOOK_BUDGET_MS } from "./hook-fast.js";
import { stopFacts, withinToolBudget } from "./agent-hooks.js";

let root = "", server: Server | undefined, bodies: Record<string, unknown>[] = [], reply = "{}", hang = false;
const session = "11111111-2222-4333-8444-555555555555";

// The Hook runs on macOS and Linux only; the script talks over a Unix socket.
describe.skipIf(process.platform === "win32")("claude-hook.mjs", () => {
  beforeEach(async () => {
    root = await mkdtemp("/tmp/phren-fast-");
    await mkdir(path.join(root, "herdr")); await mkdir(path.join(root, "current"));
    await writeFile(fastHookPath(path.join(root, "current")), FAST_HOOK_SOURCE);
    bodies = []; reply = "{}"; hang = false;
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      bodies.push({ url: req.url, ...JSON.parse(Buffer.concat(chunks).toString()) });
      // A Hook too busy to answer in time.
      if (!hang) res.end(reply);
    });
    await new Promise<void>(resolve => server!.listen(path.join(root, "agent.sock"), resolve));
  });
  afterEach(async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server!.close(resolve)); }
    await rm(root, { recursive: true, force: true });
  });

  const herdr = () => ({ HERDR_ENV: "1", HERDR_SOCKET_PATH: path.join(root, "herdr/herdr.sock"), HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t1", HERDR_PANE_ID: "w1:p2" });
  function run(input: unknown, env: Record<string, string>, args = ["claude"]): Promise<{ stdout: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fastHookPath(path.join(root, "current")), ...args], {
        env: { PATH: process.env.PATH, HOME: root, PHREN_BRIDGE_HOME: root, PHREN_HERDR_HOME: path.join(root, "herdr"), ...env } });
      let stdout = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.on("error", reject); child.on("close", code => resolve({ stdout, code }));
      child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
    });
  }

  it("sends the body agentHook sends for a Herdr pane and prints only a refusal", async () => {
    reply = JSON.stringify({ decision: "block", reason: "Phren sent this to another conversation." });
    const prompt = await run({ hook_event_name: "UserPromptSubmit", session_id: session, prompt: "hello", cwd: "/work" }, { ...herdr(), PHREN_DISPATCH_ID: "brief-12345" });
    expect(prompt).toEqual({ stdout: reply, code: 0 });
    expect(bodies).toEqual([{ url: "/hook", target: { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p2", source: "claude", session },
      event: "UserPromptSubmit", dispatchId: "brief-12345", cwd: "/work", prompt: "hello" }]);
    reply = "{}";
    expect((await run({ hook_event_name: "UserPromptSubmit", session_id: session, prompt: "hi" }, herdr())).stdout).toBe("");
  });

  it("forwards Claude's native prompt_id through both forwarders, and omits missing or malformed ids", async () => {
    // A sanitized 2.1.316 hook payload, with a fake id assembled for this run.
    const { prompt_id: _fixturePrompt, ...payload } = JSON.parse(readFileSync(
      new URL("./fixtures/claude/2.1.316/user-prompt-submit.json", import.meta.url), "utf8")) as Record<string, unknown>;
    const p1 = ["fixture", "prompt", "alpha"].join("-"), expected = `claude:prompt:${p1}`;
    const submit = (promptId?: unknown) => ({ ...payload, session_id: session, prompt: "hello",
      ...(promptId === undefined ? {} : { prompt_id: promptId }) });
    bodies = [];
    await run(submit(p1), herdr());
    expect(bodies[0]).toMatchObject({ event: "UserPromptSubmit", promptEntryId: expected });
    bodies = [];
    await runBundle(submit(p1), "claude");
    expect(bodies[0]).toMatchObject({ event: "UserPromptSubmit", promptEntryId: expected });
    bodies = [];
    for (const promptId of [undefined, "not a prompt id", 42, "x".repeat(193)]) await run(submit(promptId), herdr());
    await runBundle(submit("not a prompt id"), "claude");
    expect(bodies.map(body => body.promptEntryId)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(bodies.every(body => !("promptEntryId" in body))).toBe(true);
  });

  it("carries Stop facts and prints permission answers", async () => {
    const stop = { hook_event_name: "Stop", session_id: session, last_assistant_message: "Done.", background_tasks: [{ id: "aworker1", status: "running" }, { id: "bshell2", status: "completed" }, { status: "running" }] };
    expect((await run(stop, { ...herdr(), PHREN_DISPATCH_ID: "brief-12345" })).stdout).toBe("");
    expect(bodies[0]).toMatchObject({ event: "Stop", ...stopFacts(stop) });
    expect(bodies[0].dispatchId).toBeUndefined();
    reply = JSON.stringify({ hookSpecificOutput: { decision: { behavior: "allow" } } });
    expect((await run({ hook_event_name: "PermissionRequest", session_id: session, tool_name: "Bash", tool_input: { command: "ls" } }, herdr())).stdout).toBe(reply);
    expect(bodies[1]).toMatchObject({ event: "PermissionRequest", tool: "Bash", input: { command: "ls" } });
  });

  // A same-pane `claude --resume`: without the start source the record kept the dead agents of the last Stop.
  it("names how the session started, so a resume clears the last Stop's running agents", async () => {
    await run({ hook_event_name: "SessionStart", session_id: session, source: "resume" }, herdr());
    expect(bodies[0]).toMatchObject({ event: "SessionStart", startSource: "resume" });
    await run({ hook_event_name: "UserPromptSubmit", session_id: session, source: "resume", prompt: "hi" }, herdr());
    expect(bodies[1].startSource).toBeUndefined();
  });

  it("keeps a running agent listed behind 64 finished tasks, as the bundle does", async () => {
    const tasks = [...Array.from({ length: 64 }, (_, i) => ({ id: `bshell${i}`, status: "completed" })), { id: "a1", status: "running" }];
    const stop = { hook_event_name: "Stop", session_id: session, background_tasks: tasks };
    await run(stop, herdr());
    expect(bodies[0]).toMatchObject({ event: "Stop", background: 1, backgroundTasks: stopFacts(stop).backgroundTasks });
    expect((bodies[0].backgroundTasks as { id: string; running: boolean }[])[0]).toEqual({ id: "a1", running: true });
    expect(bodies[0].backgroundTasks).toHaveLength(65);
  });

  it("forwards matching turn context through both handlers without adding approval fields", async () => {
    for (const event of ["SessionStart", "UserPromptSubmit"]) {
      const context = { hookSpecificOutput: { hookEventName: event, additionalContext: "Current role: conductor." } };
      reply = JSON.stringify({ ...context, decision: "approve" });
      const input = { hook_event_name: event, session_id: session, prompt: "status" };
      expect(JSON.parse((await run(input, herdr())).stdout)).toEqual(context);
      expect(JSON.parse((await runBundle(input)).stdout)).toEqual(context);
    }
    for (const bad of ["not json", JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: "wrong event" } }),
      JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: {} } })]) {
      reply = bad;
      const input = { hook_event_name: "SessionStart", session_id: session };
      expect((await run(input, herdr())).stdout).toBe("");
      expect((await runBundle(input)).stdout).toBe("");
    }
  });

  it("stays silent for subagents, other Herdr sockets, no pane and an unreachable Hook", async () => {
    await run({ hook_event_name: "Stop", session_id: session, agent_id: "a1" }, herdr());
    await run({ hook_event_name: "Stop", session_id: session }, { ...herdr(), HERDR_SOCKET_PATH: "/elsewhere/herdr.sock" });
    await run({ hook_event_name: "Stop", session_id: session }, {});
    await run("not json", herdr());
    expect(bodies).toEqual([]);
    await new Promise(resolve => server!.close(resolve)); server = undefined;
    expect(await run({ hook_event_name: "UserPromptSubmit", session_id: session }, herdr())).toEqual({ stdout: "", code: 0 });
  });

  // Mini, 2026-10-01: Codex showed "Hook failed: hook timed out after 10s" on
  // every tool call; the 8 s socket wait after a slow start ran past it.
  it("gives a tool call's callback up within its budget when the Hook does not answer", async () => {
    hang = true;
    await writeFile(fastHookPath(path.join(root, "current")), fastHookSource(600));
    const started = Date.now();
    expect(await run({ hook_event_name: "PreToolUse", session_id: session, tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t1" }, herdr()))
      .toEqual({ stdout: "", code: 0 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(bodies).toMatchObject([{ event: "PreToolUse", tool: "Bash" }]);
    expect(FAST_HOOK_SOURCE).toBe(fastHookSource(TOOL_HOOK_BUDGET_MS));
    expect(FAST_HOOK_SOURCE).toContain(`Math.floor(${TOOL_HOOK_BUDGET_MS} - performance.now())`);
  });

  const bundle = fileURLToPath(new URL("../../dist/bridge-hook.mjs", import.meta.url));
  function runBundle(input: unknown, source = "codex"): Promise<{ stdout: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bundle, "hook", source], {
        env: { PATH: process.env.PATH, HOME: root, PHREN_BRIDGE_HOME: root, PHREN_PATH: path.join(root, "store"), PHREN_HERDR_HOME: path.join(root, "herdr"), ...herdr() } });
      let stdout = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.on("error", reject); child.on("close", code => resolve({ stdout, code }));
      child.stdin.end(JSON.stringify(input));
    });
  }
  const toolCall = { hook_event_name: "PreToolUse", session_id: session, tool_name: "exec_command", tool_input: { cmd: "ls" }, tool_use_id: "t1", cwd: root };
  it("exits the bundle's Codex callback for a tool call well inside Codex's 10 s hook timeout", async () => {
    hang = true;
    const started = Date.now();
    // Failing open writes nothing: the agent's own permission rules decide the call.
    expect(await runBundle(toolCall)).toEqual({ stdout: "", code: 0 });
    expect(bodies).toMatchObject([{ event: "PreToolUse", tool: "exec_command" }]);
    expect(Date.now() - started).toBeLessThan(TOOL_HOOK_BUDGET_MS + 2_000);
  }, 20_000);

  // A tool call's callback that gives up must never read as an approval. It
  // never answers for the agent at all, in time or not: only PermissionRequest
  // (and a refused prompt) prints a decision.
  it("never prints a decision for a tool call, even one the Hook answers with allow", async () => {
    reply = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" }, decision: "approve" });
    expect(await run({ ...toolCall, tool_name: "Bash", tool_input: { command: "rm -rf build" } }, herdr())).toEqual({ stdout: "", code: 0 });
    expect(await runBundle(toolCall)).toEqual({ stdout: "", code: 0 });
    expect(bodies.map(body => body.event)).toEqual(["PreToolUse", "PreToolUse"]);
  }, 20_000);

  it("runs the bundle's full handler for a tmux pane and other agents", async () => {
    await writeFile(path.join(root, "current/bridge-hook.mjs"), "let input = ''; for await (const c of process.stdin) input += c;\nprocess.stdout.write(JSON.stringify([process.argv.slice(2), input]));\n");
    const input = { hook_event_name: "Stop", session_id: session };
    expect(JSON.parse((await run(input, { TMUX: "/tmp/tmux-501/default,1,0", TMUX_PANE: "%1" })).stdout)).toEqual([["hook", "claude"], JSON.stringify(input)]);
    expect(JSON.parse((await run(input, herdr(), ["codex"])).stdout)[0]).toEqual(["hook", "codex"]);
    expect(bodies).toEqual([]);
  });
});

describe("a tool call's callback budget", () => {
  it("bounds PreToolUse and PostToolUse from process start, and leaves every other event alone", async () => {
    const never = () => new Promise<string>(() => {});
    const started = Date.now();
    expect(await withinToolBudget("PreToolUse", never, () => 4_900, 5_000)).toBe("abandoned");
    expect(Date.now() - started).toBeLessThan(1_000);
    let ran = false;
    expect(await withinToolBudget("PostToolUse", async () => { ran = true; return "sent"; }, () => 5_000, 5_000)).toBe("abandoned");
    expect(ran).toBe(false);
    expect(await withinToolBudget("PreToolUse", async left => left(), () => 1_000, 5_000)).toBe(4_000);
    expect(await withinToolBudget("Stop", async left => left(), () => 60_000, 5_000)).toBe(Infinity);
    // An approval is never cut short by the tool budget: it waits for the owner's answer.
    expect(await withinToolBudget("PermissionRequest", async () => "allow", () => 60_000, 5_000)).toBe("allow");
    expect(await withinToolBudget("PostToolUseFailure", async left => left(), () => 60_000, 5_000)).toBe(Infinity);
    expect(TOOL_HOOK_BUDGET_MS).toBeLessThanOrEqual(5_000);
  });
});

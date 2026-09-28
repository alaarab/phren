import { afterEach, beforeEach, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { FAST_HOOK_SOURCE, fastHookPath } from "./hook-fast.js";
import { stopFacts } from "./agent-hooks.js";

let root = "", server: Server | undefined, bodies: Record<string, unknown>[] = [], reply = "{}";
const session = "11111111-2222-4333-8444-555555555555";

beforeEach(async () => {
  root = await mkdtemp("/tmp/phren-fast-");
  await mkdir(path.join(root, "herdr")); await mkdir(path.join(root, "current"));
  await writeFile(fastHookPath(root), FAST_HOOK_SOURCE);
  bodies = []; reply = "{}";
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push({ url: req.url, ...JSON.parse(Buffer.concat(chunks).toString()) });
    res.end(reply);
  });
  await new Promise<void>(resolve => server!.listen(path.join(root, "agent.sock"), resolve));
});
afterEach(async () => { if (server) await new Promise(resolve => server!.close(resolve)); await rm(root, { recursive: true, force: true }); });

const herdr = () => ({ HERDR_ENV: "1", HERDR_SOCKET_PATH: path.join(root, "herdr/herdr.sock"), HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t1", HERDR_PANE_ID: "w1:p2" });
function run(input: unknown, env: Record<string, string>, args = ["claude"]): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fastHookPath(root), ...args], {
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

it("carries Stop facts and prints permission answers", async () => {
  const stop = { hook_event_name: "Stop", session_id: session, last_assistant_message: "Done.", background_tasks: [{ status: "running" }, { status: "completed" }] };
  expect((await run(stop, { ...herdr(), PHREN_DISPATCH_ID: "brief-12345" })).stdout).toBe("");
  expect(bodies[0]).toMatchObject({ event: "Stop", ...stopFacts(stop) });
  expect(bodies[0].dispatchId).toBeUndefined();
  reply = JSON.stringify({ hookSpecificOutput: { decision: { behavior: "allow" } } });
  expect((await run({ hook_event_name: "PermissionRequest", session_id: session, tool_name: "Bash", tool_input: { command: "ls" } }, herdr())).stdout).toBe(reply);
  expect(bodies[1]).toMatchObject({ event: "PermissionRequest", tool: "Bash", input: { command: "ls" } });
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

it("runs the bundle's full handler for a tmux pane and other agents", async () => {
  await writeFile(path.join(root, "current/bridge-hook.mjs"), "let input = ''; for await (const c of process.stdin) input += c;\nprocess.stdout.write(JSON.stringify([process.argv.slice(2), input]));\n");
  const input = { hook_event_name: "Stop", session_id: session };
  expect(JSON.parse((await run(input, { TMUX: "/tmp/tmux-501/default,1,0", TMUX_PANE: "%1" })).stdout)).toEqual([["hook", "claude"], JSON.stringify(input)]);
  expect(JSON.parse((await run(input, herdr(), ["codex"])).stdout)[0]).toEqual(["hook", "codex"]);
  expect(bodies).toEqual([]);
});

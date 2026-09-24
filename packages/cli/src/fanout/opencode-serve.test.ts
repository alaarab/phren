import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../test-helpers.js";
import { AgentHooks } from "../bridge/agent-hooks.js";
import { fanoutChildren } from "../bridge/fanouts.js";
import type { ApprovalPushService } from "../bridge/push.js";
import type { Target } from "../bridge/protocol.js";
import { createJob, launch, readJob } from "./launcher.js";
import { DENIED_FEEDBACK } from "./opencode-serve.js";

vi.mock("../bridge/herdr.js", async importOriginal => ({
  ...await importOriginal<typeof import("../bridge/herdr.js")>(),
  validateTarget: vi.fn(async () => ({})),
  servers: vi.fn(async () => []),
}));

/** A stand-in for `opencode serve`: one session whose turn asks for a
 * directory outside the worktree, then finishes according to the answer. It
 * refuses any request without the launcher's password and logs every reply. */
const FAKE_OPENCODE = `#!/usr/bin/env node
const http = require("node:http"), fs = require("node:fs");
if (process.argv[2] !== "serve") { console.error("fake opencode only serves"); process.exit(2); }
const log = value => fs.appendFileSync(process.env.FAKE_OPENCODE_LOG, JSON.stringify(value) + "\\n");
const auth = "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_SERVER_PASSWORD).toString("base64");
const session = "ses_fake1", clients = [];
const send = (type, properties) => { for (const client of clients) client.write("data: " + JSON.stringify({ type, properties }) + "\\n\\n"); };
const part = (id, fields) => send("message.part.updated", { part: { id, sessionID: session, messageID: "msg_1", ...fields } });
const finish = text => { part("prt_3", { type: "text", text, time: { start: 1, end: 2 } }); part("prt_4", { type: "step-finish", reason: "stop" }); send("session.status", { sessionID: session, status: { type: "idle" } }); };
http.createServer((req, res) => {
  let body = "";
  req.on("data", chunk => body += chunk);
  req.on("end", () => {
    const url = new URL(req.url, "http://fake");
    if (req.headers.authorization !== auth || url.searchParams.get("directory") !== process.cwd()) { res.writeHead(401); res.end("{}"); return; }
    const data = body ? JSON.parse(body) : undefined;
    if (req.method === "GET" && url.pathname === "/event") {
      res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write("data: " + JSON.stringify({ type: "server.connected", properties: {} }) + "\\n\\n");
      clients.push(res); return;
    }
    if (req.method === "POST" && url.pathname === "/session") { log({ create: data }); res.end(JSON.stringify({ id: session })); return; }
    if (req.method === "POST" && url.pathname === "/session/" + session + "/prompt_async") {
      log({ prompt: data }); res.writeHead(204); res.end();
      setTimeout(() => {
        send("session.status", { sessionID: session, status: { type: "busy" } });
        part("prt_1", { type: "step-start" });
        send("permission.asked", { id: "per_fake1", sessionID: session, permission: "external_directory", patterns: ["/private/tmp/elsewhere/*"], metadata: {}, always: [] });
      }, 50);
      return;
    }
    const reply = /^\\/permission\\/([^/]+)\\/reply$/.exec(url.pathname);
    if (req.method === "POST" && reply) {
      log({ permission: reply[1], ...data }); res.end("true");
      const input = { filePath: "/private/tmp/elsewhere/notes.txt" };
      if (data.reply === "once") {
        part("prt_2", { type: "tool", tool: "read", callID: "call_1", state: { status: "completed", input, output: "notes", title: "notes.txt", metadata: {} } });
        finish("Finished after the owner allowed it.");
      } else {
        part("prt_2", { type: "tool", tool: "read", callID: "call_1", state: { status: "error", input, error: "The user rejected permission to use this specific tool call with the following feedback: " + data.message } });
        finish("Could not read /private/tmp/elsewhere: " + data.message);
      }
      return;
    }
    res.writeHead(404); res.end("{}");
  });
}).listen(0, "127.0.0.1", function () { console.log("opencode server listening on http://127.0.0.1:" + this.address().port); });
`;

const parent = "00000000-0000-4000-8000-0000000000aa";
const target: Target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "claude", session: parent };

function fakePush() {
  const sent: { binding: string; title?: string; message?: string }[] = [];
  return { sent, service: { available: true,
    notify: vi.fn(async (value: { binding: string }) => { sent.push(value); return true; }),
    notifyFanoutBlocked: vi.fn(async () => true) } as unknown as ApprovalPushService };
}

describe("an OpenCode fan-out worker asks the phone", () => {
  let temp: ReturnType<typeof makeTempDir>, store: string, logFile: string;
  beforeEach(() => {
    temp = makeTempDir("fanout-serve-");
    store = path.join(temp.path, "store");
    const bin = path.join(temp.path, "bin"), bridge = path.join(temp.path, "bridge"), worktree = path.join(temp.path, "worktree");
    for (const directory of [store, bin, worktree, path.join(bridge, "bindings", "default")]) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(bin, "opencode"), FAKE_OPENCODE, { mode: 0o700 });
    // The parent conversation's pane, as the Hook's agent callback records it.
    fs.writeFileSync(path.join(bridge, "bindings", "default", "w1%3Ap1.json"), JSON.stringify({ terminal: "term-1", source: "claude",
      session: parent, pids: [process.pid], workspace: "w1", tab: "w1:t1" }));
    logFile = path.join(temp.path, "opencode.log");
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
    vi.stubEnv("PHREN_PATH", store);
    vi.stubEnv("PHREN_BRIDGE_HOME", bridge);
    vi.stubEnv("FAKE_OPENCODE_LOG", logFile);
  });
  afterEach(() => { vi.unstubAllEnvs(); temp.cleanup(); });

  async function start() {
    const options = { store, provider: "opencode" as const, model: "opencode-go/mimo-v2-flash", label: "limiter",
      worktree: path.join(temp.path, "worktree"), prompt: "Compare against the stock device.", reason: "eligible" };
    const reservation = createJob(options, { CLAUDE_CODE_SESSION_ID: parent });
    const running = launch(options, reservation);
    const request = path.join(store, ".runtime", "approvals", "opencode-ses_fake1.request.json");
    for (let waited = 0; !fs.existsSync(request); waited += 50) {
      if (waited > 15_000) throw new Error(`The worker never asked: ${fs.readFileSync(path.join(reservation.job, "stderr.log"), "utf8")}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const push = fakePush(), hooks = new AgentHooks(push.service);
    await hooks.sweepOpencodeApprovals();
    return { running, reservation, hooks, push };
  }
  const replies = () => fs.readFileSync(logFile, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.permission);
  const events = (job: string) => fs.readFileSync(path.join(job, "events.jsonl"), "utf8");

  it("waits as needs-you on the parent and Allow resumes the same session to completion", async () => {
    const { running, reservation, hooks, push } = await start();
    const approval = hooks.approval(target);
    expect(approval).toMatchObject({ toolName: "external_directory", title: "Allow external_directory for limiter?",
      message: "external_directory: /private/tmp/elsewhere/*" });
    expect(String(approval?.actionId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(hooks.pendingPanes("default", { panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "claude" }] })).toEqual(new Set(["w1:p1"]));
    expect(push.sent).toHaveLength(1);
    const [child] = await fanoutChildren("claude", parent);
    expect(child).toMatchObject({ state: "running", session: "ses_fake1", reason: "needs-you: external_directory: /private/tmp/elsewhere/*" });
    expect(readJob(store, reservation.manifest.id)).toMatchObject({ status: "running", session: "ses_fake1" });

    await hooks.answer(target, String(approval!.actionId), "approve");
    expect(await running).toBe(0);
    expect(replies()).toEqual([{ permission: "per_fake1", reply: "once" }]);
    expect(readJob(store, reservation.manifest.id)).toMatchObject({ status: "completed", exitCode: 0, session: "ses_fake1" });
    expect(events(reservation.job)).toContain("Finished after the owner allowed it.");
    expect(events(reservation.job)).toContain('"decision":"approve"');
    expect(fs.existsSync(path.join(reservation.job, "blocked.json"))).toBe(false);
    expect(fs.existsSync(path.join(store, ".runtime", "approvals", "opencode-ses_fake1.request.json"))).toBe(false);
    expect(hooks.approval(target)).toBeUndefined();
    const created = fs.readFileSync(logFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(created[0].create.permission).toEqual(expect.arrayContaining([{ permission: "question", action: "deny", pattern: "*" }]));
    expect(created[1].prompt).toMatchObject({ agent: "build", model: { providerID: "opencode-go", modelID: "mimo-v2-flash" },
      parts: [{ type: "text", text: "Compare against the stock device." }] });
  }, 30_000);

  it("Deny from the push resumes the worker with the refusal, which it reports", async () => {
    const { running, reservation, hooks, push } = await start();
    await hooks.answerPush(push.sent[0].binding, "deny");
    expect(await running).toBe(0);
    expect(replies()).toEqual([{ permission: "per_fake1", reply: "reject", message: DENIED_FEEDBACK }]);
    expect(readJob(store, reservation.manifest.id)).toMatchObject({ status: "completed", exitCode: 0 });
    expect(events(reservation.job)).toContain(`Could not read /private/tmp/elsewhere: ${DENIED_FEEDBACK}`);
    expect(events(reservation.job)).toContain('"decision":"deny"');
    expect(fs.existsSync(path.join(reservation.job, "blocked.json"))).toBe(false);
    await expect(hooks.answerPush(push.sent[0].binding, "approve")).rejects.toThrow("no longer pending");
  }, 30_000);
});

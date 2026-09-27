import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

vi.hoisted(() => { process.env.PHREN_APPROVAL_HOLD_MS = "300"; });

import { AgentHooks } from "./agent-hooks.js";
import { localSocket } from "./agent-hook-stores.js";
import { codexAutoReview } from "./codex-review-mode.js";
import { rpc, snapshot, validateTarget } from "./herdr.js";
import type { ApprovalPushService } from "./push.js";
import type { Target } from "./protocol.js";

vi.mock("./herdr.js", async importOriginal => ({
  ...await importOriginal<typeof import("./herdr.js")>(), rpc: vi.fn(), snapshot: vi.fn(), validateTarget: vi.fn(),
}));

// What Codex 0.155 records: a turn_context per turn, and a
// thread_settings_applied event when /approvals changes the session.
const turnContext = (reviewer: string, policy: unknown = "on-request") =>
  JSON.stringify({ timestamp: "2026-09-26T20:01:33.000Z", type: "turn_context", payload: { turn_id: "t1", cwd: "/work",
    approval_policy: policy, approvals_reviewer: reviewer, sandbox_policy: { type: "workspace-write", network_access: false } } });
const settingsApplied = (reviewer: string, policy: unknown = "on-request") =>
  JSON.stringify({ timestamp: "2026-09-26T20:05:00.000Z", type: "event_msg", payload: { type: "thread_settings_applied",
    thread_id: "t", thread_settings: { model: "gpt-5.6-sol", approval_policy: policy, approvals_reviewer: reviewer } } });
const noise = (text: string) => JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: text } });

describe("codexAutoReview", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "phren-review-mode-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  const rollout = async (lines: string[]) => {
    const file = path.join(dir, "rollout-2026-09-26T20-01-32-01a0e0cf-8aab-7a71-8c19-ad59217792b1.jsonl");
    await writeFile(file, lines.join("\n") + "\n");
    return file;
  };

  it("is on only for auto_review with a policy Codex routes to its reviewer", async () => {
    expect(await codexAutoReview(await rollout([turnContext("auto_review")]))).toBe(true);
    expect(await codexAutoReview(await rollout([turnContext("auto_review", { granular: { sandbox_approval: true } })]))).toBe(true);
    expect(await codexAutoReview(await rollout([turnContext("user")]))).toBe(false);
    // Codex asks the owner under untrusted even with the reviewer set.
    expect(await codexAutoReview(await rollout([turnContext("auto_review", "untrusted")]))).toBe(false);
    // An older rollout without the field keeps the owner as the approver.
    expect(await codexAutoReview(await rollout([JSON.stringify({ type: "turn_context", payload: { approval_policy: "on-request" } })]))).toBe(false);
  });

  it("follows the session's latest settings, not the first", async () => {
    expect(await codexAutoReview(await rollout([turnContext("auto_review"), noise("x"), settingsApplied("user")]))).toBe(false);
    expect(await codexAutoReview(await rollout([turnContext("user"), noise("x"), settingsApplied("auto_review")]))).toBe(true);
    // A message that merely quotes the settings does not count.
    expect(await codexAutoReview(await rollout([turnContext("user"), noise("\"type\":\"turn_context\" \"approvals_reviewer\":\"auto_review\"")]))).toBe(false);
  });

  it("finds settings written megabytes before the end of a long turn", async () => {
    const filler = Array.from({ length: 3_000 }, (_, i) => noise(`${"é".repeat(400)} ${i}`));
    expect(await codexAutoReview(await rollout([turnContext("auto_review"), ...filler]))).toBe(true);
  });

  it("ignores anything that is not a readable Codex rollout", async () => {
    expect(await codexAutoReview(undefined)).toBe(false);
    expect(await codexAutoReview("relative/rollout-x.jsonl")).toBe(false);
    expect(await codexAutoReview(path.join(dir, "rollout-missing.jsonl"))).toBe(false);
    const other = path.join(dir, "notes.jsonl");
    await writeFile(other, turnContext("auto_review") + "\n");
    expect(await codexAutoReview(other)).toBe(false);
  });
});

const target: Target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1",
  source: "codex", session: "01a0e0cf-8aab-7a71-8c19-ad59217792b1" };
const CODEX_DIALOG = "Would you like to run the following command?\n\n  Reason: Allow network access?\n\n  $ curl -sI https://example.com\n\n"
  + "› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel";
const REVIEWING = "• Reviewing approval request (6s • esc to interrupt)\n  └ /usr/bin/bash -lc 'curl -sI https://example.com'\n› Ask Codex to do anything";

/** Codex's hook subprocess as the Hook sees it, with the flag it adds for an
 * auto-reviewed session. */
function ask(autoReview: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: localSocket(), path: "/hook", method: "POST" }, res => {
      let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ event: "PermissionRequest", target, ...(autoReview ? { autoReview: true } : {}), tool: "Bash",
      input: { command: "curl -sI https://example.com", description: "Allow network access?" } }));
  });
}

describe.skipIf(process.platform === "win32")("a Codex approval under automatic review", () => {
  let bridge: string, previous: string | undefined, hooks: AgentHooks, screen: string, status: string;
  const sent: { binding: string; title?: string; message?: string }[] = [];
  const pane = () => ({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "codex", agent_status: status, terminal_id: "term-1" });

  beforeEach(async () => {
    sent.length = 0; screen = REVIEWING; status = "working";
    bridge = await mkdtemp(path.join(tmpdir(), "phren-auto-review-"));
    previous = process.env.PHREN_BRIDGE_HOME; process.env.PHREN_BRIDGE_HOME = bridge;
    vi.mocked(snapshot).mockReset().mockImplementation(async () => ({ panes: [pane()] }));
    vi.mocked(validateTarget).mockReset().mockResolvedValue({});
    vi.mocked(rpc).mockReset().mockImplementation(async (_server, method) => {
      if (method === "pane.process_info") return { process_info: { foreground_processes: [{ pid: process.pid }] } };
      if (method === "agent.read") return { read: { text: screen } };
      if (method === "agent.send_keys") return { ok: true };
      throw new Error(`Unexpected RPC ${method}`);
    });
    const push = { available: true, start: async () => {}, status: { configured: true },
      notify: vi.fn(async (value: { binding: string }) => { sent.push(value); return true; }) };
    hooks = new AgentHooks(push as unknown as ApprovalPushService);
    await hooks.start();
  });
  afterEach(async () => {
    hooks.close();
    if (previous === undefined) delete process.env.PHREN_BRIDGE_HOME; else process.env.PHREN_BRIDGE_HOME = previous;
    await rm(bridge, { recursive: true, force: true });
  });

  it("raises nothing on the phone and lets Codex's reviewer decide at once", async () => {
    const started = Date.now();
    expect(await ask(true)).toBe("{}");
    // No hold: the reviewer starts immediately instead of after the phone times out.
    expect(Date.now() - started).toBeLessThan(250);
    expect(hooks.approval(target)).toBeUndefined();
    expect(hooks.terminalPrompt(target)).toBeUndefined();
    // Even if the terminal reports the pane as waiting while it reviews,
    // there is no dialog to publish or push.
    status = "blocked";
    await hooks.observeWaitingPanes("default", [pane()], async () => target);
    expect(hooks.terminalPrompt(target)).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("still reaches the phone when Codex hands the request back to the owner", async () => {
    expect(await ask(true)).toBe("{}");
    expect(sent).toEqual([]);
    // The reviewer could not decide: Codex draws its own approval dialog.
    screen = CODEX_DIALOG; status = "blocked";
    await hooks.observeWaitingPanes("default", [pane()], async () => target);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ title: "Codex needs your approval" });
    expect(hooks.terminalPrompt(target)).toMatchObject({ choice: { options: expect.arrayContaining([expect.objectContaining({ key: "y" })]) } });
    await hooks.answerPush(sent[0].binding, "approve");
    expect(vi.mocked(rpc).mock.calls.filter(call => call[1] === "agent.send_keys").map(call => call[2]?.keys)).toEqual([["y"]]);
  });

  it("holds and pushes as before in a session the owner approves", async () => {
    const answer = ask(false);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(hooks.approval(target)).toMatchObject({ toolName: "Bash" });
    await hooks.answerPush(sent[0].binding, "approve");
    expect(JSON.parse(await answer)).toMatchObject({ hookSpecificOutput: { decision: { behavior: "allow" } } });
  });
});

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync, realpathSync } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, open, readFile, realpath as realpathAsync, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createConnection, createServer as createNetServer, type Server, type Socket } from "node:net";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { ApprovalWatchLeases, permissionPrompt, terminalChoice, visibleTerminalChoice } from "./agent-hooks.js";
import { capturesChanges, namedPaths, outputCallIds, ToolChanges } from "./changes.js";
import { herdrSocketError, rpc, workspaceSnapshot } from "./herdr.js";
import { planAgentHooks, upgradeKeys } from "./install.js";
import { locateProject } from "./locate.js";
import { repositoryBranch, repositoryDiff } from "./projects.js";
import { BridgeError, object } from "./protocol.js";
import { herdrAgentName, streamCloseReason } from "./server.js";
import { historicalImage, phrenStoreRoot, TranscriptReader, transcriptPath, visibleEvent } from "./transcripts.js";
import { dispatch } from "./transport.js";
import { enrollComputer, publicComputerKey } from "./computers.js";

const execFileAsync = promisify(execFile);
const session = "aaaaaaaa-1111-4111-8111-111111111111";
const hookBundle = path.resolve(process.env.PHREN_TEST_HOOK_BUNDLE || "packages/cli/dist/bridge-hook.mjs");
const target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "codex", session };
const row = (text: string) => ({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Resolves once `condition` holds, or after `timeoutMs` so the caller's own expectation reports the miss. */
async function waitFor(condition: () => unknown, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition()) && Date.now() < deadline) await sleep(10);
}

// Real tools, recorded (see fixtures/): the fake Herdr answers in these shapes
// and the fake Codex pane draws these screens.
const HERDR_VERSION = "0.9.1";
const recorded = (file: string) => readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8");
const herdrSchema = JSON.parse(recorded(`herdr/${HERDR_VERSION}/schema.json`)).schemas;
const recordedSnapshot = JSON.parse(recorded(`herdr/${HERDR_VERSION}/snapshot.json`)).result.snapshot;
type SchemaNode = { $ref?: string; properties?: Record<string, SchemaNode>; required?: string[]; enum?: unknown[];
  type?: string | string[]; items?: SchemaNode; anyOf?: SchemaNode[]; oneOf?: SchemaNode[] };
function schemaNode(node: SchemaNode): SchemaNode {
  while (node.$ref) {
    const [, group, name] = /^#\/schemas\/([^/]+)\/\$defs\/(.+)$/.exec(node.$ref)!;
    node = herdrSchema[group].$defs[name];
  }
  return node;
}
/** Where `value` departs from a recorded Herdr type: a missing required key,
 * a key Herdr never sends, or a value outside its enum. */
function herdrShapeProblems(node: SchemaNode, value: unknown, at = "$"): string[] {
  node = schemaNode(node);
  const branches = node.anyOf ?? node.oneOf;
  if (branches) {
    const results = branches.map(branch => herdrShapeProblems(branch, value, at));
    return results.find(problems => !problems.length) ?? results[0];
  }
  if (value === undefined || value === null) {
    const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
    return !types.length || types.includes("null") ? [] : [`${at} is missing`];
  }
  if (node.enum) return node.enum.includes(value) ? [] : [`${at} ${JSON.stringify(value)} is not one of ${node.enum.join(", ")}`];
  if (node.items && Array.isArray(value)) return value.flatMap((item, index) => herdrShapeProblems(node.items!, item, `${at}[${index}]`));
  if (!node.properties || typeof value !== "object") return [];
  const record = value as Record<string, unknown>, properties = node.properties;
  return [
    ...(node.required ?? []).filter(key => record[key] === undefined).map(key => `${at}.${key} is required`),
    ...Object.keys(record).filter(key => record[key] !== undefined && !(key in properties)).map(key => `${at}.${key} is not a Herdr field`),
    ...Object.keys(record).filter(key => key in properties).flatMap(key => herdrShapeProblems(properties[key], record[key], `${at}.${key}`)),
  ];
}
/** Herdr's own reason for refusing a request before reading it: an unknown
 * method, a missing parameter or a value outside its enum. */
function herdrRequestProblem(method: string, params: Record<string, unknown> | undefined): string | undefined {
  const entry = (herdrSchema.request.oneOf as SchemaNode[]).find(candidate => (candidate.properties!.method as { const?: string }).const === method);
  if (!entry) return `invalid request: unknown variant \`${method}\``;
  const shape = schemaNode(entry.properties!.params);
  const missing = (shape.required ?? []).find(key => params?.[key] === undefined);
  if (missing) return `invalid request: missing field \`${missing}\``;
  for (const [key, property] of Object.entries(shape.properties ?? {})) {
    const choices = schemaNode(property).enum;
    if (choices && params?.[key] !== undefined && !choices.includes(params[key])) return `invalid request: unknown variant \`${String(params[key])}\``;
  }
  return undefined;
}
/** Codex 0.155.1's /permissions menu as recorded, with the cursor on `highlight` (none when undefined). */
const recordedPermissionsMenu = recorded("codex/0.155.1/permissions-menu.txt").replace(/^› /m, "  ");
const permissionsMenu = (highlight: number | undefined) => highlight === undefined ? recordedPermissionsMenu
  : recordedPermissionsMenu.replace(new RegExp(`^  ${highlight + 1}\\. `, "m"), `› ${highlight + 1}. `);
const fullAccessConfirmation = recorded("codex/0.155.1/full-access-confirmation.txt");
/** The same confirmation with shortcut keys on its rows, as Codex draws its approval rows. */
const keyedFullAccessConfirmation = fullAccessConfirmation
  .replace("Yes, continue anyway  ", "Yes, continue anyway (1)  ").replace("Cancel                ", "Cancel (esc)          ");

describe("Phren Hook boundaries", () => {
  it("splits numbered option descriptions without changing labels or answer keys", () => {
    const choice = visibleTerminalChoice("Older output\n\nAllow the tool?\n"
      + "› 1. Allow            Run the tool and continue.\n"
      + "2. Allow for this session (p)  Keep this permission until the session ends.\n"
      + "3. No (esc)\n");
    expect(choice).toEqual({ title: "Allow the tool?", highlightedIndex: 0, options: [
      { label: "Allow", description: "Run the tool and continue.", key: "1", hasKey: false },
      { label: "Allow for this session", description: "Keep this permission until the session ends.", key: "p", hasKey: true },
      { label: "No", key: "Escape", hasKey: true },
    ] });
    expect(visibleTerminalChoice("Continue?\n1. Allow  Run the tool.  Then continue. (y)\n2. No (esc)")?.options[0])
      .toEqual({ label: "Allow", description: "Run the tool.  Then continue.", key: "y", hasKey: true });
    expect(terminalChoice({ question: "Allow?", options: [
      { label: "Allow", description: "Run it.", key: "1" }, { label: "Decline", key: "2" },
    ] })?.options).toEqual([{ label: "Allow", description: "Run it.", key: "1" }, { label: "Decline", key: "2" }]);
  });

  it("records keyless menu highlights and refuses an unreadable or ambiguous cursor", () => {
    expect(visibleTerminalChoice(permissionsMenu(0))).toMatchObject({ title: "Update Model Permissions", highlightedIndex: 0,
      options: [{ label: "Ask for approval (current)", key: "1", hasKey: false },
        { label: "Approve for me", key: "2", hasKey: false }, { label: "Full Access", key: "3", hasKey: false }] });
    // The fake's cursor sits where Codex drew it after two Down presses.
    expect(visibleTerminalChoice(recorded("codex/0.155.1/permissions-menu-full-access.txt")))
      .toEqual(visibleTerminalChoice(permissionsMenu(2)));
    expect(visibleTerminalChoice(permissionsMenu(undefined))).toBeUndefined();
    expect(visibleTerminalChoice(permissionsMenu(0).replace("  2.", "› 2."))).toBeUndefined();
    for (const marker of [">", "❯", "›", "▸", "▶", "»", "•", "*"]) {
      expect(visibleTerminalChoice(permissionsMenu(2).replace("›", marker))?.highlightedIndex).toBe(2);
    }
  });

  it("normalizes MCP arguments and only resolves choices for the matching permission", () => {
    const input = { action: "read_skill", name: "m4l-improve" };
    const sentence = "Allow the phren MCP server to run tool phren_admin?";
    const options = "\n› 1. Allow  Run the tool and continue.\n2. Allow for this session  Keep it until the session ends.\n3. Deny";
    const prompt = permissionPrompt("mcp__phren__phren_admin", input, sentence + options);
    expect(prompt.title).toBe(sentence);
    expect(JSON.parse(prompt.details)).toEqual(input);
    expect(prompt.terminalOnly).toBe(false);
    expect(prompt.choice?.options.map(option => option.key)).toEqual(["1", "2", "3"]);
    expect(prompt.choice?.options[0]).toEqual({ label: "Allow", description: "Run the tool and continue.", key: "1", hasKey: false });
    // A provider may report only the bare tool name; prefer its pane's sentence.
    expect(permissionPrompt("phren_admin", input, sentence + options).title).toBe(sentence);
    expect(permissionPrompt("mcp__phren__phren_admin", input, "Allow a different tool?" + options).terminalOnly).toBe(true);
    expect(permissionPrompt("mcp__phren__phren_admin", input).choice).toBeUndefined();
    expect(permissionPrompt("action", input)).toEqual({ details: JSON.stringify(input, null, 2), title: undefined, terminalOnly: true });
  });

  it("derives a Herdr agent name from a human label", () => {
    expect(herdrAgentName("Conductor smoke 4")).toBe("conductor-smoke-4");
    expect(herdrAgentName("  42 fix the queue strip, remove & send now  ")).toBe("fix-the-queue-strip-remove-send");
    expect(herdrAgentName("phren")).toBe("phren");
    expect(herdrAgentName("!!!")).toBe("agent");
    expect(herdrAgentName("a".repeat(50))).toHaveLength(32);
  });

  it("expires overview approval watches and isolates servers", () => {
    let now = 100;
    const leases = new ApprovalWatchLeases(() => now);
    leases.renew("default");
    expect(leases.has("default")).toBe(true);
    expect(leases.has("another")).toBe(false);
    now += 24_999;
    expect(leases.has("default")).toBe(true);
    now++;
    expect(leases.has("default")).toBe(false);
    leases.renew("default");
    expect(leases.has("default")).toBe(true);
  });
  it("captures file tools and resolves their literal paths including patch headers", () => {
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch", "functions.apply_patch", "str_replace_editor", "create_file", "replace_string_in_file"]) {
      expect(capturesChanges(tool, {})).toBe(true);
    }
    expect(capturesChanges("Read", { file_path: "/work/file" })).toBe(false);
    expect(namedPaths("", { file_path: "/work/a file.swift", notebook_path: "notes.ipynb", path: "relative/file" })).toEqual(["/work/a file.swift", "relative/file", "notes.ipynb"]);
    expect(namedPaths("", { patch: "*** Begin Patch\n*** Update File: ../repo/a.swift\n@@\n-old\n+new\n*** Add File: new.txt\n+x\n*** End Patch" })).toEqual(["../repo/a.swift", "new.txt"]);
  });
  it("exports the shared iPhone lifecycle and usage contract", async () => {
    const cases = JSON.parse(await readFile(new URL("../../../../apps/ios/PhrenKit/Tests/PhrenKitTests/Fixtures/hook-events.json", import.meta.url), "utf8"));
    for (const fixture of cases) for (const event of fixture.events) {
      expect(visibleEvent(event, fixture.source)).toEqual(event);
    }
  });
  it("recognizes a conductor by the name Herdr keeps on the pane or in its agents list", () => {
    const base = {
      workspaces: [{ workspace_id: "w1", label: "Conductor" }],
      tabs: [{ workspace_id: "w1", tab_id: "w1:t1", label: "1" }],
      panes: [{ workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", agent: "claude" }],
    };
    const role = (s: Record<string, unknown>) => (workspaceSnapshot(s) as any).groups[0].children[0].role;
    expect(role(base)).toBeUndefined();
    expect(role({ ...base, agents: [{ pane_id: "w1:p1", agent: "claude", name: "conductor-conductor" }] })).toBe("conductor");
    expect(role({ ...base, panes: [{ ...base.panes[0], agent_name: "conductor-lead" }] })).toBe("conductor");
    expect(role({ ...base, agents: [{ pane_id: "w1:p1", agent: "claude", name: "conductor" }] })).toBe("conductor");
    expect(role({ ...base, agents: [{ pane_id: "w1:p1", agent: "claude", name: "conductors-helper" }] })).toBeUndefined();
  });
  it("exports focus only when workspace, tab and pane belong together", () => {
    const snapshot = {
      focused_workspace_id: "w2", focused_tab_id: "w2:t1", focused_pane_id: "w2:p1",
      workspaces: [{ workspace_id: "w1", label: "First" }, { workspace_id: "w2", label: "Focused" }],
      tabs: [{ workspace_id: "w1", tab_id: "w1:t1", label: "1" }, { workspace_id: "w2", tab_id: "w2:t1", label: "1" }],
      panes: [{ workspace_id: "w2", tab_id: "w2:t1", pane_id: "w2:p1" }],
    };
    expect(workspaceSnapshot(snapshot).focus).toEqual({ workspaceID: "w2", tabID: "w2:t1", paneID: "w2:p1" });
    expect(workspaceSnapshot({ ...snapshot, focused_workspace_id: "w1" }).focus).toBeUndefined();
    expect(workspaceSnapshot({ ...snapshot, focused_pane_id: "missing" }).focus).toBeUndefined();
    expect(workspaceSnapshot({ ...snapshot, focused_pane_id: undefined }).focus).toBeUndefined();
    // The tab carries the highest state_change_seq of its panes, and nothing when Herdr gives none.
    const seq = workspaceSnapshot({ ...snapshot, panes: [{ workspace_id: "w2", tab_id: "w2:t1", pane_id: "w2:p1", state_change_seq: 7 }, { workspace_id: "w2", tab_id: "w2:t1", pane_id: "w2:p2", state_change_seq: 12 }] });
    expect((seq.groups as { children: { changedSeq?: number }[] }[])[1].children[0].changedSeq).toBe(12);
    expect((workspaceSnapshot(snapshot).groups as { children: { changedSeq?: number }[] }[])[1].children[0].changedSeq).toBeUndefined();
  });
  it("migrates only recognized Phren keys and preserves unrelated restrictions", () => {
    const key = 'restrict,port-forwarding,permitopen="127.0.0.1:*",command="python3 ~/.local/share/phren/chat-progress.py" ssh-ed25519 AAAA phren-iphone\n';
    const other = key.replace("phren-iphone", "personal");
    const custom = key.replace("python3 ~/.local/share/phren/chat-progress.py", "/custom/policy");
    const result = upgradeKeys(key + other + custom);
    expect(result.changed).toBe(1);
    expect(result.text).toContain('restrict,pty,command="sh ~/.local/share/phren/bridge/dispatch"');
    expect(result.text).toContain(other + custom);
    expect(upgradeKeys(result.text).changed).toBe(0);
  });
  it("rejects arbitrary commands, shells, and malformed terminal destinations", async () => {
    for (const command of ["", "sh", "phren-hook v1 pipe; id", "phren-hook v1 shell /Users/me", "phren-hook v1 terminal ../../work", "phren-hook v1 terminal work\necho secret", "phren-hook v2 pipe"]) {
      await expect(dispatch(command)).rejects.toThrow("only permits");
    }
  });
  it("excludes private reasoning and sidechain events", () => {
    expect(visibleEvent({ type: "response_item", payload: { type: "reasoning", text: "private" } }, "codex")).toBeUndefined();
    expect(visibleEvent({ type: "assistant", isSidechain: true, message: {} }, "claude")).toBeUndefined();
    expect(visibleEvent({ type: "assistant.message", agentId: "subagent", data: { content: "private" } }, "copilot")).toBeUndefined();
    expect(JSON.stringify(visibleEvent({ type: "assistant", message: { content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Visible" }] } }, "claude"))).not.toContain("private");
  });
  it("exports Claude background task notifications and queued prompts from queue rows", () => {
    const content = "<task-notification>\n<tool-use-id>tool-1</tool-use-id>\n<status>completed</status>\n<summary>Background tests completed (exit code 0)</summary>\n</task-notification>";
    expect(visibleEvent({ type: "queue-operation", operation: "enqueue", timestamp: "now", content }, "claude"))
      .toEqual({ type: "system", phrenBackground: true, timestamp: "now", message: { role: "user", content } });
    // A prompt sent mid-turn only ever exists as its enqueue row; the phone
    // draws it as the person's bubble. Consumption exports only its digest.
    expect(visibleEvent({ type: "queue-operation", operation: "enqueue", timestamp: "now", content: "a queued human prompt" }, "claude"))
      .toMatchObject({ type: "user", phrenQueued: true, timestamp: "now", message: { role: "user", content: "a queued human prompt" } });
    expect(visibleEvent({ type: "queue-operation", operation: "remove", timestamp: "now", content: "a queued human prompt" }, "claude"))
      .toMatchObject({ type: "phren_queue_consumed", timestamp: "now" });
    expect(visibleEvent({ type: "queue-operation", content: "<task-notification>missing id</task-notification>" }, "claude")).toBeUndefined();
    expect(visibleEvent({ type: "queue-operation", operation: "enqueue", content: "<system-reminder>internal</system-reminder>" }, "claude")).toBeUndefined();
    // Sent from the phone mid-turn: the terminal pastes it, Claude Code wraps
    // it, and the bubble must still appear with the person's own words.
    const pasted = '<pasted_content id="57d2">\nAm I on the latest version?\n</pasted_content id="57d2">';
    const queued = visibleEvent({ type: "queue-operation", operation: "enqueue", timestamp: "now", content: pasted }, "claude") as { phrenQueueKey: string };
    expect(queued).toMatchObject({ type: "user", phrenQueued: true, message: { role: "user", content: "Am I on the latest version?" } });
    expect(visibleEvent({ type: "queue-operation", operation: "remove", timestamp: "now", content: pasted }, "claude"))
      .toMatchObject({ type: "phren_queue_consumed", key: queued.phrenQueueKey });
    expect(visibleEvent({ type: "queue-operation", operation: "enqueue", content: '<pasted_content id="1">\n<system-reminder>x</system-reminder>\n</pasted_content id="1">' }, "claude")).toBeUndefined();
  });
  it("exports phren-agent message events without reasoning, header, or splices", () => {
    const assistant = { seq: 3, time: "2026-09-12T20:00:00.000Z", type: "assistant/message", data: { turn: 1, stop_reason: "tool_use",
      usage: { input_tokens: 120, output_tokens: 40 },
      message: { role: "assistant", content: [{ type: "reasoning", text: "private", signature: "sig" }, { type: "text", text: "Visible" },
        { type: "tool_use", id: "call_1", name: "bash", input: { cmd: "ls" } }] } } };
    const exported = visibleEvent(assistant, "phren")!;
    expect(JSON.stringify(exported)).not.toContain("private");
    expect(exported).toEqual({ seq: 3, time: "2026-09-12T20:00:00.000Z", type: "assistant/message", data: { turn: 1, stop_reason: "tool_use",
      usage: { input_tokens: 120, output_tokens: 40 },
      message: { role: "assistant", content: [{ type: "redacted" }, { type: "text", text: "Visible" }, { type: "tool_use", id: "call_1", name: "bash", input: { cmd: "ls" } }] } } });
    expect(visibleEvent({ type: "header", version: 1, sessionId: session, cwd: "/work" }, "phren")).toBeUndefined();
    expect(visibleEvent({ seq: 9, type: "log/replace", data: { start: 1, end: 4, message: { role: "user", content: "summary" } } }, "phren")).toBeUndefined();
    const results = visibleEvent({ seq: 4, type: "tool/results", data: { turn: 1, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "a\nb" }] } } }, "phren")!;
    expect(object(results.data).message).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "a\nb" }] });
  });
  it("finds a phren-agent event log under the store's runtime sessions", async () => {
    const store = await mkdtemp(path.join(tmpdir(), "phren-store-"));
    const previous = process.env.PHREN_PATH;
    process.env.PHREN_PATH = store;
    try {
      expect(phrenStoreRoot()).toBe(path.resolve(store));
      await mkdir(path.join(store, ".runtime/sessions"), { recursive: true });
      const file = path.join(store, ".runtime/sessions", `session-${session}.events.jsonl`);
      await writeFile(file, JSON.stringify({ type: "header", version: 1, sessionId: session, cwd: store }) + "\n"
        + JSON.stringify({ seq: 1, time: "t", type: "user/message", data: { message: { role: "user", content: "Hi" }, source: "user", turn: 1 } }) + "\n");
      expect(await transcriptPath("phren", session)).toBe(await realpathAsync(file));
      const page = await new TranscriptReader(await transcriptPath("phren", session), "phren").read();
      expect(page.entries.map(e => e.raw.type)).toEqual(["user/message"]);
      await expect(transcriptPath("phren", "bbbbbbbb-2222-4222-8222-222222222222")).rejects.toThrow("not available");
    } finally {
      if (previous === undefined) delete process.env.PHREN_PATH; else process.env.PHREN_PATH = previous;
      await rm(store, { recursive: true, force: true });
    }
  });
  it("exports only the model from a Codex turn context", () => {
    const context = { type: "turn_context", timestamp: "2026-09-12T05:24:16.986Z", payload: { model: "gpt-6-astra", cwd: "/private/work", approval_policy: "never", instructions: "private" } };
    expect(visibleEvent(context, "codex")).toEqual({ type: "turn_context", timestamp: "2026-09-12T05:24:16.986Z", payload: { model: "gpt-6-astra" } });
    expect(visibleEvent({ type: "turn_context", payload: { cwd: "/private/work" } }, "codex")).toBeUndefined();
  });
  it("locates a project on this computer from activity, Herdr state, registration and search roots", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "phren-locate-"));
    await mkdir(path.join(home, "Projects/phren/apps"), { recursive: true });
    await mkdir(path.join(home, "work/phren"), { recursive: true });
    await mkdir(path.join(home, ".config/herdr"), { recursive: true });
    await writeFile(path.join(home, ".config/herdr/session.json"), JSON.stringify({ workspaces: [{ cwd: path.join(home, "work/phren") }, { cwd: "/nowhere/phren" }] }));
    await mkdir(path.join(home, "store/phren"), { recursive: true });
    await writeFile(path.join(home, "store/phren/phren.project.yaml"), `sourcePath: ${path.join(home, "Projects/phren")}\n`);
    const previousHerdr = process.env.PHREN_HERDR_HOME;
    process.env.PHREN_HERDR_HOME = path.join(home, ".config/herdr");
    try {
      const activity = [
        { at: "2026-09-12T01:00:00Z", directory: path.join(home, "Projects/phren/apps") },
        { at: "2026-09-12T02:00:00Z", directory: "/gone/phren" },
        { at: "2026-09-12T03:00:00Z", directory: path.join(home, "Projects/other") },
      ];
      const found = await locateProject("phren", activity, { ...process.env, PHREN_PATH: path.join(home, "store"), PROJECTS_DIR: path.join(home, "work") });
      // Candidates come back as real paths (macOS resolves /var to /private/var).
      const real = (p: string) => realpathSync.native(p);
      expect(found.map(f => [f.source, f.directory])).toEqual([
        ["activity", real(path.join(home, "Projects/phren"))], // trimmed to the project folder, newest first
        ["herdr", real(path.join(home, "work/phren"))],
      ]);
      expect(found[0].lastSeen).toBe("2026-09-12T01:00:00Z");
      await expect(locateProject("../etc", [])).rejects.toThrow("Invalid project name");
      expect(await locateProject("nothing-here", [], { ...process.env, HOME: home })).toEqual([]);
    } finally {
      if (previousHerdr === undefined) delete process.env.PHREN_HERDR_HOME; else process.env.PHREN_HERDR_HOME = previousHerdr;
    }
  });

  it("reports the pane's branch with a short cache and nothing for a plain folder", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "phren-branch-"));
    const git = (...args: string[]) => execFileAsync("git", ["-C", repo, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: repo } });
    await git("init", "-q", "-b", "trunk");
    expect(await repositoryBranch(repo)).toBe("trunk");
    await git("checkout", "-q", "-b", "feature");
    expect(await repositoryBranch(repo)).toBe("trunk"); // cached for a few seconds
    const plain = await mkdtemp(path.join(tmpdir(), "phren-plain-"));
    expect(await repositoryBranch(plain)).toBeUndefined();
  });

  it("records what a shell call changed, across the pane's repository and the store, and holds the output row until it is known", async () => {
    const home = await realpathAsync(await mkdtemp(path.join(tmpdir(), "phren-changes-")));
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: home, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
    const git = (cwd: string, ...args: string[]) => execFileAsync("git", ["-C", cwd, ...args], { env });
    const project = path.join(home, "work/app"), store = path.join(home, ".phren");
    await mkdir(path.join(project, "src"), { recursive: true }); await mkdir(path.join(store, "app"), { recursive: true });
    for (const repo of [project, store]) await git(repo, "init", "-q", "-b", "main");
    await writeFile(path.join(project, "src/a.ts"), "const a = 1;\n"); await writeFile(path.join(project, ".gitignore"), "dist/\n");
    await git(project, "add", "."); await git(project, "commit", "-q", "-m", "start");
    await writeFile(path.join(store, "app/FINDINGS.md"), "- old\n"); await git(store, "add", "."); await git(store, "commit", "-q", "-m", "start");
    const previous = { HOME: process.env.HOME, PHREN_PATH: process.env.PHREN_PATH, PHREN_BRIDGE_HOME: process.env.PHREN_BRIDGE_HOME };
    process.env.HOME = home; process.env.PHREN_PATH = store; process.env.PHREN_BRIDGE_HOME = path.join(home, "bridge");
    try {
      const changes = new ToolChanges();
      const command = "sed -i '' 's/1/2/' src/a.ts && echo '- new' >> ~/.phren/app/FINDINGS.md && mkdir -p dist && echo x > dist/out.js";
      await changes.before("claude:s1", "toolu_1", project, command);
      const view = changes.view("claude:s1");
      expect(view.pending("toolu_1")).toBe(true);
      // The command runs: an edit, a new file the store's hook commits at once, and ignored build output.
      await writeFile(path.join(project, "src/a.ts"), "const a = 2;\n");
      await writeFile(path.join(project, "src/b.ts"), "export {};\n");
      await mkdir(path.join(project, "dist")); await writeFile(path.join(project, "dist/out.js"), "x");
      await appendFile(path.join(store, "app/FINDINGS.md"), "- new\n"); await git(store, "commit", "-q", "-am", "phren: capture finding");
      await changes.after("claude:s1", "toolu_1");
      expect(view.pending("toolu_1")).toBe(false);
      const files = (await view.changes("toolu_1"))!;
      expect(files.map(f => [f.root, f.path, f.status, f.added, f.removed])).toEqual([
        [project, "src/a.ts", "M", 1, 1], [project, "src/b.ts", "A", 1, 0], [store, "app/FINDINGS.md", "M", 1, 0],
      ]);
      expect(files[0].patch).toContain("+const a = 2;");
      expect(await view.changes("toolu_none")).toBeUndefined();
      // A fresh instance reads the record back from disk.
      expect((await new ToolChanges().view("claude:s1").changes("toolu_1"))?.map(f => f.path)).toEqual(["src/a.ts", "src/b.ts", "app/FINDINGS.md"]);
      // A call that changed nothing leaves no attachment.
      await changes.before("claude:s1", "toolu_2", project, "ls"); await changes.after("claude:s1", "toolu_2");
      expect(await view.changes("toolu_2")).toBeUndefined();

      // The reader attaches the record to the output row, and holds a row whose diff is still pending.
      const transcript = path.join(home, "t.jsonl");
      const row = (id: string) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
      await writeFile(transcript, [JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command } }] } }), row("toolu_1")].join("\n") + "\n");
      const reader = new TranscriptReader(transcript, "claude", undefined, view);
      const page = await reader.read();
      expect(page.entries).toHaveLength(2);
      expect(Object.keys((page.entries[1].raw as { phren_changes: Record<string, unknown> }).phren_changes)).toEqual(["toolu_1"]);
      await changes.before("claude:s1", "toolu_3", project, "touch src/c.ts");
      await appendFile(transcript, row("toolu_3") + "\n");
      const held = await reader.read();
      expect(held.entries).toHaveLength(0); // the row waits for PostToolUse
      await writeFile(path.join(project, "src/c.ts"), ""); await changes.after("claude:s1", "toolu_3");
      const released = await reader.read();
      expect(released.entries.map(e => e.line)).toEqual([2]);
      expect((released.entries[0].raw as { phren_changes: Record<string, { path: string }[]> }).phren_changes.toolu_3.map(f => f.path)).toEqual(["src/c.ts"]);
    } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
    expect(namedPaths("cat ~/x/y.md /etc/hosts ./a https://h/p 'p/q'")).toEqual(["~/x/y.md", "/etc/hosts", "./a"]);
    expect(outputCallIds({ type: "response_item", payload: { type: "function_call_output", call_id: "c1" } }, "codex")).toEqual(["c1"]);
    expect(outputCallIds({ type: "tool.execution_complete", data: { toolCallId: "t1" } }, "copilot")).toEqual(["t1"]);
  });

  it("diffs the paths a command named: other repositories and commits a hook already made", async () => {
    const home = await realpathAsync(await mkdtemp(path.join(tmpdir(), "phren-diff-")));
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: home, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
    const git = (cwd: string, ...args: string[]) => execFileAsync("git", ["-C", cwd, ...args], { env });
    const project = path.join(home, "work/app"), store = path.join(home, ".phren");
    await mkdir(project, { recursive: true }); await mkdir(path.join(store, "app"), { recursive: true });
    for (const repo of [project, store]) await git(repo, "init", "-q", "-b", "main");
    await writeFile(path.join(project, "a.txt"), "one\n"); await git(project, "add", "."); await git(project, "commit", "-q", "-m", "start");
    await writeFile(path.join(store, "app/FINDINGS.md"), "- old\n"); await git(store, "add", "."); await git(store, "commit", "-q", "-m", "start");
    // The agent appended to the store and phren's Stop hook committed it at once.
    await appendFile(path.join(store, "app/FINDINGS.md"), "- new pitfall\n"); await git(store, "commit", "-q", "-am", "phren: capture finding");
    // The project has an edit still in the working tree and one already committed.
    await writeFile(path.join(project, "a.txt"), "two\n");
    await writeFile(path.join(project, "b.txt"), "b\n"); await git(project, "add", "b.txt"); await git(project, "commit", "-q", "-m", "add b");
    const previousHome = process.env.HOME, previousStore = process.env.PHREN_PATH;
    process.env.HOME = home; process.env.PHREN_PATH = store;
    try {
      const diff = await repositoryDiff(project, ["~/.phren/app", path.join(project, "b.txt")]) as {
        root: string; files: { path: string; status: string; sections: { id: string; kind: string; patch: string; note?: string }[] }[];
        related: { root: string; branch: string; files: { path: string; status: string; sections: { patch: string; note?: string }[] }[] }[];
      };
      expect(diff.root).toBe(project);
      expect(diff.files.map(f => f.path)).toEqual(["a.txt", "b.txt"]);
      expect(diff.files[0].sections[0]).toMatchObject({ kind: "unstaged" });
      expect(diff.files[1].sections[0]).toMatchObject({ id: "committed:b.txt", kind: "committed", note: expect.stringMatching(/^[0-9a-f]{7,} · add b · /) });
      expect(diff.files[1].sections[0].patch).toContain("+b");
      expect(diff.related).toHaveLength(1);
      expect(diff.related[0]).toMatchObject({ root: store, branch: "main" });
      expect(diff.related[0].files).toHaveLength(1);
      expect(diff.related[0].files[0]).toMatchObject({ path: "app", status: "  " });
      expect(diff.related[0].files[0].sections[0].patch).toContain("+- new pitfall");
      expect(diff.related[0].files[0].sections[0].note).toMatch(/phren: capture finding/);
      // Nothing named: the same shape as before, without the related list.
      expect(await repositoryDiff(project)).not.toHaveProperty("related");
    } finally {
      process.env.HOME = previousHome;
      if (previousStore === undefined) delete process.env.PHREN_PATH; else process.env.PHREN_PATH = previousStore;
    }
  });
});

describe.skipIf(process.platform === "win32")("standalone Phren service", () => {
  let root: string, hook: ChildProcess, herdr: Server, log: string, record: string, commands: { method: string; params: Record<string, unknown> }[];
  let current = session;
  let agentStatus = "working";
  let reportIdentity = true, foregroundPID = process.pid, terminalID = "term-one";
  let holdSnapshot = false, releaseSnapshot: (() => void) | undefined;
  let replaceBeforeMutation = false;
  let deliveries: { method: string; session: string }[];
  let extraWorkspaces: Record<string, unknown>[] = [], extraTabs: Record<string, unknown>[] = [], extraPanes: Record<string, unknown>[] = [], failAgentStart = false, blockAgentStart = false, promptNotReady = 0;
  let helperPIDs: number[] = [];
  let paneLines = "", drawConfirmation = false;
  let confirmationHasKeys = true;
  let menuHighlight: number | undefined, confirmedMenuRow: number | undefined;
  let ignoredMenuMoves = 0, loseMenuHighlight = false, replaceMenuAfterMove = false;
  /** The pane a moving highlight redraws; the permissions menu unless a test sets its own. */
  let menuPane: (highlight: number | undefined) => string = permissionsMenu;
  let paneAgent = "codex";
  let paneCwd: string | undefined;
  let remoteHook: ChildProcess | undefined;
  // The Hook's identity cache (2 s) and terminal-dialog throttle (3 s), shortened so tests do not wait them out.
  const IDENTITY_CACHE_MS = 200, DIALOG_THROTTLE_MS = 300;
  /** Agent names by pane: real Herdr keeps them in the snapshot's agents list, never on the pane. */
  let agentNames = new Map<string, string>();
  const herdrSockets = new Set<Socket>();
  // The fake's snapshot, built in the recorded Herdr shape (see herdrShapeProblems).
  const paneInfo = (workspace: string, tab: string, pane: string, terminal: string, cwd: unknown): Record<string, unknown> =>
    ({ pane_id: pane, terminal_id: terminal, workspace_id: workspace, tab_id: tab, focused: false, cwd, foreground_cwd: cwd, agent_status: "unknown", revision: 0 });
  const tabInfo = (workspace: string, tab: string, label: unknown, number: number): Record<string, unknown> =>
    ({ tab_id: tab, workspace_id: workspace, number, label, focused: false, pane_count: 1, agent_status: "unknown" });
  const workspaceInfo = (workspace: string, label: unknown, number: number): Record<string, unknown> =>
    ({ workspace_id: workspace, number, label, focused: false, pane_count: 1, tab_count: 1, active_tab_id: `${workspace}:t1`, agent_status: "unknown" });
  const mainPane = (): Record<string, unknown> => ({ ...paneInfo("w1", "w1:t1", "w1:p1", terminalID, paneCwd ?? root),
    agent: paneAgent, agent_status: agentStatus,
    agent_session: reportIdentity ? { source: `herdr:${paneAgent}`, agent: paneAgent, kind: "id", value: current } : undefined });
  const agentInfo = (pane: Record<string, unknown>): Record<string, unknown> => ({ terminal_id: pane.terminal_id,
    name: agentNames.get(String(pane.pane_id)), agent: pane.agent, agent_status: pane.agent_status, agent_session: pane.agent_session,
    workspace_id: pane.workspace_id, tab_id: pane.tab_id, pane_id: pane.pane_id, focused: pane.focused,
    cwd: pane.cwd, foreground_cwd: pane.foreground_cwd, revision: pane.revision });
  function fakeSnapshot(): Record<string, unknown> {
    const panes = [mainPane(), ...extraPanes];
    // A tab or workspace reports the status of the agent it holds.
    const status = (match: (pane: Record<string, unknown>) => boolean) => panes.find(p => match(p) && p.agent)?.agent_status ?? "unknown";
    return { version: recordedSnapshot.version, protocol: recordedSnapshot.protocol,
      workspaces: [workspaceInfo("w1", "Project", 1), ...extraWorkspaces].map(w => ({ ...w, agent_status: status(p => p.workspace_id === w.workspace_id) })),
      tabs: [tabInfo("w1", "w1:t1", "1", 1), ...extraTabs].map(t => ({ ...t, agent_status: status(p => p.tab_id === t.tab_id) })),
      panes, layouts: [], agents: panes.filter(p => p.agent).map(agentInfo) };
  }
  function api(url: string, body?: unknown, method?: string): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const verb = method ?? (payload === undefined ? "GET" : "POST");
      const req = request({ socketPath: path.join(root, "bridge/hook.sock"), path: url, method: verb,
        headers: payload ? { "Content-Length": Buffer.byteLength(payload), "Content-Type": "application/json" } : {} }, res => {
        let data = ""; res.on("data", bytes => data += bytes); res.on("end", () => resolve({ status: res.statusCode!, data: JSON.parse(data) }));
      });
      req.on("error", reject); req.end(payload);
    });
  }
  /** One request straight to the fake Herdr socket, answered as Herdr answers it. */
  function herdrCall(method: string, params: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const client = createConnection(path.join(root, "herdr/herdr.sock"));
      let data = "";
      client.on("connect", () => client.write(JSON.stringify({ id: "fixture", method, params }) + "\n"));
      client.on("data", bytes => data += bytes);
      client.on("end", () => resolve(JSON.parse(data.split("\n")[0])));
      client.on("error", reject);
    });
  }
  /** A GET whose body is bytes, not JSON. */
  function blob(url: string): Promise<{ status: number; bytes: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: path.join(root, "bridge/hook.sock"), path: url, method: "GET" }, res => {
        const chunks: Buffer[] = []; res.on("data", bytes => chunks.push(bytes)); res.on("end", () => resolve({ status: res.statusCode!, bytes: Buffer.concat(chunks) }));
      });
      req.on("error", reject); req.end();
    });
  }
  function resetVars(): void {
    paneCwd = undefined; commands = []; current = session; agentStatus = "working"; reportIdentity = true; foregroundPID = process.pid; terminalID = "term-one"; log = ""; holdSnapshot = false; releaseSnapshot = undefined;
    replaceBeforeMutation = false; deliveries = [];
    extraWorkspaces = []; extraTabs = []; extraPanes = []; agentNames = new Map(); failAgentStart = false; promptNotReady = 0; helperPIDs = []; remoteHook = undefined;
    paneLines = ""; drawConfirmation = false; paneAgent = "codex";
    confirmationHasKeys = true;
    menuHighlight = undefined; confirmedMenuRow = undefined; ignoredMenuMoves = 0; menuPane = permissionsMenu;
    loseMenuHighlight = false; replaceMenuAfterMove = false;
  }
  async function resetRecord(): Promise<void> {
    record = path.join(root, `codex/sessions/2026/09/10/rollout-2026-09-10T00-00-00-${session}.jsonl`);
    await writeFile(record, JSON.stringify({ type: "session_meta", payload: { id: session } }) + "\n" + JSON.stringify(row("First message")) + "\n");
  }
  async function startFixture(): Promise<void> {
    await stopFixture();
    resetVars();
    root = await mkdtemp(path.join(tmpdir(), "phren-hook-"));
    // Darwin's Unix socket paths are limited to 104 bytes.
    root = await import("node:fs/promises").then(fs => fs.realpath(root));
    if (root.length > 55) {
      const short = await mkdtemp("/tmp/phren-hook-"); await rm(root, { recursive: true }); root = short;
    }
    await mkdir(path.join(root, "bin"));
    await mkdir(path.join(root, "herdr"));
    await mkdir(path.join(root, "codex/sessions/2026/09/10"), { recursive: true });
    await resetRecord();
    herdr = createNetServer(socket => {
      herdrSockets.add(socket); socket.on("close", () => herdrSockets.delete(socket));
      socket.on("error", () => { /* A cancelled client may close before the fixture's reply. */ });
      let pending = ""; socket.on("data", bytes => {
        pending += bytes;
        if (!pending.includes("\n")) return;
        const req = JSON.parse(pending.split("\n")[0]); commands.push(req);
        // Herdr's error envelope: a string code and its own message. A request
        // its schema rejects is answered before it is read, with an empty id.
        const fail = (code: string, message: string, id: string = req.id) =>
          socket.end(JSON.stringify({ id, error: { code, message } }) + "\n");
        const invalid = herdrRequestProblem(req.method, req.params);
        if (invalid) { fail("invalid_request", invalid, ""); return; }
        const panes = () => [mainPane(), ...extraPanes];
        const agentTarget = typeof req.params?.target === "string" ? req.params.target : undefined;
        if (agentTarget !== undefined && !panes().some(p => p.pane_id === agentTarget || agentNames.get(String(p.pane_id)) === agentTarget)) {
          fail("agent_not_found", `agent target ${agentTarget} not found`); return;
        }
        if (["pane.read", "pane.process_info"].includes(req.method) && !panes().some(p => p.pane_id === req.params.pane_id)) {
          fail("pane_not_found", `pane ${req.params.pane_id} not found`); return;
        }
        if (req.method === "agent.prompt" && promptNotReady > 0) {
          promptNotReady--;
          fail("agent_not_ready", `agent ${req.params.target} is not an active named agent`); return;
        }
        if (["agent.prompt", "agent.send_keys"].includes(req.method)) {
          // Herdr 0.8.2/protocol 20 and 0.9.x resolve the current pane occupant.
          // Replace it at dispatch, after every possible snapshot preflight.
          // Unknown params cannot bind an expected session in that contract.
          if (replaceBeforeMutation) current = "bbbbbbbb-1111-4111-8111-111111111111";
          deliveries.push({ method: req.method, session: current });
          const sent: string[] = Array.isArray(req.params?.keys) ? req.params.keys : [];
          if (menuHighlight !== undefined) {
            const arrows = sent.filter(key => key === "down" || key === "up");
            if (arrows.length) {
              if (ignoredMenuMoves > 0) ignoredMenuMoves--;
              else for (const key of arrows) menuHighlight = Math.max(0, Math.min(2, menuHighlight + (key === "down" ? 1 : -1)));
              paneLines = menuPane(loseMenuHighlight ? undefined : menuHighlight);
              if (replaceMenuAfterMove) paneLines = paneLines.replace("Update Model Permissions", "Choose a different setting");
            }
            if (sent.includes("enter")) { confirmedMenuRow = menuHighlight; paneLines = ""; menuHighlight = undefined; }
          }
          // A Codex pane: Enter on the permissions menu draws Full Access's
          // recorded second confirmation; another Enter clears it.
          if (drawConfirmation && sent.includes("enter")) {
            paneLines = paneLines.includes("Enable full access?") ? ""
              : confirmationHasKeys ? keyedFullAccessConfirmation : fullAccessConfirmation;
          }
          if (sent.includes("1")) paneLines = "";
        }
        // Herdr's create calls answer with the new workspace/tab and its root
        // pane, which also show up in the next snapshot; agent.start answers
        // at once and names the agent in the snapshot's agents list.
        let created: Record<string, unknown> | undefined;
        if (req.method === "workspace.create") {
          const wid = `w${9 + extraWorkspaces.length}`;
          extraWorkspaces.push(workspaceInfo(wid, req.params.label, extraWorkspaces.length + 2));
          extraTabs.push(tabInfo(wid, `${wid}:t1`, "1", 1));
          extraPanes.push(paneInfo(wid, `${wid}:t1`, `${wid}:p1`, `term-${wid}`, req.params.cwd));
          created = { type: "workspace_created", workspace: extraWorkspaces.at(-1), tab: extraTabs.at(-1), root_pane: extraPanes.at(-1) };
        } else if (req.method === "tab.create") {
          const wid = req.params.workspace_id, n = extraTabs.filter(t => t.workspace_id === wid).length + 2;
          extraTabs.push(tabInfo(wid, `${wid}:t${n}`, req.params.label, n));
          extraPanes.push(paneInfo(wid, `${wid}:t${n}`, `${wid}:p${n}`, `term-${wid}-${n}`, req.params.cwd));
          created = { type: "tab_created", tab: extraTabs.at(-1), root_pane: extraPanes.at(-1) };
        } else if (req.method === "agent.start") {
          const timeout = req.params.timeout_ms;
          if (typeof timeout === "number" && (timeout <= 3_000 || timeout > 300_000)) {
            fail("invalid_agent_timeout", "agent start timeout must be greater than 3000ms and at most 300000ms"); return;
          }
          const target = extraPanes.find(p => p.pane_id === req.params.pane_id);
          if (!target) { fail("agent_pane_not_found", `agent target pane ${req.params.pane_id} not found`); return; }
          if (failAgentStart) { fail("agent_pane_busy", `agent target pane ${req.params.pane_id} is not an available shell`); return; }
          agentNames.set(String(target.pane_id), req.params.name);
          target.agent = req.params.kind;
          if (blockAgentStart) {
            target.agent_status = "blocked";
            fail("agent_not_ready", `agent ${req.params.name} is blocked during startup and is not ready for prompts`); return;
          }
          target.agent_status = "idle";
          created = { type: "agent_started", agent: agentInfo(target), argv: [req.params.kind, ...(req.params.args ?? [])] };
        }
        const readPane = (paneId: string) => {
          const pane = panes().find(p => p.pane_id === paneId || agentNames.get(String(p.pane_id)) === paneId)!;
          return { type: "pane_read", read: { pane_id: pane.pane_id, workspace_id: pane.workspace_id, tab_id: pane.tab_id,
            source: req.params.source, format: req.params.format ?? "text", text: pane.pane_id === "w1:p1" ? paneLines : "", revision: 0, truncated: false } };
        };
        const answer = () => socket.end(JSON.stringify({ id: req.id, result: created
          ?? (req.method === "session.snapshot" ? { type: "session_snapshot", snapshot: fakeSnapshot() }
          : req.method === "pane.process_info" ? { type: "pane_process_info", process_info: { pane_id: req.params.pane_id,
            foreground_processes: [{ pid: foregroundPID }, ...helperPIDs.map(pid => ({ pid }))] } }
          : req.method === "agent.read" ? readPane(req.params.target)
          : req.method === "pane.read" ? readPane(req.params.pane_id)
          : req.method === "agent.prompt" ? { type: "agent_prompted", agent: agentInfo(panes().find(p => p.pane_id === agentTarget || agentNames.get(String(p.pane_id)) === agentTarget)!) }
          : { type: "ok" }) }) + "\n");
        if (holdSnapshot && req.method === "session.snapshot") { holdSnapshot = false; releaseSnapshot = answer; }
        else answer();
      });
    });
    await new Promise<void>(resolve => herdr.listen(path.join(root, "herdr/herdr.sock"), resolve));
    await mkdir(path.join(root, "bridge/changes"), { recursive: true });
    const expired = path.join(root, "bridge/changes/expired.jsonl");
    await writeFile(expired, "{}\n"); await utimes(expired, 1, 1);
    hook = spawn(process.execPath, [hookBundle, "serve"], { env: { ...process.env,
      PATH: `${path.join(root, "bin")}:${process.env.PATH}`, PHREN_PATH: path.join(root, ".phren"),
      HOME: root, PHREN_BRIDGE_HOME: path.join(root, "bridge"), PHREN_HERDR_HOME: path.join(root, "herdr"), CODEX_HOME: path.join(root, "codex"),
      PHREN_APPROVAL_HOLD_MS: "2500", PHREN_IDENTITY_CACHE_MS: String(IDENTITY_CACHE_MS), PHREN_DIALOG_THROTTLE_MS: String(DIALOG_THROTTLE_MS), PHREN_SNAPSHOT_SHARE_MS: String(IDENTITY_CACHE_MS) },
      stdio: ["ignore", "ignore", "pipe"] });
    hook.stderr!.on("data", bytes => log += bytes);
    let ready = false;
    await waitFor(async () => ready = await api("/v1/health").then(r => r.status === 200, () => false));
    expect(ready, log).toBe(true);
  }
  /** SIGTERM, then SIGKILL when a Hook still has not exited three seconds later. */
  async function stopHook(child: ChildProcess | undefined, name: string): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const escalate = setTimeout(() => { console.warn(`${name} ignored SIGTERM for 3 s; killing it`); child.kill("SIGKILL"); }, 3_000);
    await exited; clearTimeout(escalate);
  }
  async function stopFixture(): Promise<void> {
    releaseSnapshot?.();
    await stopHook(hook, "Hook");
    await stopHook(remoteHook, "Remote Hook");
    // A client that never hung up must not hold the fake Herdr open.
    for (const socket of herdrSockets) socket.destroy();
    if (herdr) await new Promise<void>(resolve => herdr.close(() => resolve()));
    if (root) await rm(root, { recursive: true, force: true });
  }
  beforeAll(startFixture);
  afterAll(stopFixture);
  async function dispatchFixture(): Promise<void> {
    const remoteRoot = path.join(root, "remote");
    await mkdir(path.join(root, "remote-store/phren"), { recursive: true });
    await mkdir(path.join(root, "checkout"));
    await writeFile(path.join(root, "remote-store/phren/phren.project.yaml"), `sourcePath: ${JSON.stringify(path.join(root, "checkout"))}\n`);
    const line = await enrollComputer("Desk", path.join(root, "bridge"));
    const hostKey = publicComputerKey(line.slice(line.indexOf("ssh-ed25519")));
    await writeFile(path.join(root, "bridge/hooks.yaml"), JSON.stringify({ version: 1, computers: [
      { name: "Linuxbox", address: "desk.example", username: "sam", hostKey },
    ] }), { mode: 0o600 });
    // The fake SSH executable preserves the byte-pipe boundary; the receiver
    // is a second real Hook with its own store and runtime identity.
    await writeFile(path.join(root, "bin/ssh"), `#!${process.execPath}
const fs = require('node:fs');
const net = require('node:net');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(root, "ssh-calls.jsonl"))}, JSON.stringify(args) + '\\n');
if (args.at(-1) !== 'phren-hook v1 pipe' || !args.includes('StrictHostKeyChecking=yes')) process.exit(2);
const socket = net.connect(${JSON.stringify(path.join(remoteRoot, "hook.sock"))});
socket.on('connect', () => { process.stdin.pipe(socket); socket.pipe(process.stdout); });
socket.on('error', () => process.exit(1));
socket.on('close', () => process.exit(0));
`, { mode: 0o700 });
    remoteHook = spawn(process.execPath, [hookBundle, "serve"], { env: { ...process.env,
      HOME: root, PHREN_PATH: path.join(root, "remote-store"), PHREN_BRIDGE_HOME: remoteRoot,
      PHREN_HERDR_HOME: path.join(root, "herdr"), CODEX_HOME: path.join(root, "codex") }, stdio: ["ignore", "ignore", "pipe"] });
    remoteHook.stderr!.on("data", bytes => log += bytes);
    await waitFor(() => stat(path.join(remoteRoot, "hook.sock")).catch(() => undefined), 2_000);
    if (!await stat(path.join(remoteRoot, "hook.sock")).catch(() => undefined)) throw new Error(`Remote Hook did not start: ${log}`);
  }

  describe("shared fixture", () => {
    beforeEach(async () => { resetVars(); await resetRecord(); });
    it("answers in the shapes recorded from real Herdr", async () => {
      const shape = (name: string) => ({ $ref: `#/schemas/success_response/$defs/${name}` });
      // The recording itself and the fake's snapshot, before and after a launch.
      expect(herdrShapeProblems(shape("SessionSnapshot"), recordedSnapshot)).toEqual([]);
      expect(herdrShapeProblems(shape("SessionSnapshot"), fakeSnapshot())).toEqual([]);
      const created = await herdrCall("workspace.create", { label: "Shape check", cwd: root, focus: false });
      expect(herdrShapeProblems(shape("PaneInfo"), created.result.root_pane)).toEqual([]);
      const started = await herdrCall("agent.start", { name: "shape-check", kind: "codex", pane_id: created.result.root_pane.pane_id, timeout_ms: 45_000 });
      expect(herdrShapeProblems(shape("AgentInfo"), started.result.agent)).toEqual([]);
      const snapshot = fakeSnapshot();
      expect(herdrShapeProblems(shape("SessionSnapshot"), snapshot)).toEqual([]);
      // Real Herdr names an agent only in its agents list, never on the pane.
      expect((snapshot.panes as Record<string, unknown>[]).some(p => "agent_name" in p)).toBe(false);
      expect((snapshot.agents as Record<string, unknown>[]).find(a => a.pane_id === created.result.root_pane.pane_id)?.name).toBe("shape-check");
      expect((await herdrCall("agent.start", { name: "late", kind: "codex", pane_id: created.result.root_pane.pane_id, timeout_ms: 3_000 })).error)
        .toEqual({ code: "invalid_agent_timeout", message: "agent start timeout must be greater than 3000ms and at most 300000ms" });
      // Every error envelope the fake can send has Herdr's string code.
      const errors = JSON.parse(recorded(`herdr/${HERDR_VERSION}/errors.json`)) as { request: { method: string; params: Record<string, unknown> }; response: unknown }[];
      for (const { response } of errors) expect(herdrShapeProblems(herdrSchema.error_response, response)).toEqual([]);
      // The fake refuses a malformed request with Herdr's own words.
      const unread = errors.find(e => e.request.method === "agent.read" && !("source" in e.request.params))!;
      expect(String((unread.response as { error: { message: string } }).error.message))
        .toContain(herdrRequestProblem("agent.read", unread.request.params)!);
      expect(await herdrCall("agent.read", { target: "w1:p1" })).toMatchObject({ id: "", error: { code: "invalid_request" } });
      expect(await herdrCall("pane.read", { pane_id: "w404:p1", source: "recent" })).toMatchObject({ error: { code: "pane_not_found" } });
      expect(await herdrCall("agent.prompt", { target: "nobody", text: "x" })).toMatchObject({ error: { code: "agent_not_found" } });
      // pane.read and agent.read answer with the recorded read's fields.
      const responses = JSON.parse(recorded(`herdr/${HERDR_VERSION}/responses.json`));
      for (const [method, params] of [["pane.read", { pane_id: "w1:p1", source: "recent", lines: 40 }], ["agent.read", { target: "w1:p1", source: "visible" }]] as const) {
        const answer = await herdrCall(method, params);
        expect(herdrShapeProblems(shape("PaneReadResult"), answer.result.read), method).toEqual([]);
        expect(Object.keys(answer.result.read).sort()).toEqual(Object.keys(responses[method].response.result.read).sort());
        expect(answer.result.type).toBe(responses[method].response.result.type);
      }
    });

    it("discovers workspaces through a private protocol without any TCP helper", async () => {
      const checkout = path.join(root, "Projects", "browser-test");
      await mkdir(checkout, { recursive: true });
      await writeFile(path.join(checkout, "readme.md"), "# checkout");
      const listing = await api("/v1/projects/files?project=browser-test");
      expect(listing.status).toBe(200);
      expect(listing.data.entries).toEqual([{ name: "readme.md", path: "readme.md", kind: "file" }]);
      const read = await api("/v1/projects/files?project=browser-test&path=readme.md");
      expect(Buffer.from(read.data.data, "base64").toString()).toBe("# checkout");
      expect((await api("/v1/projects/files?project=browser-test&directory=/etc")).status).toBe(404);
      expect((await api("/v1/projects/files?project=browser-test&path=../secret")).status).toBe(400);
      // Files the phone keeps on the computer, and the simulator routes.
      const upload = await api("/v1/files", { name: "notes.md", data: Buffer.from("# hi\n").toString("base64") });
      expect(upload.status, JSON.stringify(upload.data)).toBe(200); expect(upload.data.path).toMatch(/uploads\/files\/[0-9a-f-]{36}-notes\.md$/);
      expect((await api("/v1/files", { name: "../x", data: "aGk=" })).status).toBe(400);
      expect((await api("/v1/files", { name: "shot.png", data: Buffer.from("not an image").toString("base64") })).status).toBe(400);
      const files = await api("/v1/files");
      expect(files.data.files.map((f: { name: string; size: number }) => [f.name, f.size])).toEqual([["notes.md", 5]]);
      expect((await api("/v1/simulators/screenshot?udid=nope")).status).toBe(400);
      expect((await api("/v1/simulators/action", { udid: "nope", action: "tap", x: 0.5, y: 0.5 })).status).toBe(400);
      expect((await api("/v1/simulators/apps?udid=nope")).status).toBe(400);
      const simulators = await api("/v1/simulators");
      expect(simulators.status).toBe(200); expect(Array.isArray(simulators.data.simulators)).toBe(true);
      if (process.platform !== "darwin") expect(simulators.data.simulators).toEqual([]);
      const health = await api("/v1/health");
      expect(health.data.product).toBe("phren-hook"); expect(health.data.protocol).toBe(1);
      // The code module is off in this fixture, so the package is reported missing.
      expect(health.data.codePackage).toEqual({ missing: true });
      expect(health.data.load.cpus).toBeGreaterThan(0);
      expect(health.data.load.average).toBeGreaterThanOrEqual(0);
      // The node gateway's last startup cost, once it has answered.
      await writeFile(path.join(root, "bridge/gateway.json"), JSON.stringify({ ms: 4200, at: new Date().toISOString() }));
      expect((await api("/v1/health")).data.gatewayMs).toBe(4200);
      // A phone that predates OpenCode Go names no sources and must not meet one it cannot read.
      const legacyUsage = await api("/v1/usage");
      expect(legacyUsage.status).toBe(200);
      expect(legacyUsage.data.accounts.map((a: { source: string }) => a.source)).not.toContain("opencode-go");
      const fullUsage = await api("/v1/usage?sources=codex,claude,opencode,opencode-go,openrouter");
      expect(fullUsage.data.accounts.map((a: { source: string }) => a.source)).toContain("opencode-go");
      const workspaces = await api("/v1/workspaces?mux=herdr:default");
      expect(workspaces.data.groups[0].children[0].id).toBe("w1:t1");
      expect(workspaces.data.phren.load.cpus).toBeGreaterThan(0);
      expect(workspaces.data.phren.gatewayMs).toBe(4200);
      expect((await api("/v1/workspaces/panes?groupId=w1&childId=w1:t1")).data.panes[0].sessionId).toBe(session);
      expect((await api("/v1/activity")).data.events[0].directory).toBe(root);
      // The counters saw the Herdr calls, identity probe and timers behind the reads above.
      const metrics = await api("/v1/metrics");
      expect(metrics.status).toBe(200);
      expect(Object.keys(metrics.data).sort()).toEqual(["git", "herdr", "identity", "pid", "startedAt", "timers", "uptimeSeconds"]);
      expect(metrics.data.herdr["session.snapshot"].total).toBeGreaterThan(0);
      expect(metrics.data.herdr["pane.process_info"].total).toBeGreaterThan(0);
      expect(Object.keys(metrics.data.identity).length).toBeGreaterThan(0);
      expect(metrics.data.herdr["session.snapshot"]).toEqual({ total: expect.any(Number), lastMinute: expect.any(Number),
        currentMinute: expect.any(Number), perMinute: expect.any(Number) });
      expect(JSON.stringify(metrics.data)).not.toContain(root);
      const permissions = await import("node:fs/promises").then(fs => fs.stat(path.join(root, "bridge/hook.sock")));
      expect(permissions.mode & 0o777).toBe(0o600);
      expect(await stat(path.join(root, "bridge/changes/expired.jsonl")).catch(() => undefined)).toBeUndefined();
      expect((await stat(path.join(root, "bridge/computer-id"))).mode & 0o777).toBe(0o600);
    });

    it("records the node gateway cost for the phone's byte pipe", async () => {
      await rm(path.join(root, "bridge/gateway.json"), { force: true });
      const child = spawn(process.execPath, [hookBundle, "ssh"], {
        env: { ...process.env, PHREN_BRIDGE_HOME: path.join(root, "bridge"), PHREN_HERDR_HOME: path.join(root, "herdr"),
          PHREN_PATH: path.join(root, ".phren"), SSH_ORIGINAL_COMMAND: "phren-hook v1 pipe" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const chunks: Buffer[] = []; child.stdout.on("data", bytes => chunks.push(bytes));
      child.stdin.end("GET /v1/health HTTP/1.1\r\nHost: phren.local\r\nConnection: close\r\n\r\n");
      const [code] = await once(child, "exit");
      expect(code).toBe(0);
      expect(Buffer.concat(chunks).toString()).toContain('"product":"phren-hook"');
      const sample = JSON.parse(await readFile(path.join(root, "bridge/gateway.json"), "utf8"));
      expect(sample.ms).toBeGreaterThanOrEqual(0);
    });

    it.each([false, true])("returns an intact upload reply through the SSH gateway (stdin EOF: %s)", async endInput => {
      const child = spawn(process.execPath, [hookBundle, "ssh"], {
        env: { ...process.env, PHREN_BRIDGE_HOME: path.join(root, "bridge"), PHREN_HERDR_HOME: path.join(root, "herdr"),
          PHREN_PATH: path.join(root, ".phren"), SSH_ORIGINAL_COMMAND: "phren-hook v1 pipe" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [], errors: Buffer[] = [];
      child.stdout.on("data", bytes => chunks.push(bytes));
      child.stderr.on("data", bytes => errors.push(bytes));
      const closed = once(child, "close");
      const bytes = Buffer.alloc(400 * 1024, 0x61);
      // Keep the PNG signature that the upload validator checks.
      Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
      const body = Buffer.from(JSON.stringify({ target, name: "large.png", data: bytes.toString("base64") }));
      try {
        child.stdin.write(`POST /v1/upload HTTP/1.1\r\nHost: phren.local\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
        for (let offset = 0; offset < body.length; offset += 16_384) {
          if (!child.stdin.write(body.subarray(offset, offset + 16_384))) await once(child.stdin, "drain");
        }
        if (endInput) child.stdin.end();
        const [code] = await closed;
        expect(code, Buffer.concat(errors).toString()).toBe(0);
        const reply = Buffer.concat(chunks).toString();
        const boundary = reply.indexOf("\r\n\r\n");
        expect(reply.slice(0, boundary)).toMatch(/^HTTP\/1\.1 200 /);
        const json = reply.slice(boundary + 4);
        const length = /content-length: (\d+)/i.exec(reply.slice(0, boundary));
        expect(length).not.toBeNull();
        expect(Buffer.byteLength(json)).toBe(Number(length![1]));
        const uploaded = JSON.parse(json);
        expect(await readFile(uploaded.path)).toEqual(bytes);
      } finally {
        child.stdin.destroy();
        if (child.exitCode === null) child.kill();
      }
    });

    it("lists, launches, and reports scheduled prompts", async () => {
      const health = await api("/v1/health"), computer = health.data.computer.name;
      const project = path.join(root, ".phren/demo");
      await mkdir(project, { recursive: true });
      await writeFile(path.join(project, "phren.project.yaml"), `sourcePath: ${JSON.stringify(root)}\n`);
      await writeFile(path.join(project, "schedules.yaml"), `version: 1
schedules:
  - id: 7f3a2c1d
    name: Nightly test sweep
    enabled: true
    computer: ${JSON.stringify(computer)}
    harness: codex
    model: gpt-5.6-sol
    every: daily
    at: "07:30"
    prompt: Run the test suite.
    createdAt: 2099-09-20T21:00:00Z
    updatedAt: 2099-09-20T21:00:00Z
`);
      const listing = await api("/v1/schedules", {});
      expect(listing.status).toBe(200);
      expect(listing.data.computer).toBe(computer);
      expect(listing.data.schedules[0]).toMatchObject({ id: "7f3a2c1d", project: "demo", running: false, lastRun: null });
      // Claude is still starting when the run first prompts; the run waits for it.
      promptNotReady = 1;
      const launched = await api("/v1/schedules/run", { project: "demo", id: "7f3a2c1d" });
      expect(launched.status, JSON.stringify(launched.data)).toBe(200);
      expect(commands.filter(command => command.method === "agent.prompt" && command.params.text === "Run the test suite.")).toHaveLength(2);
      expect(launched.data.run).toMatchObject({ scheduleId: "7f3a2c1d", project: "demo", status: "running",
        launch: { mode: "herdr" } });
      expect(commands.some(command => command.method === "agent.prompt" && command.params.text === "Run the test suite.")).toBe(true);
      expect((await api("/v1/schedules/run", { project: "demo", id: "7f3a2c1d" })).status).toBe(409);
      const history = await api("/v1/schedules/history", { project: "demo", id: "7f3a2c1d", limit: 10 });
      expect(history.status).toBe(200);
      expect(history.data.runs[0]).toMatchObject({ scheduleId: "7f3a2c1d", project: "demo" });
      const runsFile = path.join(root, "bridge", "schedule-runs.jsonl");
      await appendFile(runsFile, JSON.stringify({ id: "3f0e9c2a-0000-4000-8000-000000000001", scheduleId: "7f3a2c1d", project: "demo",
        startedAt: "2026-09-21T08:00:00.000Z", status: "blocked",
        blockedStartupPrompt: "Allow external CLAUDE.md file imports?",
        launch: { mode: "herdr", server: "default", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" } }) + "\n");
      const blockedHistory = await api("/v1/schedules/history", { project: "demo", id: "7f3a2c1d", limit: 10 });
      expect(blockedHistory.data.runs[0]).toMatchObject({ status: "blocked",
        blockedStartupPrompt: "Allow external CLAUDE.md file imports?" });
      const listingAfterBlock = await api("/v1/schedules", {});
      expect(listingAfterBlock.data.schedules[0].lastRun).toMatchObject({ status: "blocked",
        blockedStartupPrompt: "Allow external CLAUDE.md file imports?" });
    });

    it("serves the phone's own uploaded images by path and nothing outside the uploads folder", async () => {
      // A picture the phone sent lands in a Claude transcript as the text
      // "[Image: source: <path>]"; the chat fetches its bytes back by that path.
      const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("fixture pixels")]);
      const upload = await api("/v1/files", { name: "shot.png", data: png.toString("base64") });
      expect(upload.status, JSON.stringify(upload.data)).toBe(200);
      const served = await blob("/v1/uploads/image?path=" + encodeURIComponent(upload.data.path));
      expect(served.status).toBe(200); expect(served.bytes.equals(png)).toBe(true);
      // An image somewhere else on the computer, a traversal that lands on
      // it, and a link inside uploads that points at it are all unknown.
      const outside = path.join(root, "outside.png"); await writeFile(outside, png);
      expect((await api("/v1/uploads/image?path=" + encodeURIComponent(outside))).status).toBe(404);
      const traversal = path.join(root, "bridge/uploads/files/../../../outside.png");
      expect((await api("/v1/uploads/image?path=" + encodeURIComponent(traversal))).status).toBe(404);
      const link = path.join(root, "bridge/uploads/files/link.png"); await symlink(outside, link);
      expect((await api("/v1/uploads/image?path=" + encodeURIComponent(link))).status).toBe(404);
      // Only images: a note the phone kept is not served through this route,
      // and neither is a relative path, a folder, or a file that is not there.
      const note = await api("/v1/files", { name: "notes.md", data: Buffer.from("# hi\n").toString("base64") });
      expect((await api("/v1/uploads/image?path=" + encodeURIComponent(note.data.path))).status).toBe(404);
      expect((await api("/v1/uploads/image?path=uploads/files/shot.png")).status).toBe(404);
      expect((await api("/v1/uploads/image?path=" + encodeURIComponent(path.join(root, "bridge/uploads/files")))).status).toBe(404);
      expect((await api("/v1/uploads/image?path=" + encodeURIComponent(path.join(root, "bridge/uploads/files/missing.png")))).status).toBe(404);
      expect((await api("/v1/uploads/image")).status).toBe(404);
    });

    it("exports starting panes and sends a first prompt only to their verified terminal", async () => {
      reportIdentity = false;
      const discover = async () => (await api("/v1/workspaces/panes?groupId=w1&childId=w1:t1")).data.panes[0];
      const pane = await discover();
      expect(pane).toMatchObject({ agent: "codex", starting: true });
      expect(pane.sessionId).toBeUndefined(); expect(pane.startingToken).toMatch(/^[a-f0-9]{64}$/);
      const overview = await api("/v1/workspaces");
      expect(overview.data.groups[0].children[0]).toMatchObject({ agent: "codex", starting: true });
      const { session: _session, ...location } = target;
      const starting = { ...location, starting: true, startingToken: pane.startingToken };
      expect((await api("/v1/prompt", { target: { ...starting, startingToken: "0".repeat(64) }, text: "wrong token" })).status).toBe(409);
      // Helpers the agent forks while starting up do not change the token.
      helperPIDs = [foregroundPID + 100_000, foregroundPID + 100_001];
      expect((await discover()).startingToken).toBe(pane.startingToken);
      for (const route of ["/v1/upload", "/v1/diff", "/v1/approvals/answer", "/v1/keys"]) {
        expect((await api(route, { target: starting, text: "must not run" })).status).toBe(400);
      }
      expect((await api("/v1/prompt", { target: starting, text: "First message" })).status).toBe(200);
      expect(deliveries).toHaveLength(1);
      reportIdentity = true;
      const attached = await discover();
      expect(attached.sessionId).toBe(session); expect(attached.starting).toBeUndefined();
      expect(attached.startingToken).toBe(starting.startingToken);
      expect((await api("/v1/prompt", { target: starting, text: "stale first send" })).status).toBe(409);
      reportIdentity = false; terminalID = "replacement";
      expect((await api("/v1/prompt", { target: starting, text: "replaced terminal" })).status).toBe(409);
      expect(deliveries).toHaveLength(1);
    });

    it("captures a Write PreToolUse/PostToolUse pair as phren_changes without altering the repository index", async () => {
      const repo = path.join(root, "write-repo"); await mkdir(repo);
      await execFileAsync("git", ["init", "-q", repo]);
      const file = path.join(repo, "new.txt");
      const callback = (event: string) => new Promise<any>((resolve, reject) => {
        const payload = JSON.stringify({ target, event, tool: "Write", toolUseId: "write-one", cwd: root,
          input: { file_path: file, content: "hello from Write\n" } });
        const req = request({ socketPath: path.join(root, "bridge/agent.sock"), path: "/hook", method: "POST",
          headers: { "Content-Length": Buffer.byteLength(payload) } }, res => {
          let data = ""; res.on("data", bytes => data += bytes); res.on("end", () => resolve(JSON.parse(data)));
        }); req.on("error", reject); req.end(payload);
      });
      expect(await callback("PreToolUse")).toEqual({});
      await writeFile(file, "hello from Write\n");
      await writeFile(path.join(repo, ".env"), "SECRET=hidden\n");
      expect(await callback("PostToolUse")).toEqual({});
      expect(await stat(path.join(repo, ".git/index")).catch(() => undefined)).toBeUndefined();
      await appendFile(record, JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "write-one", output: "Done" } }) + "\n");
      const page = await api("/v1/transcripts/history?" + new URLSearchParams({ ...target, beforeLine: "9" }));
      expect(page.status).toBe(200);
      const files = page.data.entries.find((entry: any) => entry.raw.phren_changes)?.raw.phren_changes["write-one"];
      expect(files.find((f: any) => f.path === "new.txt").patch).toContain("+hello from Write");
      // A Write changed only the file it names; the .env beside it is not its change.
      expect(files.map((f: any) => f.path)).toEqual(["new.txt"]);
      expect(JSON.stringify(page.data)).not.toContain("SECRET");
    });

    it("launches a workspace in a directory with an agent started in its pane", async () => {
      const launched = await api("/v1/workspaces/launch?mux=herdr:default", { cwd: root, label: "phren", kind: "claude" });
      expect(launched.status, JSON.stringify(launched.data)).toBe(200);
      expect(launched.data).toMatchObject({ ok: true, workspaceId: "w9", tabId: "w9:t1", paneId: "w9:p1", agent: "claude", agentStatus: "idle" });
      expect(commands.find(c => c.method === "workspace.create")?.params).toMatchObject({ label: "phren", cwd: await realpathAsync(root), focus: false });
      expect(commands.find(c => c.method === "agent.start")?.params).toMatchObject({ name: "phren", kind: "claude", pane_id: "w9:p1", timeout_ms: 45_000 });
      // The new pane is now a chat target the overview can see.
      const overview = await api("/v1/workspaces?mux=herdr:default");
      expect(overview.data.groups.some((g: any) => g.id === "w9" && g.children[0].agent === "claude")).toBe(true);
    });

    it("launches opencode in a directory", async () => {
      const launched = await api("/v1/workspaces/launch?mux=herdr:default", { cwd: root, label: "oc", kind: "opencode" });
      expect(launched.status, JSON.stringify(launched.data)).toBe(200);
      expect(launched.data).toMatchObject({ ok: true, agent: "opencode", agentStatus: "idle" });
      expect(commands.find(c => c.method === "agent.start")?.params).toMatchObject({ kind: "opencode" });
    });

    it("passes a model to the harness on launch", async () => {
      const launched = await api("/v1/workspaces/launch?mux=herdr:default", { cwd: root, label: "model", kind: "opencode", model: "openrouter/deepseek/deepseek-v4.1-flash" });
      expect(launched.status, JSON.stringify(launched.data)).toBe(200);
      expect(commands.find(c => c.method === "agent.start")?.params).toMatchObject({ kind: "opencode", args: ["--model", "openrouter/deepseek/deepseek-v4.1-flash"] });
    });

    it("omits the model argument for a harness without one", async () => {
      const launched = await api("/v1/workspaces/launch?mux=herdr:default", { cwd: root, label: "nomodel", kind: "copilot", model: "anything" });
      expect(launched.status, JSON.stringify(launched.data)).toBe(200);
      expect(commands.filter(c => c.method === "agent.start").at(-1)?.params).not.toHaveProperty("args");
    });

    it("launches a tab inside an existing workspace when asked", async () => {
      const launched = await api("/v1/workspaces/launch?mux=herdr:default", { cwd: root, label: "second", kind: "codex", workspaceId: "w1", name: "Codex here", timeoutMs: 1 });
      expect(launched.status, JSON.stringify(launched.data)).toBe(200);
      expect(launched.data).toMatchObject({ workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", agent: "codex" });
      expect(commands.find(c => c.method === "tab.create")?.params).toMatchObject({ workspace_id: "w1", label: "second", cwd: await realpathAsync(root) });
      expect(commands.find(c => c.method === "agent.start")?.params).toMatchObject({ name: "codex-here", pane_id: "w1:p2", timeout_ms: 3_001 });
    });

    it("reports a failed agent start without hiding the workspace it created", async () => {
      failAgentStart = true;
      const launched = await api("/v1/workspaces/launch?mux=herdr:default", { cwd: root, label: "broken", kind: "copilot" });
      expect(launched.status).toBe(409);
      expect(launched.data.error).toContain("couldn't start copilot");
      expect(launched.data.error).toContain("still open on the computer");
      expect(commands.some(c => c.method === "workspace.create")).toBe(true);
    });

    it("reports available Codex context without opening chat and drops a replaced session's usage", async () => {
      const overview = async () => (await api("/v1/workspaces?mux=herdr:default")).data.groups[0].children[0];
      expect((await overview()).contextUsedPercent).toBeUndefined();
      await appendFile(record, JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: {
        last_token_usage: { total_tokens: 45_000 }, model_context_window: 100_000,
      } } }) + "\n");
      expect((await overview()).contextUsedPercent).toBe(45);
      current = "bbbbbbbb-1111-4111-8111-111111111111";
      expect((await overview()).contextUsedPercent).toBeUndefined();
    });

    it("uses the bound parent conversation when Codex also holds subagent logs open", async () => {
      reportIdentity = false;
      const child = "bbbbbbbb-1111-4111-8111-111111111111";
      const childRecord = record.replace(session, child);
      await writeFile(childRecord, JSON.stringify({ type: "session_meta", payload: {
        id: child, source: { subagent: { thread_spawn: { parent_thread_id: session } } },
      } }) + "\n");
      // Real descriptors reproduce the foreground-process discovery path on
      // both macOS (lsof) and Linux (/proc), without an explicit Herdr identity.
      const handles = [];
      try {
        handles.push(await open(record, "r"));
        handles.push(await open(childRecord, "r"));
        const discover = async () => (await api("/v1/workspaces/panes?groupId=w1&childId=w1:t1")).data.panes[0].sessionId;
        // An earlier test's lifecycle callback bound this pane; start unbound.
        const folder = path.join(root, "bridge/bindings/default");
        await rm(folder, { recursive: true, force: true });
        expect(await discover()).toBeUndefined();
        const binding = { terminal: "term-one", source: "codex", session, pids: [process.pid] };
        await mkdir(folder, { recursive: true });
        const bind = (value: typeof binding) => writeFile(path.join(folder, "w1%3Ap1.json"), JSON.stringify(value));
        for (const wrong of [
          { ...binding, terminal: "replaced-terminal" },
          { ...binding, source: "claude" },
          { ...binding, pids: [] },
          { ...binding, session: "cccccccc-1111-4111-8111-111111111111" },
        ]) {
          await bind(wrong);
          await sleep(IDENTITY_CACHE_MS + 50);
          expect(await discover(), JSON.stringify(wrong)).toBeUndefined();
        }
        await bind(binding);
        await sleep(IDENTITY_CACHE_MS + 50);
        expect(await discover()).toBe(session);
        const page = await api("/v1/transcripts/history?" + new URLSearchParams({ ...target, beforeLine: "2" }));
        expect(page.status).toBe(200);
        expect(JSON.stringify(page.data)).toContain("First message");
        expect((await api("/v1/prompt", { target, text: "parent only" })).status).toBe(200);
        expect((await api("/v1/prompt", { target: { ...target, session: child }, text: "must not send" })).status).toBe(409);
        expect(commands.filter(c => c.method === "agent.prompt")).toHaveLength(1);
        // Once the parent's descriptor closes, its old binding must not override
        // the sole conversation still held by the current process.
        await handles[0].close();
        await sleep(IDENTITY_CACHE_MS + 50);
        expect(await discover()).toBe(child);
        expect((await api("/v1/prompt", { target, text: "stale parent" })).status).toBe(409);
      } finally { await Promise.all(handles.map(handle => handle.close())); }
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

    // Herdr types into a pane and cannot bind the write to a conversation. A
    // prompt is bound at the other end instead: the agent that receives it
    // reports through UserPromptSubmit, and a conversation the phone did not
    // mean is told to drop it. An Escape has no such report; the residual race
    // is a cancelled turn in a conversation that replaced the pane's occupant
    // within the milliseconds after validation, kept visible as a known failure.
    it.fails("rejects stop if the conversation is replaced between validation and dispatch (Herdr limitation)", async () => {
      replaceBeforeMutation = true;
      const result = await api("/v1/keys", { target, keys: ["Escape"] });
      expect({ status: result.status, deliveries }).toEqual({ status: 409, deliveries: [] });
    });

    it("binds a typed prompt to its conversation through the receiving agent's UserPromptSubmit hook", async () => {
      const other = "bbbbbbbb-1111-4111-8111-111111111111";
      const submit = (session: string, prompt: string) => new Promise<any>((resolve, reject) => {
        const payload = JSON.stringify({ target: { ...target, session }, event: "UserPromptSubmit", prompt });
        const req = request({ socketPath: path.join(root, "bridge/agent.sock"), path: "/hook", method: "POST",
          headers: { "Content-Length": Buffer.byteLength(payload) } }, res => {
          let data = ""; res.on("data", bytes => data += bytes); res.on("end", () => resolve({ status: res.statusCode, ...JSON.parse(data) }));
        }); req.on("error", reject); req.end(payload);
      });
      // The pane's occupant changed after validation: the replacement submits
      // the pasted text, is refused, and the phone learns nothing was delivered.
      const refused = api("/v1/prompt", { target, text: "must stay in the original conversation" });
      await sleep(150);
      expect(await submit(other, "<pasted_content id=\"7\">\nmust stay in the original conversation\n</pasted_content id=\"7\">")).toMatchObject({ decision: "block" });
      expect((await refused).status).toBe(409);
      // The intended conversation submits it: confirmed, not merely uncertain.
      const confirmed = api("/v1/prompt", { target, text: "hello there" });
      await sleep(150);
      expect(await submit(session, "hello there")).toEqual({ status: 200 });
      expect(await confirmed).toEqual({ status: 200, data: { ok: true, delivered: true } });
      // A prompt nobody typed from the phone is never blocked, whoever submits it.
      expect(await submit(other, "typed at the keyboard")).toEqual({ status: 200 });
      // A busy agent submits queued text long after the phone stopped waiting;
      // the record outlives that wait, so a wrong conversation is still refused.
      expect((await api("/v1/prompt", { target, text: "queued while busy" })).data).toEqual({ ok: true });
      expect(await submit(other, "queued while busy")).toMatchObject({ decision: "block" });
      expect(await submit(session, "queued while busy")).toEqual({ status: 200 });
    }, 15_000);

    // Seen on the phone: an idle Claude Code redrawing (an update notice)
    // dropped the Enter, and the text sat in its input line.
    it("presses Enter once more when an idle agent has not taken the prompt, and says so when it still has not", async () => {
      const submit = (prompt: string) => new Promise<any>((resolve, reject) => {
        const payload = JSON.stringify({ target: claude, event: "UserPromptSubmit", prompt });
        const req = request({ socketPath: path.join(root, "bridge/agent.sock"), path: "/hook", method: "POST",
          headers: { "Content-Length": Buffer.byteLength(payload) } }, res => {
          let data = ""; res.on("data", bytes => data += bytes); res.on("end", () => resolve({ status: res.statusCode, ...JSON.parse(data) }));
        }); req.on("error", reject); req.end(payload);
      });
      paneAgent = "claude"; agentStatus = "idle";
      const claude = { ...target, source: "claude" as const };
      const enters = () => commands.filter(c => c.method === "agent.send_keys" && JSON.stringify(c.params.keys) === '["enter"]').length;
      const before = enters();
      const retried = api("/v1/prompt", { target: claude, text: "commit it when the soak passes" });
      await waitFor(() => enters() > before, 4_000);
      expect(await submit("commit it when the soak passes")).toEqual({ status: 200 });
      expect(await retried).toEqual({ status: 200, data: { ok: true, delivered: true } });
      expect(enters()).toBe(before + 1);
      // Nothing takes it even after the second Enter: not sent, never a third.
      expect((await api("/v1/prompt", { target: claude, text: "keep going with the phone layout" })).data)
        .toEqual({ ok: true, deliveryUncertain: true, unsubmitted: true });
      expect(enters()).toBe(before + 2);
      // A slash command opens a menu a second Enter would answer: never retried.
      await api("/v1/prompt", { target: claude, text: "/model" });
      expect(enters()).toBe(before + 2);
    }, 15_000);

    it("reports a compacting conversation and clears it when the new context starts", async () => {
      const post = (event: string) => new Promise<any>((resolve, reject) => {
        const payload = JSON.stringify({ target, event, source: "compact" });
        const req = request({ socketPath: path.join(root, "bridge/agent.sock"), path: "/hook", method: "POST",
          headers: { "Content-Length": Buffer.byteLength(payload) } }, res => {
          let data = ""; res.on("data", bytes => data += bytes); res.on("end", () => resolve({ status: res.statusCode, ...JSON.parse(data) }));
        }); req.on("error", reject); req.end(payload);
      });
      const status = async () => {
        const socket = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/status?${new URLSearchParams(target)}`);
        const frames: any[] = []; socket.on("message", data => frames.push(JSON.parse(data.toString())));
        await once(socket, "open");
        await waitFor(() => frames.length, 2_000);
        socket.terminate();
        return frames[0].agentStatus;
      };
      expect(await post("PreCompact")).toEqual({ status: 200 });
      expect((await status()).compacting).toBe(true);
      expect(await post("SessionStart")).toEqual({ status: 200 });
      expect((await status()).compacting).toBe(false);
    });

    it("presses keys for a prompt the Hook remembered even when Herdr reads the pane as working", async () => {
      agentStatus = "working";
      const callback = JSON.stringify({ target, event: "PermissionRequest", tool: "Bash", input: { command: "python3 tools/fetch_sdk.py" } });
      // Nobody holds the request, so the hook answers at once and remembers it.
      await new Promise<void>((resolve, reject) => {
        const req = request({ socketPath: path.join(root, "bridge/agent.sock"), path: "/hook", method: "POST",
          headers: { "Content-Length": Buffer.byteLength(callback) } }, res => { res.resume(); res.on("end", resolve); });
        req.on("error", reject); req.end(callback);
      });
      const before = commands.filter(c => c.method === "agent.send_keys").length;
      expect((await api("/v1/keys", { target, keys: ["y"] })).status).toBe(200);
      expect(commands.filter(c => c.method === "agent.send_keys").length).toBe(before + 1);
      // Answered: the pane is working again and plain keys are refused as before.
      expect((await api("/v1/keys", { target, keys: ["y"] })).status).toBe(409);
    });

    it("remembers a permission request it could not hold and shows it while the pane waits", async () => {
      agentStatus = "blocked";
      const callback = JSON.stringify({ target, event: "PermissionRequest", tool: "Shell", input: { command: "xcrun simctl list runtimes",
        justification: "Inspect the runtimes", options: [{ label: "Yes, proceed", key: "y" }, { label: "No", key: "esc" }] } });
      const reply = await new Promise<string>((resolve, reject) => {
        const req = request({ socketPath: path.join(root, "bridge/agent.sock"), path: "/hook", method: "POST", headers: { "Content-Length": Buffer.byteLength(callback) } },
          res => { let data = ""; res.on("data", bytes => data += bytes); res.on("end", () => resolve(data)); });
        req.on("error", reject); req.end(callback);
      });
      expect(reply).toBe("{}");
      const socket = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/status?${new URLSearchParams(target)}`);
      const frames: any[] = []; socket.on("message", data => frames.push(JSON.parse(data.toString())));
      await once(socket, "open");
      await waitFor(() => frames.length, 2_000);
      expect(frames[0].agentStatus).toMatchObject({ status: "blocked", terminalPrompt: { toolName: "Shell" } });
      expect(frames[0].agentStatus.terminalPrompt.message).toContain("xcrun simctl list runtimes");
      // The command and its options ride along for the phone's question card.
      expect(frames[0].agentStatus.terminalPrompt.choice).toEqual({ title: "Inspect the runtimes", body: "xcrun simctl list runtimes",
        options: [{ label: "Yes, proceed", key: "y" }, { label: "No", key: "Escape" }] });
      socket.terminate();
      // Answering with a key clears it; moving through the menu does not.
      expect((await api("/v1/keys", { target, keys: ["Down"] })).status).toBe(200);
      const again = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/status?${new URLSearchParams(target)}`);
      const later: any[] = []; again.on("message", data => later.push(JSON.parse(data.toString())));
      await once(again, "open");
      await waitFor(() => later.length, 2_000);
      expect(later[0].agentStatus.terminalPrompt).toMatchObject({ toolName: "Shell" });
      again.terminate();
      expect((await api("/v1/keys", { target, keys: ["y"] })).status).toBe(200);
      const cleared = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/status?${new URLSearchParams(target)}`);
      const last: any[] = []; cleared.on("message", data => last.push(JSON.parse(data.toString())));
      await once(cleared, "open");
      await waitFor(() => last.length, 2_000);
      expect(last[0].agentStatus.terminalPrompt).toBeUndefined();
      cleared.terminate();
    });

    it("carries Codex's queued follow-up question on the overview and answers it with alt+up then the option key", async () => {
      agentStatus = "blocked";
      const sqlite = await import("node:sqlite");
      const historyPath = path.join(root, "codex/thread_history_1.sqlite");
      const db = new sqlite.DatabaseSync(historyPath);
      db.exec("create table if not exists thread_items (thread_id text, turn_id text, item_id text, rollout_ordinal integer, created_at_ms integer, item_json text, item_type text, updated_at_ordinal integer, primary key (thread_id, turn_id, item_id))");
      const item = { type: "question", id: "q-queued", status: "queued",
        questions: [{ title: "Deploy as-is?", options: ["Yes, deploy", "Hold"] }] };
      db.prepare("insert or replace into thread_items values (?, 'turn-1', ?, ?, ?, ?, ?, ?)")
        .run(session, item.id, 7, 1700, JSON.stringify(item), item.type, 7);
      db.close();
      try {
        const socket = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/status?${new URLSearchParams(target)}`);
        const frames: any[] = []; socket.on("message", data => frames.push(JSON.parse(data.toString())));
        await once(socket, "open");
        await waitFor(() => frames.length, 2_000);
        expect(frames[0].agentStatus.terminalPrompt).toMatchObject({
          toolName: "Question", message: "Deploy as-is?", queued: true,
          choice: { title: "Deploy as-is?",
            options: [{ label: "Yes, deploy", key: "1" }, { label: "Hold", key: "2" }] },
        });
        socket.terminate();
        // The phone opens Codex's queue first, then presses the option's key.
        expect((await api("/v1/keys", { target, keys: ["AltUp", "1"] })).status).toBe(200);
        expect(commands.filter(c => c.method === "agent.send_keys").map(c => c.params.keys)).toEqual([["alt+Up", "1"]]);
        // Answered in the store: the choice is gone from the next frame.
        const answered = { ...item, status: "answered", answers: { deploy: ["Yes, deploy"] } };
        const rewrite = new sqlite.DatabaseSync(historyPath);
        rewrite.prepare("insert or replace into thread_items values (?, 'turn-1', ?, ?, ?, ?, ?, ?)")
          .run(session, item.id, 7, 1707, JSON.stringify(answered), answered.type, 8);
        rewrite.close();
        const cleared = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/status?${new URLSearchParams(target)}`);
        const last: any[] = []; cleared.on("message", data => last.push(JSON.parse(data.toString())));
        await once(cleared, "open");
        await waitFor(() => last.length, 2_000);
        expect(last[0].agentStatus.terminalPrompt).toBeUndefined();
        cleared.terminate();
      } finally {
        // Leave no thread store behind: a later test deletes the rollout and
        // expects the conversation to have no transcript at all.
        const cleanup = new sqlite.DatabaseSync(historyPath);
        cleanup.prepare("delete from thread_items where thread_id = ?").run(session);
        cleanup.close();
        await rm(path.join(root, `bridge/codex-threads/${session}.jsonl`), { force: true });
        await rm(path.join(root, `bridge/codex-threads/${session}.jsonl.state.json`), { force: true });
      }
    });

    it("tells the overview what a working agent is doing", async () => {
      await appendFile(record, JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-astra" } }) + "\n");
      const before = await api("/v1/workspaces");
      expect(before.data.groups[0].children[0]).toMatchObject({ currentStep: "Writing a reply", model: "gpt-6-astra" });
      await appendFile(record, JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "shell", call_id: "s1", arguments: JSON.stringify({ command: ["bash", "-lc", "swift build"] }) } }) + "\n");
      expect((await api("/v1/workspaces")).data.groups[0].children[0].currentStep).toBe("shell: swift build");
      agentStatus = "idle";
      expect((await api("/v1/workspaces")).data.groups[0].children[0]).not.toHaveProperty("currentStep");
    });

    it("takes typed text for a waiting agent only when no structured prompt is pending", async () => {
      agentStatus = "blocked";
      expect((await api("/v1/prompt", { target, text: "deploy as-is" })).status).toBe(200);
      const callback = JSON.stringify({ target, event: "PermissionRequest", tool: "Shell", input: { command: "rm -rf build" } });
      await new Promise<void>((resolve, reject) => {
        const req = request({ socketPath: path.join(root, "bridge/agent.sock"), path: "/hook", method: "POST", headers: { "Content-Length": Buffer.byteLength(callback) } },
          res => { res.resume(); res.on("end", resolve); });
        req.on("error", reject); req.end(callback);
      });
      expect((await api("/v1/prompt", { target, text: "must not be typed into the prompt" })).status).toBe(409);
      expect((await api("/v1/keys", { target, keys: ["y"] })).status).toBe(200);
      expect((await api("/v1/prompt", { target, text: "next question" })).status).toBe(200);
      agentStatus = "unknown";
      expect((await api("/v1/prompt", { target, text: "nobody knows" })).status).toBe(409);
    });

    it("lets the phone walk a menu it just opened with a slash command, briefly", async () => {
      agentStatus = "idle";
      expect((await api("/v1/keys", { target, keys: ["Down"] })).status).toBe(409);
      expect((await api("/v1/prompt", { target, text: "/permissions" })).status).toBe(200);
      expect((await api("/v1/keys", { target, keys: ["Down", "Down"] })).status).toBe(200);
      // Enter runs the Hook's confirmation step once: with nothing on the pane
      // it times out still waiting and keeps the window. Escape closes it.
      expect((await api("/v1/keys", { target, keys: ["Enter"] })).status).toBe(200);
      expect((await api("/v1/keys", { target, keys: ["Enter"] })).status).toBe(200);
      expect((await api("/v1/keys", { target, keys: ["Escape"] })).status).toBe(200);
      expect((await api("/v1/keys", { target, keys: ["Down"] })).status).toBe(409);
      // Codex's /model takes no argument, so typing one would land as a chat
      // message; the Hook refuses it and the phone uses the model route.
      expect((await api("/v1/prompt", { target, text: "/model gpt-5.6-terra" })).status).toBe(422);
      // A slash command with words is still a message, not a menu to walk.
      expect((await api("/v1/prompt", { target, text: "/review the parser change" })).status).toBe(200);
      expect((await api("/v1/keys", { target, keys: ["Enter"] })).status).toBe(409);
    });

    it("walks Codex's Full Access confirmation from the pane's terminal lines", async () => {
      agentStatus = "idle"; drawConfirmation = true;
      expect((await api("/v1/prompt", { target, text: "/permissions" })).status).toBe(200);
      const selected = await api("/v1/keys", { target, keys: ["Down", "Down", "Enter"] });
      expect(selected.status, JSON.stringify(selected.data)).toBe(200);
      expect(selected.data.menuClosed).toBe(true);
      const sent = commands.filter(c => c.method === "agent.send_keys").map(c => c.params.keys);
      expect(sent).toContainEqual(["down", "down", "enter"]);
      // The Hook read "Enable full access?" and answered it with 1 then Enter
      // before reporting the menu closed.
      expect(sent).toContainEqual(["1", "enter"]);
      expect((await api("/v1/keys", { target, keys: ["Down"] })).status).toBe(409);
    });

    it("reports a confirmation that never appears as the visible waiting prompt", async () => {
      agentStatus = "idle"; drawConfirmation = false;
      paneLines = "Apply the permission change?\n› 1. Yes, continue anyway\n2. Cancel\n";
      expect((await api("/v1/prompt", { target, text: "/permissions" })).status).toBe(200);
      const selected = await api("/v1/keys", { target, keys: ["Down", "Down", "Enter"] });
      expect(selected.status, JSON.stringify(selected.data)).toBe(200);
      expect(selected.data.menuClosed).toBeUndefined();
      expect(selected.data.waiting).toMatchObject({
        message: expect.stringContaining("Apply the permission change?"),
        choice: { title: "Apply the permission change?",
          options: [{ label: "Yes, continue anyway", key: "1" }, { label: "Cancel", key: "2" }] },
      });
      const sent = commands.filter(c => c.method === "agent.send_keys").map(c => c.params.keys);
      expect(sent).not.toContainEqual(["1", "enter"]);
      // The same choice reaches the phone as the terminal prompt question card.
      agentStatus = "blocked";
      const socket = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/status?${new URLSearchParams(target)}`);
      const frames: any[] = []; socket.on("message", data => frames.push(JSON.parse(data.toString())));
      await once(socket, "open");
      await waitFor(() => frames.length, 2_000);
      expect(frames[0].agentStatus.terminalPrompt).toMatchObject({ toolName: "Permissions",
        choice: { title: "Apply the permission change?",
          options: [{ label: "Yes, continue anyway", key: "1" }, { label: "Cancel", key: "2" }] } });
      socket.terminate();
      // The window stays open so the card's own key still lands.
      expect((await api("/v1/keys", { target, keys: ["1"] })).status).toBe(200);
    });

    it("verifies the highlighted Full Access confirmation when it has no shortcut keys", async () => {
      agentStatus = "idle"; drawConfirmation = true; confirmationHasKeys = false;
      expect((await api("/v1/prompt", { target, text: "/permissions" })).status).toBe(200);
      const selected = await api("/v1/keys", { target, keys: ["Down", "Down", "Enter"] });
      expect(selected.status, JSON.stringify(selected.data)).toBe(200);
      expect(selected.data.menuClosed).toBe(true);
      expect(commands.filter(c => c.method === "agent.send_keys").map(c => c.params.keys))
        .toEqual([["down", "down", "enter"], ["enter"]]);
      expect(paneLines).toBe("");
    });

    it("asks Claude's /btw beside a working turn and streams the panel's answer as a side-answer frame", async () => {
      paneAgent = "claude"; agentStatus = "working"; paneLines = "";
      const claude = { ...target, source: "claude" as const };
      const question = "in ten short numbered points, why is the sky blue?";
      const socket = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/transcripts?${new URLSearchParams({ ...claude, sideAnswers: "1" })}`);
      const frames: any[] = []; socket.on("message", data => frames.push(JSON.parse(data.toString())));
      await once(socket, "open");
      await waitFor(() => frames.length);
      try {
        // Other slash commands still wait for the turn to end.
        expect((await api("/v1/prompt", { target: claude, text: "/compact" })).status).toBe(409);
        const asked = await api("/v1/prompt", { target: claude, text: `/btw ${question}` });
        expect(asked.status, JSON.stringify(asked.data)).toBe(200);
        const id = asked.data.sideQuestion.id;
        expect(commands.filter(c => c.method === "agent.prompt").map(c => c.params.text)).toEqual([`/btw ${question}`]);
        // The panel owns the terminal's keys until it closes.
        expect((await api("/v1/prompt", { target: claude, text: "another message" })).status).toBe(409);
        paneLines = recorded("claude/2.1.280/btw-panel-answering.txt");
        await waitFor(() => frames.some(f => f.type === "side-answer" && f.state === "pending"), 3_000);
        paneLines = recorded("claude/2.1.280/btw-panel.txt");
        await waitFor(() => commands.some(c => c.method === "agent.send_keys" && (c.params.keys as string[]).includes("esc")), 5_000);
        paneLines = "";
        await waitFor(() => frames.some(f => f.type === "side-answer" && f.state === "answer"), 3_000);
        const answer = frames.find(f => f.type === "side-answer" && f.state === "answer");
        expect(answer).toMatchObject({ type: "side-answer", source: "claude", session, id, question });
        expect(answer.answer).toMatch(/^1\. Sunlight looks white, but it\n {3}contains every color/);
        // Nothing of it entered the transcript, and the pane takes input again.
        expect(frames.filter(f => f.type === "append")).toEqual([]);
        expect((await api("/v1/side-question/dismiss", { target: claude, id })).status).toBe(200);
        expect((await api("/v1/side-question/dismiss", { target: claude, id })).status).toBe(404);
      } finally { socket.terminate(); }
    });

    it("publishes a Claude terminal numbered dialog, answers it with Enter, and drops it when the pane works", async () => {
      paneAgent = "claude"; agentStatus = "blocked";
      paneLines = "Parser aborted (timeout, resource limit, or over-length)\n"
        + "Do you want to proceed?\n"
        + "> 1. Yes\n"
        + "2. Yes, and switch to auto mode · auto mode handles these prompts for you\n"
        + "3. No\n"
        + "Esc to cancel · Tab to amend\n";
      const claude = { ...target, source: "claude" as const };
      const status = async () => {
        const socket = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/status?${new URLSearchParams(claude)}`);
        const frames: any[] = []; socket.on("message", data => frames.push(JSON.parse(data.toString())));
        await once(socket, "open");
        await waitFor(() => frames.length, 2_000);
        socket.terminate();
        return frames[0].agentStatus;
      };
      // No PermissionRequest fired: the Hook reads the pane and finds the dialog.
      expect(await status()).toMatchObject({ status: "blocked", terminalPrompt: {
        toolName: "Question", message: "Do you want to proceed?",
        choice: { title: "Do you want to proceed?",
          options: [{ label: "Yes", key: "1" },
            { label: "Yes, and switch to auto mode", key: "2" },
            { label: "No", key: "3" },
            { label: "Cancel", key: "Escape" }] } } });
      // The pane leaves waiting: the card goes with it, dialog or not.
      agentStatus = "working";
      expect((await status()).terminalPrompt).toBeUndefined();
      // Still drawn, still waiting: the dialog is read again past the throttle window.
      agentStatus = "blocked";
      await sleep(DIALOG_THROTTLE_MS + 50);
      expect((await status()).terminalPrompt).toMatchObject({ choice: { title: "Do you want to proceed?" } });
      // The phone sends the option's digit; the Hook appends Enter to submit it.
      expect((await api("/v1/keys", { target: claude, keys: ["1"] })).status).toBe(200);
      expect(commands.filter(c => c.method === "agent.send_keys").map(c => c.params.keys)).toEqual([["1", "enter"]]);
      agentStatus = "working";
      expect((await status()).terminalPrompt).toBeUndefined();
    });

    it("publishes a Codex terminal choice from the pane's numbered dialog and answers it with the option's key", async () => {
      agentStatus = "blocked";
      // Scrollback above the question must not become part of it.
      paneLines = "ence\n"
        + "Utility Live 12 ...\n"
        + "Field 1/1\n"
        + "\n"
        + "Would you like to run the following command?\n"
        + "Environment: local\n"
        + "Reason: Allow final headless rendering of the revised terminal hint hierarchy?\n"
        + "$ bun /tmp/atlas-shell-review.ts\n"
        + "› 1. Yes, proceed (y)\n"
        + "  2. Yes, and don't ask again for commands that start with 'bun /tmp/atlas-shell-review.ts' (p)\n"
        + "  3. No, and tell Codex what to do differently (esc)\n"
        + "Press enter to confirm or esc to cancel\n";
      const status = async () => {
        const socket = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/status?${new URLSearchParams(target)}`);
        const frames: any[] = []; socket.on("message", data => frames.push(JSON.parse(data.toString())));
        await once(socket, "open");
        await waitFor(() => frames.length, 2_000);
        socket.terminate();
        return frames[0].agentStatus;
      };
      // No PermissionRequest fired and no structured question: the Hook reads
      // the pane's own numbered rows and keys them by their trailing letters.
      const first = await status();
      expect(first.terminalPrompt).toMatchObject({ toolName: "Question", choice: {
        title: "Would you like to run the following command?\nEnvironment: local\n"
          + "Reason: Allow final headless rendering of the revised terminal hint hierarchy?\n"
          + "$ bun /tmp/atlas-shell-review.ts",
        options: [
          { label: "Yes, proceed", key: "y" },
          { label: "Yes, and don't ask again for commands that start with 'bun /tmp/atlas-shell-review.ts'", key: "p" },
          { label: "No, and tell Codex what to do differently", key: "Escape" },
        ],
      } });
      expect(first.terminalPrompt.choice.title).toContain("Would you like to run the following command?");
      expect(first.terminalPrompt.choice.title).toContain("bun /tmp/atlas-shell-review.ts");
      expect(first.terminalPrompt.choice.title).not.toContain("Press enter");
      // The phone sends the option's own key, not its row number.
      expect((await api("/v1/keys", { target, keys: ["p"] })).status).toBe(200);
      expect(commands.filter(c => c.method === "agent.send_keys").map(c => c.params.keys)).toEqual([["p"]]);
      // Answered: the prompt is gone, and stays gone once the pane works.
      expect((await status()).terminalPrompt).toBeUndefined();
      agentStatus = "working";
      expect((await status()).terminalPrompt).toBeUndefined();
    });

    describe("Codex keyless terminal menus", () => {
      beforeEach(startFixture);

      async function status() {
        const socket = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/status?${new URLSearchParams(target)}`);
        const frames: any[] = []; socket.on("message", data => frames.push(JSON.parse(data.toString())));
        await once(socket, "open");
        await waitFor(() => frames.length, 2_000);
        socket.terminate();
        return frames[0].agentStatus;
      }

      it.each([
        { from: 0, to: 2, ignored: 0, sent: [["down", "down"], ["enter"]] },
        { from: 2, to: 2, ignored: 0, sent: [["enter"]] },
        { from: 2, to: 0, ignored: 0, sent: [["up", "up"], ["enter"]] },
        { from: 0, to: 2, ignored: 1, sent: [["down", "down"], ["down", "down"], ["enter"]] },
      ])("answers row $to from row $from with $ignored missed moves", async ({ from, to, ignored, sent }) => {
        agentStatus = "blocked"; menuHighlight = from; ignoredMenuMoves = ignored;
        paneLines = permissionsMenu(menuHighlight);
        expect((await status()).terminalPrompt.choice).toMatchObject({ highlightedIndex: from });
        const answered = await api("/v1/keys", { target, keys: [String(to + 1)] });
        expect(answered.status, JSON.stringify(answered.data)).toBe(200);
        expect(confirmedMenuRow).toBe(to);
        expect(commands.filter(c => c.method === "agent.send_keys").map(c => c.params.keys)).toEqual(sent);
        // The last read must precede the confirming Enter, after any arrows.
        const interaction = commands.filter(c => ["agent.read", "agent.send_keys"].includes(c.method));
        expect(interaction.at(-2)?.method).toBe("agent.read");
        expect(interaction.at(-1)?.params.keys).toEqual(["enter"]);
      });

      it("reads a highlight that moved since the card was published", async () => {
        agentStatus = "blocked"; menuHighlight = 0; paneLines = permissionsMenu(menuHighlight);
        await status();
        menuHighlight = 1; paneLines = permissionsMenu(menuHighlight);
        expect((await api("/v1/keys", { target, keys: ["3"] })).status).toBe(200);
        expect(confirmedMenuRow).toBe(2);
        expect(commands.filter(c => c.method === "agent.send_keys").map(c => c.params.keys)).toEqual([["down"], ["enter"]]);
      });

      it("publishes no choice when a menu has no readable highlight", async () => {
        agentStatus = "blocked"; paneLines = permissionsMenu(undefined);
        expect((await status()).terminalPrompt?.choice).toBeUndefined();
        expect(commands.filter(c => c.method === "agent.send_keys")).toEqual([]);
      });

      it.each(["stuck", "lost", "changed", "missing"])("does not confirm a %s highlight", async mode => {
        agentStatus = "blocked"; menuHighlight = 0; paneLines = permissionsMenu(menuHighlight);
        await status();
        ignoredMenuMoves = mode === "stuck" ? 2 : 0;
        loseMenuHighlight = mode === "lost";
        replaceMenuAfterMove = mode === "changed";
        if (mode === "missing") paneLines = permissionsMenu(undefined);
        const answered = await api("/v1/keys", { target, keys: ["3"] });
        expect(answered.status).toBe(409);
        expect(JSON.stringify(answered.data)).toContain("Open terminal");
        expect(confirmedMenuRow).toBeUndefined();
        expect(commands.filter(c => c.method === "agent.send_keys").map(c => c.params.keys))
          .toEqual(mode === "stuck" ? [["down", "down"], ["down", "down"]] : mode === "missing" ? [] : [["down", "down"]]);
      });
    });

    it("flags a terminal password prompt only while the pane is reading one", async () => {
      agentStatus = "blocked";
      paneLines = "This command will run with elevated privileges.\nPassword:";
      // The previous test's pane read may be inside the throttle window.
      await sleep(DIALOG_THROTTLE_MS + 50);
      const status = async () => {
        const socket = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/status?${new URLSearchParams(target)}`);
        const frames: any[] = []; socket.on("message", data => frames.push(JSON.parse(data.toString())));
        await once(socket, "open");
        await waitFor(() => frames.length, 2_000);
        socket.terminate();
        return frames[0].agentStatus;
      };
      expect((await status()).passwordPrompt).toBe(true);
      // The pane leaves waiting: nothing is being read any more.
      agentStatus = "working";
      expect((await status()).passwordPrompt).toBeUndefined();
    });

    it("lists the models a computer's agents offer", async () => {
      const claude = await api("/v1/models?source=claude");
      expect(claude.status).toBe(200);
      // The HTTP boundary pins Claude Code's own menu: five rows, exact ids
      // and names, one default. A prefix regex would pass for aliases too.
      expect(claude.data.models.map((m: any) => [m.id, m.name])).toEqual([
        ["claude-fable-5-1", "Fable 5.1"],
        ["claude-opus-5", "Opus 5"],
        ["claude-sonnet-5", "Sonnet 5"],
        ["claude-haiku-4-5-20251001", "Haiku 4.5"],
        ["claude-fable-5-1[1m]", "Fable 5.1 (1M context)"],
      ]);
      expect(claude.data.models.filter((m: any) => m.isDefault).map((m: any) => m.id)).toEqual(["claude-fable-5-1"]);
      // OpenCode's list comes from its own binary: every id names its provider,
      // and a computer without opencode simply offers nothing.
      const opencode = (await api("/v1/models?source=opencode")).data.models;
      expect(opencode.every((m: any) => /^[^/]+\/.+/.test(m.id) && typeof m.name === "string")).toBe(true);
      expect((await api("/v1/models?source=../etc")).data).toEqual({ models: [] });
    });

    it("types a terminal secret one key at a time and never echoes it", async () => {
      const secret = "hunter 2!";
      agentStatus = "blocked";
      const sent = await api("/v1/secret", { target, text: secret });
      expect(sent.status, JSON.stringify(sent.data)).toBe(200);
      expect(sent.data).toEqual({ ok: true });
      // Every character is its own key, a space is the named key, and the
      // submission is a separate call: a bracketed paste would corrupt the read.
      expect(commands.filter(c => c.method === "agent.send_keys").map(c => c.params.keys))
        .toEqual([["h", "u", "n", "t", "e", "r", "space", "2", "!"], ["enter"]]);
      expect(JSON.stringify(sent.data)).not.toContain(secret);
      // The text is bounded and printable, and an error never carries it back.
      expect((await api("/v1/secret", { target, text: "x".repeat(300) })).status).toBe(400);
      const newline = await api("/v1/secret", { target, text: "pass\nword" });
      expect(newline.status).toBe(400);
      expect(JSON.stringify(newline.data)).not.toContain("pass");
      // Only a terminal the agent is holding a prompt in takes a secret.
      agentStatus = "idle";
      const before = commands.filter(c => c.method === "agent.send_keys").length;
      const refused = await api("/v1/secret", { target, text: secret });
      expect(refused.status).toBe(409);
      expect(refused.data.error).toBe("This agent is not waiting for an answer.");
      expect(JSON.stringify(refused.data)).not.toContain(secret);
      expect(commands.filter(c => c.method === "agent.send_keys").length).toBe(before);
    });

    it("reports uncertain prompt delivery after replacement and sends only once", async () => {
      replaceBeforeMutation = true;
      const response = await api("/v1/prompt", { target, text: "sent once" });
      expect(response).toEqual({ status: 200, data: { ok: true, deliveryUncertain: true } });
      expect(commands.filter(c => c.method === "agent.prompt")).toHaveLength(1);
    });

    it("closes the oldest websocket when a seventeenth client connects", async () => {
      const clients: WebSocket[] = [];
      try {
        for (let i = 0; i < 16; i++) {
          const client = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/status?${new URLSearchParams(target)}`);
          clients.push(client); client.on("error", () => {}); await once(client, "open");
        }
        const closed = once(clients[0], "close");
        const next = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/status?${new URLSearchParams(target)}`);
        clients.push(next); await once(next, "open"); await closed;
        expect(clients[0].readyState).toBe(WebSocket.CLOSED);
        expect(clients.slice(1).every(client => client.readyState === WebSocket.OPEN)).toBe(true);
        expect((await api("/v1/health")).status).toBe(200);
      } finally { clients.forEach(client => client.terminate()); }
    });

    it("derives diff scope from this conversation's local command rows", async () => {
      await execFileAsync("git", ["-C", root, "init", "-q"]);
      const sibling = await mkdtemp("/tmp/phren-sibling-");
      try {
        await execFileAsync("git", ["-C", sibling, "init", "-q"]);
        const outside = await realpathAsync(sibling);
        expect((await api("/v1/diff", { target, paths: [outside] })).status).toBe(403);
        await appendFile(record, JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: `ls ${outside}` }) } }) + "\n");
        expect((await api("/v1/diff", { target, paths: [outside] })).status).toBe(200);
        expect((await api("/v1/diff", { target, paths: ["/etc"] })).status).toBe(403);
        await rm(record);
        expect((await api("/v1/diff", { target, paths: [root] })).status).toBe(200);
        expect((await api("/v1/diff", { target, paths: [outside] })).status).toBe(403);
      } finally { await rm(sibling, { recursive: true, force: true }); }
    });

    it("diffs a spawned agent's own worktree through its parent-scoped child id", async () => {
      const worktree = await mkdtemp(path.join(tmpdir(), "phren-child-repo-"));
      try {
        await execFileAsync("git", ["init", "-q", worktree]);
        await writeFile(path.join(worktree, "tracked.txt"), "first line\n");
        await execFileAsync("git", ["-C", worktree, "add", "tracked.txt"]);
        await execFileAsync("git", ["-C", worktree, "-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-qm", "start"]);
        await execFileAsync("git", ["-C", worktree, "checkout", "-q", "-b", "codex/bridge-child"]);
        await writeFile(path.join(worktree, "tracked.txt"), "first line\nsecond line\n");
        const job = "child-diff-job", directory = path.join(root, ".phren/.runtime/agent-fanouts", job);
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, "events.jsonl"), JSON.stringify({ type: "thread.started", thread_id: "cccccccc-3333-4333-8333-333333333333" }) + "\n");
        await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ schemaVersion: 1, id: job,
          parent: { provider: "codex", session }, provider: "codex", taskLabel: "Child worktree",
          cwd: worktree, worktree, model: "gpt-5-codex", eventLog: "events.jsonl",
          createdAt: "2026-09-19T19:00:00.000Z", startedAt: "2026-09-19T19:00:00.000Z",
          updatedAt: "2026-09-19T19:00:00.000Z", status: "running" }));
        const tree = await api("/v1/subagents?" + new URLSearchParams(target));
        expect(tree.status).toBe(200);
        const child = tree.data.agents.find((agent: any) => agent.path === "Child worktree");
        expect(child?.id).toMatch(/^[a-f0-9]{32}$/);
        expect(child).toMatchObject({ worktreeName: path.basename(worktree), branch: "codex/bridge-child" });
        expect(child).not.toHaveProperty("cwd");
        expect(JSON.stringify(child)).not.toContain(worktree);
        const diff = await api("/v1/diff", { target, child: child.id });
        expect(diff.status, JSON.stringify(diff.data)).toBe(200);
        expect(diff.data.root).toBe(await realpathAsync(worktree));
        expect(JSON.stringify(diff.data.files)).toContain("+second line");
        expect(JSON.stringify(diff.data.files)).not.toContain(worktree);
        expect((await api("/v1/diff", { target, child: "0".repeat(32) })).status).toBe(404);
      } finally { await rm(worktree, { recursive: true, force: true }); }
    });

    it("streams incremental transcript and real usage frames, then closes after a conversation replacement", async () => {
      const query = new URLSearchParams(target).toString();
      const socket = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/transcripts?${query}`);
      const frames: any[] = []; socket.on("message", data => frames.push(JSON.parse(data.toString())));
      await once(socket, "open");
      await waitFor(() => frames.length, 1_500);
      expect(frames[0].type).toBe("backlog"); expect(JSON.stringify(frames[0])).toContain("First message");
      await appendFile(record, JSON.stringify(row("Second message")) + "\n");
      await waitFor(() => frames.length >= 2, 1_500);
      expect(frames[1].type).toBe("append"); expect(JSON.stringify(frames[1])).toContain("Second message"); expect(JSON.stringify(frames[1])).not.toContain("First message");
      await appendFile(record, JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 9, output_tokens: 3 } } } }) + "\n");
      await waitFor(() => frames.length >= 3, 1_500);
      expect(JSON.stringify(frames[2])).toContain('"output_tokens":3');
      const closed = once(socket, "close"); current = "bbbbbbbb-1111-4111-8111-111111111111"; await closed;
    });

    it("resumes a disconnected transcript after the phone's last line", async () => {
      const query = new URLSearchParams(target).toString();
      const first = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/transcripts?${query}`);
      const opening: any[] = []; first.on("message", data => opening.push(JSON.parse(data.toString())));
      await once(first, "open");
      await waitFor(() => opening.length, 1_500);
      expect(opening[0]).toMatchObject({ type: "backlog", totalLines: 2 });
      const disconnected = once(first, "close"); first.terminate(); await disconnected;

      await appendFile(record, JSON.stringify(row("While disconnected 1")) + "\n" + JSON.stringify(row("While disconnected 2")) + "\n");
      const resumed = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/transcripts?${new URLSearchParams({ ...target, afterLine: String(opening[0].totalLines - 1) })}`);
      const frames: any[] = []; resumed.on("message", data => frames.push(JSON.parse(data.toString())));
      try {
        await once(resumed, "open");
        await waitFor(() => frames.length, 1_500);
        expect(frames[0]).toMatchObject({ type: "backlog", totalLines: 4 });
        expect(frames[0].entries.map((entry: any) => entry.line)).toEqual([2, 3]);
        expect(JSON.stringify(frames[0])).not.toContain("First message");
        // An in-range resume is a delta, never an explicit replacement.
        expect(frames[0].reset).toBe(false);
      } finally { resumed.terminate(); }
    });

    it("treats a resume cursor past a shortened transcript as a replacement snapshot", async () => {
      const query = new URLSearchParams(target).toString();
      const first = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/transcripts?${query}`);
      const opening: any[] = []; first.on("message", data => opening.push(JSON.parse(data.toString())));
      await once(first, "open");
      await waitFor(() => opening.length, 1_500);
      expect(opening[0]).toMatchObject({ type: "backlog", totalLines: 2 });
      const disconnected = once(first, "close"); first.terminate(); await disconnected;

      // The conversation was replaced: the new file ends before the phone's cursor.
      await writeFile(record, JSON.stringify(row("Replacement message")) + "\n");
      const resumed = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/transcripts?${new URLSearchParams({ ...target, afterLine: "1" })}`);
      const frames: any[] = []; resumed.on("message", data => frames.push(JSON.parse(data.toString())));
      try {
        await once(resumed, "open");
        await waitFor(() => frames.length, 1_500);
        expect(frames[0]).toMatchObject({ type: "backlog", reset: true, totalLines: 1 });
        expect(frames[0].entries.map((entry: any) => entry.line)).toEqual([0]);
        expect(JSON.stringify(frames[0])).toContain("Replacement message");
        expect(JSON.stringify(frames[0])).not.toContain("First message");
      } finally { resumed.terminate(); }
    });

    it("streams an empty backlog for a conversation whose transcript does not exist yet, then the file once it appears", async () => {
      await rm(record);
      const query = new URLSearchParams(target).toString();
      expect((await api(`/v1/transcripts/history?${query}&beforeLine=1`)).data).toMatchObject({ type: "older", entries: [], totalLines: 0 });
      const socket = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/transcripts?${query}`);
      const frames: any[] = []; socket.on("message", data => frames.push(JSON.parse(data.toString())));
      const closed = once(socket, "close");
      await once(socket, "open");
      await waitFor(() => frames.length, 1_500);
      expect(frames[0]).toMatchObject({ type: "backlog", entries: [], totalLines: 0, session });
      expect(socket.readyState).toBe(WebSocket.OPEN);
      await writeFile(record, JSON.stringify({ type: "session_meta", payload: { id: session } }) + "\n" + JSON.stringify(row("First message")) + "\n");
      await waitFor(() => frames.length >= 2, 4_000);
      expect(frames[1].type).toBe("backlog"); expect(JSON.stringify(frames[1])).toContain("First message");
      current = "bbbbbbbb-1111-4111-8111-111111111111"; await closed;
    });

    it("follows a child agent's transcript live through the parent's socket and pages its history", async () => {
      // The parent records the launch; the child's own rollout names the parent.
      const child = "cccccccc-2222-4222-8222-222222222222";
      const activity = (kind: string) => ({ type: "event_msg", payload: { type: "item_completed", item: {
        type: "SubAgentActivity", id: "spawn-1", kind, agent_thread_id: child, agent_path: "/root/reviewer" } } });
      const childFile = path.join(root, `codex/sessions/2026/09/10/rollout-2026-09-10T00-00-01-${child}.jsonl`);
      await writeFile(childFile, [JSON.stringify({ type: "session_meta", payload: { id: child, source: { subagent: { thread_spawn: { parent_thread_id: session } } } } }),
        ...Array.from({ length: 70 }, (_, i) => JSON.stringify(row(`Child step ${i}`)))].join("\n") + "\n");
      await appendFile(record, JSON.stringify(activity("started")) + "\n");
      const tree = await api("/v1/subagents?" + new URLSearchParams(target));
      expect(tree.status).toBe(200);
      expect(tree.data.agents[0]).toMatchObject({ provider: "codex", callId: "spawn-1", state: "running" });
      const id = tree.data.agents[0].id as string;
      expect(id).toMatch(/^[a-f0-9]{32}$/);
      const socket = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/transcripts?${new URLSearchParams({ ...target, child: id })}`);
      const frames: any[] = []; socket.on("message", data => frames.push(JSON.parse(data.toString())));
      try {
        await once(socket, "open");
        await waitFor(() => frames.length, 2_000);
        // The opening page is the child's recent rows, named by the public id.
        expect(frames[0]).toMatchObject({ type: "backlog", source: "codex", session: id, hasMore: true });
        expect(frames[0].entries).toHaveLength(60);
        expect(JSON.stringify(frames[0])).toContain("Child step 69");
        expect(JSON.stringify(frames[0])).not.toContain(child);
        await appendFile(childFile, JSON.stringify(row("Child step 70")) + "\n");
        await waitFor(() => frames.length >= 2, 2_000);
        expect(frames[1]).toMatchObject({ type: "append", session: id });
        expect(JSON.stringify(frames[1])).toContain("Child step 70"); expect(JSON.stringify(frames[1])).not.toContain("Child step 69");
        socket.send(JSON.stringify({ type: "older", beforeLine: frames[0].startLine }));
        await waitFor(() => frames.some(f => f.type === "older"), 2_000);
        const older = frames.find(f => f.type === "older");
        expect(older).toMatchObject({ session: id, startLine: 0, hasMore: false });
        expect(JSON.stringify(older)).toContain("Child step 0");
      } finally { socket.terminate(); }
      const page = await api("/v1/transcripts/history?" + new URLSearchParams({ ...target, child: id, beforeLine: "11" }));
      expect(page.status).toBe(200);
      expect(page.data).toMatchObject({ type: "older", source: "codex", session: id, startLine: 0 });
      // Line 0 is the session_meta row, which is not a conversation event.
      expect(page.data.entries.map((e: any) => e.line)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
      // A child id the conversation never spawned is unknown, on every route.
      const unknown = "0".repeat(32);
      expect((await api("/v1/transcripts/history?" + new URLSearchParams({ ...target, child: unknown, beforeLine: "11" }))).status).toBe(404);
      expect((await api("/v1/subagents/transcript?" + new URLSearchParams({ ...target, child: unknown }))).status).toBe(404);
      const rejected = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/transcripts?${new URLSearchParams({ ...target, child: unknown })}`);
      const [code] = await once(rejected, "close");
      expect(code).toBe(1011);
      // The child's socket follows the parent conversation's binding: when the
      // parent is replaced, the stream closes.
      const bound = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/transcripts?${new URLSearchParams({ ...target, child: id })}`);
      await once(bound, "open");
      const closed = once(bound, "close"); current = "bbbbbbbb-1111-4111-8111-111111111111"; await closed;
    });

    it("rejects stale actions and prevents phone requests from registering agent hooks", async () => {
      expect((await api("/v1/approvals/answer", { target, actionId: "bbbbbbbb-1111-4111-8111-111111111111", decision: "approve" })).status).toBe(409);
      expect((await api("/hook", { target, event: "PermissionRequest" })).status).toBe(404);
      expect(commands.some(c => c.method === "agent.send_keys")).toBe(false);
    });

    it("answers history submitted during an in-flight transcript poll", async () => {
      const socket = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/transcripts?${new URLSearchParams(target)}`);
      const frames: any[] = []; socket.on("message", data => frames.push(JSON.parse(data.toString())));
      try {
        await once(socket, "open");
        await waitFor(() => frames.length, 800);
        expect(frames[0].type).toBe("backlog");
        holdSnapshot = true;
        await waitFor(() => releaseSnapshot, 1_500);
        expect(releaseSnapshot).toBeDefined();
        socket.send(JSON.stringify({ type: "older", beforeLine: 1 }));
        await sleep(30); releaseSnapshot!(); releaseSnapshot = undefined;
        await waitFor(() => frames.some(f => f.type === "older"), 800);
        expect(frames.find(f => f.type === "older")).toMatchObject({ entries: [], startLine: 0, hasMore: false });
      } finally { socket.terminate(); }
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

    it("uploads while input is pending without sending a prompt, and still rejects a changed conversation", async () => {
      for (const status of ["blocked", "waiting", "unknown"]) {
        agentStatus = status;
        const bytes = Buffer.from(`Notes while ${status}`);
        const upload = await api("/v1/upload", { target, name: `${status}.txt`, data: bytes.toString("base64") });
        expect(upload.status).toBe(200);
        expect(await readFile(upload.data.path)).toEqual(bytes);
      }
      // An unreadable status keeps text out; a plain waiting agent takes it
      // (the structured cases are covered where prompts are pending).
      agentStatus = "unknown";
      expect((await api("/v1/prompt", { target, text: "Do not answer the pending question" })).status).toBe(409);
      expect(commands.some(c => c.method === "agent.prompt")).toBe(false);
      current = "bbbbbbbb-1111-4111-8111-111111111111";
      expect((await api("/v1/upload", { target, name: "changed.txt", data: Buffer.from("Draft").toString("base64") })).status).toBe(409);
    });

    it("only resolves the live approval on an explicitly watched conversation", async () => {
      const socket = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/status?${new URLSearchParams(target)}`);
      const frames: any[] = []; socket.on("message", bytes => frames.push(JSON.parse(bytes.toString())));
      await once(socket, "open");
      await waitFor(() => frames.length, 1_500);
      const reply = new Promise<any>((resolve, reject) => {
        const payload = JSON.stringify({ target, event: "PermissionRequest", tool: "Bash", input: { command: "fixture-command",
          options: [{ label: "Yes, proceed", key: "y" }, { label: "No, and tell Codex what to do differently", key: "esc" }] } });
        const req = request({ socketPath: path.join(root, "bridge/agent.sock"), path: "/hook", method: "POST",
          headers: { "Content-Length": Buffer.byteLength(payload) } }, res => {
          let data = ""; res.on("data", bytes => data += bytes); res.on("end", () => resolve(JSON.parse(data)));
        }); req.on("error", reject); req.end(payload);
      });
      await waitFor(() => frames.some(f => f.agentStatus.pendingApproval), 2_500);
      const approval = frames.find(f => f.agentStatus.pendingApproval)?.agentStatus.pendingApproval;
      expect(approval?.message).toContain("fixture-command");
      // A held Codex approval publishes its choices for the phone's question card.
      expect(approval?.choice).toEqual({ body: "fixture-command",
        options: [{ label: "Yes, proceed", key: "y" }, { label: "No, and tell Codex what to do differently", key: "Escape" }] });
      expect(Date.parse(approval?.expiresAt)).toBeGreaterThan(Date.now());
      const wrong = await api("/v1/approvals/answer", { target: { ...target, session: "bbbbbbbb-1111-4111-8111-111111111111" }, actionId: approval.actionId, decision: "approve" });
      expect(wrong.status).toBe(409);
      expect((await api("/v1/approvals/answer", { target, actionId: approval.actionId, decision: "deny" })).status).toBe(200);
      expect((await reply).hookSpecificOutput.decision.behavior).toBe("deny");
      expect((await api("/v1/approvals/answer", { target, actionId: approval.actionId, decision: "approve" })).status).toBe(409);
      socket.close(); await once(socket, "close");
    });

    it("holds MCP arguments as details and answers the matching terminal choices with their own keys", async () => {
      agentStatus = "blocked";
      const sentence = "Allow the phren MCP server to run tool phren_admin?";
      // Codex marks the highlighted row; without a cursor the Hook refuses to
      // answer a menu whose rows carry no keys of their own, and the phone's
      // answer walks that cursor rather than typing a number the menu ignores.
      menuPane = highlight => sentence + "\n"
        + ["1. Allow            Run the tool and continue.",
           "2. Allow for this session  Keep this permission for this session.",
           "3. Deny  Do not run the tool."]
          .map((row, index) => (index === highlight ? "\u203a " : "  ") + row).join("\n") + "\n";
      menuHighlight = 0;
      paneLines = menuPane(menuHighlight);
      const socket = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/status?${new URLSearchParams(target)}`);
      const frames: any[] = []; socket.on("message", bytes => frames.push(JSON.parse(bytes.toString())));
      await once(socket, "open");
      await waitFor(() => frames.length, 1_500);
      const input = { action: "read_skill", name: "m4l-improve" };
      const reply = new Promise<any>((resolve, reject) => {
        const payload = JSON.stringify({ target, event: "PermissionRequest", tool: "mcp__phren__phren_admin", input });
        const req = request({ socketPath: path.join(root, "bridge/agent.sock"), path: "/hook", method: "POST",
          headers: { "Content-Length": Buffer.byteLength(payload) } }, res => {
          let data = ""; res.on("data", bytes => data += bytes); res.on("end", () => resolve(JSON.parse(data)));
        }); req.on("error", reject); req.end(payload);
      });
      await waitFor(() => frames.some(f => f.agentStatus.pendingApproval?.choice), 2_500);
      const approval = frames.find(f => f.agentStatus.pendingApproval?.choice)?.agentStatus.pendingApproval;
      expect(approval?.title).toBe(sentence);
      expect(JSON.parse(approval.details)).toEqual(input);
      expect(approval.terminalOnly).toBe(false);
      expect(approval.choice.title).toBe(sentence);
      expect(approval.choice.options).toEqual([
        { label: "Allow", description: "Run the tool and continue.", key: "1", hasKey: false },
        { label: "Allow for this session", description: "Keep this permission for this session.", key: "2", hasKey: false },
        { label: "Deny", description: "Do not run the tool.", key: "3", hasKey: false },
      ]);
      // The rows carry no keys of their own, so the Hook walks the cursor from
      // the highlighted first row to the second and confirms it.
      expect((await api("/v1/keys", { target, keys: ["2"] })).status).toBe(200);
      expect(commands.filter(c => c.method === "agent.send_keys").map(c => c.params.keys))
        .toEqual([["down"], ["enter"]]);
      expect(await reply).toEqual({});
      socket.close(); await once(socket, "close");
    });

    it("answers Claude's AskUserQuestion by allowing the call with the phone's answers added to its own input", async () => {
      const questions = [
        { question: "Which accent?", header: "Design", options: [{ label: "Cyan", description: "Keep it" }, { label: "Lavender", description: "Softer" }] },
        { question: "Which screens?", header: "Scope", multiSelect: true, options: [{ label: "Chat" }, { label: "Agents" }, { label: "Settings" }] },
      ];
      const socket = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/status?${new URLSearchParams(target)}`);
      const frames: any[] = []; socket.on("message", bytes => frames.push(JSON.parse(bytes.toString())));
      await once(socket, "open");
      await waitFor(() => frames.length, 1_500);
      const callback = (tool: string, input: unknown) => new Promise<any>((resolve, reject) => {
        const payload = JSON.stringify({ target, event: "PermissionRequest", tool, input });
        const req = request({ socketPath: path.join(root, "bridge/agent.sock"), path: "/hook", method: "POST",
          headers: { "Content-Length": Buffer.byteLength(payload) } }, res => {
          let data = ""; res.on("data", bytes => data += bytes); res.on("end", () => resolve(JSON.parse(data)));
        }); req.on("error", reject); req.end(payload);
      });
      const pendingApproval = async (after: number) => {
        await waitFor(() => frames.slice(after).some(f => f.agentStatus.pendingApproval), 2_500);
        return frames.slice(after).find(f => f.agentStatus.pendingApproval)?.agentStatus.pendingApproval;
      };
      // A shell approval never takes answers.
      let seen = frames.length;
      const bash = callback("Bash", { command: "fixture-command" });
      let approval = await pendingApproval(seen);
      expect((await api("/v1/approvals/answer", { target, actionId: approval.actionId, decision: "approve", updatedInput: { command: "fixture-command", answers: { "Which accent?": "Cyan" } } })).status).toBe(400);
      expect((await api("/v1/approvals/answer", { target, actionId: approval.actionId, decision: "deny" })).status).toBe(200);
      expect((await bash).hookSpecificOutput.decision.behavior).toBe("deny");
      // A question whose questions were rewritten, dropped, or answered with an
      // unasked key is refused and stays pending; a denial carries no answers.
      seen = frames.length;
      const asked = callback("AskUserQuestion", { questions });
      approval = await pendingApproval(seen);
      expect(approval.toolName).toBe("AskUserQuestion");
      expect(JSON.parse(approval.message).questions).toEqual(questions);
      const answers = { "Which accent?": "Cyan", "Which screens?": ["Chat", "Settings"] };
      expect((await api("/v1/approvals/answer", { target, actionId: approval.actionId, decision: "approve", updatedInput: { questions: [questions[0]], answers } })).status).toBe(400);
      expect((await api("/v1/approvals/answer", { target, actionId: approval.actionId, decision: "approve", updatedInput: { questions: [{ ...questions[0], question: "Which colour?" }, questions[1]], answers } })).status).toBe(400);
      expect((await api("/v1/approvals/answer", { target, actionId: approval.actionId, decision: "approve", updatedInput: { answers } })).status).toBe(400);
      expect((await api("/v1/approvals/answer", { target, actionId: approval.actionId, decision: "approve", updatedInput: { questions, answers: { "Which font?": "Mono" } } })).status).toBe(400);
      expect((await api("/v1/approvals/answer", { target, actionId: approval.actionId, decision: "approve", updatedInput: { questions } })).status).toBe(400);
      expect((await api("/v1/approvals/answer", { target, actionId: approval.actionId, decision: "deny", updatedInput: { questions, answers } })).status).toBe(400);
      expect((await api("/v1/approvals/answer", { target, actionId: approval.actionId, decision: "approve", updatedInput: { questions, answers: {}, response: "x".repeat(4001) } })).status).toBe(400);
      // The same questions in another key order, plus answers and a typed
      // "Other", allow the call with exactly that input.
      const reordered = questions.map(q => ({ options: q.options.map(o => ({ ...o })), ...q })).reverse();
      expect((await api("/v1/approvals/answer", { target, actionId: approval.actionId, decision: "approve",
        updatedInput: { questions: reordered.reverse(), answers: { ...answers, "Which accent?": "Something warmer" }, response: "Keep it subtle" } })).status).toBe(200);
      const decision = (await asked).hookSpecificOutput.decision;
      expect(decision.behavior).toBe("allow");
      expect(decision.updatedInput).toEqual({ questions, answers: { "Which accent?": "Something warmer", "Which screens?": ["Chat", "Settings"] }, response: "Keep it subtle" });
      expect((await api("/v1/approvals/answer", { target, actionId: approval.actionId, decision: "approve", updatedInput: { questions, answers } })).status).toBe(409);
      socket.close(); await once(socket, "close");
    });

    it("times a held AskUserQuestion out into question cards and answers it with digits, Tab and Enter", async () => {
      agentStatus = "blocked";
      const questions = [
        { question: "Which accent?", header: "Design", options: [{ label: "Cyan", description: "Keep it" }, { label: "Lavender", description: "Softer" }] },
        { question: "Which screens?", header: "Scope", multiSelect: true, options: [{ label: "Chat" }, { label: "Agents" }, { label: "Settings" }] },
      ];
      const socket = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/status?${new URLSearchParams(target)}`);
      const frames: any[] = []; socket.on("message", bytes => frames.push(JSON.parse(bytes.toString())));
      await once(socket, "open");
      await waitFor(() => frames.length, 1_500);
      const reply = new Promise<any>((resolve, reject) => {
        const payload = JSON.stringify({ target, event: "PermissionRequest", tool: "AskUserQuestion", input: { questions } });
        const req = request({ socketPath: path.join(root, "bridge/agent.sock"), path: "/hook", method: "POST",
          headers: { "Content-Length": Buffer.byteLength(payload) } }, res => {
          let data = ""; res.on("data", bytes => data += bytes); res.on("end", () => resolve(JSON.parse(data)));
        }); req.on("error", reject); req.end(payload);
      });
      // The watch holds the request; the phone sees the approval until it times out.
      await waitFor(() => frames.some(f => f.agentStatus?.pendingApproval), 3_000);
      expect(frames.find(f => f.agentStatus?.pendingApproval)?.agentStatus.pendingApproval.toolName).toBe("AskUserQuestion");
      expect(await reply).toEqual({});
      const prompt = async (after: number) => {
        for (let i = 0; i < 200; i++) {
          for (let index = frames.length - 1; index >= after; index--) if (frames[index].agentStatus?.terminalPrompt) return frames[index].agentStatus.terminalPrompt;
          await sleep(25);
        }
        return undefined;
      };
      // Released: the normalized questions ride along with the first question's choice.
      const first = await prompt(0);
      expect(first).toMatchObject({ toolName: "AskUserQuestion", questionIndex: 0, questions,
        choice: { title: "Which accent?", options: [{ label: "Cyan", key: "1" }, { label: "Lavender", key: "2" }] } });
      // Answering the first question sends its digit then Tab and moves on.
      const beforeSecond = frames.length;
      expect((await api("/v1/keys", { target, keys: ["2"] })).status).toBe(200);
      expect(commands.filter(c => c.method === "agent.send_keys").map(c => c.params.keys).at(-1)).toEqual(["2", "tab"]);
      const second = await prompt(beforeSecond);
      expect(second).toMatchObject({ questionIndex: 1,
        choice: { title: "Which screens?", options: [{ label: "Chat", key: "1" }, { label: "Agents", key: "2" },
          { label: "Settings", key: "3" }, { label: "Done", key: "Enter" }] } });
      // The last question sends its digit then Enter and clears the prompt.
      const beforeCleared = frames.length;
      expect((await api("/v1/keys", { target, keys: ["1"] })).status).toBe(200);
      expect(commands.filter(c => c.method === "agent.send_keys").map(c => c.params.keys).at(-1)).toEqual(["1", "enter"]);
      const cleared = () => frames.slice(beforeCleared).some(f => f.agentStatus && f.agentStatus.terminalPrompt === undefined);
      await waitFor(cleared, 5_000);
      expect(cleared()).toBe(true);
      socket.close(); await once(socket, "close");
    }, 20_000);

    it("holds overview requests only with an explicit watch and lets the phone approve", async () => {
      const callback = () => new Promise<any>((resolve, reject) => {
        const payload = JSON.stringify({ target, event: "PermissionRequest", tool: "Bash", input: { command: "fixture-command" } });
        const req = request({ socketPath: path.join(root, "bridge/agent.sock"), path: "/hook", method: "POST",
          headers: { "Content-Length": Buffer.byteLength(payload) } }, res => {
          let data = ""; res.on("data", bytes => data += bytes); res.on("end", () => resolve(JSON.parse(data)));
        }); req.on("error", reject); req.end(payload);
      });
      await api("/v1/workspaces");
      expect(await callback()).toEqual({});
      await api("/v1/workspaces?watchApprovals=1");
      const reply = callback();
      let pending = false;
      await waitFor(async () => pending = (await api("/v1/workspaces")).data.groups.some((g: any) => g.children.some((t: any) => t.approvalPending)), 1_500);
      expect(pending).toBe(true);
      const socket = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/status?${new URLSearchParams(target)}`);
      const frames: any[] = []; socket.on("message", bytes => frames.push(JSON.parse(bytes.toString())));
      await once(socket, "open");
      await waitFor(() => frames.some(f => f.agentStatus.pendingApproval), 1_500);
      const approval = frames.find(f => f.agentStatus.pendingApproval)?.agentStatus.pendingApproval;
      expect(approval?.actionId).toBeTruthy();
      expect((await api("/v1/approvals/answer", { target, actionId: approval.actionId, decision: "approve" })).status).toBe(200);
      expect((await reply).hookSpecificOutput.decision.behavior).toBe("allow");
      expect((await api("/v1/workspaces")).data.groups.some((g: any) => g.children.some((t: any) => t.approvalPending))).toBe(false);
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
        expect(JSON.parse(changes[0].after).hooks.PreToolUse[0]).toMatchObject({ hooks: [{ timeout: 10 }] });
        expect(JSON.parse(changes[0].after).hooks.PreToolUse[0].matcher).toBeUndefined(); // Codex: every tool, filtered by the Hook
        expect(JSON.parse(changes.find(c => c.file.endsWith("settings.json"))!.after).hooks.PreToolUse[0].matcher).toBe("Bash|Write|Edit|MultiEdit|NotebookEdit|apply_patch|str_replace_editor");
        expect(JSON.parse(changes[0].after).hooks.PostToolUse).toHaveLength(1);
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

  describe("isolated fixture", () => {
    beforeEach(startFixture);
    afterEach(stopFixture);

    it("lists, adds, and revokes conductor grants over the Hook routes", async () => {
      expect((await api("/v1/conductor/grants")).data).toEqual({ grants: [] });
      const added = await api("/v1/conductor/grants", { scope: "project:phren", actions: ["dispatch"] });
      expect(added.status).toBe(200);
      expect(added.data).toMatchObject({ ok: true, grant: { scope: "project:phren", actions: ["dispatch"] } });
      expect((await api("/v1/conductor/grants")).data.grants).toHaveLength(1);
      const duplicate = await api("/v1/conductor/grants", { scope: "project:phren", actions: ["dispatch"] });
      expect(duplicate.status).toBe(409);
      const revoked = await api("/v1/conductor/grants", { scope: "project:phren" }, "DELETE");
      expect(revoked.status).toBe(200);
      expect(revoked.data.grant).toMatchObject({ scope: "project:phren" });
      expect((await api("/v1/conductor/grants")).data.grants).toEqual([]);
      expect((await api("/v1/conductor/grants", { scope: "global" }, "DELETE")).status).toBe(404);
    });

    it("rejects DELETE on a path that is not the grants route", async () => {
      expect((await api("/v1/dispatch", undefined, "DELETE")).status).toBe(404);
    });

    it.each([
      { kind: "claude", effort: "high", required: ["--append-system-prompt-file", "--effort", "high"] },
      { kind: "codex", effort: "low", required: ["-c", "model_reasoning_effort=low", "-c"] },
      { kind: "opencode", effort: "medium", required: ["--agent", "conductor", "--variant", "medium"] },
    ])("launches a $kind conductor with its brief and effort", async ({ kind, effort, required }) => {
      const launched = await api("/v1/workspaces/launch?mux=herdr:default", { cwd: root, label: `${kind} lead`, kind, role: "conductor", effort });
      expect(launched.status, JSON.stringify(launched.data)).toBe(200);
      expect(launched.data).toMatchObject({ ok: true, role: "conductor", agent: kind });
      const params = commands.find(c => c.method === "agent.start")?.params as any;
      expect(params.name).toMatch(/^conductor-/);
      let cursor = -1;
      for (const value of required) { cursor = params.args.indexOf(value, cursor + 1); expect(cursor).toBeGreaterThanOrEqual(0); }
      if (kind === "codex") expect(JSON.stringify(params.args)).toContain("# Conductor");
      // Claude reads the multi-line brief from its file: no argument carries a newline.
      if (kind === "claude") expect(params.args).toContain(path.join(root, "bridge/conductor/brief.md"));
      expect(params.args.some((arg: string) => arg.includes("\n"))).toBe(false);
      expect(JSON.stringify(params.args)).not.toContain("name: conductor");
      expect(await readFile(path.join(root, "bridge/conductor/brief.md"), "utf8")).toContain("# Conductor");
      if (kind === "opencode") {
        const definition = await readFile(path.join(root, ".config/opencode/agents/conductor.md"), "utf8");
        expect(definition).toContain("mode: primary"); expect(definition).toContain("# Conductor");
      }
    });

    it("hands back an agent held at a first-run screen so the chat can answer it", async () => {
      blockAgentStart = true;
      try {
        const launched = await api("/v1/workspaces/launch?mux=herdr:default", { cwd: root, label: "Trust", kind: "claude" });
        expect(launched.status, JSON.stringify(launched.data)).toBe(200);
        expect(launched.data).toMatchObject({ ok: true, agent: "claude", agentStatus: "blocked" });
      } finally { blockAgentStart = false; }
    });

    it("gives a second launch with the same label its own agent name", async () => {
      await api("/v1/workspaces/launch?mux=herdr:default", { cwd: root, label: "SR requests", kind: "claude" });
      const second = await api("/v1/workspaces/launch?mux=herdr:default", { cwd: root, label: "SR requests", kind: "claude" });
      expect(second.status, JSON.stringify(second.data)).toBe(200);
      expect(commands.filter(c => c.method === "agent.start").map(c => c.params.name)).toEqual(["sr-requests", "sr-requests-2"]);
    });

    it("starts an agent with the chosen model and effort", async () => {
      const launched = await api("/v1/workspaces/launch?mux=herdr:default", { cwd: root, label: "Worker", kind: "claude", model: "claude-opus-5-5", effort: "xhigh" });
      expect(launched.status, JSON.stringify(launched.data)).toBe(200);
      expect(commands.filter(c => c.method === "agent.start").at(-1)?.params.args).toEqual(["--model", "claude-opus-5-5", "--effort", "xhigh"]);
    });

    it("starts a conductor with no folder in the phren store", async () => {
      const store = path.join(root, ".phren");
      await mkdir(store, { recursive: true });
      const launched = await api("/v1/workspaces/launch?mux=herdr:default", { label: "Conductor", kind: "codex", role: "conductor" });
      expect(launched.status, JSON.stringify(launched.data)).toBe(200);
      expect(commands.find(c => c.method === "workspace.create")?.params.cwd).toBe(await realpathAsync(store));
      expect(commands.find(c => c.method === "agent.start")?.params.name).toBe("conductor");
      const agent = await api("/v1/workspaces/launch?mux=herdr:default", { label: "Worker", kind: "codex" });
      expect(agent.status).toBe(400);
    });

    it("reports the conductor role and returns its target when a second launch is refused", async () => {
      const first = await api("/v1/workspaces/launch?mux=herdr:default", { cwd: root, label: "Owner", kind: "codex", role: "conductor", effort: "high" });
      expect(first.status).toBe(200);
      const overview = await api("/v1/workspaces?mux=herdr:default");
      const tab = overview.data.groups.find((group: any) => group.id === first.data.workspaceId).children[0];
      expect(tab).toMatchObject({ role: "conductor", agent: "codex" });
      const second = await api("/v1/workspaces/launch?mux=herdr:default", { cwd: root, label: "Another", kind: "claude", role: "conductor" });
      expect(second.status).toBe(409);
      expect(second.data.target).toMatchObject({ server: "default", workspace: first.data.workspaceId, tab: first.data.tabId, pane: first.data.paneId, source: "codex" });
      expect(commands.filter(c => c.method === "agent.start")).toHaveLength(1);
    });

    it("dispatches through a fake SSH pipe to a second Hook and its registered project", async () => {
      await dispatchFixture();
      const sent = await api("/v1/dispatch", { computer: "Linuxbox", project: "phren", harness: "codex", model: "test-model", label: "Worker", prompt: "Run the assigned checks" });
      expect(sent.status, JSON.stringify(sent.data)).toBe(200);
      expect(sent.data).toMatchObject({ ok: true, computer: "Linuxbox", state: "accepted", target: { source: "codex", starting: true, pane: "w9:p1" } });
      // The remote Hook resolves the checkout through realpath; on macOS /tmp is a symlink.
      expect(commands.find(c => c.method === "workspace.create")?.params.cwd).toBe(await realpathAsync(path.join(root, "checkout")));
      expect(commands.find(c => c.method === "agent.start")?.params.args).toEqual(["--model", "test-model"]);
      expect(commands.filter(c => c.method === "agent.prompt").map(c => c.params)).toEqual([{ target: "w9:p1", text: "Run the assigned checks" }]);
      expect((await api("/v1/dispatch")).data.dispatches[0]).toMatchObject({ id: sent.data.id, state: "accepted" });
      const connections = (await readFile(path.join(root, "ssh-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(connections).toHaveLength(3);
      expect(connections.every(args => args.includes("IdentityAgent=none"))).toBe(true);
    });

    it("reports health details, with a peer that does not list this computer back as one-way", async () => {
      await dispatchFixture();
      const details = await api("/v1/health/details");
      expect(details.status, JSON.stringify(details.data)).toBe(200);
      expect(details.data).toMatchObject({ product: "phren-hook", computer: { name: hostname() },
        push: { configured: false }, schedules: { lastRun: null }, canary: null });
      expect(details.data.versions.map((item: { tool: string }) => item.tool)).toEqual(["hook", "herdr", "claude", "codex", "copilot", "opencode"]);
      expect(details.data.versions[0]).toMatchObject({ tool: "hook", status: "ok" });
      expect(Array.isArray(details.data.stores)).toBe(true);
      expect(details.data.peers).toMatchObject({ configured: true, computers: [{ name: "Linuxbox", reachable: true, listsBack: false }] });
      // Once the peer's hooks.yaml names this computer, the link is two-way.
      const line = await enrollComputer("Back", path.join(root, "remote"));
      const hostKey = publicComputerKey(line.slice(line.indexOf("ssh-ed25519")));
      await writeFile(path.join(root, "remote/hooks.yaml"), JSON.stringify({ version: 1, computers: [
        { name: hostname().split(".")[0].replace(/[^A-Za-z0-9_.-]/g, "-"), address: "back.example", username: "sam", hostKey },
      ] }), { mode: 0o600 });
      expect((await api("/v1/health/details")).data.peers.computers[0]).toMatchObject({ name: "Linuxbox", reachable: true, listsBack: true });
    });

    it("advertises speech and answers /v1/speech with a coded error when this computer has no ElevenLabs key", async () => {
      expect((await api("/v1/health")).data.capabilities.speech).toBe(true);
      const reply = await api("/v1/speech", { text: "Hello from the conductor." });
      expect(reply.status).toBe(503);
      expect(reply.data).toMatchObject({ code: "speech-unconfigured" });
      expect((await api("/v1/speech", { text: "" })).status).toBe(400);
    });

    it("runs the canary: launches and closes its own conductor, reads an idle transcript, never types into a pane", async () => {
      agentStatus = "idle";
      const run = await api("/v1/canary", {});
      expect(run.status, JSON.stringify(run.data)).toBe(200);
      expect(run.data).toMatchObject({ version: 1, trigger: "manual", ok: true });
      const steps = Object.fromEntries(run.data.steps.map((item: { name: string; status: string }) => [item.name, item.status]));
      expect(steps).toMatchObject({ conductor: "ok", transcript: "ok", sessions: "ok" });
      const created = commands.find(c => c.method === "workspace.create");
      expect(created?.params.label).toBe("phren canary");
      expect(commands.find(c => c.method === "agent.start")?.params).toMatchObject({ name: "phren-canary", kind: "claude" });
      expect(commands.filter(c => c.method === "workspace.close").map(c => c.params.workspace_id)).toEqual(["w9"]);
      expect(commands.some(c => ["agent.prompt", "agent.send_keys"].includes(c.method))).toBe(false);
      const saved = JSON.parse(await readFile(path.join(root, "bridge/canary.json"), "utf8"));
      expect(saved.startedAt).toBe(run.data.startedAt);
      expect((await api("/v1/health/details")).data.canary).toMatchObject({ ok: true, startedAt: run.data.startedAt });
    });

    it("closes the canary's workspace and reports Herdr's reason when the conductor cannot start", async () => {
      failAgentStart = true;
      const run = await api("/v1/canary", {});
      expect(run.status).toBe(200);
      expect(run.data.ok).toBe(false);
      const conductor = run.data.steps.find((item: { name: string }) => item.name === "conductor");
      expect(conductor).toMatchObject({ status: "failed" });
      expect(conductor.reason).toContain("is not an available shell");
      expect(commands.filter(c => c.method === "workspace.close").map(c => c.params.workspace_id)).toEqual(["w9"]);
    });

    it("does not launch when the remote project is absent or the request is invalid", async () => {
      await dispatchFixture();
      const brief = { computer: "Linuxbox", project: "missing", harness: "codex", label: "Worker", prompt: "Brief" };
      expect((await api("/v1/dispatch", brief)).data).toMatchObject({ ok: false, state: "failed" });
      expect((await api("/v1/dispatch", { ...brief, project: "../phren" })).status).toBe(400);
      expect((await api("/v1/dispatch", { ...brief, cwd: root })).status).toBe(400);
      expect(commands.some(c => ["workspace.create", "agent.start", "agent.prompt"].includes(c.method))).toBe(false);
    });

    it("rejects a relative directory or an unknown agent kind before touching Herdr", async () => {
      expect((await api("/v1/workspaces/launch?mux=herdr:default", { cwd: "relative/path", label: "x", kind: "codex" })).status).toBe(400);
      expect((await api("/v1/workspaces/launch?mux=herdr:default", { cwd: root, label: "x", kind: "gemini" })).status).toBe(400);
      expect((await api("/v1/workspaces/launch?mux=herdr:default", { cwd: root, label: "", kind: "codex" })).status).toBe(400);
      expect(commands.some(c => c.method === "workspace.create" || c.method === "agent.start")).toBe(false);
    });

    it("reports only running workers and their providers in the workspace overview", async () => {
      const fanoutRoot = path.join(root, ".phren/.runtime/agent-fanouts");
      for (const worker of [{ id: "running-worker", status: "running", provider: "opencode" },
        { id: "completed-worker", status: "completed", provider: "codex" }] as const) {
        const directory = path.join(fanoutRoot, worker.id);
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, "events.jsonl"), "{}\n");
        await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ schemaVersion: 1, id: worker.id,
          parent: { provider: "codex", session }, provider: worker.provider, taskLabel: worker.id,
          cwd: root, worktree: root, eventLog: "events.jsonl", createdAt: "2026-09-20T12:00:00.000Z",
          startedAt: "2026-09-20T12:00:00.000Z", updatedAt: "2026-09-20T12:00:00.000Z", status: worker.status }));
      }
      const tab = (await api("/v1/workspaces")).data.groups[0].children[0];
      expect(tab).toMatchObject({ runningChildren: 1, childProviders: ["opencode"] });
    });

    it("presses answer keys only while the agent waits, and never anything typed", async () => {
      agentStatus = "blocked";
      expect((await api("/v1/keys", { target, keys: ["y"] })).status).toBe(200);
      expect((await api("/v1/keys", { target, keys: ["Enter"] })).status).toBe(200);
      expect((await api("/v1/keys", { target, keys: ["Down", "Enter"] })).status).toBe(200);
      expect(commands.filter(c => c.method === "agent.send_keys").map(c => c.params.keys)).toEqual([["y"], ["enter"], ["down", "enter"]]);
      expect((await api("/v1/keys", { target, keys: ["x"] })).status).toBe(400);
      expect((await api("/v1/keys", { target, keys: ["rm -rf"] })).status).toBe(400);
      expect((await api("/v1/keys", { target, keys: [] })).status).toBe(400);
      // A starting agent's own first prompt (folder trust) has no session yet.
      reportIdentity = false;
      const starting = (await api("/v1/workspaces/panes?groupId=w1&childId=w1:t1")).data.panes[0];
      expect(starting).toMatchObject({ starting: true });
      const { session: _session, ...location } = target;
      expect((await api("/v1/keys", { target: { ...location, starting: true, startingToken: starting.startingToken }, keys: ["Enter"] })).status).toBe(200);
      expect((await api("/v1/keys", { target: { ...location, starting: true, startingToken: "0".repeat(64) }, keys: ["Enter"] })).status).toBe(409);
      reportIdentity = true;
      agentStatus = "working";
      expect((await api("/v1/keys", { target, keys: ["Enter"] })).status).toBe(409);
      expect((await api("/v1/keys", { target, keys: ["Escape"] })).status).toBe(200);
      agentStatus = "idle";
      expect((await api("/v1/keys", { target, keys: ["Escape"] })).status).toBe(409);
      expect(commands.filter(c => c.method === "agent.send_keys")).toHaveLength(5);
    });

    it("enforces launch directory checks and one shared rate limit across create and launch", async () => {
      for (const route of ["create", "launch"]) {
        const rejected = await api(`/v1/workspaces/${route}`, { cwd: "/etc", label: "x", kind: "codex" });
        expect(rejected.status).toBe(403);
      }
      holdSnapshot = true;
      const first = api("/v1/workspaces/create", { cwd: root, label: "x" });
      await waitFor(() => releaseSnapshot, 1_000);
      expect(releaseSnapshot).toBeDefined();
      expect((await api("/v1/workspaces/launch", { cwd: root, label: "y", kind: "codex" })).status).toBe(429);
      releaseSnapshot!(); releaseSnapshot = undefined; expect((await first).status).toBe(200);
      for (let i = 0; i < 3; i++) expect((await api("/v1/workspaces/create", { cwd: root, label: "x" })).status).toBe(200);
      expect((await api("/v1/workspaces/create", { cwd: root, label: "x" })).status).toBe(429);
    });

    it("accepts an outside locator candidate even when the registered project has a different name", async () => {
      const outside = await mkdtemp("/tmp/phren-external-");
      try {
        const config = path.join(root, ".phren/project-alias"); await mkdir(config, { recursive: true });
        await writeFile(path.join(config, "phren.project.yaml"), `sourcePath: ${outside}\n`);
        const candidates = await api("/v1/projects/locate?project=project-alias");
        expect(candidates.data.candidates.some((c: any) => c.directory === realpathSync.native(outside))).toBe(true);
        expect((await api("/v1/workspaces/create", { cwd: outside, label: "arbitrary label" })).status).toBe(200);
      } finally { await rm(outside, { recursive: true, force: true }); }
    });

    it("measures tree and status on the phren checkout", async () => {
      paneCwd = process.cwd();
      try {
        const measure = async (route: string, directory?: string) => {
          const started = performance.now();
          const response = await api(`/v1/git/${route}`, { target, ...(directory ? { path: directory } : {}) });
          expect(response.status, JSON.stringify(response.data)).toBe(200);
          return { ms: performance.now() - started, data: response.data };
        };
        const status = await measure("status");
        const cold = await measure("tree");
        const warm = await measure("tree");
        const directory = await measure("tree", "packages/cli/src");
        console.log(JSON.stringify({ benchmark: "phren git routes", statusMs: status.ms,
          coldTreeMs: cold.ms, cachedTreeMs: warm.ms, directoryMs: directory.ms }));
        expect(warm.ms).toBeLessThan(500);
        expect(directory.data.entries.length).toBeGreaterThan(0);
      } finally { paneCwd = undefined; }
    });

    it("serves git routes for the pane's repository and refuses them outside one", async () => {
      // The mock pane's cwd is the hook root, which is not a repository yet.
      expect((await api("/v1/git/status", { target })).status).toBe(409);
      await execFileAsync("git", ["-C", root, "init", "-q"]);
      const status = await api("/v1/git/status", { target });
      expect(status.status, JSON.stringify(status.data)).toBe(200);
      expect(typeof status.data.branch).toBe("string");
      expect(Array.isArray(status.data.files)).toBe(true);
      const tree = await api("/v1/git/tree", { target });
      expect(tree.status).toBe(200);
      expect(Array.isArray(tree.data.entries)).toBe(true);
      expect((await api("/v1/git/stage", { target, paths: ["../x"] })).status).toBe(400);
      expect((await api("/v1/git/stage", { target, paths: ["/etc/passwd"] })).status).toBe(400);
    });

    it("lists the repository's other worktrees and scopes git routes, the diff and files to a listed one", async () => {
      const git = (...args: string[]) => execFileAsync("git", ["-c", "user.name=t", "-c", "user.email=t@x", "-C", root, ...args]);
      await git("init", "-q"); await writeFile(path.join(root, "base.txt"), "one\n");
      await git("add", "base.txt"); await git("commit", "-qm", "start");
      const worker = path.join(root, ".claude/worktrees/agent-x");
      await git("worktree", "add", "-q", "-b", "worktree-agent-x", worker);
      await writeFile(path.join(worker, "base.txt"), "one\ntwo\n");
      try {
        const listing = await api("/v1/git/worktrees", { target });
        expect(listing.status, JSON.stringify(listing.data)).toBe(200);
        const row = listing.data.worktrees.find((item: any) => item.path === ".claude/worktrees/agent-x");
        expect(row).toMatchObject({ branch: "worktree-agent-x", ahead: 0, changed: 1 });
        const status = await api("/v1/git/status", { target, worktree: row.id });
        expect(status.data).toMatchObject({ branch: "worktree-agent-x", files: [{ path: "base.txt", status: "M" }] });
        const diff = await api("/v1/diff", { target, worktree: row.id });
        expect(diff.status, JSON.stringify(diff.data)).toBe(200);
        expect(diff.data.files.map((file: any) => file.path)).toEqual(["base.txt"]);
        const file = await api("/v1/files/range?" + new URLSearchParams({ ...target, worktree: row.id, path: "base.txt", offset: "0", length: "64" }));
        expect(Buffer.from(file.data.data, "base64").toString()).toBe("one\ntwo\n");
        expect((await api("/v1/git/status", { target, worktree: "f".repeat(32) })).status).toBe(404);
        expect((await api("/v1/git/status", { target, worktree: worker })).status).toBe(400);
        expect((await api("/v1/git/status", { target, worktree: row.id, child: "a".repeat(32) })).status).toBe(400);
      } finally { await rm(path.join(root, ".git"), { recursive: true, force: true }); await rm(path.join(root, ".claude"), { recursive: true, force: true }); }
    });

    it("commits and pushes a listed worktree to a bare remote through the git routes", async () => {
      const git = (...args: string[]) => execFileAsync("git", ["-c", "user.name=sam", "-c", "user.email=sam@example.com", "-C", root, ...args]);
      const remote = path.join(root, "remote.git");
      await execFileAsync("git", ["init", "-q", "--bare", "-b", "main", remote]);
      await git("init", "-q", "-b", "main"); await writeFile(path.join(root, "base.txt"), "one\n");
      await git("add", "base.txt"); await git("commit", "-qm", "start");
      await git("remote", "add", "origin", remote); await git("push", "-q", "-u", "origin", "main");
      const worker = path.join(root, ".claude/worktrees/agent-y");
      await git("worktree", "add", "-q", "-b", "worktree-agent-y", worker);
      await execFileAsync("git", ["-C", worker, "config", "user.name", "sam"]);
      await execFileAsync("git", ["-C", worker, "config", "user.email", "sam@example.com"]);
      await writeFile(path.join(worker, "base.txt"), "one\ntwo\n");
      try {
        const row = (await api("/v1/git/worktrees", { target })).data.worktrees.find((item: any) => item.path === ".claude/worktrees/agent-y");
        expect((await api("/v1/git/commit", { target, worktree: row.id, message: "Worker change" })).status).toBe(409);
        expect((await api("/v1/git/stage", { target, worktree: row.id, paths: ["base.txt"] })).status).toBe(200);
        expect((await api("/v1/git/commit", { target, worktree: row.id, message: "" })).status).toBe(400);
        const commit = await api("/v1/git/commit", { target, worktree: row.id, message: "Worker change" });
        expect(commit.data, JSON.stringify(commit.data)).toMatchObject({ ok: true, subject: "Worker change", branch: "worktree-agent-y" });
        // The pane's own checkout is untouched; the commit is on the worker's branch.
        expect((await git("log", "-1", "--format=%s", "main")).stdout.trim()).toBe("start");
        const push = await api("/v1/git/push", { target, worktree: row.id });
        expect(push.data, JSON.stringify(push.data)).toMatchObject({ ok: true, upstream: "origin/worktree-agent-y", setUpstream: true });
        expect((await execFileAsync("git", ["--git-dir", remote, "log", "-1", "--format=%s", "worktree-agent-y"])).stdout.trim()).toBe("Worker change");
        // The pane itself is on main, the default branch: refused without the confirm flag.
        const refused = await api("/v1/git/push", { target });
        expect(refused.status).toBe(409);
        expect(refused.data.error).toMatch(/default branch/);
        expect((await api("/v1/git/push", { target, worktree: "f".repeat(32) })).status).toBe(404);
      } finally {
        for (const entry of [".git", ".claude", "remote.git", "base.txt"]) await rm(path.join(root, entry), { recursive: true, force: true });
      }
    });

    it("launches an agent in a new worktree on its own branch and names it in the worktree listing", async () => {
      const git = (...args: string[]) => execFileAsync("git", ["-c", "user.name=t", "-c", "user.email=t@x", "-C", root, ...args]);
      const launch = (branch: string) => api("/v1/workspaces/launch?mux=herdr:default", { cwd: root, label: "wt", kind: "claude", worktree: { branch } });
      const creates = () => commands.filter(c => c.method === "workspace.create").length;
      // Not a repository: refused before Herdr is asked for anything.
      let before = creates();
      const plain = await launch("phren/fix-login");
      expect(plain.status).toBe(409);
      expect(plain.data.error).toContain("not a Git repository");
      expect(creates()).toBe(before);
      await git("init", "-q", "-b", "main"); await writeFile(path.join(root, "base.txt"), "one\n");
      await git("add", "base.txt"); await git("commit", "-qm", "start");
      try {
        const launched = await launch("phren/fix-login");
        expect(launched.status, JSON.stringify(launched.data)).toBe(200);
        const worktree = path.join(await realpathAsync(root), ".claude/worktrees/phren-fix-login");
        expect(launched.data.worktree).toEqual({ path: worktree, branch: "phren/fix-login" });
        expect(commands.filter(c => c.method === "workspace.create").at(-1)?.params).toMatchObject({ label: "wt", cwd: worktree });
        expect(commands.filter(c => c.method === "agent.start").at(-1)?.params).toMatchObject({ name: "wt", kind: "claude" });
        // The branch starts at the project's current HEAD.
        expect((await git("rev-parse", "phren/fix-login")).stdout).toBe((await git("rev-parse", "HEAD")).stdout);
        // Changes > Workers lists the worktree, named for the agent working there.
        const listing = await api("/v1/git/worktrees", { target });
        expect(listing.status, JSON.stringify(listing.data)).toBe(200);
        expect(listing.data.worktrees.find((row: any) => row.path === ".claude/worktrees/phren-fix-login"))
          .toMatchObject({ branch: "phren/fix-login", ahead: 0, worker: { label: "wt", provider: "claude" } });
        // The branch exists now, and an existing branch is never reused.
        before = creates();
        const again = await launch("phren/fix-login");
        expect(again.status).toBe(409);
        expect(again.data.error).toContain('A branch named "phren/fix-login" already exists');
        const existing = await launch("main");
        expect(existing.status).toBe(409);
        expect(existing.data.error).toContain('"main" already exists');
        expect((await launch("bad..name")).status).toBe(400);
        expect(creates()).toBe(before);
      } finally { await rm(path.join(root, ".git"), { recursive: true, force: true }); await rm(path.join(root, ".claude"), { recursive: true, force: true }); }
    });

    it("serves a requested history page without sending a recent backlog", async () => {
      await writeFile(record, Array.from({ length: 450 }, (_, i) => JSON.stringify(row(`Message ${i}`))).join("\n") + "\n");
      // Opening a conversation is a light page: 60 rows, the newest ones;
      // history pages requested while scrolling are the fuller 200.
      const socket = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/transcripts?${new URLSearchParams(target)}`);
      const frames: any[] = []; socket.on("message", data => frames.push(JSON.parse(data.toString())));
      try {
        await once(socket, "open");
        await waitFor(() => frames.length, 800);
        expect(frames[0]).toMatchObject({ type: "backlog", startLine: 390, totalLines: 450, hasMore: true });
        expect(frames[0].entries).toHaveLength(60);
      } finally { socket.terminate(); }
      const page = await api("/v1/transcripts/history?" + new URLSearchParams({ ...target, beforeLine: "225" }));
      expect(page.status).toBe(200);
      expect(page.data).toMatchObject({ type: "older", session, startLine: 25, totalLines: 450, hasMore: true });
      expect(page.data.entries.map((e: any) => e.line)).toEqual(Array.from({ length: 200 }, (_, i) => i + 25));
      expect((await api("/v1/transcripts/history?" + new URLSearchParams({ ...target, beforeLine: "-1" }))).status).toBe(400);
      current = "bbbbbbbb-1111-4111-8111-111111111111";
      expect((await api("/v1/transcripts/history?" + new URLSearchParams({ ...target, beforeLine: "225" }))).status).toBe(409);
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
  });
});

describe("Hook module capabilities", () => {
  it("uses the same snapshot for typed capabilities and disabled routes", async () => {
    const { BUILTIN_MODULES } = await import("../modules/registry.js");
    const { capabilitiesForModules, requireRoute } = await import("./server.js");
    const names = ["memory", "hook", "schedules"];
    const snapshot = { store: "/store", profile: "work", generation: "test",
      modules: BUILTIN_MODULES.filter(module => names.includes(module.name)), has: (name: string) => names.includes(name) };
    const capabilities = capabilitiesForModules(snapshot);
    expect(capabilities.schedules).toBe(true);
    expect(capabilities.git).toBeUndefined();
    expect(capabilities.diff).toBeUndefined();
    expect(capabilities.dispatch).toBeUndefined();
    expect(capabilities.terminal).toBe("ssh-pty");
    expect(capabilities.webPreview).toBe("ssh-exec");
    expect(capabilities.providers).toEqual(["codex", "claude", "copilot", "opencode"]);
    expect(() => requireRoute(snapshot, "POST", "/v1/git/status")).toThrow("enable it with phren modules enable git");
    expect(() => requireRoute(snapshot, "POST", "/v1/dispatch")).toThrow("module conductor is disabled");
    expect(() => requireRoute(snapshot, "POST", "/v1/schedules")).not.toThrow();
  });

  it("gates the code routes and capability on the code module", async () => {
    const { BUILTIN_MODULES } = await import("../modules/registry.js");
    const { capabilitiesForModules, requireRoute } = await import("./server.js");
    const snapshot = (names: string[]) => ({ store: "/store", profile: "work", generation: "test",
      modules: BUILTIN_MODULES.filter(module => names.includes(module.name)), has: (name: string) => names.includes(name) });
    const on = snapshot(["memory", "code"]);
    expect(capabilitiesForModules(on).code).toBe(true);
    expect(() => requireRoute(on, "GET", "/v1/code/search")).not.toThrow();
    const off = snapshot(["memory"]);
    expect(capabilitiesForModules(off).code).toBeUndefined();
    expect(() => requireRoute(off, "GET", "/v1/code/search")).toThrow("run phren modules enable code");
  });

  it("starts the gateway snapshot despite an unknown module key in the store", async () => {
    const { activateModules } = await import("../modules/runtime.js");
    const { VERSION } = await import("../package-metadata.js");
    const store = await mkdtemp(path.join(tmpdir(), "phren-unknown-module-"));
    try {
      await mkdir(path.join(store, ".config"), { recursive: true });
      await writeFile(path.join(store, ".config", "modules.yaml"),
        "version: 1\nenabled:\n  hook: true\n  git: true\n  gateway-future: true\n");
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const snapshot = activateModules(store, undefined, true);
        expect(snapshot.has("hook")).toBe(true);
        expect(snapshot.has("git")).toBe(true);
        expect(snapshot.has("gateway-future")).toBe(false);
        expect(error.mock.calls.map(([line]) => String(line)))
          .toEqual([`warning: unknown module "gateway-future" in .config/modules.yaml ignored by Hook ${VERSION}`]);
      } finally { error.mockRestore(); }
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });
});

describe("failures keep their cause", () => {
  it("names the socket errno when Herdr cannot be reached", async () => {
    const errno = (code: string) => Object.assign(new Error(code), { code });
    expect(herdrSocketError(errno("ENOENT")).message).toBe("Herdr is not reachable on this computer (ENOENT: Herdr is not running).");
    expect(herdrSocketError(errno("ECONNREFUSED")).message).toContain("ECONNREFUSED: stale socket");
    expect(herdrSocketError(errno("EACCES")).message).toContain("EACCES: this user may not open");
    expect(herdrSocketError(new Error("odd")).message).toBe("Herdr is not reachable on this computer (unknown error).");
    const home = await mkdtemp(path.join(tmpdir(), "phren-herdr-missing-"));
    vi.stubEnv("PHREN_HERDR_HOME", home);
    try {
      const error = await rpc("default", "server.info").catch(caught => caught);
      expect(error.message).toContain("(ENOENT: Herdr is not running)");
      expect(error.message).not.toContain(home);
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
  });

  it("closes a stream with its own reason unless the conversation really changed", () => {
    const changed = new BridgeError(409, "This pane's conversation changed. Reopen the chat.");
    expect(streamCloseReason(changed)).toBe("The conversation changed; refresh");
    const io = Object.assign(new Error("EACCES: permission denied, open '/home/sam/.claude/projects/app/session.jsonl'"), { code: "EACCES" });
    expect(streamCloseReason(io)).toBe("Stream failed: EACCES: permission denied, open 'session.jsonl'");
    expect(streamCloseReason(new SyntaxError("Unexpected token } in JSON\n    at parse"))).toBe("Stream failed: Unexpected token } in JSON");
    expect(streamCloseReason(new BridgeError(503, "Herdr is not reachable on this computer (ECONNREFUSED: stale socket, Herdr is not listening)."))).toContain("ECONNREFUSED");
    expect(Buffer.byteLength(streamCloseReason(new Error("é".repeat(400))))).toBeLessThanOrEqual(123);
  });
});

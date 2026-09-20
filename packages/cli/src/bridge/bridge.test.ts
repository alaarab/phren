import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, open, readFile, realpath as realpathAsync, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer as createNetServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ApprovalWatchLeases } from "./agent-hooks.js";
import { capturesChanges, namedPaths, outputCallIds, ToolChanges } from "./changes.js";
import { workspaceSnapshot } from "./herdr.js";
import { planAgentHooks, upgradeKeys } from "./install.js";
import { locateProject } from "./locate.js";
import { repositoryBranch, repositoryDiff } from "./projects.js";
import { object } from "./protocol.js";
import { historicalImage, phrenStoreRoot, TranscriptReader, transcriptPath, visibleEvent } from "./transcripts.js";
import { dispatch } from "./transport.js";
import { enrollComputer, publicComputerKey } from "./computers.js";

const execFileAsync = promisify(execFile);
const session = "aaaaaaaa-1111-4111-8111-111111111111";
const hookBundle = path.resolve(process.env.PHREN_TEST_HOOK_BUNDLE || "packages/cli/dist/bridge-hook.mjs");
const target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "codex", session };
const row = (text: string) => ({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("Phren Hook boundaries", () => {
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
    const previousHome = process.env.HOME; process.env.HOME = home;
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
    } finally { process.env.HOME = previousHome; }
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
  let extraWorkspaces: Record<string, unknown>[] = [], extraTabs: Record<string, unknown>[] = [], extraPanes: Record<string, unknown>[] = [], failAgentStart = false;
  let helperPIDs: number[] = [];
  let remoteHook: ChildProcess | undefined;
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
  /** A GET whose body is bytes, not JSON. */
  function blob(url: string): Promise<{ status: number; bytes: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: path.join(root, "bridge/hook.sock"), path: url, method: "GET" }, res => {
        const chunks: Buffer[] = []; res.on("data", bytes => chunks.push(bytes)); res.on("end", () => resolve({ status: res.statusCode!, bytes: Buffer.concat(chunks) }));
      });
      req.on("error", reject); req.end();
    });
  }
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "phren-hook-"));
    // Darwin's Unix socket paths are limited to 104 bytes.
    root = await import("node:fs/promises").then(fs => fs.realpath(root));
    if (root.length > 55) {
      const short = await mkdtemp("/tmp/phren-hook-"); await rm(root, { recursive: true }); root = short;
    }
    commands = []; current = session; agentStatus = "working"; reportIdentity = true; foregroundPID = process.pid; terminalID = "term-one"; log = ""; holdSnapshot = false; releaseSnapshot = undefined;
    replaceBeforeMutation = false; deliveries = [];
    extraWorkspaces = []; extraTabs = []; extraPanes = []; failAgentStart = false; helperPIDs = []; remoteHook = undefined;
    await mkdir(path.join(root, "bin"));
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
        if (["agent.prompt", "agent.send_keys"].includes(req.method)) {
          // Herdr 0.8.2/protocol 20 and 0.9.0 resolve the current pane occupant.
          // Replace it at dispatch, after every possible snapshot preflight.
          // Unknown params cannot bind an expected session in that contract.
          if (replaceBeforeMutation) current = "bbbbbbbb-1111-4111-8111-111111111111";
          deliveries.push({ method: req.method, session: current });
        }
        // Herdr's create calls answer {ok} and the new workspace/tab/pane show
        // up in the next snapshot; agent.start marks the pane's agent.
        if (req.method === "workspace.create") {
          const wid = `w${9 + extraWorkspaces.length}`;
          extraWorkspaces.push({ workspace_id: wid, label: req.params.label });
          extraTabs.push({ tab_id: `${wid}:t1`, workspace_id: wid, label: "1" });
          extraPanes.push({ pane_id: `${wid}:p1`, tab_id: `${wid}:t1`, workspace_id: wid, terminal_id: `term-${wid}`, cwd: req.params.cwd });
        } else if (req.method === "tab.create") {
          const wid = req.params.workspace_id, n = extraTabs.filter(t => t.workspace_id === wid).length + 2;
          extraTabs.push({ tab_id: `${wid}:t${n}`, workspace_id: wid, label: req.params.label });
          extraPanes.push({ pane_id: `${wid}:p${n}`, tab_id: `${wid}:t${n}`, workspace_id: wid, terminal_id: `term-${wid}-${n}`, cwd: req.params.cwd });
        } else if (req.method === "agent.start") {
          const target = extraPanes.find(p => p.pane_id === req.params.pane_id);
          if (failAgentStart || !target) { socket.end(JSON.stringify({ id: req.id, error: { code: 1, message: "agent not detected" } }) + "\n"); return; }
          target.agent = req.params.kind; target.agent_status = "idle";
        }
        const pane = { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", terminal_id: terminalID, agent: "codex", agent_status: agentStatus,
          agent_session: reportIdentity ? { kind: "id", agent: "codex", value: current } : undefined, cwd: root };
        const snapshot = { panes: [pane, ...extraPanes], workspaces: [{ workspace_id: "w1", label: "Project" }, ...extraWorkspaces],
          tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1" }, ...extraTabs] };
        const answer = () => socket.end(JSON.stringify({ id: req.id, result: req.method === "session.snapshot" ? { snapshot }
          : req.method === "pane.process_info" ? { process_info: { foreground_processes: [{ pid: foregroundPID }, ...helperPIDs.map(pid => ({ pid }))] } } : { ok: true } }) + "\n");
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
      HOME: root, PHREN_BRIDGE_HOME: path.join(root, "bridge"), PHREN_HERDR_HOME: path.join(root, "herdr"), CODEX_HOME: path.join(root, "codex") }, stdio: ["ignore", "ignore", "pipe"] });
    hook.stderr!.on("data", bytes => log += bytes);
    let ready = false;
    for (let i = 0; i < 80; i++) { try { ready = (await api("/v1/health")).status === 200; } catch { /* startup */ } if (ready) break; await sleep(25); }
    expect(ready, log).toBe(true);
  });
  afterEach(async () => {
    releaseSnapshot?.();
    if (hook && hook.exitCode === null) { hook.kill("SIGTERM"); await once(hook, "exit"); }
    if (remoteHook && remoteHook.exitCode === null) { remoteHook.kill("SIGTERM"); await once(remoteHook, "exit"); }
    if (herdr) await new Promise<void>(resolve => herdr.close(() => resolve()));
    if (root) await rm(root, { recursive: true, force: true });
  });
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
    for (let i = 0; i < 80; i++) {
      if (await stat(path.join(remoteRoot, "hook.sock")).catch(() => undefined)) return;
      await sleep(25);
    }
    throw new Error(`Remote Hook did not start: ${log}`);
  }

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

  it("does not launch when the remote project is absent or the request is invalid", async () => {
    await dispatchFixture();
    const brief = { computer: "Linuxbox", project: "missing", harness: "codex", label: "Worker", prompt: "Brief" };
    expect((await api("/v1/dispatch", brief)).data).toMatchObject({ ok: false, state: "failed" });
    expect((await api("/v1/dispatch", { ...brief, project: "../phren" })).status).toBe(400);
    expect((await api("/v1/dispatch", { ...brief, cwd: root })).status).toBe(400);
    expect(commands.some(c => ["workspace.create", "agent.start", "agent.prompt"].includes(c.method))).toBe(false);
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
    const workspaces = await api("/v1/workspaces?mux=herdr:default");
    expect(workspaces.data.groups[0].children[0].id).toBe("w1:t1");
    expect((await api("/v1/workspaces/panes?groupId=w1&childId=w1:t1")).data.panes[0].sessionId).toBe(session);
    expect((await api("/v1/activity")).data.events[0].directory).toBe(root);
    const permissions = await import("node:fs/promises").then(fs => fs.stat(path.join(root, "bridge/hook.sock")));
    expect(permissions.mode & 0o777).toBe(0o600);
    expect(await stat(path.join(root, "bridge/changes/expired.jsonl")).catch(() => undefined)).toBeUndefined();
    expect((await stat(path.join(root, "bridge/computer-id"))).mode & 0o777).toBe(0o600);
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
    const launched = await api("/v1/schedules/run", { project: "demo", id: "7f3a2c1d" });
    expect(launched.status, JSON.stringify(launched.data)).toBe(200);
    expect(launched.data.run).toMatchObject({ scheduleId: "7f3a2c1d", project: "demo", status: "running",
      launch: { mode: "herdr" } });
    expect(commands.some(command => command.method === "agent.prompt" && command.params.text === "Run the test suite.")).toBe(true);
    expect((await api("/v1/schedules/run", { project: "demo", id: "7f3a2c1d" })).status).toBe(409);
    const history = await api("/v1/schedules/history", { project: "demo", id: "7f3a2c1d", limit: 10 });
    expect(history.status).toBe(200);
    expect(history.data.runs[0]).toMatchObject({ scheduleId: "7f3a2c1d", project: "demo" });
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
    expect(files.find((f: any) => f.path === ".env")).toMatchObject({ patch: "", redacted: true });
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
    expect(commands.find(c => c.method === "agent.start")?.params).toMatchObject({ name: "Codex here", pane_id: "w1:p2", timeout_ms: 3_000 });
  });
  it("reports a failed agent start without hiding the workspace it created", async () => {
    failAgentStart = true;
    const launched = await api("/v1/workspaces/launch?mux=herdr:default", { cwd: root, label: "broken", kind: "copilot" });
    expect(launched.status).toBe(409);
    expect(launched.data.error).toContain("couldn't start copilot");
    expect(launched.data.error).toContain("still open on the computer");
    expect(commands.some(c => c.method === "workspace.create")).toBe(true);
  });
  it("rejects a relative directory or an unknown agent kind before touching Herdr", async () => {
    expect((await api("/v1/workspaces/launch?mux=herdr:default", { cwd: "relative/path", label: "x", kind: "codex" })).status).toBe(400);
    expect((await api("/v1/workspaces/launch?mux=herdr:default", { cwd: root, label: "x", kind: "gemini" })).status).toBe(400);
    expect((await api("/v1/workspaces/launch?mux=herdr:default", { cwd: root, label: "", kind: "codex" })).status).toBe(400);
    expect(commands.some(c => c.method === "workspace.create" || c.method === "agent.start")).toBe(false);
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
      expect(await discover()).toBeUndefined();
      const binding = { terminal: "term-one", source: "codex", session, pids: [process.pid] };
      const folder = path.join(root, "bridge/bindings/default");
      await mkdir(folder, { recursive: true });
      const bind = (value: typeof binding) => writeFile(path.join(folder, "w1%3Ap1.json"), JSON.stringify(value));
      for (const wrong of [
        { ...binding, terminal: "replaced-terminal" },
        { ...binding, source: "claude" },
        { ...binding, pids: [] },
        { ...binding, session: "cccccccc-1111-4111-8111-111111111111" },
      ]) {
        await bind(wrong);
        expect(await discover()).toBeUndefined();
      }
      await bind(binding);
      await sleep(2100);
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
      await sleep(2100);
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
      for (let i = 0; i < 80 && !frames.length; i++) await sleep(25);
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
    const callback = JSON.stringify({ target, event: "PermissionRequest", tool: "Shell", input: { command: "xcrun simctl list runtimes", justification: "Inspect the runtimes" } });
    const reply = await new Promise<string>((resolve, reject) => {
      const req = request({ socketPath: path.join(root, "bridge/agent.sock"), path: "/hook", method: "POST", headers: { "Content-Length": Buffer.byteLength(callback) } },
        res => { let data = ""; res.on("data", bytes => data += bytes); res.on("end", () => resolve(data)); });
      req.on("error", reject); req.end(callback);
    });
    expect(reply).toBe("{}");
    const socket = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/status?${new URLSearchParams(target)}`);
    const frames: any[] = []; socket.on("message", data => frames.push(JSON.parse(data.toString())));
    await once(socket, "open");
    for (let i = 0; i < 80 && !frames.length; i++) await sleep(25);
    expect(frames[0].agentStatus).toMatchObject({ status: "blocked", terminalPrompt: { toolName: "Shell" } });
    expect(frames[0].agentStatus.terminalPrompt.message).toContain("xcrun simctl list runtimes");
    socket.terminate();
    // Answering with a key clears it; moving through the menu does not.
    expect((await api("/v1/keys", { target, keys: ["Down"] })).status).toBe(200);
    const again = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/status?${new URLSearchParams(target)}`);
    const later: any[] = []; again.on("message", data => later.push(JSON.parse(data.toString())));
    await once(again, "open");
    for (let i = 0; i < 80 && !later.length; i++) await sleep(25);
    expect(later[0].agentStatus.terminalPrompt).toMatchObject({ toolName: "Shell" });
    again.terminate();
    expect((await api("/v1/keys", { target, keys: ["y"] })).status).toBe(200);
    const cleared = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/status?${new URLSearchParams(target)}`);
    const last: any[] = []; cleared.on("message", data => last.push(JSON.parse(data.toString())));
    await once(cleared, "open");
    for (let i = 0; i < 80 && !last.length; i++) await sleep(25);
    expect(last[0].agentStatus.terminalPrompt).toBeUndefined();
    cleared.terminate();
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
    expect((await api("/v1/keys", { target, keys: ["Enter"] })).status).toBe(200);
    // Enter closed the menu; the pane is an idle agent again.
    expect((await api("/v1/keys", { target, keys: ["Down"] })).status).toBe(409);
    // A prompt with words is a message, not a menu.
    expect((await api("/v1/prompt", { target, text: "/model gpt-5.6-terra" })).status).toBe(200);
    expect((await api("/v1/keys", { target, keys: ["Enter"] })).status).toBe(409);
  });
  it("lists the models a computer's agents offer", async () => {
    const claude = await api("/v1/models?source=claude");
    expect(claude.status).toBe(200);
    expect(claude.data.models.map((m: any) => m.id)).toEqual(expect.arrayContaining(["fable", "opus", "sonnet", "haiku"]));
    // OpenCode's list comes from its own binary: every id names its provider,
    // and a computer without opencode simply offers nothing.
    const opencode = (await api("/v1/models?source=opencode")).data.models;
    expect(opencode.every((m: any) => /^[^/]+\/.+/.test(m.id) && typeof m.name === "string")).toBe(true);
    expect((await api("/v1/models?source=../etc")).data).toEqual({ models: [] });
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
  it("enforces launch directory checks and one shared rate limit across create and launch", async () => {
    for (const route of ["create", "launch"]) {
      const rejected = await api(`/v1/workspaces/${route}`, { cwd: "/etc", label: "x", kind: "codex" });
      expect(rejected.status).toBe(403);
    }
    holdSnapshot = true;
    const first = api("/v1/workspaces/create", { cwd: root, label: "x" });
    for (let i = 0; i < 100 && !releaseSnapshot; i++) await sleep(10);
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
  it("resumes a disconnected transcript after the phone's last line", async () => {
    const query = new URLSearchParams(target).toString();
    const first = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/transcripts?${query}`);
    const opening: any[] = []; first.on("message", data => opening.push(JSON.parse(data.toString())));
    await once(first, "open");
    for (let i = 0; i < 60 && !opening.length; i++) await sleep(25);
    expect(opening[0]).toMatchObject({ type: "backlog", totalLines: 2 });
    const disconnected = once(first, "close"); first.terminate(); await disconnected;

    await appendFile(record, JSON.stringify(row("While disconnected 1")) + "\n" + JSON.stringify(row("While disconnected 2")) + "\n");
    const resumed = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/transcripts?${new URLSearchParams({ ...target, afterLine: String(opening[0].totalLines - 1) })}`);
    const frames: any[] = []; resumed.on("message", data => frames.push(JSON.parse(data.toString())));
    try {
      await once(resumed, "open");
      for (let i = 0; i < 60 && !frames.length; i++) await sleep(25);
      expect(frames[0]).toMatchObject({ type: "backlog", totalLines: 4 });
      expect(frames[0].entries.map((entry: any) => entry.line)).toEqual([2, 3]);
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
    for (let i = 0; i < 60 && !frames.length; i++) await sleep(25);
    expect(frames[0]).toMatchObject({ type: "backlog", entries: [], totalLines: 0, session });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    await writeFile(record, JSON.stringify({ type: "session_meta", payload: { id: session } }) + "\n" + JSON.stringify(row("First message")) + "\n");
    for (let i = 0; i < 160 && frames.length < 2; i++) await sleep(25);
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
      for (let i = 0; i < 80 && !frames.length; i++) await sleep(25);
      // The opening page is the child's recent rows, named by the public id.
      expect(frames[0]).toMatchObject({ type: "backlog", source: "codex", session: id, hasMore: true });
      expect(frames[0].entries).toHaveLength(60);
      expect(JSON.stringify(frames[0])).toContain("Child step 69");
      expect(JSON.stringify(frames[0])).not.toContain(child);
      await appendFile(childFile, JSON.stringify(row("Child step 70")) + "\n");
      for (let i = 0; i < 80 && frames.length < 2; i++) await sleep(25);
      expect(frames[1]).toMatchObject({ type: "append", session: id });
      expect(JSON.stringify(frames[1])).toContain("Child step 70"); expect(JSON.stringify(frames[1])).not.toContain("Child step 69");
      socket.send(JSON.stringify({ type: "older", beforeLine: frames[0].startLine }));
      for (let i = 0; i < 80 && !frames.some(f => f.type === "older"); i++) await sleep(25);
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
      for (let i = 0; i < 80 && !frames.length; i++) await sleep(10);
      expect(frames[0].type).toBe("backlog");
      holdSnapshot = true;
      for (let i = 0; i < 150 && !releaseSnapshot; i++) await sleep(10);
      expect(releaseSnapshot).toBeDefined();
      socket.send(JSON.stringify({ type: "older", beforeLine: 1 }));
      await sleep(30); releaseSnapshot!(); releaseSnapshot = undefined;
      for (let i = 0; i < 80 && !frames.some(f => f.type === "older"); i++) await sleep(10);
      expect(frames.find(f => f.type === "older")).toMatchObject({ entries: [], startLine: 0, hasMore: false });
    } finally { socket.terminate(); }
  });
  it("serves a requested history page without sending a recent backlog", async () => {
    await writeFile(record, Array.from({ length: 450 }, (_, i) => JSON.stringify(row(`Message ${i}`))).join("\n") + "\n");
    // Opening a conversation is a light page: 60 rows, the newest ones;
    // history pages requested while scrolling are the fuller 200.
    const socket = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/transcripts?${new URLSearchParams(target)}`);
    const frames: any[] = []; socket.on("message", data => frames.push(JSON.parse(data.toString())));
    try {
      await once(socket, "open");
      for (let i = 0; i < 80 && !frames.length; i++) await sleep(10);
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
    expect(Date.parse(approval?.expiresAt)).toBeGreaterThan(Date.now());
    const wrong = await api("/v1/approvals/answer", { target: { ...target, session: "bbbbbbbb-1111-4111-8111-111111111111" }, actionId: approval.actionId, decision: "approve" });
    expect(wrong.status).toBe(409);
    expect((await api("/v1/approvals/answer", { target, actionId: approval.actionId, decision: "deny" })).status).toBe(200);
    expect((await reply).hookSpecificOutput.decision.behavior).toBe("deny");
    expect((await api("/v1/approvals/answer", { target, actionId: approval.actionId, decision: "approve" })).status).toBe(409);
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
    for (let i = 0; i < 60 && !frames.length; i++) await sleep(25);
    const callback = (tool: string, input: unknown) => new Promise<any>((resolve, reject) => {
      const payload = JSON.stringify({ target, event: "PermissionRequest", tool, input });
      const req = request({ socketPath: path.join(root, "bridge/agent.sock"), path: "/hook", method: "POST",
        headers: { "Content-Length": Buffer.byteLength(payload) } }, res => {
        let data = ""; res.on("data", bytes => data += bytes); res.on("end", () => resolve(JSON.parse(data)));
      }); req.on("error", reject); req.end(payload);
    });
    const pendingApproval = async (after: number) => {
      for (let i = 0; i < 100 && !frames.slice(after).some(f => f.agentStatus.pendingApproval); i++) await sleep(25);
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
    for (let i = 0; i < 60 && !pending; i++) {
      await sleep(25);
      pending = (await api("/v1/workspaces")).data.groups.some((g: any) => g.children.some((t: any) => t.approvalPending));
    }
    expect(pending).toBe(true);
    const socket = new WebSocket(`ws+unix:${root}/bridge/hook.sock:/v1/status?${new URLSearchParams(target)}`);
    const frames: any[] = []; socket.on("message", bytes => frames.push(JSON.parse(bytes.toString())));
    await once(socket, "open");
    for (let i = 0; i < 60 && !frames.some(f => f.agentStatus.pendingApproval); i++) await sleep(25);
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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer as createNetServer, type Server } from "node:net";
import { request } from "node:http";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm, chmod, symlink, open, realpath as realpathAsync } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { planAgentHooks, upgradeKeys } from "./install.js";
import { TranscriptReader, transcriptPath, visibleEvent, historicalImage, phrenStoreRoot } from "./transcripts.js";
import { dispatch } from "./transport.js";
import { workspaceSnapshot } from "./herdr.js";
import { repositoryBranch, repositoryDiff } from "./projects.js";
import { locateProject } from "./locate.js";
import { ToolChanges, namedPaths, outputCallIds } from "./changes.js";
import { ApprovalWatchLeases } from "./agent-hooks.js";
import { object } from "./protocol.js";

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
      const diff = await repositoryDiff(project, ["~/.phren/app", path.join(project, "b.txt"), "/etc/hosts", "../missing/file", 42]) as {
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
  let reportIdentity = true;
  let holdSnapshot = false, releaseSnapshot: (() => void) | undefined;
  let replaceBeforeMutation = false;
  let deliveries: { method: string; session: string }[];
  let extraWorkspaces: Record<string, unknown>[] = [], extraTabs: Record<string, unknown>[] = [], extraPanes: Record<string, unknown>[] = [], failAgentStart = false;
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
    commands = []; current = session; reportIdentity = true; log = ""; holdSnapshot = false; releaseSnapshot = undefined;
    replaceBeforeMutation = false; deliveries = [];
    extraWorkspaces = []; extraTabs = []; extraPanes = []; failAgentStart = false;
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
        const pane = { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", terminal_id: "term-one", agent: "codex", agent_status: "working",
          agent_session: reportIdentity ? { kind: "id", agent: "codex", value: current } : undefined, cwd: root };
        const snapshot = { panes: [pane, ...extraPanes], workspaces: [{ workspace_id: "w1", label: "Project" }, ...extraWorkspaces],
          tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1" }, ...extraTabs] };
        const answer = () => socket.end(JSON.stringify({ id: req.id, result: req.method === "session.snapshot" ? { snapshot }
          : req.method === "pane.process_info" ? { process_info: { foreground_processes: [{ pid: process.pid }] } } : { ok: true } }) + "\n");
        if (holdSnapshot && req.method === "session.snapshot") { holdSnapshot = false; releaseSnapshot = answer; }
        else answer();
      });
    });
    await new Promise<void>(resolve => herdr.listen(path.join(root, "herdr/herdr.sock"), resolve));
    hook = spawn(process.execPath, [hookBundle, "serve"], { env: { ...process.env,
      PHREN_BRIDGE_HOME: path.join(root, "bridge"), PHREN_HERDR_HOME: path.join(root, "herdr"), CODEX_HOME: path.join(root, "codex") }, stdio: ["ignore", "ignore", "pipe"] });
    hook.stderr!.on("data", bytes => log += bytes);
    let ready = false;
    for (let i = 0; i < 80; i++) { try { ready = (await api("/v1/health")).status === 200; } catch { /* startup */ } if (ready) break; await sleep(25); }
    expect(ready, log).toBe(true);
  });
  afterEach(async () => {
    releaseSnapshot?.();
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
  it("launches a workspace in a directory with an agent started in its pane", async () => {
    const launched = await api("/v1/workspaces/launch?mux=herdr:default", { cwd: root, label: "phren", kind: "claude" });
    expect(launched.status, JSON.stringify(launched.data)).toBe(200);
    expect(launched.data).toMatchObject({ ok: true, workspaceId: "w9", tabId: "w9:t1", paneId: "w9:p1", agent: "claude", agentStatus: "idle" });
    expect(commands.find(c => c.method === "workspace.create")?.params).toMatchObject({ label: "phren", cwd: root, focus: false });
    expect(commands.find(c => c.method === "agent.start")?.params).toMatchObject({ name: "phren", kind: "claude", pane_id: "w9:p1", timeout_ms: 45_000 });
    // The new pane is now a chat target the overview can see.
    const overview = await api("/v1/workspaces?mux=herdr:default");
    expect(overview.data.groups.some((g: any) => g.id === "w9" && g.children[0].agent === "claude")).toBe(true);
  });
  it("launches a tab inside an existing workspace when asked", async () => {
    const launched = await api("/v1/workspaces/launch?mux=herdr:default", { cwd: root, label: "second", kind: "codex", workspaceId: "w1", name: "Codex here", timeoutMs: 1 });
    expect(launched.status, JSON.stringify(launched.data)).toBe(200);
    expect(launched.data).toMatchObject({ workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", agent: "codex" });
    expect(commands.find(c => c.method === "tab.create")?.params).toMatchObject({ workspace_id: "w1", label: "second", cwd: root });
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
  // Known failure, task d78a0916: this requires an atomic Herdr contract.
  // Keep the desired rejection assertion executable; an unexpected pass fails
  // the suite so that it can become a normal regression once support exists.
  it.fails.each([
    ["prompt", "/v1/prompt", { text: "must stay in the original conversation" }],
    ["stop", "/v1/keys", { keys: ["Escape"] }],
  ] as const)("rejects %s if the conversation is replaced between validation and dispatch (Herdr limitation)", async (_operation, route, payload) => {
    replaceBeforeMutation = true;
    const result = await api(route, { target, ...payload });
    expect({ status: result.status, deliveries }).toEqual({ status: 409, deliveries: [] });
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
      expect(JSON.parse(changes[0].after).hooks.PreToolUse[0]).toMatchObject({ matcher: "Bash", hooks: [{ timeout: 10 }] });
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

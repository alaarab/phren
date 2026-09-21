import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ARCHIVE_MAX_FOLDERS, archiveFinishedFanouts, fanoutChildren, visibleCodexExecEvent, visibleOpenCodeRunEvent } from "./fanouts.js";
import type { ChangedFile } from "./changes.js";
import { object, objects } from "./protocol.js";

const parent = "aaaaaaaa-1111-4111-8111-111111111111";
const execFileAsync = promisify(execFile);
let roots: string[] = [];

function objectPayload(event: unknown): Record<string, unknown> {
  return (event as { payload: Record<string, unknown> }).payload;
}

async function fixture(id: string, overrides: Record<string, unknown> = {}, events = '{"type":"text"}\n') {
  const root = await mkdtemp(path.join(tmpdir(), "phren-fanouts-")); roots.push(root);
  const directory = path.join(root, ".runtime/agent-fanouts", id); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "events.jsonl"), events);
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id, parent: { provider: "codex", session: parent }, provider: "opencode",
    taskLabel: "Review bridge", cwd: "/repo", worktree: "/repo-wt", model: "openrouter/deepseek/deepseek-v4.1-flash",
    eventLog: "events.jsonl", createdAt: "2026-09-19T19:00:00.000Z", startedAt: "2026-09-19T19:00:01.000Z",
    updatedAt: "2026-09-19T19:00:02.000Z", status: "running", ...overrides,
  }));
  return { root, directory, env: { PHREN_PATH: root } };
}

/** A Codex CLI fan-out manifest; `session` is the optional Codex thread UUID. */
function codexFixture(id: string, session?: string, overrides: Record<string, unknown> = {}) {
  return fixture(id, { provider: "codex", model: "gpt-5-codex", ...(session ? { session } : {}), ...overrides },
    '{"type":"thread.started","thread_id":"cccccccc-3333-4333-8333-333333333333"}\n');
}

const HOUR_MS = 60 * 60 * 1000;

/** One job folder inside an existing store root. `manifest: null` writes no
 * manifest at all; `exit: false` leaves out the launcher's exit stamp. */
async function archiveJob(root: string, id: string,
  options: { manifest?: Record<string, unknown> | null; exit?: boolean; exitAgeMs?: number } = {}) {
  const directory = path.join(root, ".runtime/agent-fanouts", id);
  await mkdir(directory, { recursive: true });
  if (options.manifest !== null) {
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({
      schemaVersion: 1, id, parent: { provider: "codex", session: parent }, provider: "opencode",
      taskLabel: "Review bridge", cwd: "/repo", worktree: "/repo-wt", eventLog: "events.jsonl",
      createdAt: "2026-09-19T19:00:00.000Z", startedAt: "2026-09-19T19:00:01.000Z",
      updatedAt: "2026-09-19T19:00:02.000Z", status: "running", ...(options.manifest ?? {}),
    }));
  }
  if (options.exit !== false) {
    await writeFile(path.join(directory, "exit.txt"), "0\n");
    if (options.exitAgeMs !== undefined) {
      const stamp = new Date(Date.now() - options.exitAgeMs);
      await utimes(path.join(directory, "exit.txt"), stamp, stamp);
    }
  }
  return directory;
}

async function present(target: string): Promise<boolean> {
  return Boolean(await stat(target).catch(() => undefined));
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("fan-out manifests", () => {
  it("returns only jobs bound to the validated parent and hides local metadata", async () => {
    const { env } = await fixture("job-1");
    const found = await fanoutChildren("codex", parent, env);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ provider: "opencode", path: "Review bridge", state: "running", children: [] });
    expect(found[0].id).toMatch(/^[a-f0-9]{32}$/);
    expect(found[0].cwd).toBe("/repo-wt");
    expect(found[0].worktreeName).toBeUndefined();
    expect(found[0].branch).toBeUndefined();
    expect(JSON.stringify({ ...found[0], transcript: undefined, session: undefined, cwd: undefined })).not.toContain("/repo");
    expect(await fanoutChildren("codex", "bbbbbbbb-2222-4222-8222-222222222222", env)).toEqual([]);
  });

  it("accepts legacy parents and scopes a new computer-bound parent when supplied", async () => {
    const computer = "11111111-1111-4111-8111-111111111111";
    const legacy = await fixture("job-legacy");
    expect(await fanoutChildren("codex", parent, legacy.env, computer)).toHaveLength(1);

    const remote = await fixture("job-remote", { parent: { provider: "codex", session: parent, computer } });
    expect(await fanoutChildren("codex", parent, remote.env, computer)).toHaveLength(1);
    expect(await fanoutChildren("codex", parent, remote.env, "22222222-2222-4222-8222-222222222222")).toEqual([]);

    const unknown = await fixture("job-unknown-parent", { parent: { provider: "codex", session: parent, computer, path: "/home/sam/private" } });
    expect(await fanoutChildren("codex", parent, unknown.env, computer)).toEqual([]);
  });

  it("labels an existing worktree without exposing its path", async () => {
    const worktree = await mkdtemp(path.join(tmpdir(), "phren-worker-repo-")); roots.push(worktree);
    await execFileAsync("git", ["-C", worktree, "init", "-q"]);
    await writeFile(path.join(worktree, "tracked.txt"), "tracked\n");
    await execFileAsync("git", ["-C", worktree, "add", "tracked.txt"]);
    await execFileAsync("git", ["-C", worktree, "-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-qm", "start"]);
    await execFileAsync("git", ["-C", worktree, "checkout", "-q", "-b", "codex/example"]);
    const { env } = await fixture("job-worktree", { worktree });
    const found = await fanoutChildren("codex", parent, env);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ worktreeName: path.basename(worktree), branch: "codex/example" });
    expect(JSON.stringify({ ...found[0], cwd: undefined, transcript: undefined })).not.toContain(worktree);
  });

  it("reports a blocked worker as failed with the reason even when exit.txt says 0", async () => {
    const { directory, env } = await fixture("job-blocked", { status: "completed", exitCode: 0 });
    await writeFile(path.join(directory, "exit.txt"), "0\n");
    await writeFile(path.join(directory, "blocked.json"), JSON.stringify({ type: "external_directory",
      pattern: "/private/tmp/elsewhere", message: "external_directory: /private/tmp/elsewhere", at: "2026-09-19T19:00:03.000Z" }));
    const found = await fanoutChildren("codex", parent, env);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ state: "failed", reason: "blocked: external_directory /private/tmp/elsewhere" });
  });

  it("rejects event-log symlinks and mismatched directory IDs", async () => {
    const first = await fixture("job-link");
    const outside = path.join(first.root, "outside.jsonl"); await writeFile(outside, "secret");
    await rm(path.join(first.directory, "events.jsonl")); await symlink(outside, path.join(first.directory, "events.jsonl"));
    expect(await fanoutChildren("codex", parent, first.env)).toEqual([]);
    const second = await fixture("job-name", { id: "different" });
    expect(await fanoutChildren("codex", parent, second.env)).toEqual([]);
  });

  it("returns Codex fan-outs and enforces provider-matching sessions", async () => {
    const thread = "cccccccc-3333-4333-8333-333333333333";
    const bound = await codexFixture("job-codex", thread);
    const found = await fanoutChildren("codex", parent, bound.env);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ provider: "codex", session: thread, path: "Review bridge", state: "running", model: "gpt-5-codex" });

    const mismatched = await codexFixture("job-codex-bad", "ses_abc");
    expect(await fanoutChildren("codex", parent, mismatched.env)).toEqual([]);

    const crossProvider = await fixture("job-open-bad", { session: thread });
    expect(await fanoutChildren("codex", parent, crossProvider.env)).toEqual([]);
  });

  it("exports OpenCode commands, URLs, paths and output tails, never reasoning, other arguments, costs or snapshots", () => {
    const secret = "sk-secret", home = homedir();
    expect(visibleOpenCodeRunEvent({ type: "text", timestamp: 1_789_845_268_396, part: { type: "text", text: "Visible", reasoning: secret } }))
      .toMatchObject({ type: "assistant/message", data: { message: { content: [{ text: "Visible" }] } } });
    const tool = visibleOpenCodeRunEvent({ type: "tool_use", part: { type: "tool", tool: "bash", callID: "call-1",
      state: { status: "completed", input: { command: `ls ${home}/repo`, token: secret }, output: "a.txt\n", metadata: { exit: 0, cost: secret } }, snapshot: secret } });
    expect(tool).toMatchObject({ data: { message: { content: [
      { type: "tool_use", id: "call-1", name: "bash", input: { command: "ls ~/repo" }, phrenStatus: "completed" },
      { type: "tool_result", tool_use_id: "call-1", content: "a.txt\n[exit 0]" },
    ] } } });
    expect(JSON.stringify(tool)).not.toContain(secret);
    const write = visibleOpenCodeRunEvent({ type: "tool_use", part: { type: "tool", tool: "write", callID: "call-2",
      state: { status: "completed", input: { filePath: `${home}/repo/notes.md`, content: "notes" }, output: "Wrote file", metadata: { cost: secret } } } });
    expect(write).toMatchObject({ data: { message: { content: [{ name: "write", input: { path: "~/repo/notes.md", content: "notes" } }, { content: "Wrote file" }] } } });
    expect(JSON.stringify(write)).not.toContain(secret);
    const fetch = visibleOpenCodeRunEvent({ type: "tool_use", part: { type: "tool", tool: "webfetch", callID: "call-3",
      state: { status: "error", input: { url: "https://example.org/page", format: "markdown" }, error: "timed out" } } });
    expect(fetch).toMatchObject({ data: { message: { content: [{ name: "webfetch", input: { url: "https://example.org/page" } }, { content: "timed out", is_error: true }] } } });
    const running = visibleOpenCodeRunEvent({ type: "tool_use", part: { type: "tool", tool: "bash", callID: "call-4", state: { status: "running", input: { command: "sleep 1" } } } });
    expect(objects(object(object(object(running).data).message).content)).toHaveLength(1);
    expect(visibleOpenCodeRunEvent({ type: "step_start", part: { reasoning: secret } })).toBeUndefined();
  });

  it("keeps MCP tool inputs and draws changed-file diffs for edit, write and patch", () => {
    const inputOf = (event: unknown) => (event as { data: { message: { content: Array<{ input?: Record<string, unknown> }> } } })
      .data.message.content[0].input ?? {};

    const mcp = visibleOpenCodeRunEvent({ type: "tool_use", part: { type: "tool", tool: "phren_get_tasks", callID: "m1",
      state: { status: "completed", input: { project: "phren", limit: 20 }, output: "[]" } } });
    expect(inputOf(mcp)).toEqual({ project: "phren", limit: 20 });

    const long = "x".repeat(10_000);
    const truncated = visibleOpenCodeRunEvent({ type: "tool_use", part: { type: "tool", tool: "phren_add_finding", callID: "m2",
      state: { status: "completed", input: { finding: [long] }, output: "ok" } } });
    const finding = (inputOf(truncated).finding as string[])[0];
    expect(finding).toHaveLength(4_001);
    expect(finding).toBe(`${long.slice(0, 4_000)}…`);

    const diff = "@@ -1,2 +1,2 @@\n-old\n+new\n context\n";
    const edit = visibleOpenCodeRunEvent({ type: "tool_use", part: { type: "tool", tool: "edit", callID: "e1",
      state: { status: "completed", input: { filePath: "/repo/src/a.ts", oldString: "old", newString: "new" },
        metadata: { diff, filediff: { file: "/repo/src/a.ts", patch: diff, additions: 1, deletions: 1 } } } } });
    expect((edit as { phren_changes: Record<string, ChangedFile[]> }).phren_changes).toEqual({ e1: [
      { root: "", path: "/repo/src/a.ts", status: "M", patch: diff, added: 1, removed: 1 },
    ] });

    const relative = visibleOpenCodeRunEvent({ type: "tool_use", part: { type: "tool", tool: "edit", callID: "e2",
      state: { status: "completed", input: { filePath: "/repo/src/a.ts" }, metadata: { diff } } } }, "/repo");
    expect((relative as { phren_changes: Record<string, ChangedFile[]> }).phren_changes.e2[0])
      .toMatchObject({ path: `src${path.sep}a.ts` });

    const write = visibleOpenCodeRunEvent({ type: "tool_use", part: { type: "tool", tool: "write", callID: "w1",
      state: { status: "completed", input: { filePath: "/repo/src/b.ts", content: "one\ntwo\n" },
        metadata: { filepath: "/repo/src/b.ts", exists: false } } } });
    const added = (write as { phren_changes: Record<string, ChangedFile[]> }).phren_changes.w1[0];
    expect(added).toMatchObject({ path: "/repo/src/b.ts", status: "A", added: 2, removed: 0 });
    expect(added.patch).toContain("+one\n+two");

    const patched = visibleOpenCodeRunEvent({ type: "tool_use", part: { type: "tool", tool: "patch", callID: "p1",
      state: { status: "completed", input: { patch: "--- a/src/c.ts\n+++ b/src/c.ts\n@@ -1 +1 @@\n-x\n+y\n" } } } });
    expect((patched as { phren_changes: Record<string, ChangedFile[]> }).phren_changes.p1[0])
      .toMatchObject({ path: "src/c.ts", status: "M", added: 1, removed: 1 });

    const bash = visibleOpenCodeRunEvent({ type: "tool_use", part: { type: "tool", tool: "bash", callID: "b1",
      state: { status: "completed", input: { command: "ls" }, output: "a\n" } } });
    expect(bash).not.toHaveProperty("phren_changes");
  });

  it("exports Codex exec commands, output tails, and changed paths", () => {
    const home = homedir(), homePath = path.join(home, ".ssh", "id_rsa");
    const command = "cat ~/.ssh/id_rsa";
    const translated = [
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "Visible" } },
      { type: "item.started", item: { id: "item_1", type: "command_execution", command, status: "in_progress" } },
      { type: "item.completed", item: { id: "item_1", type: "command_execution", command, aggregated_output: "some output", exit_code: 0, status: "completed" } },
      { type: "item.started", item: { id: "item_9", type: "file_change", changes: [{ path: homePath, kind: "update" }], status: "in_progress" } },
      { type: "item.completed", item: { id: "item_9", type: "file_change", changes: [{ path: homePath, kind: "update" }], status: "completed" } },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } },
      { type: "error", message: "boom" },
    ].map(visibleCodexExecEvent);
    expect(translated[0]).toMatchObject({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Visible" }] } });
    expect(translated[1]).toMatchObject({ type: "response_item", payload: { type: "function_call", name: "shell", call_id: "item_1", arguments: JSON.stringify({ command }) } });
    expect(translated[2]).toMatchObject({ type: "response_item", payload: { type: "function_call_output", call_id: "item_1", output: "some output\n[exit 0]" } });
    expect(translated[3]).toMatchObject({ type: "response_item", payload: { type: "function_call", name: "apply_patch", call_id: "item_9",
      arguments: JSON.stringify({ files: [{ path: `~${path.sep}.ssh${path.sep}id_rsa`, kind: "update" }] }) } });
    expect(translated[4]).toMatchObject({ type: "response_item", payload: { type: "function_call_output", call_id: "item_9",
      output: `1 file(s) changed\n~${path.sep}.ssh${path.sep}id_rsa` } });
    expect(translated[5]).toMatchObject({ type: "event_msg", payload: { type: "task_complete" } });
    expect(translated[6]).toMatchObject({ type: "event_msg", payload: { type: "error", message: "boom" } });

    const oversizeCommand = "x".repeat(3_000);
    const commandCall = visibleCodexExecEvent({ type: "item.started", item: { id: "long", type: "command_execution", command: oversizeCommand } });
    const parsedArguments = JSON.parse(String(objectPayload(commandCall).arguments));
    expect(parsedArguments.command).toHaveLength(2_000);
    expect(parsedArguments.command).toBe(oversizeCommand.slice(0, 2_000));

    const oversizeOutput = "0123456789".repeat(500);
    const outputRow = visibleCodexExecEvent({ type: "item.completed", item: { id: "long", type: "command_execution", aggregated_output: oversizeOutput } });
    const output = String(objectPayload(outputRow).output);
    expect(output).toBe(`${oversizeOutput.slice(-4_000)}\n[finished]`);
    expect(output.startsWith(oversizeOutput.slice(-4_000))).toBe(true);
    expect(output).toContain(oversizeOutput.slice(-1));

    const many = Array.from({ length: 60 }, (_, index) => ({ path: path.join(home, `file-${index}.ts`), kind: "add" }));
    const patchStart = visibleCodexExecEvent({ type: "item.started", item: { id: "many", type: "file_change", changes: many } });
    const files = JSON.parse(String(objectPayload(patchStart).arguments)).files;
    expect(files).toHaveLength(50);
    expect(files[0]).toEqual({ path: `~${path.sep}file-0.ts`, kind: "add" });
    const patchDone = visibleCodexExecEvent({ type: "item.completed", item: { id: "many", type: "file_change", changes: many } });
    const patchOutput = String(objectPayload(patchDone).output);
    expect(patchOutput.split("\n")).toHaveLength(51);
    expect(patchOutput.startsWith("50 file(s) changed\n")).toBe(true);
    expect(patchOutput).toContain(`~${path.sep}file-49.ts`);
    expect(patchOutput).not.toContain("file-50.ts");
  });

  it("bounds MCP inputs by UTF-8 bytes and never invents an overwrite diff", () => {
    const event = (tool: string, input: Record<string, unknown>, metadata = {}) => visibleOpenCodeRunEvent({
      type: "tool_use", part: { type: "tool", tool, callID: "call", state: { status: "completed", input, metadata } },
    });
    const mcp = event("phren_add_finding", { finding: "界".repeat(8_000) });
    const input = objects(object(object(object(mcp).data).message).content)[0].input;
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(8_192);
    expect(event("write", { path: "a.ts", content: "new" }, { exists: true })).not.toHaveProperty("phren_changes");
    const newline = event("write", { path: "a.ts", content: "\n" }, { exists: false });
    expect(object(newline).phren_changes).toMatchObject({ call: [{ added: 1, removed: 0 }] });
  });

  it("keeps multi-file patches separate and names a deleted file from its old header", () => {
    const patch = "--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n"
      + "--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+new\n";
    const event = visibleOpenCodeRunEvent({ type: "tool_use", part: { type: "tool", tool: "patch", callID: "call",
      state: { status: "completed", input: { patch } } } });
    expect(object(event).phren_changes).toMatchObject({ call: [
      { path: "old.ts", status: "D", added: 0, removed: 1 },
      { path: "new.ts", status: "A", added: 1, removed: 0 },
    ] });
  });

  it("ignores private or unknown Codex exec rows", () => {
    expect(visibleCodexExecEvent({ type: "thread.started", thread_id: "cccccccc-3333-4333-8333-333333333333" })).toBeUndefined();
    expect(visibleCodexExecEvent({ type: "turn.started" })).toBeUndefined();
    expect(visibleCodexExecEvent({ type: "item.started", item: { id: "item_0", type: "agent_message", text: "partial" } })).toBeUndefined();
    expect(visibleCodexExecEvent({ type: "item.started", item: { id: "item_5", type: "reasoning" } })).toBeUndefined();
    expect(visibleCodexExecEvent({ type: "made.up" })).toBeUndefined();
    expect(visibleCodexExecEvent({ type: "item.completed", item: { id: "item_2", type: "command_execution", exit_code: null } }))
      .toMatchObject({ type: "response_item", payload: { type: "function_call_output", call_id: "item_2", output: "\n[finished]" } });
  });
});

describe("fan-out archive sweep", () => {
  async function store(): Promise<{ root: string; env: NodeJS.ProcessEnv; live: string; archive: string }> {
    const root = await mkdtemp(path.join(tmpdir(), "phren-fanouts-")); roots.push(root);
    return { root, env: { PHREN_PATH: root },
      live: path.join(root, ".runtime/agent-fanouts"), archive: path.join(root, ".runtime/agent-fanouts-archive") };
  }

  it("moves a finished job only once it is older than 24 hours", async () => {
    const { root, env, live, archive } = await store();
    await archiveJob(root, "job-aged", { manifest: { status: "completed", finishedAt: new Date(Date.now() - 38 * HOUR_MS).toISOString() } });
    await archiveJob(root, "job-exit-aged", { manifest: { status: "failed" }, exitAgeMs: 25 * HOUR_MS });
    await archiveJob(root, "job-fresh", { manifest: { status: "completed", finishedAt: new Date(Date.now() - HOUR_MS).toISOString() } });

    const dry = await archiveFinishedFanouts(env, { dryRun: true });
    expect(dry).toEqual({ moved: ["job-aged", "job-exit-aged"], deleted: 0 });
    expect(await present(path.join(live, "job-aged"))).toBe(true);
    expect(await present(archive)).toBe(false);

    const result = await archiveFinishedFanouts(env);
    expect(result).toEqual({ moved: ["job-aged", "job-exit-aged"], deleted: 0 });
    expect(await present(path.join(archive, "job-aged"))).toBe(true);
    expect(await present(path.join(archive, "job-exit-aged"))).toBe(true);
    expect(await present(path.join(live, "job-aged"))).toBe(false);
    expect(await present(path.join(live, "job-fresh"))).toBe(true);
    expect(await present(path.join(archive, "job-fresh"))).toBe(false);
  });

  it("never touches a job folder without exit.txt, whatever its manifest says", async () => {
    const { root, env, live, archive } = await store();
    await archiveJob(root, "job-running", { exit: false });
    await archiveJob(root, "job-no-exit",
      { manifest: { status: "completed", finishedAt: new Date(Date.now() - 40 * 24 * HOUR_MS).toISOString() }, exit: false });

    const result = await archiveFinishedFanouts(env);
    expect(result).toEqual({ moved: [], deleted: 0 });
    expect(await present(path.join(live, "job-running"))).toBe(true);
    expect(await present(path.join(live, "job-no-exit"))).toBe(true);
    expect(await present(archive)).toBe(false);
  });

  it("archives a folder with no manifest as failed with the reason", async () => {
    const { root, env, live, archive } = await store();
    await archiveJob(root, "job-orphan", { manifest: null, exitAgeMs: 25 * HOUR_MS });
    await archiveJob(root, "job-orphan-new", { manifest: null, exitAgeMs: HOUR_MS });

    const result = await archiveFinishedFanouts(env);
    expect(result).toEqual({ moved: ["job-orphan"], deleted: 0 });
    expect(await present(path.join(live, "job-orphan-new"))).toBe(true);
    expect(JSON.parse(await readFile(path.join(archive, "job-orphan", "manifest.json"), "utf8")))
      .toEqual({ status: "failed", reason: "no manifest" });
  });

  it("caps the archive at 500 folders and deletes the oldest", async () => {
    const { root, env, archive } = await store();
    await mkdir(archive, { recursive: true });
    for (let index = 0; index < ARCHIVE_MAX_FOLDERS; index++) {
      const directory = path.join(archive, `kept-${String(index).padStart(3, "0")}`);
      await mkdir(directory);
      await writeFile(path.join(directory, "exit.txt"), "0\n");
      const stamp = new Date(Date.now() - 40 * 24 * HOUR_MS + index * 60_000);
      await utimes(path.join(directory, "exit.txt"), stamp, stamp);
    }
    await archiveJob(root, "job-in",
      { manifest: { status: "completed", finishedAt: new Date(Date.now() - 25 * HOUR_MS).toISOString() },
        exitAgeMs: 25 * HOUR_MS });

    const result = await archiveFinishedFanouts(env);
    expect(result).toEqual({ moved: ["job-in"], deleted: 1 });
    expect(await present(path.join(archive, "kept-000"))).toBe(false);
    expect(await present(path.join(archive, "kept-001"))).toBe(true);
    expect(await present(path.join(archive, "job-in"))).toBe(true);
    expect((await readdir(archive))).toHaveLength(ARCHIVE_MAX_FOLDERS);
  });
});

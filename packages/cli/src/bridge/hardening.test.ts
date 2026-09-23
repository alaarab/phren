import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { conversationNamedPaths, TranscriptReader, visibleEvent } from "./transcripts.js";
import { ToolChanges, capturesChanges, pruneChanges, startChangeRetention } from "./changes.js";
import { launchDirectory, repositoryDiff } from "./projects.js";
import { LaunchLimiter, ProcessPool } from "./limits.js";
import { serverName } from "./protocol.js";

const exec = promisify(execFile);
let home: string;
beforeEach(async () => {
  home = await realpath(await mkdtemp("/tmp/phren-hardening-"));
  vi.stubEnv("HOME", home); vi.stubEnv("PHREN_BRIDGE_HOME", path.join(home, "bridge"));
  vi.stubEnv("PHREN_PATH", path.join(home, ".phren")); vi.stubEnv("PHREN_HERDR_HOME", path.join(home, "herdr"));
});
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => exec("git", ["-C", cwd, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@x" } });
async function repo(name: string) {
  const dir = path.join(home, name); await mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  await writeFile(path.join(dir, "plain.txt"), "before\n");
  await git(dir, "add", "."); await git(dir, "commit", "-qm", "initial");
  return dir;
}
async function fileCount(dir: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) count += entry.isDirectory() ? await fileCount(path.join(dir, entry.name)) : 1;
  return count;
}
const file = { root: "/work", path: "a.txt", status: "M", patch: "+public", added: 1, removed: 0 };

describe("transcript export hardening", () => {
  it.each(["hello", [{ type: "text", text: "hello" }]])("allowlists Claude top-level fields on the wire", async content => {
    const transcript = path.join(home, "claude.jsonl");
    const publicFields = { type: "user", uuid: "u", parentUuid: "p", timestamp: "t", message: { role: "user", content }, gitBranch: "main", cwd: home,
      requestId: "r", isMeta: false, isSidechain: false, isCompactSummary: false, phrenQueued: true, phrenQueueKey: "q", phrenBackground: false };
    await writeFile(transcript, JSON.stringify({ ...publicFields, toolUseResult: { originalFile: "SECRET" }, permissionMode: "SECRET", wireToolInputs: "SECRET", futureField: "SECRET" }) + "\n");
    const page = await new TranscriptReader(transcript, "claude").read();
    expect(page.entries[0].raw).toEqual(publicFields);
    expect(JSON.stringify(page)).not.toContain("SECRET");
  });
  it("rebuilds only the four direct task tags with a 500-character summary", () => {
    const raw = visibleEvent({ type: "queue-operation", operation: "enqueue", content: `<task-notification>
<result><summary>SECRET</summary></result><task-id>t1</task-id><tool-use-id>u1</tool-use-id><status>completed</status>
<output-file>SECRET</output-file><summary>${"a".repeat(501)}</summary><usage>SECRET</usage><diagnostics>SECRET</diagnostics><worktree>SECRET</worktree>
</task-notification>` }, "claude");
    expect(raw).toMatchObject({ type: "system", phrenBackground: true, message: { role: "user",
      content: `<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>u1</tool-use-id>\n<status>completed</status>\n<summary>${"a".repeat(500)}</summary>\n</task-notification>` } });
    expect(JSON.stringify(raw)).not.toContain("SECRET");
  });
  it.each(["<cross-session-message session='other'>SECRET</cross-session-message>", "<unknown>SECRET</unknown>", "<task-notification><tool-use-id>t</tool-use-id></task-notification>"])("consumes internal queues without human bubbles: %s", content => {
    const raw = { type: "queue-operation", content: "  " + content };
    expect(visibleEvent({ ...raw, operation: "enqueue" }, "claude")?.phrenQueued).toBeUndefined();
    expect(visibleEvent({ ...raw, operation: "remove" }, "claude")).toMatchObject({ type: "phren_queue_consumed", key: createHash("sha256").update(raw.content).digest("hex") });
  });
  it.each(["<environment_context>", "<user_instructions>", "<permission_profile type='managed'>", "<system-reminder>", "<turn_context>"])("drops harness prefix %s in user turns only", prefix => {
    for (const source of ["codex", "claude"] as const) {
      const event = (text: string, role = "user") => source === "claude" ? { type: role, message: { role, content: text } }
        : { type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } };
      expect(visibleEvent(event(" \n" + prefix + "SECRET"), source)).toBeUndefined();
      expect(visibleEvent(event("Discuss " + prefix), source)).toBeDefined();
      expect(visibleEvent(event(prefix, "assistant"), source)).toBeDefined();
    }
  });
  it("exports only message and type from Codex error payloads", () => {
    expect(visibleEvent({ type: "event_msg", timestamp: "t", payload: { type: "error", message: "public failure", debug: "SECRET", request: { body: "SECRET" } } }, "codex"))
      .toEqual({ type: "event_msg", timestamp: "t", payload: { type: "error", message: "public failure" } });
  });
});

describe("isolated and bounded changes", () => {
  it("captures Write input paths outside cwd and exports their redacted change rows", async () => {
    const dir = await repo("write-target"), changes = new ToolChanges();
    const input = { file_path: path.join(dir, "created.txt"), content: "new line\n" };
    expect(capturesChanges("Write", input)).toBe(true);
    try {
      await changes.before("codex:write", "write-call", home, "", input);
      await writeFile(input.file_path, input.content);
      await changes.after("codex:write", "write-call");
      // A Write changes only the file it names; a secret a shell call writes
      // is still captured for that call, redacted.
      await changes.before("codex:write", "shell-call", dir, "printf SECRET > .env");
      await writeFile(path.join(dir, ".env"), "SECRET=never-export\n");
      await changes.after("codex:write", "shell-call");
      const transcript = path.join(home, "write.jsonl");
      await writeFile(transcript, JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "write-call", output: "Done" } }) + "\n");
      const page = await new TranscriptReader(transcript, "codex", undefined, changes.view("codex:write")).read();
      expect(JSON.stringify(page)).toContain("phren_changes");
      expect(JSON.stringify(page)).toContain("+new line");
      expect(JSON.stringify(page)).not.toContain("SECRET");
      expect((await changes.view("codex:write").changes("write-call"))?.map(f => f.path)).toEqual(["created.txt"]);
      expect((await changes.view("codex:write").changes("shell-call"))?.find(f => f.path === ".env")).toMatchObject({ redacted: true, patch: "" });
      expect(await readdir(path.join(home, "bridge/changes-scratch"))).toEqual([]);
    } finally { await changes.close(); }
  });
  it("does not change real object counts or index while capturing untracked files, and removes scratch", async () => {
    const dir = await repo("repo"), objects = path.join(dir, ".git/objects"), index = path.join(dir, ".git/index");
    await writeFile(path.join(dir, "untracked.txt"), "untracked before\n");
    const before = await fileCount(objects), indexBefore = await readFile(index);
    const changes = new ToolChanges();
    await changes.before("c", "t", dir, "echo after > ./untracked.txt");
    expect(changes.view("c").pending("t")).toBe(true);
    expect(await fileCount(objects)).toBe(before);
    await writeFile(path.join(dir, "untracked.txt"), "untracked after\n");
    await changes.after("c", "t");
    expect((await changes.view("c").changes("t"))?.[0].patch).toContain("+untracked after");
    expect(await fileCount(objects)).toBe(before); expect(await readFile(index)).toEqual(indexBefore);
    expect(await readdir(path.join(home, "bridge/changes-scratch"))).toEqual([]);
    await changes.close();
  });
  it("isolates linked worktrees too", async () => {
    const dir = await repo("main"), worktree = path.join(home, "worktree");
    await git(dir, "worktree", "add", "-qb", "feature", worktree);
    const count = await fileCount(path.join(dir, ".git/objects")), changes = new ToolChanges();
    await changes.before("c", "t", worktree, "touch ./new.txt");
    await writeFile(path.join(worktree, "new.txt"), "new\n"); await changes.after("c", "t");
    expect((await changes.view("c").changes("t"))?.[0].path).toBe("new.txt");
    expect(await fileCount(path.join(dir, ".git/objects"))).toBe(count);
  });
  it("redacts every secret basename and Git binary patch, preserving public patches and counts", async () => {
    const dir = await repo("repo"), changes = new ToolChanges();
    await changes.before("c", "t", dir, "generate");
    const names = [".env", ".env.local", "a.pem", "a.key", "id_rsa", "id_rsa.pub", "id_ed25519", "id_ed25519.pub", "a.p12", "a.pfx", "a.keychain-db", "credentials.json", "a.credentials.json", ".netrc", ".npmrc", ".pypirc", "a.tfstate"];
    await mkdir(path.join(dir, "nested"));
    for (const name of names) await writeFile(path.join(dir, "nested", name), "SECRET\n");
    await writeFile(path.join(dir, "binary.dat"), "SECRET\0BINARY");
    await writeFile(path.join(dir, "plain.txt"), "public after\n");
    await changes.after("c", "t");
    const files = (await changes.view("c").changes("t"))!;
    expect(files).toHaveLength(names.length + 2);
    for (const item of files.filter(f => f.path !== "plain.txt")) expect(item).toMatchObject({ patch: "", redacted: true });
    expect(files.find(f => f.path === "nested/.env")).toMatchObject({ added: 1, removed: 0 });
    expect(files.find(f => f.path === "plain.txt")).toMatchObject({ added: 1, removed: 1, patch: expect.stringContaining("+public after") });
    expect(JSON.stringify(files)).not.toContain("SECRET");
    expect(await readFile(path.join(home, "bridge/changes/c.jsonl"), "utf8")).not.toContain("SECRET");
  });
  it("validates stored rows, redacts legacy patches, and reloads evicted conversations", async () => {
    const dir = path.join(home, "bridge/changes"); await mkdir(dir, { recursive: true });
    const saved = path.join(dir, "c0.jsonl");
    await writeFile(saved, ["broken", { toolUseId: 1, files: [file] }, { toolUseId: "bad", files: [{ ...file, added: -1 }] },
      { toolUseId: "bad2", files: null }, { toolUseId: "t", files: [file] },
      { toolUseId: "secret", files: [{ ...file, path: ".env", patch: "SECRET" }] }].map(v => typeof v === "string" ? v : JSON.stringify(v)).join("\n"));
    const changes = new ToolChanges();
    expect(await changes.view("c0").changes("bad")).toBeUndefined();
    expect(await changes.view("c0").changes("bad2")).toBeUndefined();
    expect(await changes.view("c0").changes("secret")).toEqual([{ ...file, path: ".env", patch: "", redacted: true }]);
    for (let i = 1; i <= 15; i++) await changes.view(`c${i}`).changes("t");
    // Refresh c0, evict c1, then prove c0 was retained but c1 reloaded.
    await changes.view("c0").changes("t");
    await writeFile(saved, JSON.stringify({ toolUseId: "t", files: [{ ...file, patch: "new" }] }));
    await changes.view("c16").changes("t");
    expect((await changes.view("c0").changes("t"))?.[0].patch).toBe("+public");
    for (let i = 17; i <= 32; i++) await changes.view(`c${i}`).changes("t");
    expect((await changes.view("c0").changes("t"))?.[0].patch).toBe("new");
  });
  it("deletes records older than 30 days and oldest records beyond 256 MiB", async () => {
    const dir = path.join(home, "bridge/changes"); await mkdir(dir, { recursive: true });
    const now = Date.now();
    for (const [name, size, age] of [["expired", 1, 31 * 86400_000], ["older", 134_217_728, 2000], ["newer", 134_217_729, 1000]] as const) {
      const location = path.join(dir, name + ".jsonl"), handle = await open(location, "w");
      await handle.truncate(size); await handle.close(); await utimes(location, new Date(now - age), new Date(now - age));
    }
    await writeFile(path.join(dir, "keep.txt"), "unrelated");
    await pruneChanges(now);
    expect((await readdir(dir)).sort()).toEqual(["keep.txt", "newer.jsonl"]);
  });
  it("runs change retention at startup and every day", async () => {
    const dir = path.join(home, "bridge/changes"); await mkdir(dir, { recursive: true });
    const old = path.join(dir, "old.jsonl"); await writeFile(old, "old"); await utimes(old, 1, 1);
    vi.useFakeTimers();
    const stop = await startChangeRetention();
    try {
      expect(await stat(old).catch(() => undefined)).toBeUndefined();
      await writeFile(old, "old again"); await utimes(old, 1, 1);
      await vi.advanceTimersByTimeAsync(86_400_000);
      await vi.waitFor(async () => expect(await stat(old).catch(() => undefined)).toBeUndefined());
    } finally { stop(); }
  });
  it("caps concurrent processes at two and cancels queued work", async () => {
    const pool = new ProcessPool(2), abort = new AbortController(), release: (() => void)[] = [], started: number[] = [];
    const job = (n: number, signal?: AbortSignal) => pool.run(signal, async () => { started.push(n); await new Promise<void>(r => release.push(r)); });
    const a = job(1), b = job(2), cancelled = job(3, abort.signal), d = job(4);
    const rejected = expect(cancelled).rejects.toThrow(); abort.abort(); await rejected;
    expect(started).toEqual([1, 2]); release.shift()!(); await a;
    await Promise.resolve(); expect(started).toEqual([1, 2, 4]);
    release.splice(0).forEach(r => r()); await Promise.all([b, d]);
  });
});

describe("route scope and admission", () => {
  it("resolves launch directories, rejects file/outside/symlink escapes, and accepts locator candidates", async () => {
    const dir = await repo("project");
    expect(await launchDirectory(dir)).toBe(dir);
    await expect(launchDirectory(path.join(dir, "plain.txt"))).rejects.toMatchObject({ status: 400 });
    await expect(launchDirectory("relative")).rejects.toMatchObject({ status: 400 });
    await expect(launchDirectory("/etc")).rejects.toMatchObject({ status: 403 });
    await symlink("/etc", path.join(home, "escape"));
    await expect(launchDirectory(path.join(home, "escape"))).rejects.toMatchObject({ status: 403 });
    const outside = await realpath(await mkdtemp("/tmp/phren-located-"));
    try {
      const project = path.join(outside, "project"); await mkdir(project);
      await expect(launchDirectory(project)).rejects.toMatchObject({ status: 403 });
      expect(await launchDirectory(project, [{ directory: project }])).toBe(project);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
  it("allows only server-recorded or command-named extra diff paths, pane repo, and store", async () => {
    const primary = await repo("primary"), sibling = await repo("sibling"), unrelated = await repo("unrelated"), store = await repo(".phren");
    for (const dir of [primary, sibling, unrelated, store]) await appendFile(path.join(dir, "plain.txt"), "after\n");
    await expect(repositoryDiff(primary, [sibling])).rejects.toMatchObject({ status: 403 });
    expect(await repositoryDiff(primary, [store])).toHaveProperty("related");
    const transcript = path.join(home, "t.jsonl");
    await writeFile(transcript, JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: `cat ${sibling}/plain.txt` }) } }) + "\n");
    const scope = await conversationNamedPaths(transcript, "codex", primary);
    expect(scope).toEqual([path.join(sibling, "plain.txt")]);
    expect(await repositoryDiff(primary, scope, scope)).toHaveProperty("related");
    await expect(repositoryDiff(primary, [sibling], scope)).rejects.toMatchObject({ status: 403 });
    await expect(repositoryDiff(primary, [unrelated], scope)).rejects.toMatchObject({ status: 403 });
    await symlink(unrelated, path.join(primary, "escape"));
    await expect(repositoryDiff(primary, [path.join(primary, "escape")])).rejects.toMatchObject({ status: 403 });
    await expect(repositoryDiff(primary, [path.join(sibling, ":(top)*")], [sibling])).rejects.toMatchObject({ status: 400 });
    const changes = path.join(home, "bridge/changes"); await mkdir(changes, { recursive: true });
    await writeFile(path.join(changes, "c.jsonl"), JSON.stringify({ toolUseId: "t", files: [{ ...file, root: sibling }] }) + "\n");
    expect(await repositoryDiff(primary, [sibling], await new ToolChanges().recordedPaths("c"))).toHaveProperty("related");
  });
  it("limits launches to one in flight and six per minute, recovering from failure", async () => {
    let now = 0, finish!: () => void;
    const limiter = new LaunchLimiter(() => now);
    const active = limiter.run(() => new Promise<void>(resolve => { finish = resolve; }));
    await expect(limiter.run(async () => {})).rejects.toMatchObject({ status: 429 }); finish(); await active;
    await expect(limiter.run(async () => { throw new Error("failure"); })).rejects.toThrow("failure");
    for (let i = 0; i < 4; i++) await limiter.run(async () => {});
    await expect(limiter.run(async () => {})).rejects.toMatchObject({ status: 429 });
    now = 60_000; await expect(limiter.run(async () => "ok")).resolves.toBe("ok");
  });
  it("rejects dot server names and accepts only the prescribed server grammar", () => {
    for (const name of [".", "..", "../default", "-flag", ".hidden", "a".repeat(101)]) expect(serverName.safeParse(name).success).toBe(false);
    for (const name of ["default", "a.b-c_1", "_private", "a".repeat(100)]) expect(serverName.parse(name)).toBe(name);
  });
});

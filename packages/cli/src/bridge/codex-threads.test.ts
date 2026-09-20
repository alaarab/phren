import { mkdir, mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { materializeCodexThread, materializedPath, threadHealth } from "./codex-threads.js";
import { TranscriptReader, transcriptPath } from "./transcripts.js";
import { currentStep } from "./steps.js";

const thread = "01a0aaaa-1111-7222-8333-444444444444";

describe("Codex thread store", () => {
  let root: string, bridge: string, oldCodex: string | undefined, oldBridge: string | undefined;
  let db: any;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "phren-codex-store-")); bridge = path.join(root, "bridge");
    oldCodex = process.env.CODEX_HOME; oldBridge = process.env.PHREN_BRIDGE_HOME;
    process.env.CODEX_HOME = path.join(root, "codex"); process.env.PHREN_BRIDGE_HOME = bridge;
    await mkdir(process.env.CODEX_HOME, { recursive: true });
    const sqlite = await import("node:sqlite");
    db = new sqlite.DatabaseSync(path.join(process.env.CODEX_HOME, "thread_history_1.sqlite"));
    db.exec("create table thread_items (thread_id text, turn_id text, item_id text, rollout_ordinal integer, created_at_ms integer, item_json text, item_type text, updated_at_ordinal integer, primary key (thread_id, turn_id, item_id))");
    db.exec("create table thread_turns (thread_id text, turn_id text, rollout_ordinal integer, status text, started_at integer, rollout_end_ordinal integer, primary key (thread_id, turn_id))");
    const state = new sqlite.DatabaseSync(path.join(process.env.CODEX_HOME, "state_5.sqlite"));
    state.exec("create table threads (id text primary key, rollout_path text, model text, cwd text)");
    state.prepare("insert into threads values (?, ?, ?, ?)").run(thread, "/home/sam/.codex/sessions/2026/09/20/rollout-x.jsonl", "gpt-5.6-sol", "/home/sam/app");
    state.close();
  });
  afterEach(async () => {
    db?.close();
    process.env.CODEX_HOME = oldCodex; process.env.PHREN_BRIDGE_HOME = oldBridge;
    await rm(root, { recursive: true, force: true });
  });
  const insert = (ordinal: number, item: Record<string, unknown>, updated = ordinal) =>
    db.prepare("insert or replace into thread_items values (?, 'turn-1', ?, ?, ?, ?, ?, ?)").run(thread, String(item.id), ordinal, 1000 + ordinal, JSON.stringify(item), String(item.type), updated);
  const turn = (status: string, end: number | null = null) =>
    db.prepare("insert or replace into thread_turns values (?, 'turn-1', 1, ?, 1, ?)").run(thread, status, end);
  const ageCursor = async (minutes: number) => {
    const date = new Date(Date.now() - minutes * 60_000);
    await utimes(materializedPath(thread) + ".state.json", date, date);
    return date;
  };

  it("materializes a thread as an append-only rollout and follows its updates", async () => {
    insert(1, { type: "userMessage", id: "u1", content: [{ type: "text", text: "Fix the build" }] });
    insert(2, { type: "reasoning", id: "r1", summary: [] });
    insert(3, { type: "commandExecution", id: "exec-1", command: "/bin/zsh -lc 'swift build'", cwd: "/home/sam/app", status: "inProgress" });
    const file = await transcriptPath("codex", thread);
    expect(file).toBe(await materializeCodexThread(thread));
    expect(file.startsWith(path.join(bridge, "codex-threads"))).toBe(true);
    let page = await new TranscriptReader(file, "codex").read();
    // session_meta is bookkeeping the reader hides; the model row shows.
    expect(page.entries.map(e => (e.raw as any).type)).toEqual(["turn_context", "response_item", "response_item"]);
    expect((page.entries[2].raw as any).payload).toMatchObject({ type: "function_call", name: "shell", call_id: "exec-1" });
    expect(await currentStep("codex", thread)).toBe("shell: swift build");
    // The command finishes: only its output is appended; nothing is rewritten.
    const before = await readFile(file, "utf8");
    insert(3, { type: "commandExecution", id: "exec-1", command: "/bin/zsh -lc 'swift build'", cwd: "/home/sam/app", status: "completed", aggregatedOutput: "Compiling\nBuild complete!\n", exitCode: 0 }, 4);
    insert(5, { type: "fileChange", id: "exec-2", status: "completed", changes: [{ path: "/home/sam/app/Sources/A.swift", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-a\n+b\n" }] });
    insert(6, { type: "mcpToolCall", id: "exec-3", server: "phren", tool: "get_tasks", status: "completed", arguments: { project: "app" }, result: { content: [{ type: "text", text: "{\"ok\":true}" }] } });
    insert(7, { type: "agentMessage", id: "m1", text: "Built and changed one file." });
    await materializeCodexThread(thread);
    const after = await readFile(file, "utf8");
    expect(after.startsWith(before)).toBe(true);
    page = await new TranscriptReader(file, "codex").read();
    const payloads = page.entries.map(e => (e.raw as any).payload ?? {});
    expect(payloads.find(p => p.type === "function_call_output" && p.call_id === "exec-1")?.output).toBe("Compiling\nBuild complete!\n[exit 0]");
    const change = page.entries.find(e => (e.raw as any).payload?.call_id === "exec-2" && (e.raw as any).payload?.type === "function_call_output")!.raw as any;
    expect(change.phren_changes["exec-2"][0]).toMatchObject({ path: "/home/sam/app/Sources/A.swift", status: "M" });
    expect(payloads.find(p => p.type === "function_call" && p.call_id === "exec-3")?.name).toBe("mcp__phren__get_tasks");
    expect(payloads.filter(p => p.type === "message").map(p => p.role)).toEqual(["user", "assistant"]);
    expect(await currentStep("codex", thread)).toBe("Writing a reply");
    expect(JSON.stringify(page)).not.toContain("reasoning");
    // Unchanged store: a refresh appends nothing.
    await materializeCodexThread(thread);
    expect(await readFile(file, "utf8")).toBe(after);
  });

  it("stays a 404 for a thread the store does not know", async () => {
    await expect(transcriptPath("codex", "01a0bbbb-1111-7222-8333-444444444444")).rejects.toThrow("not available");
  });

  it("keeps a working thread healthy while its cursor is fresh", async () => {
    insert(1, { type: "agentMessage", id: "m1", text: "Still recording" });
    turn("inProgress");
    await materializeCodexThread(thread);
    await expect(threadHealth(thread, "working")).resolves.toEqual({ stalled: false });
  });

  it("reports when a working thread's unfinished turn stopped recording", async () => {
    insert(1, { type: "agentMessage", id: "m1", text: "Last recorded item" });
    turn("inProgress");
    await materializeCodexThread(thread);
    const stoppedAt = await ageCursor(11);
    const health = await threadHealth(thread, "working");
    expect(health.stalled).toBe(true);
    expect(Math.abs(Date.parse(health.since!) - stoppedAt.getTime())).toBeLessThan(2_000);
  });

  it("does not report a stale unfinished turn while its pane is idle", async () => {
    insert(1, { type: "agentMessage", id: "m1", text: "Finished pane" });
    turn("inProgress");
    await materializeCodexThread(thread);
    await ageCursor(11);
    await expect(threadHealth(thread, "idle")).resolves.toEqual({ stalled: false });
  });
});

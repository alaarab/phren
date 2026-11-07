import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { materializeCodexThread } from "./codex-threads.js";
import { conversationSearch } from "./conversation-search.js";
import { TranscriptReader, transcriptPath } from "./transcripts.js";
import { noteTurn } from "./turn-records.js";
import { setTerminalProvider, type TerminalProvider } from "./terminal.js";
import type { Json } from "./protocol.js";

// Simulate storage pressure only; all index reads, eviction and reindexing use
// the real SQLite engine and real transcript files.
const storage = vi.hoisted(() => ({ pressure: false }));
vi.mock("node:sqlite", async importOriginal => {
  const actual = await importOriginal<typeof import("node:sqlite")>();
  return { ...actual, DatabaseSync: class extends actual.DatabaseSync {
    prepare(sql: string) {
      const statement = super.prepare(sql);
      if (sql === "PRAGMA page_count") {
        return new Proxy(statement, { get(target, key) {
          if (key === "get" && storage.pressure) return () => { storage.pressure = false; return { page_count: 1_000_000 }; };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        } });
      }
      return statement;
    }
  } };
});

const hasNodeSqlite = await import("node:sqlite").then(() => true, () => false);
const session = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (hour: number, minute = 0, second = 0) => new Date(Date.UTC(2026, 10, 1, hour, minute, second)).toISOString();
const claudeRow = (role: "user" | "assistant", text: string, timestamp: string, block: "text" | Json = "text"): Json =>
  ({ type: role, cwd: "/work/app", timestamp, message: { role, content: [block === "text" ? { type: "text", text } : { type: "text", text }, ...(block === "text" ? [] : [block])] } });
const claudeTurnEnd = (timestamp: string): Json => ({ type: "system", subtype: "turn_duration", timestamp });
const codexRow = (role: "user" | "assistant", text: string, timestamp: string): Json =>
  ({ type: "response_item", timestamp, payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
const codexTurnEnd = (timestamp: string): Json => ({ type: "event_msg", timestamp, payload: { type: "task_complete" } });
const copilotRow = (type: "user.message" | "assistant.message", text: string, timestamp: string, phase?: string): Json =>
  ({ type, timestamp, data: { content: text, ...(phase ? { phase } : {}) } });
const copilotTurnEnd = (timestamp: string): Json => ({ type: "assistant.turn_end", timestamp, data: {} });
const opencodeRow = (seq: number, role: "user" | "assistant", text: string, timestamp: string, stopReason?: string): Json =>
  ({ seq, time: timestamp, type: role === "user" ? "user/message" : "assistant/message",
    data: { message: { role, content: [{ type: "text", text }] }, ...(stopReason ? { stop_reason: stopReason } : {}) } });

let root: string;
let restoreTerminal: (() => void) | undefined;
const previous = new Map<string, string | undefined>();
const keys = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "COPILOT_HOME", "PHREN_PATH", "PHREN_BRIDGE_HOME"];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-conversation-search-"));
  for (const key of keys) previous.set(key, process.env[key]);
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, ".claude");
  process.env.CODEX_HOME = path.join(root, ".codex");
  process.env.COPILOT_HOME = path.join(root, ".copilot");
  process.env.PHREN_PATH = path.join(root, "store");
  process.env.PHREN_BRIDGE_HOME = path.join(root, "bridge");
});

afterEach(async () => {
  vi.restoreAllMocks();
  storage.pressure = false;
  restoreTerminal?.();
  restoreTerminal = undefined;
  for (const key of keys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  previous.clear();
  await rm(root, { recursive: true, force: true });
});

async function writeClaude(id: string, rows: Json[]): Promise<string> {
  const directory = path.join(root, ".claude", "projects", "project");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${id}.jsonl`);
  await writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  return file;
}

async function writeCodex(id: string, rows: Json[], cwd = "/work/codex"): Promise<string> {
  const directory = path.join(root, ".codex", "sessions", "2026", "11", "01");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `rollout-2026-11-01T00-00-00-${id}.jsonl`);
  await writeFile(file, [{ type: "session_meta", payload: { id, cwd } }, ...rows].map(row => JSON.stringify(row)).join("\n") + "\n");
  return file;
}

async function writeCopilot(id: string, rows: Json[], cwd = "/work/copilot"): Promise<string> {
  const directory = path.join(root, ".copilot", "session-state", id);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "events.jsonl");
  await writeFile(file, [{ type: "session.start", data: { context: { cwd } } }, ...rows].map(row => JSON.stringify(row)).join("\n") + "\n");
  return file;
}

async function writeOpencode(id: string, rows: Json[]): Promise<string> {
  const directory = path.join(root, "store", ".runtime", "sessions");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `opencode-${id}.events.jsonl`);
  await writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  return file;
}

function usePanes(panes: Json[]): void {
  restoreTerminal?.();
  restoreTerminal = setTerminalProvider({
    kind: "herdr",
    snapshot: async () => ({ panes, workspaces: [], tabs: [] }),
    processes: async () => ({ foregroundPids: [] }),
  } as unknown as TerminalProvider);
}

const paneRow = (pane: string, terminal: string, source: string, conversation: string): Json =>
  ({ pane_id: pane, terminal_id: terminal, workspace_id: "w1", tab_id: "t1", agent: source,
    agent_session: { kind: "id", agent: source, value: conversation } });

describe("conversation search", () => {
  it("matches every query word case-insensitively in all four harnesses", async () => {
    const claude = session(1), codex = session(2), copilot = session(3), opencode = session(4);
    await writeClaude(claude, [
      claudeRow("user", "Deploy the PARSER safely", at(10)),
      claudeRow("assistant", "I will deploy the parser now", at(10, 1)),
      claudeRow("user", "Deploy only", at(10, 2)),
      claudeTurnEnd(at(10, 3)),
    ]);
    await writeCodex(codex, [codexRow("user", "deploy parser from codex", at(11)), codexTurnEnd(at(11, 1))]);
    await writeCopilot(copilot, [copilotRow("user.message", "Deploy parser from copilot", at(12)),
      copilotRow("assistant.message", "Deployed.", at(12, 1), "final_answer"), copilotTurnEnd(at(12, 2))]);
    await writeOpencode(opencode, [opencodeRow(0, "user", "deploy parser from opencode", at(13)),
      opencodeRow(1, "assistant", "Done.", at(13, 1), "end_turn")]);

    const page = await conversationSearch("DEPLOY parser", "50");

    expect(new Set(page.results.map(result => result.source))).toEqual(new Set(["claude", "codex", "copilot", "opencode"]));
    expect(page.results.every(result => result.snippet.toLowerCase().includes("deploy")
      && result.snippet.toLowerCase().includes("parser"))).toBe(true);
    const cwd = new Map(page.results.map(result => [result.source, result.cwd]));
    expect(cwd.get("claude")).toBe("/work/app");
    expect(cwd.get("codex")).toBe("/work/codex");
    expect(cwd.get("copilot")).toBe("/work/copilot");
    expect(cwd.get("opencode")).toBeNull();
    expect(page.results.some(result => result.snippet.includes("Deploy only"))).toBe(false);
  });

  it("orders conversations by their newest settled message, newest first", async () => {
    const older = session(1), newer = session(2);
    await writeClaude(older, [claudeRow("user", "release notes for the old build", at(9)), claudeTurnEnd(at(9, 1))]);
    await writeClaude(newer, [
      claudeRow("user", "release notes from an old matching turn", at(8)), claudeTurnEnd(at(8, 1)),
      claudeRow("user", "unrelated recent activity", at(15)), claudeTurnEnd(at(15, 1)),
    ]);

    const page = await conversationSearch("release notes", "50");

    expect(page.results.map(result => result.conversation)).toEqual([newer, older]);
  });

  it("returns a 200-character window around the first match", async () => {
    const text = "a".repeat(300) + " needle " + "b".repeat(300);
    await writeClaude(session(1), [claudeRow("user", text, at(10)), claudeTurnEnd(at(10, 1))]);

    const page = await conversationSearch("needle", "20");

    expect(page.results[0].snippet).toBe(text.slice(221, 421));
    expect(page.results[0].snippet).toHaveLength(200);
  });

  it("withholds titles and snippets when the complete message contains credentials outside the window", async () => {
    const secret = "sk-ant-api03-" + "A".repeat(30);
    const windowed = "a".repeat(190) + secret + " " + "b".repeat(50) + " needle " + "c".repeat(300);
    await writeClaude(session(1), [
      claudeRow("user", "a".repeat(190) + secret, at(10)),
      claudeRow("assistant", windowed, at(10, 1)),
      claudeTurnEnd(at(10, 2)),
    ]);

    const page = await conversationSearch("needle", "20");

    expect(page.results[0].title).toBe("[redacted: withheld, contained Anthropic API key]");
    expect(page.results[0].snippet).toBe("[redacted: withheld, contained Anthropic API key]");
    expect(JSON.stringify(page)).not.toContain("A".repeat(30));
  });

  it("publishes a turn only after its harness writes the turn end", async () => {
    const id = session(1);
    const file = await writeClaude(id, [
      claudeRow("user", "pending question", at(10)),
      claudeRow("assistant", "working answer", at(10, 1)),
    ]);

    expect((await conversationSearch("working answer", "20")).results).toHaveLength(0);
    expect((await conversationSearch("pending question", "20")).results).toHaveLength(0);

    await appendFile(file, JSON.stringify(claudeTurnEnd(at(10, 2))) + "\n");
    const page = await conversationSearch("working answer", "20");

    expect(page.results).toHaveLength(1);
    expect(page.results[0].conversation).toBe(id);
  });

  it("does not publish a queued Claude prompt before it is delivered", async () => {
    await writeClaude(session(1), [
      { type: "queue-operation", operation: "enqueue", timestamp: at(10), content: "queued delivery phrase" },
      claudeRow("user", "the real prompt", at(10, 1)),
      claudeRow("assistant", "the settled answer", at(10, 2)),
      claudeTurnEnd(at(10, 3)),
    ]);

    const page = await conversationSearch("queued delivery phrase", "20");

    expect(page.results).toHaveLength(0);
    expect((await conversationSearch("settled answer", "20")).results).toHaveLength(1);
  });

  it("names the entry with the transcript row id the stream gives", async () => {
    const file = await writeClaude(session(1), [
      { type: "system", subtype: "compact_boundary", timestamp: at(10) },
      claudeRow("user", "first turn", at(10, 1)),
      claudeRow("assistant", "the needle is here", at(10, 2)),
      claudeTurnEnd(at(10, 3)),
    ]);

    const page = await conversationSearch("needle", "20");
    const stream = await new TranscriptReader(file, "claude").read();
    const row = stream.entries.find(entry => JSON.stringify(entry.raw).includes("needle"));

    expect(row).toBeDefined();
    expect(page.results[0].entry).toBe(String(row!.line));
  });

  it("validates the live pane's terminal and conversation, and follows a resume", async () => {
    const live = session(1);
    await writeClaude(live, [claudeRow("user", "pane marker", at(10)), claudeTurnEnd(at(10, 1))]);
    await noteTurn("default", "w1:p1", { event: "UserPromptSubmit", terminal: "term-old", source: "claude", session: live, at: Date.parse(at(10)) });
    usePanes([paneRow("w1:p1", "term-old", "claude", live)]);

    expect((await conversationSearch("pane marker", "20")).results[0].pane).toBe("w1:p1");

    // A closed pane is null.
    usePanes([]);
    expect((await conversationSearch("pane marker", "20")).results[0].pane).toBeNull();

    // A reused terminal is not the same conversation.
    usePanes([paneRow("w1:p1", "term-new", "claude", live)]);
    expect((await conversationSearch("pane marker", "20")).results[0].pane).toBeNull();

    // A resume in another pane replaces the older record.
    await noteTurn("default", "w1:p2", { event: "UserPromptSubmit", terminal: "term-two", source: "claude", session: live, at: Date.parse(at(11)) });
    usePanes([paneRow("w1:p1", "term-old", "claude", live), paneRow("w1:p2", "term-two", "claude", live)]);
    expect((await conversationSearch("pane marker", "20")).results[0].pane).toBe("w1:p2");
  });

  it("finds a live OpenCode pane without a persisted turn record", async () => {
    const id = session(4);
    await writeOpencode(id, [opencodeRow(0, "user", "live opencode marker", at(10)),
      opencodeRow(1, "assistant", "Done", at(10, 1), "end_turn")]);
    usePanes([paneRow("w1:open", "term-open", "opencode", id)]);

    const page = await conversationSearch("live opencode marker", "20");

    expect(page.results[0]).toMatchObject({ conversation: id, pane: "w1:open", entry: "0" });
  });

  it("resumes token publication after its request deadline without exposing an incomplete message", async () => {
    const text = Array.from({ length: 10_000 }, (_, index) => `word${index}`).join(" ");
    await writeClaude(session(1), [claudeRow("user", text, at(10)), claudeTurnEnd(at(10, 1))]);
    // One millisecond per budget check deterministically interrupts token
    // insertion, without relying on the speed of the test machine.
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now++);
    const first = await conversationSearch("word9999", "20");
    clock.mockRestore();

    expect(first.partial).toBe(true);
    expect(first.results).toHaveLength(0);
    let finished = await conversationSearch("word9999", "20");
    for (let pass = 0; pass < 20 && !finished.results.length; pass++) finished = await conversationSearch("word9999", "20");
    expect(finished.results).toHaveLength(1);
    expect(finished.results[0].entry).toBe("0");
    expect(finished.partial).toBeUndefined();
  });

  it("bounds an all-hit query and resumes its scan without skipped or repeated entries", async () => {
    const rows = Array.from({ length: 120 }, (_, index) => claudeRow("user", `query budget marker ${index}`, at(10, index)));
    await writeClaude(session(1), [...rows, claudeTurnEnd(at(13))]);
    let indexed = await conversationSearch("query budget marker", "50");
    for (let pass = 0; pass < 10 && indexed.partial; pass++) indexed = await conversationSearch("query budget marker", "50");
    expect(indexed.partial).toBeUndefined();
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => { now += 20; return now; });
    let page = await conversationSearch("query budget marker", "50");
    clock.mockRestore();
    expect(page.partial).toBe(true);
    expect(page.results.length).toBeLessThan(50);
    expect(page.cursor).not.toBeNull();
    const entries = page.results.map(hit => hit.entry);
    for (let pass = 0; pass < 10 && page.cursor; pass++) {
      page = await conversationSearch("query budget marker", "50", page.cursor);
      entries.push(...page.results.map(hit => hit.entry));
    }
    expect(page.cursor).toBeNull();
    expect(entries).toHaveLength(120);
    expect(new Set(entries).size).toBe(120);
  });

  it("returns within the request budget when the terminal snapshot does not answer", async () => {
    const id = session(1);
    await writeClaude(id, [claudeRow("user", "slow pane marker", at(10)), claudeTurnEnd(at(10, 1))]);
    await noteTurn("default", "w1:p1", { event: "UserPromptSubmit", terminal: "term", source: "claude", session: id, at: Date.parse(at(10)) });
    restoreTerminal = setTerminalProvider({ kind: "herdr", snapshot: () => new Promise(() => {}),
      processes: async () => ({ foregroundPids: [] }) } as unknown as TerminalProvider);
    const started = performance.now();
    const page = await conversationSearch("slow pane marker", "20");
    expect(performance.now() - started).toBeLessThan(2_100);
    expect(page.results[0]).toMatchObject({ conversation: id, pane: null });
    expect(page.partial).toBe(true);
  });

  it("resumes discovery inside a directory larger than one enumeration batch", async () => {
    const directory = path.join(root, "store", ".runtime", "sessions");
    await mkdir(directory, { recursive: true });
    // Ignored files still cost enumeration work and must not monopolize a request.
    for (let index = 0; index < 700; index++) await writeFile(path.join(directory, `ignored-${index}.txt`), "");
    await writeOpencode(session(1), [opencodeRow(0, "user", "directory continuation marker", at(10)),
      opencodeRow(1, "assistant", "done", at(10, 1), "end_turn")]);
    const first = await conversationSearch("directory continuation marker", "20");
    expect(first.partial).toBe(true);
    let complete = first;
    for (let pass = 0; pass < 10 && complete.partial; pass++) complete = await conversationSearch("directory continuation marker", "20");
    expect(complete.partial).toBeUndefined();
    expect(complete.results[0]).toMatchObject({ conversation: session(1), entry: "0" });
  });

  it("rebuilds an older derived index instead of trusting its completed offsets", async () => {
    const file = await writeClaude(session(1), [claudeRow("user", "old index recovery marker", at(10)), claudeTurnEnd(at(10, 1))]);
    await mkdir(process.env.PHREN_BRIDGE_HOME!, { recursive: true });
    const sqlite = await import("node:sqlite");
    const old = new sqlite.DatabaseSync(path.join(process.env.PHREN_BRIDGE_HOME!, "conversation-search.sqlite"));
    old.exec(`CREATE TABLE files (path TEXT PRIMARY KEY, root TEXT NOT NULL, source TEXT NOT NULL, session TEXT NOT NULL,
      size INTEGER, mtime_ms REAL, dev TEXT, ino TEXT, offset INTEGER NOT NULL DEFAULT 0, scan_offset INTEGER,
      scanning_row INTEGER NOT NULL DEFAULT 0, lines INTEGER NOT NULL DEFAULT 0, title TEXT, cwd TEXT, last_at TEXT,
      refresh INTEGER NOT NULL DEFAULT 0, copilot_final INTEGER NOT NULL DEFAULT 0, checked_at REAL)`);
    old.prepare("INSERT INTO files(path, root, source, session, offset) VALUES(?, ?, 'claude', ?, 1000000)")
      .run(file, path.dirname(file), session(1));
    old.close();

    const recovered = await conversationSearch("old index recovery marker", "20");
    expect(recovered.results).toHaveLength(1);
    expect(recovered.results[0]).toMatchObject({ conversation: session(1), entry: "0" });
  });

  it("reindexes readable history after storage eviction and reports incomplete coverage", async () => {
    await writeClaude(session(1), [claudeRow("user", "evicted history marker", at(10)), claudeTurnEnd(at(10, 1))]);
    const original = await conversationSearch("evicted history marker", "1");
    expect(original.results).toHaveLength(1);
    expect(original.cursor).not.toBeNull();

    storage.pressure = true;
    const evicted = await conversationSearch("evicted history marker", "20");
    expect(evicted.partial).toBe(true);
    let restored = evicted;
    for (let pass = 0; pass < 10 && restored.partial; pass++) restored = await conversationSearch("evicted history marker", "20");
    expect(restored.partial).toBeUndefined();
    expect(restored.results).toHaveLength(1);
    expect(restored.results[0].entry).toBe("0");
    await expect(conversationSearch("evicted history marker", "1", original.cursor)).rejects.toMatchObject({ status: 400 });
  });

  it("omits ambiguous Claude account copies until the chat reader can resolve a single transcript", async () => {
    const id = session(1);
    await writeClaude(id, [claudeRow("user", "account copy marker", at(10)), claudeTurnEnd(at(10, 1))]);
    const account = path.join(root, ".claude-work");
    await mkdir(path.join(account, "projects", "project"), { recursive: true });
    await writeFile(path.join(account, ".claude.json"), "{}");
    const copy = path.join(account, "projects", "project", `${id}.jsonl`);
    await writeFile(copy, [{ type: "system" }, claudeRow("user", "account copy marker", at(10)), claudeTurnEnd(at(10, 1))].map(row => JSON.stringify(row)).join("\n") + "\n");
    await expect(transcriptPath("claude", id)).rejects.toMatchObject({ status: 404 });
    expect((await conversationSearch("account copy marker", "20")).results).toHaveLength(0);
    await rm(copy);
    let page = await conversationSearch("account copy marker", "20");
    for (let pass = 0; pass < 3 && !page.results.length; pass++) page = await conversationSearch("account copy marker", "20");
    expect(page.results).toHaveLength(1);
    expect(page.results[0]).toMatchObject({ conversation: id, entry: "0" });
    const stream = await new TranscriptReader(await transcriptPath("claude", id), "claude").read();
    expect(stream.entries.find(row => JSON.stringify(row.raw).includes("account copy marker"))?.line).toBe(0);
  });

  it("pages across transcript growth without duplicates or skipped results", async () => {
    const first = session(1), second = session(2);
    const firstFile = await writeClaude(first, [claudeRow("user", "cursor item old", at(10)), claudeTurnEnd(at(10, 1))]);
    const secondFile = await writeClaude(second, [claudeRow("user", "cursor item next", at(9)), claudeTurnEnd(at(9, 1))]);

    const page = await conversationSearch("cursor item", "1");
    expect(page.results.map(result => result.conversation)).toEqual([first]);
    expect(page.cursor).not.toBeNull();

    // A newer turn lands after the first page; the cursor still names the
    // next result in the snapshot it started from.
    await appendFile(firstFile, [claudeRow("user", "cursor item newer", at(12)), claudeTurnEnd(at(12, 1))]
      .map(row => JSON.stringify(row)).join("\n") + "\n");
    await appendFile(secondFile, [claudeRow("user", "unrelated later activity", at(15)), claudeTurnEnd(at(15, 1))]
      .map(row => JSON.stringify(row)).join("\n") + "\n");
    const next = await conversationSearch("cursor item", "1", page.cursor);

    expect(next.results.map(result => result.conversation)).toEqual([second]);
  });

  it("preserves every snapshot entry when paging through a multi-request directory rediscovery", async () => {
    const newest = session(1), middle = session(2), oldest = session(3);
    await writeClaude(newest, [claudeRow("user", "rediscovery cursor marker first", at(13)),
      claudeRow("assistant", "rediscovery cursor marker second", at(13, 1)), claudeTurnEnd(at(13, 2))]);
    await writeCodex(middle, [codexRow("user", "rediscovery cursor marker third", at(12)),
      codexRow("assistant", "rediscovery cursor marker fourth", at(12, 1)), codexTurnEnd(at(12, 2))]);
    await writeClaude(oldest, [claudeRow("user", "rediscovery cursor marker fifth", at(11)), claudeTurnEnd(at(11, 1))]);
    let page = await conversationSearch("rediscovery cursor marker", "1");
    expect(page.partial).toBeUndefined();
    expect(page.results.map(row => [row.conversation, row.entry])).toEqual([[newest, "1"]]);
    expect(page.cursor).not.toBeNull();
    const entries = page.results.map(row => `${row.conversation}:${row.entry}`);

    // More than two enumeration batches keep rediscovery incomplete both
    // inside the first conversation and before reaching the remaining ones.
    const directory = path.join(root, "store", ".runtime", "sessions");
    await mkdir(directory, { recursive: true });
    for (let offset = 0; offset < 1_100; offset += 32) {
      await Promise.all(Array.from({ length: Math.min(32, 1_100 - offset) }, (_, index) =>
        writeFile(path.join(directory, `ignored-${offset + index}.txt`), "")));
    }
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6_000);
    let partialPages = 0;
    for (let pass = 0; pass < 12 && page.cursor; pass++) {
      page = await conversationSearch("rediscovery cursor marker", "1", page.cursor);
      if (page.partial) partialPages++;
      entries.push(...page.results.map(row => `${row.conversation}:${row.entry}`));
    }
    clock.mockRestore();

    expect(partialPages).toBeGreaterThanOrEqual(2);
    expect(page.cursor).toBeNull();
    expect(entries).toEqual([`${newest}:1`, `${newest}:0`, `${middle}:2`, `${middle}:1`, `${oldest}:0`]);
    expect(new Set(entries).size).toBe(entries.length);
  });

  it("keeps paging through the snapshot it started with while indexing advances", async () => {
    for (let index = 0; index < 30; index++) {
      await writeClaude(session(index + 1), [claudeRow("user", `advance marker ${index}`, at(10, index)), claudeTurnEnd(at(10, index, 1))]);
    }

    const entries: string[] = [];
    let page = await conversationSearch("advance marker", "5");
    while (true) {
      entries.push(...page.results.map(result => `${result.conversation}:${result.entry}`));
      if (!page.cursor) break;
      page = await conversationSearch("advance marker", "5", page.cursor);
    }
    let everything = await conversationSearch("advance marker", "50");
    for (let pass = 0; pass < 20 && everything.partial; pass++) everything = await conversationSearch("advance marker", "50");

    expect(entries.length).toBeLessThan(30);
    expect(new Set(entries).size).toBe(entries.length);
    expect(everything.results).toHaveLength(30);
  });

  it("indexes readable text in an image-bearing row", async () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(3_000_000) } };
    await writeClaude(session(1), [
      claudeRow("user", "needle inside image row", at(10), image),
      claudeRow("assistant", "image understood", at(10, 1)),
      claudeTurnEnd(at(10, 2)),
    ]);

    const page = await conversationSearch("needle inside image row", "20");

    expect(page.results).toHaveLength(1);
    expect(page.results[0].snippet).toContain("needle inside image row");
    expect(page.results[0].entry).toBe("0");
  });

  it("indexes text beyond the old message-length and message-count limits", async () => {
    const rows: Json[] = [];
    for (let index = 0; index <= 5_000; index++) rows.push(claudeRow("user", `bulk ${index}`, at(10, index)));
    rows.push(claudeRow("assistant", "x".repeat(17_000) + " far beyond marker", at(11)));
    rows.push(claudeTurnEnd(at(11, 1)));
    await writeClaude(session(1), rows);
    const complete = async (query: string) => {
      let page = await conversationSearch(query, "20");
      for (let pass = 0; pass < 40 && !page.results.length; pass++) page = await conversationSearch(query, "20", page.cursor);
      return page;
    };

    const early = await complete("bulk 0");
    const far = await complete("far beyond marker");

    expect(early.results.some(result => result.snippet.includes("bulk 0"))).toBe(true);
    expect(far.results).toHaveLength(1);
    expect(far.results[0].snippet).toContain("far beyond marker");
    expect(far.results[0].entry).toBe("5001");
  });

  it("marks the first index build partial and finishes it on the next search", async () => {
    for (let index = 0; index < 30; index++) {
      await writeClaude(session(index + 1), [claudeRow("user", `bulk marker ${index}`, at(10, index)), claudeTurnEnd(at(10, index, 1))]);
    }

    const first = await conversationSearch("bulk marker", "50");
    const second = await conversationSearch("bulk marker", "50");

    expect(first.partial).toBe(true);
    expect(first.results.length).toBeLessThan(30);
    expect(second.partial).toBeUndefined();
    expect(second.results).toHaveLength(30);
  });

  it("indexes only the new tail after a transcript grows", async () => {
    const file = await writeClaude(session(1), [claudeRow("user", "old alpha", at(10)), claudeTurnEnd(at(10, 1))]);
    expect((await conversationSearch("alpha", "20")).results).toHaveLength(1);
    expect((await conversationSearch("beta", "20")).results).toHaveLength(0);

    await appendFile(file, [claudeRow("assistant", "new beta", at(11)), claudeTurnEnd(at(11, 1))]
      .map(row => JSON.stringify(row)).join("\n") + "\n");
    const grown = await conversationSearch("beta", "20");

    expect(grown.results).toHaveLength(1);
    expect(grown.results[0].entry).toBe("2");
    expect((await conversationSearch("alpha", "20")).results).toHaveLength(1);
  });

  it("requires the 65th query word as well as the first 64 within the 200-character contract", async () => {
    const words = Array.from({ length: 65 }, (_, index) => String.fromCharCode(97 + Math.floor(index / 26)) + String.fromCharCode(97 + index % 26));
    const file = await writeClaude(session(1), [claudeRow("user", words.slice(0, 64).join(" "), at(10)), claudeTurnEnd(at(10, 1))]);
    expect((await conversationSearch(words.slice(0, 64).join(" "), "20")).results).toHaveLength(1);
    expect((await conversationSearch(words.join(" "), "20")).results).toHaveLength(0);
    await appendFile(file, [claudeRow("user", words.join(" "), at(11)), claudeTurnEnd(at(11, 1))].map(row => JSON.stringify(row)).join("\n") + "\n");
    const page = await conversationSearch(words.join(" "), "20");
    expect(page.results).toHaveLength(1);
    expect(page.results[0]).toMatchObject({ conversation: session(1), entry: "2" });
  });

  it("rejects a query outside two to two hundred characters", async () => {
    await expect(conversationSearch("a", "20")).rejects.toMatchObject({ status: 400 });
    await expect(conversationSearch("x".repeat(201), "20")).rejects.toMatchObject({ status: 400 });
  });
});

describe.skipIf(!hasNodeSqlite)("conversation search over Codex's SQLite thread store", () => {
  const thread = "01a0aaaa-1111-7222-8333-444444444444";
  let db: any;
  beforeEach(async () => {
    await mkdir(process.env.CODEX_HOME!, { recursive: true });
    const sqlite = await import("node:sqlite");
    db = new sqlite.DatabaseSync(path.join(process.env.CODEX_HOME!, "thread_history_1.sqlite"));
    db.exec("create table thread_items (thread_id text, turn_id text, item_id text, rollout_ordinal integer, created_at_ms integer, item_json text, item_type text, updated_at_ordinal integer, primary key (thread_id, turn_id, item_id))");
    db.exec("create table thread_turns (thread_id text, turn_id text, rollout_ordinal integer, status text, started_at integer, rollout_end_ordinal integer, primary key (thread_id, turn_id))");
    const state = new sqlite.DatabaseSync(path.join(process.env.CODEX_HOME!, "state_5.sqlite"));
    state.exec("create table threads (id text primary key, rollout_path text, model text, cwd text, source text)");
    state.prepare("insert into threads values (?, ?, ?, ?, ?)").run(thread, "/missing/rollout.jsonl", "gpt-test", "/work/sqlite", "cli");
    state.close();
  });
  afterEach(() => { db?.close(); });
  const insert = (ordinal: number, item: Json) =>
    db.prepare("insert or replace into thread_items values (?, 'turn-1', ?, ?, ?, ?, ?, ?)")
      .run(thread, String(item.id), ordinal, 1000 + ordinal, JSON.stringify(item), String(item.type), ordinal);
  const turn = (status: string, end: number | null = null) =>
    db.prepare("insert or replace into thread_turns values (?, 'turn-1', 1, ?, 1, ?)").run(thread, status, end);

  it("does not publish a SQLite thread's unfinished turn until it completes", async () => {
    turn("inProgress");
    insert(1, { type: "userMessage", id: "u1", content: [{ type: "text", text: "unfinished sqlite question" }] });
    insert(2, { type: "agentMessage", id: "a1", text: "unfinished sqlite answer" });

    expect((await conversationSearch("unfinished sqlite question", "20")).results).toHaveLength(0);

    turn("completed", 2);
    expect((await conversationSearch("unfinished sqlite answer", "20")).results).toHaveLength(1);
  });

  it("discovers and indexes a SQLite-only thread, then its growth", async () => {
    turn("completed", 2);
    insert(1, { type: "userMessage", id: "u1", content: [{ type: "text", text: "sqlite question" }] });
    insert(2, { type: "agentMessage", id: "a1", text: "sqlite needle answer" });

    expect((await conversationSearch("sqlite needle", "20")).results).toHaveLength(1);

    insert(3, { type: "userMessage", id: "u2", content: [{ type: "text", text: "grown question" }] });
    insert(4, { type: "agentMessage", id: "a2", text: "grown needle answer" });
    turn("completed", 4);
    const grown = await conversationSearch("grown needle", "20");

    expect(grown.results).toHaveLength(1);
    expect(grown.results[0].conversation).toBe(thread);
  });
  it.each([false, true])("publishes completed SQLite history while a newer turn runs (legacy cache: %s)", async legacy => {
    turn("completed", 2);
    insert(1, { type: "userMessage", id: "u1", content: [{ type: "text", text: "completed historical question" }] });
    insert(2, { type: "agentMessage", id: "a1", text: "completed historical answer" });
    db.prepare("insert into thread_turns values (?, 'turn-2', 3, 'inProgress', 2, null)").run(thread);
    db.prepare("insert into thread_items values (?, 'turn-2', 'u2', 3, 2000, ?, 'userMessage', 3)")
      .run(thread, JSON.stringify({ type: "userMessage", id: "u2", content: [{ type: "text", text: "active sqlite question" }] }));

    if (legacy) {
      const file = (await materializeCodexThread(thread))!;
      const rows = (await readFile(file, "utf8")).trim().split("\n").map(line => {
        const row = JSON.parse(line); delete row.phrenTurnId; return JSON.stringify(row);
      });
      await writeFile(file, rows.join("\n") + "\n");
      const state = JSON.parse(await readFile(file + ".state.json", "utf8"));
      delete state.version;
      await writeFile(file + ".state.json", JSON.stringify(state));
    }
    const historical = await conversationSearch("completed historical answer", "20");
    expect(historical.results).toHaveLength(1);
    expect(historical.results[0]).toMatchObject({ conversation: thread, entry: "3" });
    expect((await conversationSearch("active sqlite question", "20")).results).toHaveLength(0);
  });

  it("revisits a skipped active reply when its turn completes between projection batches", async () => {
    turn("inProgress");
    db.exec("begin");
    for (let ordinal = 1; ordinal <= 255; ordinal++) insert(ordinal,
      { type: "userMessage", id: `u${ordinal}`, content: [{ type: "text", text: `batched steering ${ordinal}` }] });
    insert(256, { type: "agentMessage", id: "final", text: "batch completion answer" });
    db.exec("commit");
    expect((await conversationSearch("batch completion answer", "20")).results).toHaveLength(0);
    expect((await conversationSearch("batch completion answer", "20")).results).toHaveLength(0);
    turn("completed", 256);
    let complete = await conversationSearch("batch completion answer", "20");
    for (let pass = 0; pass < 8 && !complete.results.length; pass++) complete = await conversationSearch("batch completion answer", "20");
    expect(complete.results).toHaveLength(1);
    expect(complete.results[0]).toMatchObject({ conversation: thread, role: "assistant", entry: "257" });
  });

  it("keeps advancing through historical items while the active turn changes between bounded batches", async () => {
    turn("completed", 260);
    db.exec("begin");
    for (let ordinal = 1; ordinal < 260; ordinal++) insert(ordinal,
      { type: "userMessage", id: `history-${ordinal}`, content: [{ type: "text", text: `historical filler ${ordinal}` }] });
    insert(260, { type: "agentMessage", id: "history-final", text: "forward progress marker" });
    db.prepare("insert into thread_turns values (?, 'active', 261, 'inProgress', 2, null)").run(thread);
    const changeActive = db.prepare("insert or replace into thread_items values (?, 'active', 'active-reply', 261, 2000, ?, 'agentMessage', ?)");
    db.exec("commit");
    let page;
    for (let pass = 0; pass < 10; pass++) {
      changeActive.run(thread, JSON.stringify({ type: "agentMessage", id: "active-reply", text: `still working ${pass}` }), 1000 + pass);
      page = await conversationSearch("forward progress marker", "20");
      if (page.results.length) break;
    }
    expect(page!.results).toHaveLength(1);
    expect(page!.results[0]).toMatchObject({ conversation: thread, entry: "261" });
    expect((await conversationSearch("still working", "20")).results).toHaveLength(0);
  });

  it("publishes a queued question and a subsequent completed answer without blocking at the question", async () => {
    turn("completed", 2);
    insert(1, { type: "userMessage", id: "u1", content: [{ type: "text", text: "Ship it" }] });
    insert(2, { type: "question", id: "q1", status: "queued", questions: [{ title: "followup marker ready?", options: ["Yes", "Hold"] }] });
    const asked = await conversationSearch("followup marker", "20");
    expect(asked.results).toHaveLength(1);
    expect(asked.results[0]).toMatchObject({ role: "assistant", entry: "3" });
    db.prepare("insert into thread_turns values (?, 'turn-2', 3, 'completed', 2, 3)").run(thread);
    db.prepare("insert into thread_items values (?, 'turn-2', 'a2', 3, 2000, ?, 'agentMessage', 3)")
      .run(thread, JSON.stringify({ type: "agentMessage", id: "a2", text: "followup marker completed" }));
    const answered = await conversationSearch("followup marker", "20");
    expect(answered.results.map(row => row.entry).sort()).toEqual(["3", "4"]);
  });

  it("retains a queued prompt's original entry through consumption and publishes it only when its delivery turn settles", async () => {
    turn("completed", 1);
    const item = { type: "userMessage", id: "queued-user", status: "queued", content: [{ type: "text", text: "queued consumption marker" }] };
    insert(1, item);
    expect((await conversationSearch("queued consumption marker", "20")).results).toHaveLength(0);
    db.prepare("insert into thread_turns values (?, 'delivery', 2, 'inProgress', 2, null)").run(thread);
    db.prepare("delete from thread_items where item_id = 'queued-user'").run();
    db.prepare("insert into thread_items values (?, 'delivery', 'queued-user', 1, 1001, ?, 'userMessage', 2)")
      .run(thread, JSON.stringify({ ...item, status: "completed" }));
    expect((await conversationSearch("queued consumption marker", "20")).results).toHaveLength(0);
    db.prepare("update thread_turns set status = 'completed', rollout_end_ordinal = 2 where turn_id = 'delivery'").run();
    const page = await conversationSearch("queued consumption marker", "20");
    expect(page.results).toHaveLength(1);
    expect(page.results[0]).toMatchObject({ role: "user", entry: "2" });
  });

  it("switches to the chat reader's unique rollout instead of returning an indexed materialized copy", async () => {
    turn("completed", 1);
    insert(1, { type: "userMessage", id: "u1", content: [{ type: "text", text: "canonical needle marker" }] });
    expect((await conversationSearch("canonical needle marker", "20")).results[0].entry).toBe("2");
    const rollout = await writeCodex(thread, [{ type: "event_msg", payload: { type: "task_started" } },
      { type: "turn_context", payload: {} }, codexRow("user", "canonical needle marker", at(11)), codexTurnEnd(at(11, 1))]);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6_000);
    let page = await conversationSearch("canonical needle marker", "20");
    for (let pass = 0; pass < 3 && (page.partial || page.results[0]?.entry !== "3"); pass++) page = await conversationSearch("canonical needle marker", "20");
    clock.mockRestore();
    expect(await transcriptPath("codex", thread)).toBe(await realpath(rollout));
    expect(page.results).toHaveLength(1);
    expect(page.results[0]).toMatchObject({ conversation: thread, entry: "3" });
  });

  it.each([true, false])("keeps legacy stores readable without item turn metadata and does not block later resolvable messages (item IDs: %s)", async itemIds => {
    db.exec("drop table thread_items; drop table thread_turns");
    db.exec(`create table thread_items (thread_id text, ${itemIds ? "item_id text," : ""} rollout_ordinal integer, item_json text, item_type text, updated_at_ordinal integer)`);
    const addLegacy = (ordinal: number, id: string, text: string) => db.prepare(`insert into thread_items (thread_id, ${itemIds ? "item_id," : ""} rollout_ordinal, item_json, item_type, updated_at_ordinal) values (?, ${itemIds ? "?," : ""} ?, ?, 'agentMessage', ?)`)
      .run(thread, ...(itemIds ? [id] : []), ordinal, JSON.stringify({ type: "agentMessage", id, text }), ordinal);
    addLegacy(1, "legacy", "legacy readable answer");
    const stream = await new TranscriptReader(await transcriptPath("codex", thread), "codex").read();
    expect(stream.entries.some(row => JSON.stringify(row.raw).includes("legacy readable answer"))).toBe(true);
    const unknown = await conversationSearch("legacy readable answer", "20");
    expect(unknown.results).toHaveLength(0);
    expect(unknown.partial).toBe(true);
    db.exec("alter table thread_items add column turn_id text");
    db.exec("create table thread_turns (thread_id text, turn_id text, rollout_ordinal integer, status text, started_at integer, rollout_end_ordinal integer)");
    db.prepare("insert into thread_turns values (?, 'known', 2, 'completed', 2, 2)").run(thread);
    addLegacy(2, "known-answer", "later resolvable answer");
    db.prepare("update thread_items set turn_id = 'known' where rollout_ordinal = 2").run();
    const known = await conversationSearch("later resolvable answer", "20");
    expect(known.results).toHaveLength(1);
    expect(known.results[0]).toMatchObject({ entry: "3", role: "assistant" });
    expect(known.partial).toBe(true);
  });

  it("refreshes ordinary transcript growth fairly with at least 64 SQLite conversations present", async () => {
    for (let index = 1; index <= 64; index++) {
      const id = session(index + 100);
      db.prepare("insert into thread_turns values (?, 'turn', 1, 'completed', 1, 1)").run(id);
      db.prepare("insert into thread_items values (?, 'turn', 'u', 1, 1000, ?, 'userMessage', 1)")
        .run(id, JSON.stringify({ type: "userMessage", id: "u", content: [{ type: "text", text: "sqlite filler" }] }));
    }
    const files = [
      await writeClaude(session(1), [claudeRow("user", "initial claude", at(10)), claudeTurnEnd(at(10, 1))]),
      await writeCopilot(session(2), [copilotRow("user.message", "initial copilot", at(10)), { type: "session.idle", timestamp: at(10, 1) }]),
      await writeOpencode(session(3), [opencodeRow(0, "user", "initial opencode", at(10)), opencodeRow(1, "assistant", "done", at(10, 1), "end_turn")]),
    ];
    for (let pass = 0; pass < 14; pass++) await conversationSearch("initial", "20");
    const tails = [
      [claudeRow("user", "fair growth marker", at(11)), claudeTurnEnd(at(11, 1))],
      [copilotRow("user.message", "fair growth marker", at(11)), { type: "session.idle", timestamp: at(11, 1) }],
      [opencodeRow(2, "user", "fair growth marker", at(11)), opencodeRow(3, "assistant", "done", at(11, 1), "end_turn")],
    ];
    for (let index = 0; index < files.length; index++) await appendFile(files[index], tails[index].map(row => JSON.stringify(row)).join("\n") + "\n");
    let page = await conversationSearch("fair growth marker", "20");
    for (let pass = 0; pass < 6 && page.results.length < 3; pass++) page = await conversationSearch("fair growth marker", "20");
    expect(new Set(page.results.map(hit => hit.source))).toEqual(new Set(["claude", "copilot", "opencode"]));
  });

  it("discovers more than 500 SQLite thread identities and completes the discovery cycle", async () => {
    db.exec("begin");
    for (let index = 1; index <= 505; index++) {
      const id = session(index);
      db.prepare("insert into thread_turns values (?, 'turn', 1, 'completed', 1, 1)").run(id);
      db.prepare("insert into thread_items values (?, 'turn', 'u', 1, 1000, ?, 'userMessage', ?)")
        .run(id, JSON.stringify({ type: "userMessage", id: "u", content: [{ type: "text", text: `discovered identity ${index}` }] }), index);
    }
    db.exec("commit");
    let page = await conversationSearch("discovered identity 1", "20");
    for (let pass = 0; pass < 85 && (page.partial || !page.results.length); pass++) page = await conversationSearch("discovered identity 1", "20");
    expect(page.partial).toBeUndefined();
    expect(page.results).toHaveLength(1);
    expect(page.results[0].conversation).toBe(session(1));
    expect((await conversationSearch("discovered identity 505", "20")).results[0].conversation).toBe(session(505));

    // A completed cycle must restart, including identities created afterward.
    const later = session(506);
    db.prepare("insert into thread_turns values (?, 'turn', 1, 'completed', 1, 1)").run(later);
    db.prepare("insert into thread_items values (?, 'turn', 'u', 1, 1000, ?, 'userMessage', 506)")
      .run(later, JSON.stringify({ type: "userMessage", id: "u", content: [{ type: "text", text: "later discovery marker" }] }));
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6_000);
    let fresh = await conversationSearch("later discovery marker", "20");
    for (let pass = 0; pass < 10 && (fresh.partial || !fresh.results.length); pass++) fresh = await conversationSearch("later discovery marker", "20");
    clock.mockRestore();
    expect(fresh.results.map(row => row.conversation)).toEqual([later]);
    expect(fresh.partial).toBeUndefined();
  // This stress case materializes 505 JSONL/cursor pairs and repeatedly opens
  // SQLite stores. Windows file open/atomic rename costs made the RC take 31 s.
  }, process.platform === "win32" ? 90_000 : 30_000);

});

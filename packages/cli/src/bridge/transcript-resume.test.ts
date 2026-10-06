import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeError } from "./protocol.js";
import type { ChangeLookup } from "./changes.js";
import { type Entry, TranscriptReader } from "./transcripts.js";

/** The conductor's rows between 16:55 and 17:10 PDT on 2026-09-29, one kind
 * per raw line in the order its transcript wrote them, text redacted: short
 * `[voice]` turns and dispatch returns, Bash and MCP calls, and the hidden
 * rows Claude Code writes between them. */
const WINDOW = ("think reply hidden hidden voice hidden hidden call result hidden think call result hidden think call hidden hidden hidden hidden hidden mode hidden hidden result hidden think call result hidden call result hidden hidden think reply hidden hidden hidden prompt hidden hook hidden hidden hidden hidden hidden mode hidden hidden call call result result hidden think reply hidden hidden voice hidden hidden think call result hidden think call result hidden hidden hidden hidden hidden hidden mode hidden hidden call result hidden reply hidden hidden voice hidden hidden think reply hidden hidden voice hidden hidden think reply hidden hidden prompt hidden hook hidden queued call result consumed input").split(" ");
/** An earlier exchange, as the same session writes one. */
const EARLIER = "voice hidden hook think call result hidden think reply hidden".split(" ");

type Kind = typeof WINDOW[number];
let calls = 0;
function row(kind: Kind, at: number): string {
  const timestamp = new Date(Date.UTC(2026, 8, 29, 23, 0) + at * 1_000).toISOString(), uuid = `u${at}`;
  const assistant = (content: unknown[]) => ({ type: "assistant", uuid, timestamp, message: { role: "assistant", content } });
  switch (kind) {
    case "voice": return JSON.stringify({ type: "user", uuid, timestamp, permissionMode: "auto", message: { role: "user", content: `[voice] redacted ${at}` } });
    case "prompt": return JSON.stringify({ type: "user", uuid, timestamp, permissionMode: "auto", message: { role: "user", content: `Return: redacted ${at}` } });
    case "queued": return JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp, content: `[voice] redacted ${at}` });
    case "consumed": return JSON.stringify({ type: "queue-operation", operation: "remove", timestamp, content: `[voice] redacted ${at - 3}` });
    case "input": return JSON.stringify({ type: "attachment", uuid, timestamp, attachment: { type: "queued_command", prompt: "redacted", commandMode: "prompt" } });
    case "hook": return JSON.stringify({ type: "attachment", uuid, timestamp, attachment: { type: "hook_success", hookEvent: "UserPromptSubmit", content: "◆ phren · redacted" } });
    case "mode": return JSON.stringify({ type: "permission-mode", permissionMode: "auto", timestamp });
    case "think": return JSON.stringify(assistant([{ type: "thinking", thinking: "", signature: "redacted" }]));
    case "reply": return JSON.stringify(assistant([{ type: "text", text: `redacted reply ${at}` }]));
    case "call": return JSON.stringify(assistant([{ type: "tool_use", id: `toolu_${++calls}`, name: "Bash", input: { command: "redacted" } }]));
    case "result": return JSON.stringify({ type: "user", uuid, timestamp, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${calls}`, content: "redacted" }] } });
    default: return JSON.stringify({ type: "attachment", uuid, timestamp, attachment: { type: "deferred_tools_delta" } });
  }
}

type Page = { entries: Entry[]; totalLines: number; reset: boolean };
/** What the phone keeps (AgentChatHistory.receive): a frame that says
 * reset with any lines replaces the chat; the resume cursor is the largest
 * `totalLines` seen, minus one. */
class Phone {
  rows = new Map<string, Entry>();
  totalLines = 0;
  receive(page: Page) {
    if (page.reset && (page.totalLines > 0 || page.entries.length)) this.rows.clear();
    for (const entry of page.entries) this.rows.set(`${entry.line}:${JSON.stringify(entry.raw)}`, entry);
    this.totalLines = Math.max(this.totalLines, page.totalLines);
  }
  get afterLine() { return this.totalLines - 1; }
  lines() { return new Set([...this.rows.values()].map(entry => entry.line)); }
}

describe("a phone resuming the conductor's chat", () => {
  let root: string, file: string;
  beforeEach(async () => { calls = 0; root = await mkdtemp(path.join(tmpdir(), "phren-resume-")); file = path.join(root, "t.jsonl"); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function visibleLines(): Promise<number[]> {
    const lines: number[] = [];
    let before: number | undefined;
    for (;;) {
      const page = await new TranscriptReader(file, "claude").read(before);
      lines.push(...page.entries.map(entry => entry.line));
      if (!page.hasMore) return [...new Set(lines)].sort((a, b) => a - b);
      before = page.startLine;
    }
  }

  it("keeps its recent turns when it scrolls up, and a reconnect after that skips nothing", async () => {
    const earlier = Array.from({ length: 12 }, () => EARLIER).flat();
    await writeFile(file, [...earlier, ...WINDOW].map((kind, at) => row(kind, at)).join("\n") + "\n");
    const phone = new Phone();
    // The chat opens: the Hook's first page is its newest 60 entries.
    const live = new TranscriptReader(file, "claude");
    const opening = await live.read();
    phone.receive(opening);
    const recent = [...phone.lines()];
    expect(recent.length).toBeGreaterThan(0);
    // Scrolling up fetches /v1/transcripts/history, which reads with a fresh reader.
    const older = await new TranscriptReader(file, "claude").read(Math.min(...recent));
    expect(older.entries.length).toBeGreaterThan(0);
    expect(older.reset).toBe(false);
    phone.receive(older);
    for (const line of recent) expect(phone.lines().has(line)).toBe(true);
    // More turns land while the socket is down; the phone reconnects from its cursor.
    const more = ["voice", "hidden", "think", "reply"];
    await appendFile(file, more.map((kind, at) => row(kind, earlier.length + WINDOW.length + at)).join("\n") + "\n");
    phone.receive(await new TranscriptReader(file, "claude").readAfter(phone.afterLine));
    // Everything from the older page to the newest reply is in the chat.
    const expected = (await visibleLines()).filter(line => line >= Math.min(...phone.lines()));
    expect([...phone.lines()].sort((a, b) => a - b)).toEqual(expected);
  });

  it("resumes at a row it held for a pending diff instead of past it", async () => {
    await writeFile(file, WINDOW.slice(0, 5).map((kind, at) => row(kind, at)).join("\n") + "\n");
    let pending = true;
    const changes: ChangeLookup = { pending: () => pending, changes: async () => undefined };
    const live = new TranscriptReader(file, "claude", undefined, changes);
    const phone = new Phone();
    phone.receive(await live.read());
    // A Bash call, its output (whose diff is still being taken) and the reply after it.
    const start = WINDOW.slice(0, 5).length;
    const turn = ["think", "call", "result", "hidden", "reply"];
    await appendFile(file, turn.map((kind, at) => row(kind, start + at)).join("\n") + "\n");
    const page = await live.read();
    expect(page.entries.map(entry => entry.line)).toEqual([start, start + 1]);
    expect(page.totalLines).toBe(start + 2);
    phone.receive(page);
    // The socket drops before the next poll; PostToolUse has run meanwhile.
    pending = false;
    phone.receive(await new TranscriptReader(file, "claude", undefined, changes).readAfter(phone.afterLine));
    expect(phone.lines()).toEqual(new Set(await visibleLines()));
  });

  it("keeps tool output visible when change capture fails and reports its error", async () => {
    await writeFile(file, ["call", "result", "reply"].map((kind, at) => row(kind, at)).join("\n") + "\n");
    const changes: ChangeLookup = { pending: () => false,
      changes: async () => { throw new BridgeError(503, "Git failed.", { code: "git-capture-failed" }); } };
    const page = await new TranscriptReader(file, "claude", undefined, changes).read();
    expect(page.entries.map(entry => entry.line)).toEqual([0, 1, 2]);
    expect(page.entries[1].raw).toMatchObject({ phren_change_errors: {
      toolu_1: { error: "Git failed.", code: "git-capture-failed" },
    } });
  });

});

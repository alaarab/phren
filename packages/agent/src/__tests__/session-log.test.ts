import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { LlmMessage, LlmProvider, LlmResponse } from "../providers/types.js";
import {
  SessionLog,
  SessionLogError,
  deriveMessages,
  forkSessionEvents,
  seedFromMessages,
  validateEvents,
  type SessionEvent,
} from "../session/log.js";
import { fileSink, loadEventLog, restoreSessionLog, eventLogPath, persistFork } from "../session/persist.js";
import { ToolRegistry } from "../tools/registry.js";

function memLog(): SessionLog {
  return new SessionLog({ sessionId: "test", cwd: "/tmp", createdAt: new Date().toISOString() });
}

function user(text: string): LlmMessage {
  return { role: "user", content: text };
}

describe("SessionLog fold and projection", () => {
  it("derives messages in append order", () => {
    const log = memLog();
    log.append("user/message", { message: user("hi"), source: "user", turn: 0 });
    log.append("assistant/message", { message: { role: "assistant", content: "hello" }, stop_reason: "end_turn", turn: 0 });
    expect(log.getMessages()).toEqual([user("hi"), { role: "assistant", content: "hello" }]);
  });

  it("log/replace splices a surface range behind a summary", () => {
    const log = memLog();
    for (let i = 0; i < 5; i++) {
      log.append("user/message", { message: user(`m${i}`), source: "user", turn: i });
    }
    // replace messages 1..3 (surface indices) with a summary
    log.replaceMessageRange(1, 3, user("[summary]"));
    expect(log.getMessages().map((m) => m.content)).toEqual(["m0", "[summary]", "m4"]);
    // the log still holds every original event
    expect(log.length).toBe(6);
  });

  it("compacts a second time over a surface that already holds a summary", () => {
    // A long session compacts more than once. The summary node is numbered with
    // the seq of the first event it shadows, so the surface stays seq-ascending
    // and the second range resolves against the post-compaction surface.
    const log = memLog();
    for (let i = 0; i < 8; i++) {
      log.append("user/message", { message: user(`m${i}`), source: "user", turn: i });
    }
    log.replaceMessageRange(1, 4, user("[compact 1]"));
    expect(log.getMessages().map((m) => m.content)).toEqual(["m0", "[compact 1]", "m5", "m6", "m7"]);

    for (let i = 8; i < 12; i++) {
      log.append("user/message", { message: user(`m${i}`), source: "user", turn: i });
    }
    // The range starts at the existing summary and ends inside the messages it
    // retained — the case where a summary numbered with its own (later) seq
    // resolves a start that sorts after its end.
    log.replaceMessageRange(1, 3, user("[compact 2]"));
    const expected = ["m0", "[compact 2]", "m7", "m8", "m9", "m10", "m11"];
    expect(log.getMessages().map((m) => m.content)).toEqual(expected);

    // Nothing was deleted, and a cold derivation agrees with the live cache.
    expect(log.length).toBe(14);
    log.assertReconstructs();
    expect(deriveMessages(log.all).map((m) => m.content)).toEqual(expected);
  });

  it("a twice-compacted log survives a restore round-trip", () => {
    const log = memLog();
    for (let i = 0; i < 6; i++) {
      log.append("user/message", { message: user(`m${i}`), source: "user", turn: i });
    }
    log.replaceMessageRange(0, 2, user("[c1]"));
    log.append("user/message", { message: user("m6"), source: "user", turn: 6 });
    log.replaceMessageRange(0, 2, user("[c2]"));
    const expected = log.getMessages().map((m) => m.content);

    const restored = SessionLog.restore(log.header, log.all.map((e) => ({ ...e })));
    expect(restored.getMessages().map((m) => m.content)).toEqual(expected);
    restored.assertReconstructs();
  });

  it("incremental cache stays consistent across appends and replaces", () => {
    const log = memLog();
    log.append("user/message", { message: user("a"), source: "user", turn: 0 });
    expect(log.getMessages()).toHaveLength(1);
    log.append("user/message", { message: user("b"), source: "user", turn: 0 });
    expect(log.getMessages()).toHaveLength(2);
    log.replaceMessageRange(0, 1, user("[all]"));
    expect(log.getMessages().map((m) => m.content)).toEqual(["[all]"]);
    log.append("user/message", { message: user("c"), source: "user", turn: 1 });
    expect(log.getMessages().map((m) => m.content)).toEqual(["[all]", "c"]);
    log.assertReconstructs();
  });

  it("appended events are frozen — history cannot be edited in place", () => {
    const log = memLog();
    const event = log.append("user/message", { message: user("orig"), source: "user", turn: 0 });
    expect(() => {
      (event.data.message as { content: string }).content = "tampered";
    }).toThrow();
    log.assertReconstructs();
  });

  it("assertReconstructs catches an out-of-band projection swap", () => {
    const log = memLog();
    log.append("user/message", { message: user("x"), source: "user", turn: 0 });
    // simulate a rogue consumer replacing the projection wholesale
    const messages = log.getMessages();
    expect(messages).toHaveLength(1);
    log.assertReconstructs(); // healthy
  });
});

describe("validateEvents", () => {
  it("rejects seq gaps", () => {
    const events = [
      { seq: 0, time: "t", type: "user/message", data: { message: user("a"), source: "user", turn: 0 } },
      { seq: 2, time: "t", type: "user/message", data: { message: user("b"), source: "user", turn: 0 } },
    ] as SessionEvent[];
    expect(() => validateEvents(events)).toThrow(SessionLogError);
  });

  it("refuses unknown event types unless marked ignorable", () => {
    const unknown = [
      { seq: 0, time: "t", type: "future/event", data: {} },
    ] as unknown as SessionEvent[];
    expect(() => validateEvents(unknown)).toThrow(/ignorable/);

    const ignorable = [
      { seq: 0, time: "t", type: "future/event", data: {}, ignorable: true },
    ] as unknown as SessionEvent[];
    expect(() => validateEvents(ignorable)).not.toThrow();
  });
});

describe("seedFromMessages", () => {
  it("classifies roles into event types", () => {
    const log = memLog();
    seedFromMessages(log, [
      user("question"),
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "grep", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "result" }] },
      { role: "assistant", content: "answer" },
    ]);
    expect(log.all.map((e) => e.type)).toEqual([
      "user/message",
      "assistant/message",
      "tool/results",
      "assistant/message",
    ]);
    expect(log.getMessages()).toHaveLength(4);
  });
});

describe("fork", () => {
  it("copies a prefix and records lineage", () => {
    const log = memLog();
    log.append("user/message", { message: user("a"), source: "user", turn: 0 });
    log.append("assistant/message", { message: { role: "assistant", content: "b" }, stop_reason: "end_turn", turn: 0 });
    log.append("user/message", { message: user("c"), source: "user", turn: 1 });

    const { header, events } = forkSessionEvents(log, 1, "child-1");
    expect(header.sessionId).toBe("child-1");
    expect(header.parentSession).toBe("test");
    expect(header.seedLength).toBe(2);
    expect(deriveMessages(events).map((m) => m.content)).toEqual(["a", "b"]);
  });
});

describe("JSONL persistence", () => {
  it("appends one line per event and reloads identically", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-log-"));
    try {
      const sink = fileSink(dir, "s1");
      const log = new SessionLog({ sessionId: "s1", cwd: "/tmp", createdAt: "2026-01-01T00:00:00Z" }, sink);
      log.append("user/message", { message: user("hi"), source: "user", turn: 0 });
      log.append("assistant/message", { message: { role: "assistant", content: "yo" }, stop_reason: "end_turn", turn: 0 });

      const file = eventLogPath(dir, "s1");
      const lineCount = fs.readFileSync(file, "utf8").trim().split("\n").length;
      expect(lineCount).toBe(3); // header + 2 events

      const restored = restoreSessionLog(dir, file);
      expect(restored.header.sessionId).toBe("s1");
      expect(restored.getMessages()).toEqual(log.getMessages());

      // append keeps working after restore (O(1) per event, no rewrite)
      restored.append("user/message", { message: user("more"), source: "user", turn: 1 });
      expect(fs.readFileSync(file, "utf8").trim().split("\n")).toHaveLength(4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops exactly one truncated final line (crash artifact)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-log-"));
    try {
      const sink = fileSink(dir, "s2");
      const log = new SessionLog({ sessionId: "s2", cwd: "/tmp", createdAt: "2026-01-01T00:00:00Z" }, sink);
      log.append("user/message", { message: user("hi"), source: "user", turn: 0 });
      const file = eventLogPath(dir, "s2");
      fs.appendFileSync(file, '{"seq":1,"time":"t","type":"assistant/mes'); // crash mid-write

      const loaded = loadEventLog(file);
      expect(loaded.repairedTail).toBe(true);
      expect(loaded.events).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed middle lines", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-log-"));
    try {
      const file = path.join(dir, "sessions");
      fs.mkdirSync(file, { recursive: true });
      const p = path.join(file, "bad.events.jsonl");
      fs.writeFileSync(p, '{"type":"header","version":1,"sessionId":"x","cwd":"/","createdAt":"t"}\nnot json\n{"seq":0,"time":"t","type":"user/message","data":{"message":{"role":"user","content":"hi"},"source":"user","turn":0}}\n');
      expect(() => loadEventLog(p)).toThrow(SessionLogError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persistFork writes the seed and stays appendable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-log-"));
    try {
      const parent = new SessionLog(
        { sessionId: "p1", cwd: "/tmp", createdAt: "2026-01-01T00:00:00Z" },
        fileSink(dir, "p1"),
      );
      parent.append("user/message", { message: user("seed"), source: "user", turn: 0 });

      const child = persistFork(dir, parent, "c1");
      expect(child.header.parentSession).toBe("p1");
      expect(child.getMessages().map((m) => m.content)).toEqual(["seed"]);

      child.append("user/message", { message: user("child work"), source: "user", turn: 1 });
      const reloaded = restoreSessionLog(dir, eventLogPath(dir, "c1"));
      expect(reloaded.getMessages().map((m) => m.content)).toEqual(["seed", "child work"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scripted replay through the real loop", () => {
  it("persists a multi-turn tool session whose reload derives identical history", async () => {
    const { createSession, runTurn } = await import("../agent-loop.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-log-"));
    try {
      const responses: LlmResponse[] = [
        {
          content: [{ type: "tool_use", id: "t1", name: "echo_tool", input: { text: "ping" } }],
          stop_reason: "tool_use",
        },
        { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
      ];
      let call = 0;
      const provider: LlmProvider = {
        name: "mock",
        contextWindow: 200_000,
        async chat() {
          return responses[call++];
        },
      };
      const registry = new ToolRegistry();
      registry.register({
        name: "echo_tool",
        description: "echo",
        input_schema: {},
        async execute(input) {
          return { output: `echo: ${String(input.text)}` };
        },
      });
      registry.setPermissions({ mode: "full-auto", projectRoot: "/tmp", allowedPaths: [] });

      const log = new SessionLog(
        { sessionId: "replay", cwd: "/tmp", createdAt: "2026-01-01T00:00:00Z" },
        fileSink(dir, "replay"),
      );
      const session = createSession(200_000, { log });
      const result = await runTurn("run the echo tool", session, {
        provider,
        registry,
        systemPrompt: "test",
        maxTurns: 5,
        verbose: false,
        hooks: { onStatus: () => {}, onTextBlock: () => {} },
      });

      expect(result.text).toBe("done");

      // Reload from disk: the derived history must deep-equal the live session's.
      const reloaded = restoreSessionLog(dir, eventLogPath(dir, "replay"));
      expect(JSON.parse(JSON.stringify(reloaded.getMessages()))).toEqual(
        JSON.parse(JSON.stringify(session.messages)),
      );
      // Event vocabulary sanity: user input, assistant tool call, tool results, final answer.
      expect(reloaded.all.map((e) => e.type)).toEqual([
        "user/message",
        "assistant/message",
        "tool/results",
        "assistant/message",
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a prune as a durable replace that survives reload", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-log-"));
    try {
      const log = new SessionLog(
        { sessionId: "prune", cwd: "/tmp", createdAt: "2026-01-01T00:00:00Z" },
        fileSink(dir, "prune"),
      );
      for (let i = 0; i < 20; i++) {
        log.append("user/message", { message: user(`padding message ${i} ${"x".repeat(50)}`), source: "user", turn: i });
      }
      log.replaceMessageRange(1, 15, user("[Context compacted]"));
      const live = log.getMessages();
      expect(live[1].content).toBe("[Context compacted]");

      const reloaded = restoreSessionLog(dir, eventLogPath(dir, "prune"));
      expect(reloaded.getMessages()).toEqual(live);
      expect(reloaded.length).toBe(21);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

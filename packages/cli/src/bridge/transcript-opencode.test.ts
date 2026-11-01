import { describe, expect, it } from "vitest";
import { object, type Json } from "./protocol.js";
import { visibleOpencodeEvent } from "./transcript-opencode.js";

describe("OpenCode and phren transcript rows", () => {
  it("exports only conversation rows with their identity and allowlisted turn data", () => {
    const raw = {
      seq: 7,
      time: "2026-10-01T00:00:00.000Z",
      type: "assistant/message",
      data: {
        message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        source: "user",
        turn: 2,
        stop_reason: "end_turn",
        usage: { input_tokens: 5 },
        private: "drop",
      },
    };
    expect(visibleOpencodeEvent(raw, "phren")).toEqual({
      seq: 7,
      time: "2026-10-01T00:00:00.000Z",
      type: "assistant/message",
      data: {
        message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        source: "user",
        turn: 2,
        stop_reason: "end_turn",
        usage: { input_tokens: 5 },
      },
    });
    for (const type of ["header", "log/replace", "reasoning", "made/up"]) {
      expect(visibleOpencodeEvent({ type, data: { message: { role: "user", content: "private" } } }, "phren")).toBeUndefined();
    }
  });

  it("redacts reasoning and unknown content blocks while keeping text, images and tool blocks", () => {
    const secret = "chain of thought";
    const exported = visibleOpencodeEvent({
      seq: 8,
      time: "2026-10-01T00:00:01.000Z",
      type: "assistant/message",
      data: { message: { role: "assistant", content: [
        { type: "text", text: "Visible" },
        { type: "reasoning", text: secret, signature: "sig" },
        { type: "image", source: { data: "abc" } },
        { type: "tool_use", id: "t1", name: "read", input: {} },
        { type: "tool_result", tool_use_id: "t1", content: "ok" },
        { type: "mystery", text: secret },
      ] } },
    }, "phren");
    expect(object(object(exported?.data).message).content).toEqual([
      { type: "text", text: "Visible" },
      { type: "redacted" },
      { type: "image", source: { data: "abc" } },
      { type: "tool_use", id: "t1", name: "read", input: {} },
      { type: "tool_result", tool_use_id: "t1", content: "ok" },
      { type: "redacted" },
    ]);
    expect(JSON.stringify(exported)).not.toContain(secret);
    expect(visibleOpencodeEvent({ type: "user/message", data: { message: { role: "user", content: "plain" } } }, "phren"))
      .toMatchObject({ data: { message: { role: "user", content: "plain" } } });
  });

  it("projects OpenCode run events for the opencode source and not for phren's own log", () => {
    const run = { type: "text", timestamp: 1_789_845_268_396, part: { type: "text", text: "Visible", reasoning: "secret" } };
    const exported = visibleOpencodeEvent(run, "opencode");
    expect(exported).toEqual({
      type: "assistant/message",
      time: "2026-09-19T19:14:28.396Z",
      data: { message: { role: "assistant", content: [{ type: "text", text: "Visible" }] } },
    });
    expect(JSON.stringify(exported)).not.toContain("secret");
    expect(visibleOpencodeEvent(run, "phren")).toBeUndefined();
  });

  it("falls through to phren's tool-result rows when an opencode row is not a run event", () => {
    const raw: Json = {
      seq: 4,
      time: "2026-10-01T00:00:02.000Z",
      type: "tool/results",
      data: {
        message: { role: "user", content: [
          { type: "tool_result", tool_use_id: "call-1", content: "ok" },
          { type: "reasoning", text: "hidden" },
        ] },
        turn: 1,
      },
    };
    expect(visibleOpencodeEvent(raw, "opencode")).toEqual({
      seq: 4,
      time: "2026-10-01T00:00:02.000Z",
      type: "tool/results",
      data: {
        message: { role: "user", content: [
          { type: "tool_result", tool_use_id: "call-1", content: "ok" },
          { type: "redacted" },
        ] },
        turn: 1,
      },
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import type { ContentBlock, LlmMessage, LlmProvider, LlmResponse, StreamDelta } from "../providers/types.js";
import { IncompleteStreamError, RetryableProviderError } from "../providers/types.js";
import type { AgentConfig } from "../agent-loop.js";
import { ToolRegistry } from "../tools/registry.js";
import { withRetry } from "../providers/retry.js";
import { parseOpenAiResponse, parseOpenAiStream, parseToolArguments } from "../providers/openai-compat.js";
import { consumeStream } from "../agent-loop/stream.js";

vi.mock("../spinner.js", () => ({
  createSpinner: () => ({ start: vi.fn(), update: vi.fn(), stop: vi.fn() }),
  formatTurnHeader: () => "",
  formatToolCall: () => "",
}));
vi.mock("../memory/error-recovery.js", () => ({ searchErrorRecovery: vi.fn().mockResolvedValue("") }));
vi.mock("../memory/auto-capture.js", () => ({
  createCaptureState: () => ({ captured: 0, hashes: new Set(), lastCaptureTime: 0 }),
  analyzeAndCapture: vi.fn().mockResolvedValue(0),
}));
vi.mock("../checkpoint.js", () => ({ createCheckpoint: vi.fn().mockReturnValue(null) }));
vi.mock("../tools/lint-test.js", () => ({ detectLintCommand: () => null, detectTestCommand: () => null }));

const { runTurn, createSession } = await import("../agent-loop/index.js");

const fast = { baseDelayMs: 1, maxDelayMs: 2 };
const quiet = { onStatus: () => {}, onTextDelta: () => {}, onTextBlock: () => {} };

function config(provider: LlmProvider, executed: Array<Record<string, unknown>>): AgentConfig {
  const registry = new ToolRegistry();
  registry.setPermissions({ mode: "full-auto", projectRoot: process.cwd(), allowedPaths: [] });
  registry.register({
    name: "write_note",
    description: "write",
    input_schema: { type: "object", properties: { text: { type: "string" } } },
    async execute(input) {
      executed.push(input);
      return { output: "written" };
    },
  });
  return { provider, registry, systemPrompt: "sys", maxTurns: 10, verbose: false };
}

function sse(lines: string[]): Response {
  return new Response(`${lines.join("\n")}\n`);
}
const data = (chunk: unknown) => `data: ${JSON.stringify(chunk)}`;

describe("retryable provider failures", () => {
  it("insufficient_system_resource throws a retryable error from stream and batch parsers", async () => {
    const stream = parseOpenAiStream(sse([
      data({ choices: [{ delta: { content: "half an ans" } }] }),
      data({ choices: [{ delta: {}, finish_reason: "insufficient_system_resource" }] }),
      "data: [DONE]",
    ]));
    await expect(consumeStream(stream, null, () => {})).rejects.toBeInstanceOf(RetryableProviderError);
    expect(() => parseOpenAiResponse({ choices: [{ message: { content: "x" }, finish_reason: "insufficient_system_resource" }] }))
      .toThrow(RetryableProviderError);
  });

  it("withRetry retries marked errors, 504 and a mid-body socket drop", async () => {
    for (const err of [
      new RetryableProviderError("capacity"),
      new IncompleteStreamError("cut off"),
      new Error("OpenAI API error 504: gateway timeout"),
      Object.assign(new TypeError("terminated"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }),
    ]) {
      const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("ok");
      await expect(withRetry(fn, fast)).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    }
  });

  it("does not retry ordinary errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("API error 400: bad request"));
    await expect(withRetry(fn, fast)).rejects.toThrow(/400/);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("mid-stream retry", () => {
  it("re-requests a stream that fails after output started, and the turn completes", async () => {
    let calls = 0;
    const provider: LlmProvider = {
      name: "mock",
      async chat(): Promise<LlmResponse> { throw new Error("unused"); },
      async *chatStream(): AsyncIterable<StreamDelta> {
        calls++;
        yield { type: "text_delta", text: calls === 1 ? "partial " : "complete answer" };
        if (calls === 1) throw new IncompleteStreamError("stream ended early");
        yield { type: "done", stop_reason: "end_turn" };
      },
    };
    const retried = vi.fn();
    const shown: string[] = [];
    const result = await runTurn("go", createSession(), config(provider, []), {
      ...quiet,
      onTextDelta: (t) => shown.push(t),
      onStreamRetry: retried,
    });
    expect(calls).toBe(2);
    expect(retried).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("end_turn");
    expect(result.text).toBe("complete answer");
    expect(shown).toEqual(["partial ", "complete answer", "\n"]);
  });
});

describe("malformed tool-call JSON", () => {
  it("parseToolArguments: empty means no arguments; junk and non-objects are errors", () => {
    expect(parseToolArguments("")).toEqual({ input: {} });
    expect(parseToolArguments("  ")).toEqual({ input: {} });
    expect(parseToolArguments('{"a":1}')).toEqual({ input: { a: 1 } });
    expect(parseToolArguments('{"text": "unterminated')).toHaveProperty("error");
    expect(parseToolArguments("[1]")).toEqual({ error: "arguments must be a JSON object" });
  });

  it("streamed: the call gets an error result and the tool never runs", async () => {
    const requests: LlmMessage[][] = [];
    let call = 0;
    const provider: LlmProvider = {
      name: "mock",
      async chat(): Promise<LlmResponse> { throw new Error("unused"); },
      async *chatStream(_s, messages): AsyncIterable<StreamDelta> {
        requests.push(structuredClone(messages));
        call++;
        if (call === 1) {
          yield { type: "tool_use_start", id: "ok", name: "write_note" };
          yield { type: "tool_use_delta", id: "ok", json: '{"text":"fine"}' };
          yield { type: "tool_use_end", id: "ok" };
          yield { type: "tool_use_start", id: "bad", name: "write_note" };
          yield { type: "tool_use_delta", id: "bad", json: '{"text": "oops' };
          yield { type: "tool_use_end", id: "bad" };
          yield { type: "done", stop_reason: "tool_use" };
        } else {
          yield { type: "text_delta", text: "done" };
          yield { type: "done", stop_reason: "end_turn" };
        }
      },
    };
    const executed: Array<Record<string, unknown>> = [];
    const ended: Array<[string, boolean]> = [];
    const result = await runTurn("go", createSession(), config(provider, executed), {
      ...quiet,
      onToolStart: () => {},
      onToolEnd: (name, _i, _o, isError) => ended.push([name, isError]),
    });
    expect(result.stopReason).toBe("end_turn");
    expect(executed).toEqual([{ text: "fine" }]);
    expect(result.toolCalls).toBe(2);
    const results = requests[1].at(-1)!.content as ContentBlock[];
    expect(results.map((r) => (r as { tool_use_id: string }).tool_use_id)).toEqual(["ok", "bad"]);
    expect(results[0]).toMatchObject({ is_error: false, content: "written" });
    expect(results[1]).toMatchObject({ is_error: true });
    expect(String((results[1] as { content: string }).content)).toMatch(/^Not run: the arguments for write_note were not valid JSON .*You sent: \{"text": "oops$/);
    expect(ended).toContainEqual(["write_note", true]);
  });

  it("batch: parseOpenAiResponse reports the invalid call and runTurn answers it", async () => {
    const parsed = parseOpenAiResponse({
      choices: [{
        message: { tool_calls: [{ id: "b1", type: "function", function: { name: "write_note", arguments: "{oops" } }] },
        finish_reason: "tool_calls",
      }],
    });
    expect(parsed.invalidToolCalls).toEqual([{ id: "b1", name: "write_note", raw: "{oops", error: expect.any(String) }]);

    const replies: LlmResponse[] = [parsed, { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }];
    const seen: LlmMessage[][] = [];
    const provider: LlmProvider = {
      name: "mock",
      async chat(_s, messages): Promise<LlmResponse> {
        seen.push(structuredClone(messages));
        return replies.shift()!;
      },
    };
    const executed: Array<Record<string, unknown>> = [];
    await runTurn("go", createSession(), config(provider, executed), quiet);
    expect(executed).toEqual([]);
    expect((seen[1].at(-1)!.content as ContentBlock[])[0]).toMatchObject({ type: "tool_result", tool_use_id: "b1", is_error: true });
  });

  it("a no-argument call with empty arguments still runs", async () => {
    const stream = parseOpenAiStream(sse([
      data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "n", function: { name: "git_status", arguments: "" } }] } }] }),
      data({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      "data: [DONE]",
    ]));
    const out = await consumeStream(stream, null, () => {});
    expect(out.invalidToolCalls).toEqual([]);
    expect(out.content).toEqual([{ type: "tool_use", id: "n", name: "git_status", input: {} }]);
  });
});

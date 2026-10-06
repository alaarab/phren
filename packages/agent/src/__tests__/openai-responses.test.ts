import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentToolDef, StreamDelta } from "../providers/types.js";
import { OpenAiResponsesProvider } from "../providers/openai-responses.js";

const tool: AgentToolDef = {
  name: "grep",
  description: "Search files",
  input_schema: { type: "object", properties: { pattern: { type: "string" } } },
};

function jsonResponse(value: Record<string, unknown>): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

function sseResponse(events: Record<string, unknown>[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

async function collect(stream: AsyncIterable<StreamDelta>): Promise<StreamDelta[]> {
  const result: StreamDelta[] = [];
  for await (const delta of stream) result.push(delta);
  return result;
}

afterEach(() => vi.unstubAllGlobals());

describe("OpenAiResponsesProvider", () => {
  it("uses Responses for native OpenAI tool calls, effort, and opaque reasoning round-trips", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({
      output: [
        {
          type: "reasoning",
          id: "rs_next",
          encrypted_content: "next-secret",
          summary: [{ type: "summary_text", text: "considered" }],
        },
        { type: "function_call", call_id: "call_next", name: "grep", arguments: '{"pattern":"todo"}' },
      ],
      status: "completed",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiResponsesProvider("sk-test", "gpt-5.4", "https://api.test/v1", 12_345, "high");
    const response = await provider.chat(
      "You are concise.",
      [
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "foreign", provider: "openai-codex", id: "rs_foreign", encrypted_content: "wrong-wire" },
            { type: "reasoning", text: "ours", provider: "openai", id: "rs_1", encrypted_content: "right-wire" },
            { type: "tool_use", id: "call_1", name: "grep", input: { pattern: "old" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "old result" }] },
      ],
      [tool],
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/responses");
    expect(init.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer sk-test" });
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "gpt-5.4",
      instructions: "You are concise.",
      max_output_tokens: 12_345,
      store: false,
      stream: false,
      reasoning: { effort: "high" },
      tool_choice: "auto",
    });
    expect(body.tools).toEqual([{ type: "function", name: "grep", description: "Search files", parameters: tool.input_schema }]);
    expect(body.input).toEqual([
      { type: "reasoning", id: "rs_1", encrypted_content: "right-wire", summary: [] },
      { type: "function_call", call_id: "call_1", name: "grep", arguments: '{"pattern":"old"}' },
      { type: "function_call_output", call_id: "call_1", output: "old result" },
    ]);
    expect(response.content).toEqual([
      { type: "reasoning", text: "considered", provider: "openai", id: "rs_next", encrypted_content: "next-secret" },
      { type: "tool_use", id: "call_next", name: "grep", input: { pattern: "todo" } },
    ]);
    expect(response.stop_reason).toBe("tool_use");
  });

  it("maps Responses SSE output into text, reasoning, tool, and completion deltas", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => sseResponse([
      { type: "response.output_item.added", item: { type: "function_call", id: "fc_item", call_id: "call_2", name: "grep" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_item", delta: '{"pattern":' },
      { type: "response.function_call_arguments.delta", item_id: "fc_item", delta: '"todo"}' },
      { type: "response.function_call_arguments.done", item_id: "fc_item", arguments: '{"pattern":"todo"}' },
      { type: "response.output_item.added", item: { type: "reasoning", id: "rs_stream" } },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_stream", delta: "checking" },
      { type: "response.output_item.done", item: { type: "reasoning", id: "rs_stream", encrypted_content: "stream-secret" } },
      { type: "response.output_text.delta", delta: "done" },
      {
        type: "response.completed",
        response: { status: "completed", output: [{ type: "function_call", call_id: "call_2" }], usage: { input_tokens: 7, output_tokens: 5 } },
      },
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiResponsesProvider("sk-test", "o3", "https://api.test/v1", 100, "medium");
    const deltas = await collect(provider.chatStream("system", [{ role: "user", content: "find todo" }], [tool]));

    expect(deltas).toEqual([
      { type: "tool_use_start", id: "call_2", name: "grep" },
      { type: "tool_use_delta", id: "call_2", json: '{"pattern":' },
      { type: "tool_use_delta", id: "call_2", json: '"todo"}' },
      { type: "tool_use_end", id: "call_2" },
      { type: "reasoning_delta", text: "checking" },
      { type: "reasoning_end", id: "rs_stream", encrypted_content: "stream-secret" },
      { type: "text_delta", text: "done" },
      { type: "done", stop_reason: "tool_use", usage: { input_tokens: 7, output_tokens: 5 } },
    ]);
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.reasoning).toEqual({ effort: "medium" });
  });

  it("surfaces a provider stream error and does not turn it into a successful completion", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => sseResponse([
      { type: "response.failed", response: { error: { code: "server_error", message: "upstream unavailable" } } },
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiResponsesProvider("sk-test", "gpt-5.4", "https://api.test/v1");
    await expect(collect(provider.chatStream("system", [{ role: "user", content: "hello" }], [])))
      .rejects.toThrow("OpenAI Responses API error (server_error): upstream unavailable");
  });
});

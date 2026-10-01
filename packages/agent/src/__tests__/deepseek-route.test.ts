import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../agent-loop.js";
import { ToolRegistry } from "../tools/registry.js";
import { OpenAiProvider } from "../providers/openrouter.js";

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

const quiet = { onStatus: () => {}, onTextDelta: () => {}, onTextBlock: () => {} };

function sse(chunks: unknown[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/**
 * A fake DeepSeek chat-completions endpoint that enforces the thinking-mode
 * rule: with tools present, every earlier assistant message must carry its
 * reasoning_content, or the request is rejected with 400.
 */
function fakeDeepSeek(script: Array<() => Response>) {
  const requests: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push(body);
    const messages = body.messages as Array<Record<string, unknown>>;
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      const missing = messages.findIndex((m) => m.role === "assistant" && typeof m.reasoning_content !== "string");
      if (missing !== -1) {
        return new Response(
          JSON.stringify({ error: { message: `The reasoning_content in the thinking mode must be passed back to the API (message ${missing})` } }),
          { status: 400 },
        );
      }
    }
    const next = script.shift();
    if (!next) throw new Error("fake DeepSeek ran out of scripted responses");
    return next();
  });
  return { fetchMock, requests };
}

function config(provider: OpenAiProvider): AgentConfig {
  const registry = new ToolRegistry();
  registry.setPermissions({ mode: "full-auto", projectRoot: process.cwd(), allowedPaths: [] });
  registry.register({
    name: "echo",
    description: "echo",
    input_schema: { type: "object", properties: {} },
    async execute(input) { return { output: `echo ${JSON.stringify(input)}` }; },
  });
  return { provider, registry, systemPrompt: "sys", maxTurns: 10, verbose: false };
}

afterEach(() => vi.unstubAllGlobals());

describe("DeepSeek two-turn session", () => {
  for (const [label, name, model] of [
    ["direct", "deepseek", "deepseek-flash"],
    ["OpenCode Go", "openai-compat", "deepseek-v4.1-flash"],
  ] as const) {
    it(`a plain answer followed by a tool turn does not 400 (${label})`, async () => {
      const { fetchMock, requests } = fakeDeepSeek([
        // Turn 1: thinking + a plain answer, no tool call.
        () => sse([
          { choices: [{ delta: { reasoning_content: "user says hi" } }] },
          { choices: [{ delta: { content: "Hello." } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3 } },
        ]),
        // Turn 2: thinking + a tool call…
        () => sse([
          { choices: [{ delta: { reasoning_content: "need the tool" } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "echo", arguments: "{}" } }] } }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ]),
        // …then the final answer.
        () => sse([
          { choices: [{ delta: { reasoning_content: "done" } }] },
          { choices: [{ delta: { content: "Ran it." } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
      ]);
      vi.stubGlobal("fetch", fetchMock);

      const provider = new OpenAiProvider("sk", model, "https://fake.test/v1").withName(name);
      const session = createSession(provider.contextWindow);
      const cfg = config(provider);

      const first = await runTurn("hi", session, cfg, quiet);
      expect(first.text).toContain("Hello.");
      const second = await runTurn("now run echo", session, cfg, quiet);
      expect(second.text).toContain("Ran it.");

      expect(requests).toHaveLength(3);
      const priorAssistant = (requests[1].messages as Array<Record<string, unknown>>).find((m) => m.role === "assistant");
      expect(priorAssistant).toMatchObject({ content: "Hello.", reasoning_content: "user says hi" });
    });
  }

  it("the fake endpoint does reject a plain answer without its reasoning (guards the test itself)", async () => {
    const { fetchMock } = fakeDeepSeek([]);
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetch("https://fake.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        tools: [{ type: "function", function: { name: "echo" } }],
        messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "Hello." }, { role: "user", content: "again" }],
      }),
    });
    expect(res.status).toBe(400);
  });
});

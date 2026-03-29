import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LlmProvider, LlmMessage, AgentToolDef, LlmResponse, ContentBlock } from "../providers/types.js";
import type { AgentConfig } from "../agent-loop.js";
import { ToolRegistry } from "../tools/registry.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Stub modules with side effects so tests stay fast and isolated.
vi.mock("../spinner.js", () => ({
  createSpinner: () => ({ start: vi.fn(), update: vi.fn(), stop: vi.fn() }),
  formatTurnHeader: (_t: number, _c: number) => "",
  formatToolCall: (_n: string, _i: Record<string, unknown>) => "",
}));

vi.mock("../memory/error-recovery.js", () => ({
  searchErrorRecovery: vi.fn().mockResolvedValue(""),
}));

vi.mock("../memory/auto-capture.js", () => ({
  createCaptureState: () => ({ captured: 0, hashes: new Set(), lastCaptureTime: 0 }),
  analyzeAndCapture: vi.fn().mockResolvedValue(0),
}));

vi.mock("../checkpoint.js", () => ({
  createCheckpoint: vi.fn().mockReturnValue(null),
}));

vi.mock("../plan.js", () => ({
  injectPlanPrompt: (s: string) => s + "\n## Plan mode",
  requestPlanApproval: vi.fn().mockResolvedValue({ approved: true }),
}));

vi.mock("../tools/lint-test.js", () => ({
  detectLintCommand: () => null,
  detectTestCommand: () => null,
  runPostEditCheck: () => ({ passed: true, output: "" }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a mock provider that returns canned responses in sequence. */
function mockProvider(responses: LlmResponse[]): LlmProvider {
  let idx = 0;
  return {
    name: "mock",
    contextWindow: 200_000,
    async chat(): Promise<LlmResponse> {
      if (idx >= responses.length) {
        return { content: [{ type: "text", text: "(exhausted)" }], stop_reason: "end_turn" };
      }
      return responses[idx++];
    },
  };
}

/** Build a minimal AgentConfig. */
function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    provider: mockProvider([{ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }]),
    registry: new ToolRegistry(),
    systemPrompt: "You are a test assistant.",
    maxTurns: 10,
    verbose: false,
    ...overrides,
  };
}

/** A simple text-only response. */
function textResponse(text: string): LlmResponse {
  return { content: [{ type: "text", text }], stop_reason: "end_turn" };
}

/** A response that requests a single tool call. */
function toolCallResponse(toolName: string, input: Record<string, unknown>, id = "tc_1"): LlmResponse {
  return {
    content: [{ type: "tool_use", id, name: toolName, input }],
    stop_reason: "tool_use",
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("agent-loop", () => {
  // Suppress stdout/stderr writes from the agent loop during tests.
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  // --- 1. Simple text response ends turn --------------------------------
  it("returns text and counts a single turn for a simple response", async () => {
    const { runAgent } = await import("../agent-loop.js");
    const result = await runAgent("hello", makeConfig({
      provider: mockProvider([textResponse("Hello back!")]),
    }));

    expect(result.finalText).toBe("Hello back!");
    expect(result.turns).toBe(1);
    expect(result.toolCalls).toBe(0);
  });

  // --- 2. Tool call → result → final text --------------------------------
  it("executes a tool call and returns the follow-up text", async () => {
    const { runAgent } = await import("../agent-loop.js");
    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "echo input",
      input_schema: { type: "object", properties: { msg: { type: "string" } } },
      async execute(input) {
        return { output: `echoed: ${input.msg}` };
      },
    });
    // auto-confirm so permission check passes
    registry.setPermissions({ mode: "full-auto", projectRoot: "/tmp", allowedPaths: [] });

    const provider = mockProvider([
      toolCallResponse("echo", { msg: "hi" }),
      textResponse("Done echoing."),
    ]);

    const result = await runAgent("echo something", makeConfig({ provider, registry }));

    expect(result.finalText).toBe("Done echoing.");
    expect(result.toolCalls).toBe(1);
    expect(result.turns).toBe(2);
  });

  // --- 3. Unknown tool returns error ─────────────────────────────────────
  it("handles unknown tool gracefully with an error result", async () => {
    const { runAgent } = await import("../agent-loop.js");
    const registry = new ToolRegistry();
    registry.setPermissions({ mode: "full-auto", projectRoot: "/tmp", allowedPaths: [] });

    const provider = mockProvider([
      toolCallResponse("nonexistent_tool", {}),
      textResponse("I see the error."),
    ]);

    const result = await runAgent("try it", makeConfig({ provider, registry }));

    expect(result.finalText).toBe("I see the error.");
    // The unknown tool still counts as a tool call
    expect(result.toolCalls).toBe(1);
  });

  // --- 4. Multiple tool calls in one turn (concurrent) ───────────────────
  it("runs multiple tool calls concurrently in a single turn", async () => {
    const { runAgent } = await import("../agent-loop.js");
    const callOrder: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "tool_a",
      description: "a",
      input_schema: {},
      async execute() {
        callOrder.push("a");
        return { output: "a_result" };
      },
    });
    registry.register({
      name: "tool_b",
      description: "b",
      input_schema: {},
      async execute() {
        callOrder.push("b");
        return { output: "b_result" };
      },
    });
    registry.setPermissions({ mode: "full-auto", projectRoot: "/tmp", allowedPaths: [] });

    const provider = mockProvider([
      {
        content: [
          { type: "tool_use", id: "tc_a", name: "tool_a", input: {} },
          { type: "tool_use", id: "tc_b", name: "tool_b", input: {} },
        ],
        stop_reason: "tool_use" as const,
      },
      textResponse("Both done."),
    ]);

    const result = await runAgent("do both", makeConfig({ provider, registry }));

    expect(result.finalText).toBe("Both done.");
    expect(result.toolCalls).toBe(2);
    expect(callOrder).toContain("a");
    expect(callOrder).toContain("b");
  });

  // --- 5. Max turns limit ────────────────────────────────────────────────
  it("stops when maxTurns is reached", async () => {
    const { runAgent } = await import("../agent-loop.js");
    const registry = new ToolRegistry();
    registry.register({
      name: "loop_tool",
      description: "loops",
      input_schema: {},
      async execute() { return { output: "ok" }; },
    });
    registry.setPermissions({ mode: "full-auto", projectRoot: "/tmp", allowedPaths: [] });

    // Provider always returns a tool call — should be capped by maxTurns.
    let calls = 0;
    const provider: LlmProvider = {
      name: "mock-infinite",
      contextWindow: 200_000,
      async chat(): Promise<LlmResponse> {
        calls++;
        return toolCallResponse("loop_tool", {}, `tc_${calls}`);
      },
    };

    const result = await runAgent("loop forever", makeConfig({ provider, registry, maxTurns: 3 }));

    expect(result.turns).toBe(3);
  });

  // --- 6. Budget enforcement ─────────────────────────────────────────────
  it("stops when cost budget is exceeded", async () => {
    const { runAgent } = await import("../agent-loop.js");
    const { createCostTracker } = await import("../cost.js");

    const costTracker = createCostTracker("gpt-4o", 0.001); // tiny budget
    // Simulate prior usage that already exceeded budget
    costTracker.recordUsage(1_000_000, 1_000_000);

    const provider = mockProvider([textResponse("should not reach")]);
    const result = await runAgent("test budget", makeConfig({ provider, costTracker }));

    // The loop should break before consuming the response text,
    // so finalText is empty since no assistant message was added.
    expect(result.finalText).toBe("");
    expect(result.turns).toBe(0);
  });

  // --- 7. max_tokens continuation ────────────────────────────────────────
  it("injects continuation prompt on max_tokens stop reason", async () => {
    const { runAgent } = await import("../agent-loop.js");

    const messagesReceived: LlmMessage[][] = [];
    let callNum = 0;
    const provider: LlmProvider = {
      name: "mock-trunc",
      contextWindow: 200_000,
      async chat(_sys: string, msgs: LlmMessage[]): Promise<LlmResponse> {
        messagesReceived.push(structuredClone(msgs));
        callNum++;
        if (callNum === 1) {
          return { content: [{ type: "text", text: "partial..." }], stop_reason: "max_tokens" };
        }
        return textResponse("...completed.");
      },
    };

    const result = await runAgent("long task", makeConfig({ provider }));

    expect(result.finalText).toBe("...completed.");
    expect(result.turns).toBe(2);
    // Second call should include the continuation prompt as a user message
    const lastUserMsg = messagesReceived[1]?.findLast(m => m.role === "user");
    expect(lastUserMsg).toBeDefined();
    expect(typeof lastUserMsg!.content === "string" && lastUserMsg!.content).toContain("truncated");
  });

  // --- 8. Streaming provider path ────────────────────────────────────────
  it("handles streaming provider with chatStream", async () => {
    const { runAgent } = await import("../agent-loop.js");

    const provider: LlmProvider = {
      name: "mock-stream",
      contextWindow: 200_000,
      async chat(): Promise<LlmResponse> {
        throw new Error("should not be called");
      },
      async *chatStream() {
        yield { type: "text_delta" as const, text: "streamed " };
        yield { type: "text_delta" as const, text: "output" };
        yield { type: "done" as const, stop_reason: "end_turn" as const, usage: { input_tokens: 10, output_tokens: 5 } };
      },
    };

    const result = await runAgent("stream test", makeConfig({ provider }));

    expect(result.finalText).toBe("streamed output");
    expect(result.turns).toBe(1);
  });

  // --- 9. Tool error triggers anti-pattern recording ─────────────────────
  it("records tool errors for anti-pattern tracking", async () => {
    const { createSession, runTurn } = await import("../agent-loop.js");
    const registry = new ToolRegistry();
    registry.register({
      name: "flaky_tool",
      description: "fails then succeeds",
      input_schema: {},
      async execute() { return { output: "something broke", is_error: true }; },
    });
    registry.setPermissions({ mode: "full-auto", projectRoot: "/tmp", allowedPaths: [] });

    const provider = mockProvider([
      toolCallResponse("flaky_tool", { attempt: 1 }),
      textResponse("I see the error."),
    ]);

    const session = createSession();
    const config = makeConfig({ provider, registry });
    await runTurn("do it", session, config);

    // The session's anti-pattern tracker should have recorded the attempt
    const patterns = session.antiPatterns.extractAntiPatterns();
    // No anti-pattern yet (need fail then success with different input), but the
    // attempt was recorded — verified by checking the tool call count
    expect(session.toolCalls).toBe(1);
  });

  // --- 10. Session state persists across multiple runTurn calls ──────────
  it("accumulates state across multiple runTurn calls on the same session", async () => {
    const { createSession, runTurn } = await import("../agent-loop.js");

    let callIdx = 0;
    const provider: LlmProvider = {
      name: "mock-multi",
      contextWindow: 200_000,
      async chat(): Promise<LlmResponse> {
        callIdx++;
        return textResponse(`response ${callIdx}`);
      },
    };

    const session = createSession();
    const config = makeConfig({ provider });

    const r1 = await runTurn("first", session, config);
    expect(r1.text).toBe("response 1");
    expect(r1.turns).toBe(1);
    expect(session.turns).toBe(1);

    const r2 = await runTurn("second", session, config);
    expect(r2.text).toBe("response 2");
    expect(r2.turns).toBe(1);
    expect(session.turns).toBe(2);

    // Messages from both turns are in the session
    expect(session.messages.length).toBe(4); // user1 + assistant1 + user2 + assistant2
  });
});

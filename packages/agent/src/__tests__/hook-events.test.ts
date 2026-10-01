import { describe, expect, it, vi } from "vitest";
import type { LlmMessage, LlmProvider, LlmResponse } from "../providers/types.js";
import type { AgentConfig } from "../agent-loop.js";
import { ToolRegistry } from "../tools/registry.js";
import { runLifecycleHooks, type HookExecutor, type HooksConfig } from "../user-hooks.js";
import { DIFF_MARKER } from "../multi/diff-renderer.js";
import { modelVisibleOutput } from "../agent-loop/stream.js";

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

/** Real shell hooks: each command is run by sh, its exit code and output real. */
const hook = (command: string) => [{ command }];

function provider(replies: LlmResponse[], requests: LlmMessage[][]): LlmProvider {
  return {
    name: "mock",
    contextWindow: 200_000,
    async chat(_s, messages): Promise<LlmResponse> {
      requests.push(structuredClone(messages));
      return replies.shift() ?? { content: [{ type: "text", text: "(none)" }], stop_reason: "end_turn" };
    },
  };
}

function config(p: LlmProvider, hookConfig: HooksConfig): AgentConfig {
  const registry = new ToolRegistry();
  registry.setPermissions({ mode: "full-auto", projectRoot: process.cwd(), allowedPaths: [] });
  return { provider: p, registry, systemPrompt: "sys", maxTurns: 10, verbose: false, hookConfig };
}

describe("UserPromptSubmit", () => {
  it("exit 2 blocks the prompt: nothing is sent or logged", async () => {
    const requests: LlmMessage[][] = [];
    const session = createSession();
    const result = await runTurn("deploy prod", session, config(provider([], requests), {
      UserPromptSubmit: hook("echo 'no deploys on Friday' >&2; exit 2"),
    }), quiet);
    expect(result.stopReason).toBe("hook_blocked");
    expect(requests).toHaveLength(0);
    expect(session.messages).toHaveLength(0);
  });

  it("exit 0 stdout rides along with the prompt as context", async () => {
    const requests: LlmMessage[][] = [];
    await runTurn("fix it", createSession(), config(provider([{ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }], requests), {
      UserPromptSubmit: hook("echo 'ticket ABC-1 is about the login page'"),
    }), quiet);
    expect(String(requests[0][0].content)).toContain("fix it");
    expect(String(requests[0][0].content)).toContain("ticket ABC-1 is about the login page");
  });
});

describe("Stop", () => {
  it("exit 2 sends the model back to work with the reason, and says it already did", async () => {
    const requests: LlmMessage[][] = [];
    const replies: LlmResponse[] = [
      { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
      { content: [{ type: "text", text: "now really done" }], stop_reason: "end_turn" },
    ];
    // Blocks the first stop only: the second run sees stop_hook_active true.
    const result = await runTurn("work", createSession(), config(provider(replies, requests), {
      Stop: hook("grep -q '\"stop_hook_active\":true' || { echo 'tests still fail' >&2; exit 2; }"),
    }), quiet);
    expect(result.text).toBe("now really done");
    expect(result.stopReason).toBe("end_turn");
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1].at(-1))).toContain("tests still fail");
  });

  it("can't keep the model going forever", async () => {
    const requests: LlmMessage[][] = [];
    const replies = Array.from({ length: 10 }, () => ({ content: [{ type: "text" as const, text: "done" }], stop_reason: "end_turn" as const }));
    const result = await runTurn("work", createSession(), config(provider(replies, requests), {
      Stop: hook("echo again >&2; exit 2"),
    }), quiet);
    expect(result.stopReason).toBe("end_turn");
    expect(requests).toHaveLength(6); // the first stop, then 5 blocks
  });
});

describe("SessionStart, PreCompact and PostToolUse", () => {
  it("SessionStart and PreCompact pass their payload; stdout is context", async () => {
    const seen: string[] = [];
    const executor: HookExecutor = async (_cmd, stdin) => {
      seen.push(stdin);
      return { exitCode: 0, stdout: "branch main, 3 open PRs", stderr: "", timedOut: false };
    };
    const started = await runLifecycleHooks({ SessionStart: hook("x") }, "SessionStart", { source: "resume" }, { executor });
    expect(started).toEqual({ blocked: false, reason: "", context: "branch main, 3 open PRs" });
    await runLifecycleHooks({ PreCompact: hook("x") }, "PreCompact", { trigger: "auto" }, { executor });
    expect(JSON.parse(seen[0])).toMatchObject({ hook_event_name: "SessionStart", source: "resume" });
    expect(JSON.parse(seen[1])).toMatchObject({ hook_event_name: "PreCompact", trigger: "auto" });
  });

  it("a PostToolUse hook exiting 2 tells the model, before the TUI's diff payload", async () => {
    const registry = new ToolRegistry();
    registry.setPermissions({ mode: "full-auto", projectRoot: process.cwd(), allowedPaths: [] });
    registry.register({
      name: "edit_file",
      description: "edit",
      input_schema: { type: "object", properties: {} },
      async execute() { return { output: `Edited a.ts${DIFF_MARKER}{"diff":1}` }; },
    });
    registry.hookConfig = { PostToolUse: [{ matcher: "edit_file", command: "echo 'lint: missing semicolon' >&2; exit 2" }] };
    const result = await registry.execute("edit_file", {});
    expect(modelVisibleOutput(result.output)).toContain("PostToolUse hook: lint: missing semicolon");
    expect(result.output).toContain(DIFF_MARKER);
  });
});

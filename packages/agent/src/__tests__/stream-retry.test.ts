import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { LlmProvider, LlmResponse, StreamDelta } from "../providers/types.js";
import { IncompleteStreamError } from "../providers/types.js";
import type { AgentConfig } from "../agent-loop.js";
import { ToolRegistry } from "../tools/registry.js";
import { withRetry } from "../providers/retry.js";
import { livePreview } from "../session/preview.js";
import { createIpcHooks } from "../multi/ipc-hooks.js";
import type { ChildMessage } from "../multi/types.js";

vi.mock("../spinner.js", () => ({
  createSpinner: () => ({ start: vi.fn(), update: vi.fn(), stop: vi.fn() }),
  formatTurnHeader: () => "",
  formatToolCall: () => "",
}));
vi.mock("../checkpoint.js", () => ({ createCheckpoint: vi.fn().mockReturnValue(null) }));
vi.mock("../tools/lint-test.js", () => ({ detectLintCommand: () => null, detectTestCommand: () => null }));

const { runTurn, createSession } = await import("../agent-loop/index.js");

/** Backoff sleeps (the retry's, at least 1 s) run at once; `atSleep` sees the state when one starts. */
function fastBackoff(atSleep: () => void = () => {}): void {
  const real = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
    if ((ms ?? 0) >= 1000) { atSleep(); return real(fn, 0); }
    return real(fn, ms);
  }) as typeof setTimeout);
}

afterEach(() => { vi.restoreAllMocks(); });

function config(provider: LlmProvider, preview?: string): AgentConfig {
  const registry = new ToolRegistry();
  registry.setPermissions({ mode: "full-auto", projectRoot: process.cwd(), allowedPaths: [] });
  return {
    provider, registry, systemPrompt: "sys", maxTurns: 5, verbose: false,
    ...(preview ? { livePreview: () => livePreview(preview) } : {}),
  };
}

/** Fails `failures` times after writing "abandoned", then answers "Final answer". */
function flaky(failures: number, onAttempt: (n: number) => void = () => {}): LlmProvider & { calls: number } {
  const provider = {
    name: "mock",
    calls: 0,
    async chat(): Promise<LlmResponse> { throw new Error("unused"); },
    async *chatStream(): AsyncIterable<StreamDelta> {
      provider.calls++;
      onAttempt(provider.calls);
      if (provider.calls <= failures) {
        yield { type: "text_delta", text: "abandoned " };
        throw new IncompleteStreamError("stream ended early");
      }
      yield { type: "text_delta", text: "Final " };
      onAttempt(-provider.calls);
      yield { type: "text_delta", text: "answer" };
      yield { type: "done", stop_reason: "end_turn" };
    },
  };
  return provider;
}

describe("withRetry onRetry", () => {
  it("runs before the backoff sleep", async () => {
    const order: string[] = [];
    fastBackoff(() => order.push("sleep"));
    const fn = vi.fn().mockRejectedValueOnce(new IncompleteStreamError("cut")).mockResolvedValue("ok");
    await withRetry(fn, { onRetry: (attempt) => order.push(`retry ${attempt}`) });
    expect(order).toEqual(["retry 1", "sleep"]);
  });
});

describe("live preview across retries", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "phren-retry-preview-"));
  const read = (file: string) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).text : null;

  it("a retried stream clears the sidecar before the wait and restarts it with the new attempt's text", async () => {
    const dir = tmp();
    const file = path.join(dir, "session.events.jsonl.preview.json");
    const seen: Array<string | null> = [];
    try {
      fastBackoff(() => seen.push(`at sleep: ${read(file)}`));
      const provider = flaky(1, (n) => {
        if (n === 1) seen.push(`attempt 1 start: ${read(file)}`);
        if (n === -2) seen.push(`attempt 2 mid: ${read(file)}`);
      });
      const result = await runTurn("go", createSession(), config(provider, file), { onStatus: () => {}, onTextDelta: () => {}, onStreamRetry: () => {} });
      expect(result.text).toBe("Final answer");
      expect(seen).toEqual(["attempt 1 start: null", "at sleep: null", "attempt 2 mid: Final "]);
      // Removed once the message is in the log.
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is empty after the final failure", async () => {
    const dir = tmp();
    const file = path.join(dir, "session.events.jsonl.preview.json");
    try {
      fastBackoff();
      const provider = flaky(10);
      await expect(runTurn("go", createSession(), config(provider, file), { onStatus: () => {}, onTextDelta: () => {}, onStreamRetry: () => {} }))
        .rejects.toBeInstanceOf(IncompleteStreamError);
      expect(provider.calls).toBe(4);
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("retry without a UI that can take text back", () => {
  it("ends the abandoned line and says the reply starts again (REPL, one-shot)", async () => {
    fastBackoff();
    const shown: string[] = [];
    const statuses: string[] = [];
    const result = await runTurn("go", createSession(), config(flaky(1)), {
      onStatus: (m) => statuses.push(m),
      onTextDelta: (t) => shown.push(t),
    });
    expect(result.text).toBe("Final answer");
    expect(shown).toEqual(["abandoned ", "\n", "Final ", "answer", "\n"]);
    expect(statuses.join("")).toMatch(/retrying, the reply starts again/);
  });
});

describe("subagent retries", () => {
  it("tell the parent how much streamed text to drop", () => {
    const sent: ChildMessage[] = [];
    const hooks = createIpcHooks("agent-1", (m) => sent.push(m));
    hooks.onTextDelta!("kept");
    hooks.onAssistantMessage!([], "tool_use");
    hooks.onTextDelta!("aband");
    hooks.onTextDelta!("oned");
    hooks.onStreamRetry!();
    hooks.onTextDelta!("new");
    hooks.onStreamRetry!();
    expect(sent.filter((m) => m.type === "stream_retry")).toEqual([
      { type: "stream_retry", agentId: "agent-1", discard: 9 },
      { type: "stream_retry", agentId: "agent-1", discard: 3 },
    ]);
  });

  it("the spawner re-emits stream_retry", async () => {
    const { AgentSpawner } = await import("../multi/spawner.js");
    const spawner = new AgentSpawner();
    const got: Array<[string, number]> = [];
    spawner.on("stream_retry", (id: string, discard: number) => got.push([id, discard]));
    (spawner as unknown as { handleChildMessage(msg: ChildMessage): void }).handleChildMessage({ type: "stream_retry", agentId: "agent-1", discard: 4 });
    expect(got).toEqual([["agent-1", 4]]);
  });
});

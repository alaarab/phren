import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../providers/retry.js";
import { prefetchFirst, runToolsConcurrently } from "../agent-loop/stream.js";
import { ToolRegistry } from "../tools/registry.js";
import { checkPermission } from "../permissions/checker.js";
import type { PermissionConfig } from "../permissions/types.js";
import type { ToolUseBlock } from "../providers/types.js";

function apiError(status: number, extra = ""): Error {
  return new Error(`API error ${status}: rate limited${extra}`);
}

function block(id: string, name: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: "tool_use", id, name, input };
}

function permissiveRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.setPermissions({ mode: "full-auto", projectRoot: "/tmp", allowedPaths: [] });
  return registry;
}

describe("withRetry abort handling", () => {
  it("skips the first attempt and rejects when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn().mockResolvedValue("ok");

    await expect(withRetry(fn, {}, false, controller.signal)).rejects.toThrow("Aborted");
    expect(fn).not.toHaveBeenCalled();
  });

  it("rejects promptly when aborted during the backoff sleep", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(apiError(429));
    const start = Date.now();

    const promise = withRetry(fn, { baseDelayMs: 1, maxRetries: 5 }, false, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    await expect(promise).rejects.toThrow("Aborted");
    expect(Date.now() - start).toBeLessThan(3000);
    expect(fn).toHaveBeenCalledTimes(1);
    randomSpy.mockRestore();
  });

  it("still retries a retryable error when no signal is aborted", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(apiError(429))
      .mockResolvedValue("recovered");

    const result = await withRetry(fn, { baseDelayMs: 1, maxDelayMs: 1 });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("runToolsConcurrently turn abort", () => {
  it("does not execute a tool when the turn signal is already aborted", async () => {
    const execute = vi.fn().mockResolvedValue({ output: "ran" });
    const registry = permissiveRegistry();
    registry.register({ name: "fake", description: "fake", input_schema: {}, execute });
    const controller = new AbortController();
    controller.abort();

    const results = await runToolsConcurrently([block("a1", "fake", {})], registry, controller.signal);

    expect(execute).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0].is_error).toBe(true);
    expect(results[0].output).toBe("Cancelled by user.");
  });

  it("aborts the signal handed to executing tools and settles every block", async () => {
    const controller = new AbortController();
    const received: Array<AbortSignal | undefined> = [];
    let started = 0;
    let resolveStarted: () => void = () => {};
    const allStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    const registry = permissiveRegistry();
    registry.register({
      name: "waiter",
      description: "waits for abort",
      input_schema: {},
      execute(_input, signal) {
        received.push(signal);
        started++;
        if (started === 2) resolveStarted();
        return new Promise((resolve) => {
          if (signal?.aborted) {
            resolve({ output: "aborted cooperatively" });
            return;
          }
          signal?.addEventListener("abort", () => resolve({ output: "aborted cooperatively" }));
        });
      },
    });

    const promise = runToolsConcurrently(
      [block("w1", "waiter", { q: 1 }), block("w2", "waiter", { q: 2 })],
      registry,
      controller.signal,
    );
    await allStarted;
    controller.abort();
    const results = await promise;

    expect(received).toHaveLength(2);
    expect(received.every((signal) => signal?.aborted)).toBe(true);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result !== undefined)).toBe(true);
    expect(results.every((result) => result.is_error)).toBe(true);
    expect(results.every((result) => result.output === "Cancelled by user." || result.output === "aborted cooperatively")).toBe(true);
  });
});

describe("prefetchFirst", () => {
  function countingIterator(values: number[]) {
    let calls = 0;
    let index = 0;
    return {
      nextCalls: () => calls,
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<number>> {
        calls++;
        if (index >= values.length) return { done: true, value: undefined };
        return { done: false, value: values[index++] };
      },
    };
  }

  it("replays the first item then yields the remaining items", async () => {
    const iterator = countingIterator([1, 2, 3]);
    const first = await iterator.next();
    expect(iterator.nextCalls()).toBe(1);

    const seen: number[] = [];
    for await (const value of prefetchFirst(iterator, first)) seen.push(value);

    expect(seen).toEqual([1, 2, 3]);
    expect(iterator.nextCalls()).toBe(4);
  });

  it("handles a done first result", async () => {
    const iterator = countingIterator([]);
    const first = await iterator.next();
    expect(first.done).toBe(true);

    const seen: number[] = [];
    for await (const value of prefetchFirst(iterator, first)) seen.push(value);

    expect(seen).toEqual([]);
  });
});

describe("checkPermission always-safe read tools", () => {
  function suggestConfig(): PermissionConfig {
    return { mode: "suggest", projectRoot: "/tmp/project", allowedPaths: [] };
  }

  for (const tool of ["read_file", "glob", "grep"]) {
    it(`allows ${tool} with an in-sandbox path in suggest mode`, () => {
      const rule = checkPermission(suggestConfig(), tool, { path: "/tmp/project/foo.ts" });
      expect(rule.verdict).toBe("allow");
    });
  }
});

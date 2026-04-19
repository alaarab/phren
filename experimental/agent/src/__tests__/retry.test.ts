import { describe, expect, it, vi, beforeEach } from "vitest";
import { withRetry } from "../providers/retry.js";

// Stub timers so tests don't actually wait
beforeEach(() => {
  vi.useFakeTimers();
});

/** Helper: create an Error with an HTTP status in the message. */
function apiError(status: number, extra = ""): Error {
  return new Error(`API error ${status}: rate limited${extra}`);
}

/** Helper: create a network error with a code property. */
function networkError(code: string): Error & { code: string } {
  const err = new Error(`connect ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

/** Run withRetry while advancing fake timers so sleep() resolves. */
async function withAdvancingTimers<T>(promise: Promise<T>): Promise<T> {
  // Continuously advance timers until the promise settles
  const result = promise.finally(() => {});
  const advance = async () => {
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(70_000);
    }
  };
  const [value] = await Promise.all([result, advance()]);
  return value;
}

describe("withRetry", () => {
  // ── Success path ────────────────────────────────────────────────────

  it("returns the value on first success", async () => {
    const result = await withRetry(() => Promise.resolve("ok"));
    expect(result).toBe("ok");
  });

  it("calls fn only once when it succeeds", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    await withRetry(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // ── Retryable HTTP statuses ─────────────────────────────────────────

  it("retries on 429 and eventually succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(apiError(429))
      .mockResolvedValue("recovered");

    const result = await withAdvancingTimers(withRetry(fn));
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on 500", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(apiError(500))
      .mockResolvedValue("ok");

    const result = await withAdvancingTimers(withRetry(fn));
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on 502, 503, 529", async () => {
    for (const status of [502, 503, 529]) {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(apiError(status))
        .mockResolvedValue("ok");

      const result = await withAdvancingTimers(withRetry(fn));
      expect(result).toBe("ok");
    }
  });

  // ── Non-retryable statuses ──────────────────────────────────────────

  it("does not retry on 400 (non-retryable)", async () => {
    const fn = vi.fn().mockRejectedValue(apiError(400));

    await expect(withRetry(fn)).rejects.toThrow("API error 400");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 401", async () => {
    const fn = vi.fn().mockRejectedValue(apiError(401));

    await expect(withRetry(fn)).rejects.toThrow("API error 401");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 404", async () => {
    const fn = vi.fn().mockRejectedValue(apiError(404));

    await expect(withRetry(fn)).rejects.toThrow("API error 404");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // ── Network errors ──────────────────────────────────────────────────

  it("retries on ECONNRESET", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(networkError("ECONNRESET"))
      .mockResolvedValue("ok");

    const result = await withAdvancingTimers(withRetry(fn));
    expect(result).toBe("ok");
  });

  it("retries on ECONNREFUSED", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(networkError("ECONNREFUSED"))
      .mockResolvedValue("ok");

    const result = await withAdvancingTimers(withRetry(fn));
    expect(result).toBe("ok");
  });

  it("retries on ETIMEDOUT", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(networkError("ETIMEDOUT"))
      .mockResolvedValue("ok");

    const result = await withAdvancingTimers(withRetry(fn));
    expect(result).toBe("ok");
  });

  it("retries on EPIPE", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(networkError("EPIPE"))
      .mockResolvedValue("ok");

    const result = await withAdvancingTimers(withRetry(fn));
    expect(result).toBe("ok");
  });

  it("retries when network code appears in message (no code property)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up ECONNRESET"))
      .mockResolvedValue("ok");

    const result = await withAdvancingTimers(withRetry(fn));
    expect(result).toBe("ok");
  });

  // ── Max retries exhaustion ──────────────────────────────────────────

  it("throws after maxRetries exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(apiError(429));

    await expect(
      withAdvancingTimers(withRetry(fn, { maxRetries: 2 })),
    ).rejects.toThrow("API error 429");
    // initial + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respects default maxRetries of 3", async () => {
    const fn = vi.fn().mockRejectedValue(apiError(500));

    await expect(withAdvancingTimers(withRetry(fn))).rejects.toThrow(
      "API error 500",
    );
    // initial + 3 retries = 4 calls
    expect(fn).toHaveBeenCalledTimes(4);
  });

  // ── Custom config ───────────────────────────────────────────────────

  it("accepts custom retryableStatuses", async () => {
    const fn = vi.fn().mockRejectedValue(apiError(418));

    // 418 is not retryable by default
    await expect(withRetry(fn)).rejects.toThrow("API error 418");
    expect(fn).toHaveBeenCalledTimes(1);

    // Now make it retryable
    fn.mockClear();
    fn.mockRejectedValueOnce(apiError(418)).mockResolvedValue("teapot");

    const result = await withAdvancingTimers(
      withRetry(fn, { retryableStatuses: new Set([418]) }),
    );
    expect(result).toBe("teapot");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("accepts maxRetries = 0 (no retries)", async () => {
    const fn = vi.fn().mockRejectedValue(apiError(429));

    await expect(withRetry(fn, { maxRetries: 0 })).rejects.toThrow(
      "API error 429",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // ── Retry-After header parsing ──────────────────────────────────────

  it("respects Retry-After hint in error message", async () => {
    const sleepCalls: number[] = [];
    const origSetTimeout = globalThis.setTimeout;

    // Track the delay passed to setTimeout via fake timers
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms) => {
      if (ms && ms > 0) sleepCalls.push(ms as number);
      return origSetTimeout(fn as () => void, 0);
    });

    const err = new Error("API error 429: rate limited. Retry-After: 5");
    const fnWithRetryAfter = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue("ok");

    await withAdvancingTimers(withRetry(fnWithRetryAfter));

    // Retry-After: 5 => 5000ms
    expect(sleepCalls.some((ms) => ms === 5000)).toBe(true);

    vi.restoreAllMocks();
  });

  // ── Verbose logging ─────────────────────────────────────────────────

  it("logs to stderr when verbose is true", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const fn = vi
      .fn()
      .mockRejectedValueOnce(apiError(429))
      .mockResolvedValue("ok");

    await withAdvancingTimers(withRetry(fn, {}, true));

    expect(stderrSpy).toHaveBeenCalled();
    const output = stderrSpy.mock.calls[0]?.[0] as string;
    expect(output).toMatch(/Retry 1\/3/);
    expect(output).toMatch(/status 429/);

    stderrSpy.mockRestore();
  });

  it("does not log when verbose is false/undefined", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const fn = vi
      .fn()
      .mockRejectedValueOnce(apiError(429))
      .mockResolvedValue("ok");

    await withAdvancingTimers(withRetry(fn));

    expect(stderrSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
  });

  // ── Non-Error throws ────────────────────────────────────────────────

  it("handles string throws for status extraction", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce("API error 429: overloaded")
      .mockResolvedValue("ok");

    const result = await withAdvancingTimers(withRetry(fn));
    expect(result).toBe("ok");
  });

  it("does not retry generic non-Error throws", async () => {
    const fn = vi.fn().mockRejectedValue("unknown failure");

    await expect(withRetry(fn)).rejects.toBe("unknown failure");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

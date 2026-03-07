/**
 * Tests for the withWriteQueue serial execution pattern used in index.ts.
 *
 * The write queue is a closure inside createServer() so we test the logic
 * directly using an equivalent standalone implementation that mirrors it exactly.
 */
import { describe, expect, it, vi } from "vitest";

// Mirror of the withWriteQueue pattern from index.ts, parameterized for testing
function makeWriteQueue(maxDepth = 50, timeoutMs = 30_000) {
  let queue: Promise<void> = Promise.resolve();
  let depth = 0;

  async function withWriteQueue<T>(fn: () => Promise<T>): Promise<T> {
    if (depth >= maxDepth) {
      throw new Error(`Write queue full (${maxDepth} items). Try again shortly.`);
    }
    const run = queue.then(async () => {
      try {
        return await Promise.race([
          fn(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Write timeout after 30s")), timeoutMs)
          ),
        ]);
      } finally {
        depth = Math.max(0, depth - 1);
      }
    });
    depth++;
    queue = run.then(
      () => undefined,
      (): void => { /* swallow to keep queue alive */ }
    );
    return run;
  }

  return {
    withWriteQueue,
    getDepth: () => depth,
  };
}

describe("withWriteQueue: serial execution", () => {
  it("executes items in FIFO order", async () => {
    const { withWriteQueue } = makeWriteQueue();
    const order: number[] = [];

    const p1 = withWriteQueue(async () => { order.push(1); });
    const p2 = withWriteQueue(async () => { order.push(2); });
    const p3 = withWriteQueue(async () => { order.push(3); });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("depth counter is 0 after all items complete", async () => {
    const { withWriteQueue, getDepth } = makeWriteQueue();

    await withWriteQueue(async () => "a");
    await withWriteQueue(async () => "b");
    expect(getDepth()).toBe(0);
  });

  it("depth counter decrements even after rejection", async () => {
    const { withWriteQueue, getDepth } = makeWriteQueue();

    const failing = withWriteQueue(async () => {
      throw new Error("intentional failure");
    });

    await expect(failing).rejects.toThrow("intentional failure");
    // Allow queue to drain
    await new Promise(r => setTimeout(r, 10));
    expect(getDepth()).toBe(0);
  });

  it("queue stays live after a rejection (subsequent calls run)", async () => {
    const { withWriteQueue } = makeWriteQueue();

    const failing = withWriteQueue(async () => {
      throw new Error("first fails");
    });
    await expect(failing).rejects.toThrow("first fails");

    // Second call should succeed even after first failed
    const result = await withWriteQueue(async () => "second succeeded");
    expect(result).toBe("second succeeded");
  });

  it("rejects when depth limit reached", async () => {
    const { withWriteQueue } = makeWriteQueue(3); // small limit for testing

    // Hold the queue with a long-running task
    let release!: () => void;
    const blocker = new Promise<void>(r => { release = r; });

    // Fill the queue to the limit
    withWriteQueue(async () => { await blocker; });
    withWriteQueue(async () => { await blocker; });
    withWriteQueue(async () => { await blocker; });

    // 4th call should reject with queue full error
    await expect(withWriteQueue(async () => {})).rejects.toThrow("Write queue full");

    release();
  });

  it("returns the resolved value from fn", async () => {
    const { withWriteQueue } = makeWriteQueue();
    const result = await withWriteQueue(async () => 42);
    expect(result).toBe(42);
  });

  it("propagates rejection from fn to the caller", async () => {
    const { withWriteQueue } = makeWriteQueue();
    await expect(
      withWriteQueue(async () => { throw new Error("bad write"); })
    ).rejects.toThrow("bad write");
  });

  it("concurrent enqueues are all eventually executed", async () => {
    const { withWriteQueue } = makeWriteQueue();
    const results: number[] = [];

    await Promise.all(
      [1, 2, 3, 4, 5].map(n =>
        withWriteQueue(async () => { results.push(n); })
      )
    );

    expect(results.sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("withWriteQueue: timeout behavior", () => {
  it("times out and rejects if fn takes too long", async () => {
    vi.useFakeTimers();
    const { withWriteQueue } = makeWriteQueue(50, 1000); // 1s timeout

    const slow = withWriteQueue(async () => {
      await new Promise<void>(r => setTimeout(r, 5000)); // 5s > 1s timeout
    });
    // Attach early to prevent unhandled rejection noise from fake timers
    slow.catch(() => {});

    await vi.advanceTimersByTimeAsync(1100);
    await expect(slow).rejects.toThrow("Write timeout after 30s");
    vi.useRealTimers();
  });
});

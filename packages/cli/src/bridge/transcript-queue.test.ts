import { describe, expect, it } from "vitest";
import { visibleEvent } from "./transcripts.js";

describe("Claude queue handoff", () => {
  it("exports a stable content-free consumed marker paired with the enqueue", () => {
    const enqueue = visibleEvent({ type: "queue-operation", operation: "enqueue", content: "Run tests", timestamp: "now" }, "claude");
    const remove = visibleEvent({ type: "queue-operation", operation: "remove", content: "Run tests", timestamp: "later" }, "claude");
    expect(enqueue?.phrenQueueKey).toMatch(/^[a-f0-9]{64}$/);
    expect(remove).toEqual({ type: "phren_queue_consumed", key: enqueue?.phrenQueueKey, timestamp: "later" });
    expect(JSON.stringify(remove)).not.toContain("Run tests");
  });
  it("hides private enqueue payloads but consumes every identifiable removal", () => {
    for (const raw of [{ content: "  <system-reminder>secret</system-reminder>" }, { content: "secret", isMeta: true },
                       { content: "secret", isSidechain: true }, {}]) {
      expect(visibleEvent({ type: "queue-operation", operation: "enqueue", ...raw }, "claude")).toBeUndefined();
      const removed = visibleEvent({ type: "queue-operation", operation: "remove", ...raw }, "claude");
      if ("content" in raw) expect(removed).toMatchObject({ type: "phren_queue_consumed", key: expect.stringMatching(/^[a-f0-9]{64}$/) });
      else expect(removed).toBeUndefined();
    }
  });
});

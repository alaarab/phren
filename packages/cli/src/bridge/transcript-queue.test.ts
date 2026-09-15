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
  it("does not export private queue rows or unidentifiable removals", () => {
    for (const raw of [{ content: "  <system-reminder>secret</system-reminder>" }, { content: "secret", isMeta: true },
                       { content: "secret", isSidechain: true }, {}]) {
      expect(visibleEvent({ type: "queue-operation", operation: "remove", ...raw }, "claude")).toBeUndefined();
    }
  });
});

import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { redactPeerHandoff, redactPeerPayload } from "./peer-handoff.js";

describe("peer free-text redaction", () => {
  it("preserves opaque protocol values and structural metadata", () => {
    const token = "a1".repeat(32);
    const payload = { startingToken: token, author: "Al", authority: "owner", cwd: "/workspace/" + "a1/".repeat(30), capabilities: { projectHostToken: true, authority: true }, text: "password=hunter2" };
    expect(redactPeerPayload(payload)).toEqual({ ...payload, text: "password=[redacted]" });
  });

  it("redacts credential values in free text without refusing a long path", () => {
    const cwd = "/workspace/" + "a1/".repeat(30);
    expect(redactPeerHandoff(`Continue in ${cwd}\n--token abc\nPGPASSWORD=hunter2`)).toBe(`Continue in ${cwd}\n--token [redacted]\nPGPASSWORD=[redacted]`);
  });

  it("redacts a 32k identifier in less than 50 ms", () => {
    const input = "a.".repeat(16_000);
    const start = performance.now();
    const result = redactPeerHandoff(input);
    const elapsed = performance.now() - start;
    expect(result).toBe(input);
    expect(elapsed).toBeLessThan(50);
  });
});

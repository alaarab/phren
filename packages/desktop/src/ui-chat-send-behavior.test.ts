import { describe, expect, it } from "vitest";
// @ts-expect-error Browser ES module.
import { followState, openedRequest, pasteBecomesAttachment, pullRequestLanded, waitTimeLabel, workedForLabel } from "../ui/chat/send-behavior.js";

// Phone-visible boundaries: UTF-8 admission, duration/wait wording, successful
// creation evidence and reader intent. No DOM or private implementation seams.
describe("phone chat sending parity", () => {
  it("converts a paste at 32 KiB of UTF-8, including non-ASCII text", () => {
    expect(pasteBecomesAttachment("a".repeat(32767))).toBe(false);
    expect(pasteBecomesAttachment("a".repeat(32768))).toBe(true);
    expect(pasteBecomesAttachment("é".repeat(16383))).toBe(false);
    expect(pasteBecomesAttachment("é".repeat(16384))).toBe(true);
    expect(pasteBecomesAttachment("😀".repeat(8192))).toBe(true);
  });
  it.each([[0, "Waiting"], [59, "Waiting"], [60, "Waiting 1m"], [3599, "Waiting 59m"], [3600, "Waiting 1h"], [86399, "Waiting 23h"], [86400, "Waiting 1d"], [-60, "Waiting"]])("labels a wait of %s seconds", (seconds, label) => {
    expect(waitTimeLabel("2026-11-07T00:00:00Z", true, Date.parse("2026-11-07T00:00:00Z") + Number(seconds) * 1000)).toBe(label);
  });
  it("omits wait badges for absent/invalid timestamps and sessions not needing the owner", () => {
    expect(waitTimeLabel(null, true)).toBeNull();
    expect(waitTimeLabel("bad", true)).toBeNull();
    expect(waitTimeLabel("2026-11-07T00:00:00Z", false)).toBeNull();
  });
  it.each([["Thought for", 0, "Thought for 0s"], ["Worked for", 64.9, "Worked for 1m 04s"], ["Stopped after", 3723, "Stopped after 1h 02m 03s"], ["Brewed for", -10, "Brewed for 0s"]])("formats %s using phone duration boundaries", (verb, elapsed, label) => {
    const start = Date.parse("2026-11-07T00:00:00Z");
    expect(workedForLabel({ verb, startedAt: new Date(start).toISOString(), finishedAt: new Date(start + Number(elapsed) * 1000).toISOString() })).toBe(label);
  });
  it("announces only usable publication results, using the forge's wording", () => {
    expect(pullRequestLanded({ ok: true, pullURL: "https://github.com/a/b/pull/42" })).toEqual({ text: "PR #42 opened", url: "https://github.com/a/b/pull/42", number: 42 });
    expect(pullRequestLanded({ ok: true, existing: true, pullURL: "https://git.example/a/b/-/merge_requests/5" }, "gitlab").text).toBe("MR !5 was already open");
    expect(pullRequestLanded({ ok: false, pullURL: "https://github.com/a/b/pull/42" })).toBeNull();
    expect(pullRequestLanded({ ok: true, pullURL: "javascript:alert(1)" })).toBeNull();
  });
  it("requires a paired successful creation tool result, never an assistant link or PR read", () => {
    const call = { role: "tool", toolCallID: "c1", text: JSON.stringify({ command: "gh pr create --title Fix --body Done" }) };
    const result = { role: "tool", isToolResult: true, toolCallID: "c1", text: "https://github.com/a/b/pull/42" };
    expect(openedRequest([call, result])?.text).toBe("PR #42 opened");
    expect(openedRequest([{ ...call, text: '{"command":"gh pr view 42"}' }, result])).toBeNull();
    expect(openedRequest([{ ...call, text: '{"command":"echo gh pr create"}' }, result])).toBeNull();
    expect(openedRequest([call, { ...result, isToolError: true }])).toBeNull();
    expect(openedRequest([call, { ...result, toolCallID: "other" }])).toBeNull();
    expect(openedRequest([{ role: "assistant", text: result.text }])).toBeNull();
  });
  it("keeps a reader put through streaming, replay and touching until an explicit re-follow action", () => {
    let state = { following: true, touching: false };
    state = followState(state, { type: "reader-scroll", distance: 120 });
    for (const type of ["stream", "backlog", "resize"]) state = followState(state, { type, distance: 0 });
    expect(state.following).toBe(false);
    state = followState(state, { type: "reader-scroll", distance: 20 });
    expect(state.following).toBe(false); // near the bottom still isn't the end
    state = followState(state, { type: "reader-scroll", distance: 0 });
    expect(state.following).toBe(true);
    state = followState(state, { type: "touch-start" });
    state = followState(state, { type: "reader-scroll", distance: 0 });
    expect(state.following).toBe(false);
    state = followState(state, { type: "touch-end" });
    expect(state.following).toBe(false);
    expect(followState(state, { type: "latest" }).following).toBe(true);
    expect(followState(state, { type: "send" }).following).toBe(true);
  });
});

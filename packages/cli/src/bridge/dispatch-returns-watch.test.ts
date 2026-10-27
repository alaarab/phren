import { describe, expect, it } from "vitest";
import { formatReturnLine, RETURN_LINE_TAIL, watchReturns } from "./dispatch-returns.js";
import type { Json } from "./protocol.js";

const row = (extra: Json = {}): Json => ({ id: "40000000-0000-4000-8000-000000000001", computer: "buildbox", project: "phren", label: "parser-fix",
  harness: "codex", state: "done", at: "2026-10-27T12:03:04.000Z", ...extra });

describe("a watched return line", () => {
  it("shows when it landed, the label, the computer, the state and the reply's tail", () => {
    expect(formatReturnLine(row({ reply: "Tests pass.\nPR #12 is open." }), "UTC")).toBe("12:03:04  parser-fix  buildbox  done  Tests pass. PR #12 is open.");
  });

  it("shows what a worker that needs you asks, and why one failed or is blocked", () => {
    expect(formatReturnLine(row({ state: "needs-you", question: "Merge now?", reply: "Done." }), "UTC")).toBe("12:03:04  parser-fix  buildbox  needs-you  Merge now?");
    expect(formatReturnLine(row({ state: "failed", error: "The pane closed." }), "UTC")).toBe("12:03:04  parser-fix  buildbox  failed  The pane closed.");
    expect(formatReturnLine(row({ state: "blocked", approval: { actionId: "a1", tool: "Bash", title: "Run the deploy" } }), "UTC"))
      .toBe("12:03:04  parser-fix  buildbox  blocked  waiting on Run the deploy");
    expect(formatReturnLine(row({ state: "gone" }), "UTC")).toBe("12:03:04  parser-fix  buildbox  gone");
  });

  it("keeps only the end of a long reply", () => {
    const line = formatReturnLine(row({ reply: `${"x".repeat(500)} the end.` }), "UTC");
    expect(line.endsWith("the end.")).toBe(true);
    expect(line.length).toBe("12:03:04  parser-fix  buildbox  done  ".length + RETURN_LINE_TAIL);
  });
});

describe("watching returns", () => {
  it("prints each return once as it lands, as lines or one JSON object per line, until stopped", async () => {
    for (const json of [false, true]) {
      const batches: Json[][] = [[row({ reply: "First." })], [], [row({ label: "docs", state: "failed", error: "No checkout." })]];
      const printed: string[] = [];
      const stop = new AbortController();
      let reads = 0;
      const read = async () => { reads++; const next = batches.shift(); if (!batches.length) stop.abort(); return next ?? []; };
      await watchReturns(read, line => printed.push(line), { signal: stop.signal, json, intervalMs: 1, timeZone: "UTC" });
      expect(reads).toBe(3);
      if (json) expect(printed.map(line => JSON.parse(line))).toEqual([row({ reply: "First." }), row({ label: "docs", state: "failed", error: "No checkout." })]);
      else expect(printed).toEqual(["12:03:04  parser-fix  buildbox  done  First.", "12:03:04  docs  buildbox  failed  No checkout."]);
    }
  });

  it("keeps watching through a Hook that does not answer, saying so once on the side in both forms", async () => {
    for (const json of [false, true]) {
      const printed: string[] = [], warned: string[] = [];
      const stop = new AbortController();
      let reads = 0;
      const read = async () => {
        if (++reads <= 3) throw new Error("Phren Hook timed out. Do not retry a dispatch automatically.");
        stop.abort(); return [row()];
      };
      await watchReturns(read, line => printed.push(line), { signal: stop.signal, json, intervalMs: 1, timeZone: "UTC", warn: line => warned.push(line) });
      expect(printed).toHaveLength(1);
      expect(warned).toEqual(["Phren Hook did not answer: Phren Hook timed out.", "Phren Hook answers again."]);
    }
  });

  it("never sends a worker's escape sequences to the terminal, and cuts on whole characters", () => {
    const line = formatReturnLine(row({ reply: "Done\u001b]52;c;cGF5bG9hZA==\u0007 \u009b2J now" }), "UTC");
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(formatReturnLine(row({ reply: "😀".repeat(200) }), "UTC")).not.toContain("�");
    expect(Array.from(formatReturnLine(row({ reply: "😀".repeat(200) }), "UTC").split("  ").at(-1)!)).toHaveLength(RETURN_LINE_TAIL);
  });

  it("adds no listener per tick to the stop signal", async () => {
    const stop = new AbortController();
    let reads = 0;
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(warning.name);
    process.on("warning", onWarning);
    try {
      await watchReturns(async () => { if (++reads === 30) stop.abort(); return []; }, () => undefined, { signal: stop.signal, intervalMs: 1 });
      await new Promise(resolve => setImmediate(resolve));
    } finally { process.off("warning", onWarning); }
    expect(reads).toBe(30);
    expect(warnings).not.toContain("MaxListenersExceededWarning");
  });
});

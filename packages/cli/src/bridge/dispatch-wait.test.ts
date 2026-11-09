import { describe, expect, it } from "vitest";
import { waitForDispatch } from "./dispatch-wait.js";
import type { Json } from "./protocol.js";

const id = "40000000-0000-4000-8000-000000000001";
const other = "40000000-0000-4000-8000-000000000002";
const target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "codex", session: "s1" };
const at = "2026-11-08T10:00:00.000Z";

function run(request: (route: string, data?: Json) => Promise<Json>): Promise<{ code: number; lines: Json[] }> {
  const lines: Json[] = [];
  return waitForDispatch(id, { intervalMs: 1, jitter: false, out: line => lines.push(line), request })
    .then(code => ({ code, lines }));
}

describe("dispatch wait", () => {
  it("prints running, needs_you and the final done line with prs, and acknowledges only this dispatch", async () => {
    const acked: Json[] = [];
    let reads = 0;
    const { code, lines } = await run(async (route, data) => {
      if (route === "/v1/dispatch") return { dispatches: [{ id, target }] };
      if (route.startsWith("/v1/dispatch/returns?")) {
        reads++;
        if (reads === 1) return { returns: [{ id: other, state: "failed", error: "other worker", at }] };
        if (reads === 2) return { returns: [{ id: other, state: "failed", error: "other worker", at }, { id, state: "needs-you", question: "Which branch?", at }] };
        return { returns: [{ id: other, state: "failed", error: "other worker", at },
          { id, state: "done", reply: "All checks passed", prs: [{ url: "https://gitboy.dev/a/b/pulls/1", repo: "a/b", branch: "agent/42", tests: "passing" }], at }] };
      }
      if (route === "/v1/dispatch/returns/ack") { acked.push(data ?? {}); return { ok: true }; }
      return { workers: [{ state: "idle" }] };
    });
    expect(code).toBe(0);
    expect(lines.map(line => line.state)).toEqual(["running", "needs_you", "done"]);
    expect(lines[1]).toMatchObject({ dispatch: id, state: "needs_you", question: "Which branch?" });
    expect(lines.at(-1)).toMatchObject({ dispatch: id, state: "done", final: true, final_reply: "All checks passed",
      prs: [{ url: "https://gitboy.dev/a/b/pulls/1", repo: "a/b", branch: "agent/42", tests: "passing" }] });
    expect(acked).toEqual([{ dispatch: id }]);
  });

  it("ends failed and gone with exit 1", async () => {
    const failed = await run(async route => route === "/v1/dispatch"
      ? { dispatches: [{ id, target }] }
      : route.startsWith("/v1/dispatch/returns?") ? { returns: [{ id, state: "failed", error: "tests failed", at }] } : { ok: true });
    expect(failed.code).toBe(1);
    expect(failed.lines.at(-1)).toMatchObject({ state: "failed", final: true, error: "tests failed" });

    const gone = await run(async route => route === "/v1/dispatch"
      ? { dispatches: [{ id, target }] }
      : route.startsWith("/v1/dispatch/returns?") ? { returns: [] } : { workers: [{ state: "gone" }] });
    expect(gone.code).toBe(1);
    expect(gone.lines.at(-1)).toMatchObject({ state: "gone", final: true });
  });

  it("times out with exit 124 and says an unknown id failed after its grace period", async () => {
    const lines: Json[] = [];
    const code = await waitForDispatch(id, { intervalMs: 1, jitter: false, timeoutMs: 1, out: line => lines.push(line),
      request: async route => route === "/v1/dispatch" ? { dispatches: [{ id, target }] } : { returns: [] } });
    expect(code).toBe(124);
    expect(lines.at(-1)).toMatchObject({ dispatch: id, state: "timeout", final: true });

    const unknownLines: Json[] = [];
    const unknown = await waitForDispatch(id, { intervalMs: 1, jitter: false, graceMs: 1, out: line => unknownLines.push(line),
      request: async () => ({ dispatches: [] }) });
    expect(unknown).toBe(1);
    expect(unknownLines.at(-1)).toMatchObject({ state: "failed", final: true, error: "unknown dispatch" });
  });

  it("keeps a pending targetless receipt running past ten minutes and ends only on the Hook's terminal return", async () => {
    let clock = Date.parse("2026-11-08T10:10:00.000Z");
    let reads = 0;
    const lines: Json[] = [];
    const code = await waitForDispatch(id, { intervalMs: 1, jitter: false, now: () => clock,
      sleep: async ms => { clock += ms; }, out: line => lines.push(line),
      request: async route => {
        if (route === "/v1/dispatch") return { dispatches: [{ id, state: "launching", createdAt: "2026-11-08T10:00:00.000Z" }] };
        if (route.startsWith("/v1/dispatch/returns?")) {
          reads++;
          return { returns: reads < 3 ? [] : [{ id, state: "failed", error: "launch interrupted", at: new Date(clock).toISOString() }] };
        }
        return { ok: true };
      } });
    expect(code).toBe(1);
    expect(lines.slice(0, -1).every(line => line.state === "running" && line.final !== true)).toBe(true);
    expect(lines.at(-1)).toMatchObject({ state: "failed", final: true, error: "launch interrupted" });
  });

  it("counts every polled route's failures toward one unavailability deadline", async () => {
    const failedWith = async (request: (route: string) => Promise<Json>) => {
      const lines: Json[] = [];
      const code = await waitForDispatch(id, { intervalMs: 1, jitter: false, unavailableMs: 1, out: line => lines.push(line), request });
      expect(code).toBe(1);
      expect(lines.at(-1)).toMatchObject({ state: "failed", final: true, error: expect.stringContaining("unavailable") });
    };
    await failedWith(async route => {
      if (route === "/v1/dispatch") throw new Error("list down");
      return { returns: [] };
    });
    await failedWith(async route => {
      if (route === "/v1/dispatch") return { dispatches: [{ id, target }] };
      if (route.startsWith("/v1/dispatch/returns?")) throw new Error("peek down");
      return { workers: [{ state: "working" }] };
    });
    await failedWith(async route => {
      if (route === "/v1/dispatch") return { dispatches: [{ id, target }] };
      if (route.startsWith("/v1/dispatch/returns?")) return { returns: [] };
      throw new Error("workers down");
    });
  });

  it("emits running after a historical needs_you return once the worker resumes", async () => {
    let clock = 0;
    let reads = 0;
    const lines: Json[] = [];
    const code = await waitForDispatch(id, { intervalMs: 1, jitter: false, now: () => clock,
      sleep: async ms => { clock += ms; }, out: line => lines.push(line),
      request: async route => {
        if (route === "/v1/dispatch") return { dispatches: [{ id, target }] };
        if (route.startsWith("/v1/dispatch/returns?")) {
          reads++;
          if (reads < 3) return { returns: [{ id, state: "needs-you", question: "Q?", at: new Date(0).toISOString() }] };
          return { returns: [{ id, state: "done", reply: "done", at: new Date(clock).toISOString() }] };
        }
        return { workers: [{ state: reads <= 1 ? "idle" : "working" }] };
      } });
    expect(code).toBe(0);
    expect(lines.map(line => line.state)).toEqual(["needs_you", "running", "done"]);
  });
});

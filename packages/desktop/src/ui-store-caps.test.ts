import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("store capabilities", () => {
  it("come from the overview frame's phren block, without a /v1/health read", async () => {
    let onMessage: ((ev: { data: string }) => void) | undefined;
    class FakeSocket {
      addEventListener(type: string, fn: (ev: { data: string }) => void) { if (type === "message") onMessage = fn; }
    }
    const fetch = vi.fn();
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
    vi.stubGlobal("fetch", fetch);
    // @ts-expect-error store.js is plain JavaScript without type declarations
    const { connectStore, store } = await import("../ui/shell/store.js");
    connectStore();
    onMessage!({ data: JSON.stringify({ type: "overview", merged: { computers: [
      { computer: "mini", state: "online", overview: { groups: [], phren: { version: "0.3.45", capabilities: { taskDependencies: true } } } },
    ] } }) });
    expect(await store.capabilities("mini")).toEqual({ taskDependencies: true });
    expect(store.version("mini")).toBe("0.3.45");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("share one /v1/health read between callers", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ capabilities: { code: true } })));
    vi.stubGlobal("fetch", fetch);
    // @ts-expect-error store.js is plain JavaScript without type declarations
    const { store } = await import("../ui/shell/store.js");
    const [a, b] = await Promise.all([store.capabilities("pj"), store.capabilities("pj")]);
    expect(a).toEqual({ code: true });
    expect(b).toEqual({ code: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createHealthRead } from "../ui/sections/settings/health-read.js";

afterEach(() => vi.unstubAllGlobals());

describe("computer health read lifetime", () => {
  it.each(["leave and reopen", "force refresh"])("aborts and refetches on %s without waiting for the old read", async (action) => {
    const requests: { url: string; signal: AbortSignal; resolve: (response: Response) => void }[] = [];
    vi.stubGlobal("fetch", (url: string, options: { signal: AbortSignal }) => new Promise<Response>((resolve) => {
      requests.push({ url, signal: options.signal, resolve });
    }));
    const publish = vi.fn();
    const reader = createHealthRead("Dev box", publish);
    const oldRead = reader.load();
    if (action === "leave and reopen") {
      reader.cancel();
      expect(reader.loading).toBe(false);
    }
    const freshRead = reader.load(true);
    expect(requests).toHaveLength(2);
    expect(requests[0].signal.aborted).toBe(true);
    expect(requests[1].signal.aborted).toBe(false);
    expect(requests[1].url).toBe("/hosts/Dev%20box/v1/health/details");

    // Even if an aborted transport settles late, it cannot publish or clear
    // the replacement's loading state.
    requests[0].resolve(Response.json({ gitWrites: [{ client: "old", count: 5 }] }));
    await oldRead;
    expect(reader.loading).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    requests[1].resolve(Response.json({ gitWrites: [] }));
    await freshRead;
    expect(publish).toHaveBeenCalledExactlyOnceWith({ gitWrites: [] }, undefined);
    expect(reader.loading).toBe(false);
    expect(reader.loaded).toBe(true);
  });
});

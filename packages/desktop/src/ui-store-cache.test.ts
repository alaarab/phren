import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error store-cache.js is plain JavaScript without type declarations
import { cached, decodeBase64, storeBlobText } from "../ui/store-cache.js";

afterEach(() => vi.unstubAllGlobals());

describe("store cache", () => {
  it("reads a key once and shares the result", async () => {
    const map = new Map();
    const read = vi.fn(async () => "text");
    const [a, b] = await Promise.all([cached(map, "k", read), cached(map, "k", read)]);
    expect([a, b]).toEqual(["text", "text"]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("forgets a failed read so the next call retries", async () => {
    const map = new Map();
    await expect(cached(map, "k", async () => { throw new Error("down"); })).rejects.toThrow("down");
    expect(map.has("k")).toBe(false);
    await expect(cached(map, "k", async () => "ok")).resolves.toBe("ok");
  });

  it("decodes UTF-8 text", () => {
    expect(decodeBase64(Buffer.from("naïve — ok", "utf8").toString("base64"))).toBe("naïve — ok");
  });

  it("fetches a blob sha once across computers", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ content: Buffer.from("# hi").toString("base64") })));
    vi.stubGlobal("fetch", fetch);
    expect(await storeBlobText("one", "sha-shared")).toBe("# hi");
    expect(await storeBlobText("two", "sha-shared")).toBe("# hi");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

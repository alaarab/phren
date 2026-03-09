import { afterEach, describe, expect, it, vi } from "vitest";
import { embedText, prepareEmbeddingInput } from "./shared-ollama.js";

describe("prepareEmbeddingInput", () => {
  it("normalizes markdown-heavy content and caps length", () => {
    const raw = [
      "<!-- comment -->",
      "| Col A | Col B |",
      "| --- | --- |",
      "`inline code`",
      "[docs](https://example.com)",
      "x".repeat(7000),
    ].join("\n");

    const prepared = prepareEmbeddingInput(raw);

    expect(prepared.length).toBeLessThanOrEqual(6000);
    expect(prepared).not.toContain("<!--");
    expect(prepared).not.toContain("|");
    expect(prepared).not.toContain("`");
    expect(prepared).toContain("inline code");
    expect(prepared).toContain("docs");
  });
});

describe("embedText", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends normalized input to Ollama", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[0.1, 0.2, 0.3]] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const raw = [
      "<!-- comment -->",
      "| Col A | Col B |",
      "`inline code`",
      "x".repeat(7000),
    ].join("\n");

    const vec = await embedText(raw, "nomic-embed-text", "http://localhost:11434");
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(options.body)) as { input: string };

    expect(vec).toEqual([0.1, 0.2, 0.3]);
    expect(body.input.length).toBeLessThanOrEqual(6000);
    expect(body.input).not.toContain("<!--");
    expect(body.input).not.toContain("|");
    expect(body.input).not.toContain("`");
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callLlm } from "../content/content-dedup.js";

describe("callLlm provider routing", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all LLM-related env vars
    delete process.env.PHREN_LLM_ENDPOINT;
    delete process.env.PHREN_LLM_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.PHREN_LLM_MODEL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore environment
    for (const key of ["PHREN_LLM_ENDPOINT", "PHREN_LLM_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "PHREN_LLM_MODEL"]) {
      if (originalEnv[key] !== undefined) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it("calls custom endpoint when PHREN_LLM_ENDPOINT is set", async () => {
    process.env.PHREN_LLM_ENDPOINT = "https://custom-llm.example.com/v1";
    process.env.PHREN_LLM_KEY = "test-key";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "YES" } }] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await callLlm("test prompt");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://custom-llm.example.com/v1/chat/completions");
    expect(opts.headers.Authorization).toBe("Bearer test-key");
    expect(result).toBe("YES");
  });

  it("calls Anthropic when ANTHROPIC_API_KEY is set (no endpoint)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "NO" }] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await callLlm("test prompt");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(opts.headers["anthropic-version"]).toBe("2023-06-01");
    expect(opts.headers["x-api-key"]).toBe("sk-ant-test");
    expect(result).toBe("NO");
  });

  it("calls OpenAI when OPENAI_API_KEY is set (no endpoint, no Anthropic key)", async () => {
    process.env.OPENAI_API_KEY = "sk-openai-test";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "YES" } }] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await callLlm("test prompt");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(opts.headers.Authorization).toBe("Bearer sk-openai-test");
    expect(result).toBe("YES");
  });

  it("returns empty string when no keys are configured", async () => {
    const result = await callLlm("test prompt");
    expect(result).toBe("");
  });
});

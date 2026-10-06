import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAnthropicModels,
  parseCodexModels,
  parseDeepSeekModels,
  parseOllamaModels,
  parseOpenAiModels,
  parseOpenRouterModels,
  discoverProvider,
} from "../model-discovery.js";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "provider-catalogs");
const load = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(fixtureDir, `${name}.json`), "utf8"));

describe("provider model catalogue parsers", () => {
  it("keeps OpenRouter pricing, context, vision, and explicitly advertised efforts", () => {
    const [model] = parseOpenRouterModels(load("openrouter"));
    expect(model).toMatchObject({
      id: "openai/gpt-6.1-sol",
      contextWindow: 1050000,
      maxOutputTokens: 128000,
      vision: true,
      reasoningRange: ["low", "medium", "high"],
      pricing: { inputPer1M: 1, outputPer1M: 5, cacheReadPer1M: 0.05 },
    });
    expect(parseOpenRouterModels(load("openrouter"))).toHaveLength(2);
    expect(parseOpenRouterModels(load("openrouter")).map((model) => model.id)).toContain("nvidia/nemotron-3-ultra-550b-a55b:free");
  });

  it("reads Anthropic supported effort objects and adaptive thinking metadata", () => {
    const [model] = parseAnthropicModels(load("anthropic"));
    expect(model.reasoningRange).toEqual(["low", "medium", "high", "xhigh"]);
    expect(model.contextWindow).toBe(1_000_000);
    expect(model.reasoningMode).toBe("adaptive");
  });

  it("filters non-coding OpenAI rows, merges exact Codex metadata, and keeps DeepSeek conservative", () => {
    const openai = parseOpenAiModels(load("openai"), parseCodexModels(load("codex")));
    expect(openai).toHaveLength(1);
    expect(openai[0]).toMatchObject({
      id: "gpt-6.1-sol",
      contextWindow: 1048576,
      reasoningDefault: "medium",
      reasoningRange: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(parseDeepSeekModels(load("deepseek")).map((model) => model.reasoningRange)).toEqual([[], [], ["low", "high", "max"]]);
    expect(parseOllamaModels(load("ollama")).map((model) => model.reasoningRange)).toEqual([[], []]);
  });

  it("retains Codex max distinctly and omits CLI-only ultra", () => {
    const [model] = parseCodexModels(load("codex"));
    expect(model.reasoningRange).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(model.reasoningDefault).toBe("medium");
  });
});

describe("catalog cache boundary", () => {
  let home: string;
  const savedHome = process.env.HOME;
  const savedKey = process.env.OPENAI_API_KEY;
  const savedRouterKey = process.env.OPENROUTER_API_KEY;
  const savedCompatKey = process.env.PHREN_AGENT_API_KEY;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "phren-model-cache-"));
    process.env.HOME = home;
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENROUTER_API_KEY = "router-key";
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
    if (savedRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedRouterKey;
    if (savedCompatKey === undefined) delete process.env.PHREN_AGENT_API_KEY;
    else process.env.PHREN_AGENT_API_KEY = savedCompatKey;
    fs.rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("uses fresh cached metadata offline and reports it as cached", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "gpt-6.1-sol" }] })));
    const first = await discoverProvider("openai", { fetchImpl: fetchMock, force: true, now: 1_800_000_000_000 });
    expect(first.status).toBe("live");
    const second = await discoverProvider("openai", { fetchImpl: vi.fn(() => { throw new Error("offline"); }), now: 1_800_000_001_000 });
    expect(second.status).toBe("cached");
    expect(second.models[0].id).toBe("gpt-6.1-sol");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the override endpoint and its resolved key as one connector", async () => {
    process.env.PHREN_AGENT_API_KEY = "compat-key";
    let requestUrl = "";
    let authorization = "";
    const result = await discoverProvider("openai-compat", {
      baseUrl: "https://custom.example/v1",
      force: true,
      now: 1_800_000_000_000,
      fetchImpl: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requestUrl = String(input);
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(JSON.stringify({ data: [{ id: "custom-model" }] }));
      }),
    });
    expect(result.status).toBe("live");
    expect(requestUrl).toBe("https://custom.example/v1/models");
    expect(authorization).toBe("Bearer compat-key");
    expect(result.models[0].id).toBe("custom-model");
  });

  it("merges concurrent provider cache writes instead of dropping a provider", async () => {
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const url = String(args[0]);
      return url.includes("openrouter")
        ? new Response(JSON.stringify(load("openrouter")))
        : new Response(JSON.stringify({ data: [{ id: "gpt-6.1-sol" }] }));
    });
    await Promise.all([
      discoverProvider("openai", { fetchImpl: fetchMock, force: true, now: 1_800_000_000_000 }),
      discoverProvider("openrouter", { fetchImpl: fetchMock, force: true, now: 1_800_000_000_000 }),
    ]);
    const [openai, router] = await Promise.all([
      discoverProvider("openai", { fetchImpl: vi.fn(() => { throw new Error("offline"); }), now: 1_800_000_001_000 }),
      discoverProvider("openrouter", { fetchImpl: vi.fn(() => { throw new Error("offline"); }), now: 1_800_000_001_000 }),
    ]);
    expect(openai.status).toBe("cached");
    expect(router.status).toBe("cached");
  });
});

import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveConnector, providerAuthStatuses } from "../provider-connectors.js";
import { resolveProvider } from "../providers/resolve.js";
import { registerDiscoveredModels } from "../models.js";

let home: string;
function json(file: string, data: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
}
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "phren-connectors-"));
  for (const key of ["HOME", "CODEX_HOME", "PHREN_PATH", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "OPENCODE_CONFIG", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "PHREN_AGENT_PROVIDER", "PHREN_AGENT_BASE_URL", "PHREN_AGENT_API_KEY", "PHREN_AGENT_REASONING", "PHREN_AGENT_REPLAY", "OPENCODE_API_KEY", "OPENCODE_BASE_URL"]) vi.stubEnv(key, "");
  vi.stubEnv("HOME", home);
  vi.stubEnv("PHREN_AGENT_PROVIDERS_CONFIG", path.join(home, "providers.json"));
  vi.stubEnv("XDG_DATA_HOME", path.join(home, "data"));
  vi.stubEnv("XDG_CONFIG_HOME", path.join(home, "config"));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(home, { recursive: true, force: true }); });

it("reuses a named OpenCode API connector but never gives its Go key to an unrelated override", () => {
  json(path.join(home, "data/opencode/auth.json"), { "opencode-go": { type: "api", key: "go-secret" }, oauth: { type: "oauth", access: "not-an-api-key" } });
  expect(resolveConnector("openai-compat")).toMatchObject({ baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "go-secret", authSource: "opencode" });
  expect(resolveConnector("openai-compat", "https://custom.example/v1").apiKey).toBeUndefined();
  expect(JSON.stringify(providerAuthStatuses())).not.toContain("go-secret");
  json(path.join(home, "providers.json"), { providers: { "openai-compat": { opencodeProvider: "oauth", baseUrl: "https://custom.example/v1" } } });
  expect(resolveConnector("openai-compat").apiKey).toBeUndefined();
});

it("uses the configured connector's key and endpoint for inference as well as discovery", async () => {
  vi.stubEnv("WORK_ANTHROPIC", "work-secret");
  json(path.join(home, "providers.json"), { providers: { anthropic: { apiKeyEnv: "WORK_ANTHROPIC", baseUrl: "https://proxy.example", model: "claude-live" } } });
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" })));
  vi.stubGlobal("fetch", fetchMock);
  const provider = resolveProvider("anthropic");
  await provider.chat("sys", [{ role: "user", content: "hello" }], []);
  expect(fetchMock).toHaveBeenCalledWith("https://proxy.example/v1/messages", expect.objectContaining({ headers: expect.objectContaining({ "x-api-key": "work-secret" }) }));
  expect(provider.model).toBe("claude-live");
});

it("rejects unsupported effort before replacing the model or sending a request", () => {
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  registerDiscoveredModels("openrouter", [{ provider: "openrouter", id: "test/no-effort", label: "No effort", reasoningDefault: null, reasoningRange: [] }], "live");
  expect(() => resolveProvider("openrouter", "test/no-effort", undefined, "high")).toThrow(/Supported: model default only/);
});

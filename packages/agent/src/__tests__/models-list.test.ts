import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { credentialedProviders, listModels, printModels } from "../models-list.js";

const ENV_KEYS = ["HOME", "USERPROFILE", "CODEX_HOME", "PHREN_PATH", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "PHREN_OLLAMA_URL"];

describe("phren-agent models", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "phren-agent-models-"));
    for (const key of ENV_KEYS) vi.stubEnv(key, "");
    vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("CODEX_HOME", path.join(home, ".codex")); vi.stubEnv("PHREN_PATH", path.join(home, ".phren"));
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }); });

  it("lists only providers with credentials here, in auto-detection order", () => {
    expect(credentialedProviders()).toEqual([]);
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-deepseek");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant");
    expect(credentialedProviders()).toEqual(["anthropic", "deepseek"]);
    vi.stubEnv("PHREN_OLLAMA_URL", "off");
    expect(credentialedProviders()).not.toContain("ollama");
  });

  it("names each model by provider, marks the first provider's default, and never offers reasoning none", () => {
    const models = listModels(["anthropic", "deepseek"]);
    expect(models.every(model => /^(anthropic|deepseek)\/.+/.test(model.id))).toBe(true);
    expect(models.filter(model => model.isDefault)).toHaveLength(1);
    expect(models.find(model => model.isDefault)?.provider).toBe("anthropic");
    expect(models.find(model => model.id === "anthropic/claude-sonnet-5")).toMatchObject({ name: "Sonnet 5", description: "Anthropic API" });
    expect(models.every(model => !model.supportedReasoningEfforts.includes("none"))).toBe(true);
  });

  it("prints JSON for the Hook", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant");
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => { lines.push(line); });
    printModels(["--json"]);
    const parsed = JSON.parse(lines.join("\n")) as { models: { id: string }[] };
    expect(parsed.models.length).toBeGreaterThan(0);
    expect(JSON.stringify(parsed)).not.toContain("sk-ant");
  });
});

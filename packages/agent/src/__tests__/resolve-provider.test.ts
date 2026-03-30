import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { resolveProvider } from "../providers/resolve.js";
import { makeTempDir } from "../../../cli/src/test-helpers.js";

describe("resolveProvider auth profiles", () => {
  let tmp: { path: string; cleanup: () => void };
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    tmp = makeTempDir("resolve-provider-");
    process.env.HOME = tmp.path;
    process.env.USERPROFILE = tmp.path;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    tmp.cleanup();
  });

  it("uses a stored OpenAI API key profile when the environment variable is unset", () => {
    const authDir = path.join(tmp.path, ".phren", ".config");
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, "auth-profiles.json"), JSON.stringify({
      schemaVersion: 1,
      profiles: [{
        id: "openai-default",
        kind: "api-key",
        provider: "openai",
        label: "OpenAI API",
        apiKey: "sk-profile-key",
        createdAt: "2026-03-29T00:00:00.000Z",
        updatedAt: "2026-03-29T00:00:00.000Z",
      }],
    }, null, 2));

    const provider = resolveProvider(undefined, "openai/gpt-4o");
    expect(provider.name).toBe("openai");
  });

  it("resolves the Codex provider from a Codex CLI auth file", () => {
    const codexDir = path.join(tmp.path, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      last_refresh: "2026-03-29T12:00:00.000Z",
      tokens: {
        access_token: "header.payload.signature",
        refresh_token: "refresh-token",
        account_id: "acct_123",
      },
    }, null, 2));

    const provider = resolveProvider("openai-codex");
    expect(provider.name).toBe("openai-codex");
    expect((provider as { model?: string }).model).toBe("gpt-5.4");
    expect(provider.reasoningEffort).toBe("medium");
  });

  it("infers the Codex transport from an openai-codex namespaced model", () => {
    const codexDir = path.join(tmp.path, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      last_refresh: "2026-03-29T12:00:00.000Z",
      tokens: {
        access_token: "header.payload.signature",
        refresh_token: "refresh-token",
        account_id: "acct_123",
      },
    }, null, 2));

    const provider = resolveProvider(undefined, "openai-codex/gpt-5.4");
    expect(provider.name).toBe("openai-codex");
    expect(provider.reasoningEffort).toBe("medium");
  });
});

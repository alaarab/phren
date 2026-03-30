import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  authProfilesPath,
  getCodexAuthProfile,
  hasCodexAuthProfile,
  resolveApiKey,
  upsertApiKeyProfile,
} from "../auth/profiles.js";
import { makeTempDir } from "../test-helpers.js";

describe("auth profiles", () => {
  let tmp: { path: string; cleanup: () => void };
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    tmp = makeTempDir("auth-profiles-");
    process.env.HOME = tmp.path;
    process.env.USERPROFILE = tmp.path;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    tmp.cleanup();
  });

  it("stores API keys in the normalized auth profile store", () => {
    upsertApiKeyProfile("openai", "sk-profile-key");

    expect(resolveApiKey("openai", "OPENAI_API_KEY")).toBe("sk-profile-key");

    const stored = JSON.parse(fs.readFileSync(authProfilesPath(), "utf8")) as {
      schemaVersion: number;
      profiles: Array<{ provider: string; kind: string }>;
    };
    expect(stored.schemaVersion).toBe(1);
    expect(stored.profiles[0]).toMatchObject({ provider: "openai", kind: "api-key" });
  });

  it("prefers environment variables over stored API key profiles", () => {
    upsertApiKeyProfile("openai", "sk-profile-key");
    process.env.OPENAI_API_KEY = "sk-env-key";

    expect(resolveApiKey("openai", "OPENAI_API_KEY")).toBe("sk-env-key");
  });

  it("imports Codex CLI auth into the normalized store on demand", () => {
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

    expect(hasCodexAuthProfile({ allowCliImport: false })).toBe(false);

    const imported = getCodexAuthProfile({ allowCliImport: true });
    expect(imported?.source).toBe("codex-cli-import");
    expect(imported?.accountId).toBe("acct_123");
    expect(fs.existsSync(authProfilesPath())).toBe(true);
    expect(hasCodexAuthProfile({ allowCliImport: false })).toBe(true);
  });
});

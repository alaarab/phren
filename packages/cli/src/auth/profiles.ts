import * as fs from "fs";
import * as path from "path";
import { atomicWriteText, homePath } from "../phren-paths.js";

export type ApiKeyProvider = "openai" | "openrouter" | "anthropic";
export type AuthProvider = ApiKeyProvider | "openai-codex";

export interface ApiKeyProfile {
  id: string;
  kind: "api-key";
  provider: ApiKeyProvider;
  label: string;
  apiKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodexAuthProfile {
  id: string;
  kind: "codex-subscription";
  provider: "openai-codex";
  label: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  accountId?: string;
  lastRefresh?: string;
  source: "phren-oauth" | "codex-cli-import";
  createdAt: string;
  updatedAt: string;
}

export type AuthProfile = ApiKeyProfile | CodexAuthProfile;

interface AuthProfilesFile {
  schemaVersion: 1;
  profiles: AuthProfile[];
}

interface CodexCliAuthFile {
  auth_mode?: unknown;
  OPENAI_API_KEY?: unknown;
  last_refresh?: unknown;
  tokens?: {
    access_token?: unknown;
    refresh_token?: unknown;
    account_id?: unknown;
  };
}

const DEFAULT_PROFILE_IDS: Record<AuthProvider, string> = {
  openai: "openai-default",
  openrouter: "openrouter-default",
  anthropic: "anthropic-default",
  "openai-codex": "openai-codex-default",
};

function defaultLabel(provider: AuthProvider): string {
  switch (provider) {
    case "openai":
      return "OpenAI API";
    case "openrouter":
      return "OpenRouter API";
    case "anthropic":
      return "Anthropic API";
    case "openai-codex":
      return "OpenAI Codex Subscription";
  }
}

function authProfileDir(): string {
  return homePath(".phren", ".config");
}

function authProfilesFilePath(): string {
  return path.join(authProfileDir(), "auth-profiles.json");
}

function codexCliAuthPath(): string {
  return homePath(".codex", "auth.json");
}

function ensureAuthProfileDir(): void {
  fs.mkdirSync(authProfileDir(), { recursive: true, mode: 0o700 });
}

function persistProfiles(data: AuthProfilesFile): void {
  ensureAuthProfileDir();
  const filePath = authProfilesFilePath();
  atomicWriteText(filePath, JSON.stringify(data, null, 2) + "\n");
  try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }
}

function normalizeStore(raw: unknown): AuthProfilesFile {
  if (!raw || typeof raw !== "object") {
    return { schemaVersion: 1, profiles: [] };
  }
  const record = raw as { schemaVersion?: unknown; profiles?: unknown };
  if (record.schemaVersion !== 1 || !Array.isArray(record.profiles)) {
    return { schemaVersion: 1, profiles: [] };
  }
  return {
    schemaVersion: 1,
    profiles: record.profiles.filter((profile): profile is AuthProfile => {
      if (!profile || typeof profile !== "object") return false;
      const p = profile as Partial<AuthProfile>;
      return typeof p.id === "string" && typeof p.kind === "string" && typeof p.provider === "string";
    }),
  };
}

function loadStore(): AuthProfilesFile {
  try {
    return normalizeStore(JSON.parse(fs.readFileSync(authProfilesFilePath(), "utf8")));
  } catch {
    return { schemaVersion: 1, profiles: [] };
  }
}

function upsertProfile<T extends AuthProfile>(profile: T): T {
  const store = loadStore();
  store.profiles = store.profiles.filter((entry) => entry.id !== profile.id);
  store.profiles.push(profile);
  persistProfiles(store);
  return profile;
}

export function authProfilesPath(): string {
  return authProfilesFilePath();
}

export function getAuthProfiles(): AuthProfile[] {
  return loadStore().profiles;
}

export function getApiKeyProfile(provider: ApiKeyProvider): ApiKeyProfile | null {
  return loadStore().profiles.find((profile): profile is ApiKeyProfile =>
    profile.kind === "api-key" && profile.provider === provider && profile.id === DEFAULT_PROFILE_IDS[provider],
  ) ?? null;
}

export function hasApiKeyProfile(provider: ApiKeyProvider): boolean {
  return Boolean(getApiKeyProfile(provider));
}

export function upsertApiKeyProfile(provider: ApiKeyProvider, apiKey: string): ApiKeyProfile {
  const now = new Date().toISOString();
  const existing = getApiKeyProfile(provider);
  const profile: ApiKeyProfile = {
    id: DEFAULT_PROFILE_IDS[provider],
    kind: "api-key",
    provider,
    label: defaultLabel(provider),
    apiKey,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return upsertProfile(profile);
}

export function removeApiKeyProfile(provider: ApiKeyProvider): boolean {
  const store = loadStore();
  const before = store.profiles.length;
  store.profiles = store.profiles.filter((profile) => !(profile.kind === "api-key" && profile.provider === provider));
  if (store.profiles.length === before) return false;
  persistProfiles(store);
  return true;
}

export function resolveApiKey(provider: ApiKeyProvider, envVar: string): string | null {
  const envValue = process.env[envVar];
  if (typeof envValue === "string" && envValue.trim()) return envValue.trim();
  return getApiKeyProfile(provider)?.apiKey ?? null;
}

function inferCodexExpiry(lastRefresh: string | undefined): number {
  const refreshedAt = lastRefresh ? Date.parse(lastRefresh) : NaN;
  if (!Number.isNaN(refreshedAt)) return refreshedAt + 60 * 60 * 1000;
  return Date.now() + 60 * 60 * 1000;
}

function readCodexCliAuthFile(): CodexAuthProfile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(codexCliAuthPath(), "utf8")) as CodexCliAuthFile;
    const accessToken = typeof parsed.tokens?.access_token === "string" ? parsed.tokens.access_token : null;
    if (!accessToken) return null;

    const now = new Date().toISOString();
    return {
      id: DEFAULT_PROFILE_IDS["openai-codex"],
      kind: "codex-subscription",
      provider: "openai-codex",
      label: defaultLabel("openai-codex"),
      accessToken,
      refreshToken: typeof parsed.tokens?.refresh_token === "string" ? parsed.tokens.refresh_token : undefined,
      accountId: typeof parsed.tokens?.account_id === "string" ? parsed.tokens.account_id : undefined,
      expiresAt: inferCodexExpiry(typeof parsed.last_refresh === "string" ? parsed.last_refresh : undefined),
      lastRefresh: typeof parsed.last_refresh === "string" ? parsed.last_refresh : undefined,
      source: "codex-cli-import",
      createdAt: now,
      updatedAt: now,
    };
  } catch {
    return null;
  }
}

export function hasCodexCliAuth(): boolean {
  return Boolean(readCodexCliAuthFile());
}

export function getCodexAuthProfile(opts: { allowCliImport?: boolean } = {}): CodexAuthProfile | null {
  const localProfile = loadStore().profiles.find((profile): profile is CodexAuthProfile =>
    profile.kind === "codex-subscription" && profile.provider === "openai-codex",
  ) ?? null;
  if (localProfile) return localProfile;

  if (!opts.allowCliImport) return null;
  const imported = readCodexCliAuthFile();
  if (!imported) return null;
  return upsertCodexAuthProfile({
    accessToken: imported.accessToken,
    refreshToken: imported.refreshToken,
    expiresAt: imported.expiresAt,
    accountId: imported.accountId,
    lastRefresh: imported.lastRefresh,
    source: "codex-cli-import",
  });
}

export function hasCodexAuthProfile(opts: { allowCliImport?: boolean } = {}): boolean {
  if (getCodexAuthProfile({ allowCliImport: false })) return true;
  return Boolean(opts.allowCliImport && readCodexCliAuthFile());
}

export function upsertCodexAuthProfile(data: {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  accountId?: string;
  lastRefresh?: string;
  source?: "phren-oauth" | "codex-cli-import";
}): CodexAuthProfile {
  const now = new Date().toISOString();
  const existing = getCodexAuthProfile({ allowCliImport: false });
  const profile: CodexAuthProfile = {
    id: DEFAULT_PROFILE_IDS["openai-codex"],
    kind: "codex-subscription",
    provider: "openai-codex",
    label: defaultLabel("openai-codex"),
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: data.expiresAt,
    accountId: data.accountId,
    lastRefresh: data.lastRefresh ?? now,
    source: data.source ?? "phren-oauth",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return upsertProfile(profile);
}

export function removeCodexAuthProfile(): boolean {
  const store = loadStore();
  const before = store.profiles.length;
  store.profiles = store.profiles.filter((profile) => !(profile.kind === "codex-subscription" && profile.provider === "openai-codex"));
  if (store.profiles.length === before) return false;
  persistProfiles(store);
  return true;
}

export interface AuthStatusEntry {
  provider: AuthProvider;
  configured: boolean;
  source: "env" | "profile" | "codex-cli" | "none";
  label: string;
  expiresAt?: number;
  accountId?: string;
}

export function getAuthStatusEntries(): AuthStatusEntry[] {
  const apiProviders: Array<{ provider: ApiKeyProvider; envVar: string }> = [
    { provider: "openrouter", envVar: "OPENROUTER_API_KEY" },
    { provider: "anthropic", envVar: "ANTHROPIC_API_KEY" },
    { provider: "openai", envVar: "OPENAI_API_KEY" },
  ];

  const apiEntries = apiProviders.map(({ provider, envVar }) => {
    const envValue = process.env[envVar];
    const profile = getApiKeyProfile(provider);
    return {
      provider,
      configured: Boolean((typeof envValue === "string" && envValue.trim()) || profile),
      source: (typeof envValue === "string" && envValue.trim())
        ? "env"
        : profile
          ? "profile"
          : "none",
      label: defaultLabel(provider),
    } satisfies AuthStatusEntry;
  });

  const localCodex = getCodexAuthProfile({ allowCliImport: false });
  const cliCodex = localCodex ? null : readCodexCliAuthFile();
  const codexEntry: AuthStatusEntry = {
    provider: "openai-codex",
    configured: Boolean(localCodex || cliCodex),
    source: localCodex
      ? (localCodex.source === "codex-cli-import" ? "codex-cli" : "profile")
      : cliCodex
        ? "codex-cli"
        : "none",
    label: defaultLabel("openai-codex"),
    expiresAt: localCodex?.expiresAt ?? cliCodex?.expiresAt,
    accountId: localCodex?.accountId ?? cliCodex?.accountId,
  };

  return [...apiEntries, codexEntry];
}

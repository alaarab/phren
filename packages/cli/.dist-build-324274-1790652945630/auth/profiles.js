import * as fs from "fs";
import * as path from "path";
import { atomicWriteText, ensurePrivateDir, homePath } from "../phren-paths.js";
/** POSIX mode for every file that holds plaintext credentials. */
const CREDENTIAL_FILE_MODE = 0o600;
const DEFAULT_PROFILE_IDS = {
    openai: "openai-default",
    openrouter: "openrouter-default",
    anthropic: "anthropic-default",
    "openai-codex": "openai-codex-default",
};
function defaultLabel(provider) {
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
// auth-profiles.json holds OpenAI/OpenRouter/Anthropic API keys and OpenAI
// Codex OAuth access+refresh tokens in plaintext. It used to live under
// `.config/`, which the store's .gitignore template does NOT ignore (that
// directory is meant for shared, non-secret policy JSON) — so any store
// synced to a git remote pushed every user's credentials there. `.runtime/`
// is gitignored by the store template, so credentials now live there
// instead. See migrateLegacyAuthProfilesFile() below for the one-time move.
function authProfileDir() {
    return homePath(".phren", ".runtime");
}
function authProfilesFilePath() {
    return path.join(authProfileDir(), "auth-profiles.json");
}
function legacyAuthProfileDir() {
    return homePath(".phren", ".config");
}
function legacyAuthProfilesFilePath() {
    return path.join(legacyAuthProfileDir(), "auth-profiles.json");
}
function codexCliAuthPath() {
    return homePath(".codex", "auth.json");
}
/**
 * `mkdirSync(..., { mode: 0o700 })` only applies the mode to directories it
 * creates. `~/.phren/.runtime` is created by `runtimeFile()` on any ordinary
 * session long before the first `phren auth` call, so the mode argument was a
 * no-op on every real install and the credential directory sat at 0755.
 * ensurePrivateDir tightens an existing directory as well as creating one.
 */
function ensureAuthProfileDir() {
    ensurePrivateDir(authProfileDir());
}
/**
 * One-time migration off the old `.config/auth-profiles.json` location.
 * Runs at the top of loadStore(), the common entry point for every read and
 * write in this module, so it fires on the next `phren auth`/MCP call after
 * upgrading — no separate migration command needed. Idempotent: once the
 * file is moved, the legacy path no longer exists, so every later call is a
 * single fs.existsSync() no-op. Best-effort: if the move fails (e.g. a
 * cross-device home directory, or a permissions issue), the legacy file is
 * left in place — it stays covered by the `.config/auth-profiles.json`
 * .gitignore entry added alongside this migration, and every call retries.
 */
function migrateLegacyAuthProfilesFile() {
    const legacyPath = legacyAuthProfilesFilePath();
    const currentPath = authProfilesFilePath();
    if (fs.existsSync(currentPath) || !fs.existsSync(legacyPath))
        return;
    try {
        ensureAuthProfileDir();
        fs.renameSync(legacyPath, currentPath);
        try {
            fs.chmodSync(currentPath, CREDENTIAL_FILE_MODE);
        }
        catch { /* best effort */ }
    }
    catch { /* best effort — retried on the next call */ }
}
function persistProfiles(data) {
    ensureAuthProfileDir();
    const filePath = authProfilesFilePath();
    // Mode goes to the temp file, before the rename. Chmod-ing after the write
    // leaves the API keys and OAuth refresh tokens at 0644 for the duration of
    // the write — a window any local user can poll for.
    atomicWriteText(filePath, JSON.stringify(data, null, 2) + "\n", { mode: CREDENTIAL_FILE_MODE });
    // Belt and braces: rename over a pre-existing 0644 file keeps the *new*
    // inode's mode, but an interrupted upgrade could leave the old one behind.
    try {
        fs.chmodSync(filePath, CREDENTIAL_FILE_MODE);
    }
    catch { /* best effort */ }
}
function normalizeStore(raw) {
    if (!raw || typeof raw !== "object") {
        return { schemaVersion: 1, profiles: [] };
    }
    const record = raw;
    if (record.schemaVersion !== 1 || !Array.isArray(record.profiles)) {
        return { schemaVersion: 1, profiles: [] };
    }
    return {
        schemaVersion: 1,
        profiles: record.profiles.filter((profile) => {
            if (!profile || typeof profile !== "object")
                return false;
            const p = profile;
            return typeof p.id === "string" && typeof p.kind === "string" && typeof p.provider === "string";
        }),
    };
}
function loadStore() {
    migrateLegacyAuthProfilesFile();
    try {
        return normalizeStore(JSON.parse(fs.readFileSync(authProfilesFilePath(), "utf8")));
    }
    catch {
        return { schemaVersion: 1, profiles: [] };
    }
}
function upsertProfile(profile) {
    const store = loadStore();
    store.profiles = store.profiles.filter((entry) => entry.id !== profile.id);
    store.profiles.push(profile);
    persistProfiles(store);
    return profile;
}
export function authProfilesPath() {
    return authProfilesFilePath();
}
export function getAuthProfiles() {
    return loadStore().profiles;
}
export function getApiKeyProfile(provider) {
    return loadStore().profiles.find((profile) => profile.kind === "api-key" && profile.provider === provider && profile.id === DEFAULT_PROFILE_IDS[provider]) ?? null;
}
export function hasApiKeyProfile(provider) {
    return Boolean(getApiKeyProfile(provider));
}
export function upsertApiKeyProfile(provider, apiKey) {
    const now = new Date().toISOString();
    const existing = getApiKeyProfile(provider);
    const profile = {
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
export function removeApiKeyProfile(provider) {
    const store = loadStore();
    const before = store.profiles.length;
    store.profiles = store.profiles.filter((profile) => !(profile.kind === "api-key" && profile.provider === provider));
    if (store.profiles.length === before)
        return false;
    persistProfiles(store);
    return true;
}
export function resolveApiKey(provider, envVar) {
    const envValue = process.env[envVar];
    if (typeof envValue === "string" && envValue.trim())
        return envValue.trim();
    return getApiKeyProfile(provider)?.apiKey ?? null;
}
function inferCodexExpiry(lastRefresh) {
    const refreshedAt = lastRefresh ? Date.parse(lastRefresh) : NaN;
    if (!Number.isNaN(refreshedAt))
        return refreshedAt + 60 * 60 * 1000;
    return Date.now() + 60 * 60 * 1000;
}
function readCodexCliAuthFile() {
    try {
        const parsed = JSON.parse(fs.readFileSync(codexCliAuthPath(), "utf8"));
        const accessToken = typeof parsed.tokens?.access_token === "string" ? parsed.tokens.access_token : null;
        if (!accessToken)
            return null;
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
    }
    catch {
        return null;
    }
}
export function hasCodexCliAuth() {
    return Boolean(readCodexCliAuthFile());
}
export function getCodexAuthProfile(opts = {}) {
    const localProfile = loadStore().profiles.find((profile) => profile.kind === "codex-subscription" && profile.provider === "openai-codex") ?? null;
    if (localProfile)
        return localProfile;
    if (!opts.allowCliImport)
        return null;
    const imported = readCodexCliAuthFile();
    if (!imported)
        return null;
    return upsertCodexAuthProfile({
        accessToken: imported.accessToken,
        refreshToken: imported.refreshToken,
        expiresAt: imported.expiresAt,
        accountId: imported.accountId,
        lastRefresh: imported.lastRefresh,
        source: "codex-cli-import",
    });
}
export function hasCodexAuthProfile(opts = {}) {
    if (getCodexAuthProfile({ allowCliImport: false }))
        return true;
    return Boolean(opts.allowCliImport && readCodexCliAuthFile());
}
export function upsertCodexAuthProfile(data) {
    const now = new Date().toISOString();
    const existing = getCodexAuthProfile({ allowCliImport: false });
    const profile = {
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
export function removeCodexAuthProfile() {
    const store = loadStore();
    const before = store.profiles.length;
    store.profiles = store.profiles.filter((profile) => !(profile.kind === "codex-subscription" && profile.provider === "openai-codex"));
    if (store.profiles.length === before)
        return false;
    persistProfiles(store);
    return true;
}
export function getAuthStatusEntries() {
    const apiProviders = [
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
        };
    });
    const localCodex = getCodexAuthProfile({ allowCliImport: false });
    const cliCodex = localCodex ? null : readCodexCliAuthFile();
    const codexEntry = {
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

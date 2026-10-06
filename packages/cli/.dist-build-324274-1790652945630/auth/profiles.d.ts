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
export declare function authProfilesPath(): string;
export declare function getAuthProfiles(): AuthProfile[];
export declare function getApiKeyProfile(provider: ApiKeyProvider): ApiKeyProfile | null;
export declare function hasApiKeyProfile(provider: ApiKeyProvider): boolean;
export declare function upsertApiKeyProfile(provider: ApiKeyProvider, apiKey: string): ApiKeyProfile;
export declare function removeApiKeyProfile(provider: ApiKeyProvider): boolean;
export declare function resolveApiKey(provider: ApiKeyProvider, envVar: string): string | null;
export declare function hasCodexCliAuth(): boolean;
export declare function getCodexAuthProfile(opts?: {
    allowCliImport?: boolean;
}): CodexAuthProfile | null;
export declare function hasCodexAuthProfile(opts?: {
    allowCliImport?: boolean;
}): boolean;
export declare function upsertCodexAuthProfile(data: {
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
    accountId?: string;
    lastRefresh?: string;
    source?: "phren-oauth" | "codex-cli-import";
}): CodexAuthProfile;
export declare function removeCodexAuthProfile(): boolean;
export interface AuthStatusEntry {
    provider: AuthProvider;
    configured: boolean;
    source: "env" | "profile" | "codex-cli" | "none";
    label: string;
    expiresAt?: number;
    accountId?: string;
}
export declare function getAuthStatusEntries(): AuthStatusEntry[];

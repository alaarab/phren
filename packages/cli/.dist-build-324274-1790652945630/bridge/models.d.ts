import { BridgeError, type Json } from "./protocol.js";
/** One entry of a `/model` menu as the phone draws it. */
export interface AgentModel {
    id: string;
    name: string;
    description?: string;
    isDefault?: boolean;
    isCurrent?: boolean;
    defaultReasoningEffort?: string;
    supportedReasoningEfforts?: string[];
}
/** Only initialize and list. Never a thread, a prompt, or a login. */
export declare function readCodexModels(executable?: string): Promise<AgentModel[]>;
export declare function codexModels(result: Json): AgentModel[];
/** The menu used only when Claude Code's own catalogue cannot be read (it has
 * never run on this computer, or the cache is unreadable). Normally the phone
 * shows the live catalogue below, so a new model appears without anyone
 * editing this table. Exported so a parity test can hold the phone's built-in
 * offline fallback and the chat fixture to it. */
export declare const CLAUDE_MENU: readonly AgentModel[];
/** Claude Code fetches its `/model` catalogue from Anthropic and caches it as
 * `<config>/cache/model-catalog/<account>-...-cc.json`, refreshing it itself:
 * `catalog.config.models` is the menu in the terminal's order (`section`
 * "main" first, older models under "overflow"), each row gated by
 * `min_claude_code_version`, and `catalog.state.model` is the selected
 * default. Reading that file keeps the phone's picker identical to the
 * terminal's with nothing to maintain here. */
export declare function readClaudeCatalog(configDir?: string, installed?: string): Promise<AgentModel[]>;
/** The live catalogue when Claude Code has one cached on this computer,
 * otherwise the offline fallback, copied per call so a caller cannot mutate it. */
export declare function readClaudeModels(configDir?: string, installed?: string | null): Promise<AgentModel[]>;
/** `opencode models` prints one `provider/model` id per line. The Go plan's
 * models sit under `opencode-go/`, Zen's under `opencode/`, and everything
 * else under the gateway it came from; the configured default is marked. */
export declare function readOpenCodeModels(executable?: string, configDir?: string): Promise<AgentModel[]>;
/** "claude-fable-5-1" reads as "Fable 5.1"; a date suffix is dropped. */
export declare function claudeName(id: string): string;
/** The account a request names is not one on this computer (or has no catalogue for that source). */
export declare const accountUnavailable: (account: string) => BridgeError;
/** Catalogues change rarely and app-server takes seconds to start. Cached per
 * `${source}:${account}`; only Claude has accounts, each reading its own home. */
export declare class ModelCatalog {
    private readonly codex;
    private readonly claude;
    private readonly opencode;
    private readonly cacheMs;
    private cache;
    constructor(codex?: () => Promise<AgentModel[]>, claude?: (configDir?: string) => Promise<AgentModel[]>, opencode?: () => Promise<AgentModel[]>, cacheMs?: number);
    list(source: string, account?: string): Promise<AgentModel[]>;
}

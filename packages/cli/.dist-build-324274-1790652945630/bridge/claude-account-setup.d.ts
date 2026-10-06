/** Entries of the default home every account shares by symlink. */
export declare const SHARED_ENTRIES: string[];
/** Refresh every extra home's mcpServers from the default home. Returns the ids that changed. */
export declare function syncAccountMcpServers(env?: NodeJS.ProcessEnv): Promise<string[]>;
export interface AddedAccount {
    id: string;
    dir: string;
    linked: string[];
    created: boolean;
}
export declare function addClaudeAccount(slug: string, opts?: {
    label?: string;
    env?: NodeJS.ProcessEnv;
}): Promise<AddedAccount>;

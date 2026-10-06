import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpContext } from "./types.js";
export declare function findConflictCandidates(phrenPath: string, project: string, finding: string): string[];
export interface TeamStoreSyncResult {
    store: string;
    pushed: boolean;
    error?: string;
}
/**
 * Commit and push the team-safe pathspecs of every attached team store. Team
 * stores are independent repos, so push_changes runs this whatever happens to
 * the primary store.
 */
export declare function syncTeamStores(phrenPath: string): Promise<TeamStoreSyncResult[]>;
export declare function register(server: McpServer, ctx: McpContext): void;

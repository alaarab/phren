/**
 * `phren agent` launches phren's coding agent, which ships separately as
 * `@phren/agent` (it brings ink and React, which the CLI must not carry). Like
 * `@phren/code` it is optional: nothing here is imported until the command
 * runs, and a missing package is a one-line hint, not a stack trace.
 */
export declare const AGENT_PACKAGE_HINT = "phren agent needs @phren/agent: run npm install -g @phren/agent";
export interface AgentPackage {
    directory: string;
    bin: string;
    version?: string;
    source: string;
}
/** The installed package in `directory`, if it is @phren/agent and its binary is built. */
export declare function agentPackageAt(directory: string, source: string): AgentPackage | undefined;
/**
 * Resolution order, first hit wins: an explicit directory
 * (`PHREN_AGENT_PACKAGE`), a package Node resolves next to this CLI, this
 * repository's own packages/agent in a workspace checkout, then npm's global
 * root. `global: false` skips the npm call for quick probes such as init's.
 */
export declare function findAgentPackage(options?: {
    global?: boolean;
}): AgentPackage | undefined;
/** Whether the agent can start here, from a local package or a `phren-agent`
 * on PATH. Cheap enough for init's summary: no npm call. */
export declare function agentInstalled(): boolean;
/**
 * Run the agent in a child process with this terminal. The child's argv[0] is
 * `phren-agent`, so the tmux provider and anything else that reads the process
 * table sees the same agent whichever entry point started it; the environment
 * (HERDR_PANE_ID, PHREN_PATH) passes through unchanged, which is what binds a
 * Herdr pane to the session's event log.
 */
export declare function runAgentCommand(args: string[]): Promise<number>;

/**
 * Collect the agents running on this machine and join them onto the graph.
 *
 * This module stays free of heavy imports on purpose: the graph view calls it
 * on a timer, and `cli-registry.ts` treats cold start as a constraint. The
 * project lookup is injected rather than imported, which keeps the FTS index
 * out of this path and makes the join testable without a store.
 */
import type { AgentProvider, AgentRecord, JoinedAgent } from "./types.js";
/** Off by default, like every other optional feature here. */
export declare function agentsEnabled(): boolean;
/** Resolves a working directory to a phren project, or null. */
export type ProjectResolver = (cwd: string) => string | null;
/**
 * Ask every available provider, in order. A provider that throws or hangs is
 * skipped rather than allowed to break a repaint; duplicates by id keep the
 * first answer, so an earlier provider wins.
 */
export declare function collectAgents(providers: AgentProvider[]): AgentRecord[];
/**
 * Attach each agent to the phren project its directory belongs to. The
 * resolver is the same one the hooks use, so a git worktree lands on the
 * repository it came from. Agents outside any project keep a null project and
 * still appear in the list.
 */
export declare function joinAgents(records: AgentRecord[], resolve: ProjectResolver): JoinedAgent[];
/** Sort for display: what you are looking at first, then busy, then the rest. */
export declare function sortAgents(agents: JoinedAgent[]): JoinedAgent[];

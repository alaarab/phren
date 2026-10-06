/**
 * Agents spawned by phren-agent's own multi-agent mode.
 *
 * The spawner runs in a different process from the shell, so it publishes each
 * agent as a small JSON file under `.runtime/agents/` and removes it on exit.
 * That makes phren's own agents visible in the graph on the same footing as
 * any other host's, and gives the provider contract a second real
 * implementation rather than a speculative one.
 */
import { type AgentProvider } from "../types.js";
/** Where a spawner publishes its live agents. */
export declare function agentsRuntimeDir(phrenPath: string): string;
export declare function createSpawnerProvider(phrenPath: string, now?: () => number): AgentProvider;

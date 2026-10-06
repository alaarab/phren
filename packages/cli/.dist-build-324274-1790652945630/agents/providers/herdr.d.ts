/**
 * Agents running in a Herdr workspace.
 *
 * `herdr agent list` prints one JSON envelope describing every agent pane —
 * which agent, what it is doing, which directory, and whether it is focused —
 * and answers in a few milliseconds, so it is cheap enough to poll.
 *
 * Nothing Herdr-specific may leak past this file: the rest of phren only ever
 * sees `AgentRecord`.
 */
import type { AgentProvider, AgentRecord } from "../types.js";
/** Injected so tests never shell out. */
export type CommandExistsFn = (cmd: string) => boolean;
export type RunJsonFn = (argv: string[], timeoutMs: number) => unknown | null;
export declare function runHerdrJson(argv: string[], timeoutMs: number): unknown | null;
/** Pull the agent array out of Herdr's envelope, tolerating shape drift. */
export declare function parseHerdrAgents(payload: unknown): AgentRecord[];
export declare function createHerdrProvider(commandExists: CommandExistsFn, runJson?: RunJsonFn): AgentProvider;

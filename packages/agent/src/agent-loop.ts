/**
 * Barrel re-export — the actual implementation lives in agent-loop/ directory.
 * This file exists so all existing `from "./agent-loop.js"` imports continue working.
 */
export {
  type AgentConfig,
  type AgentResult,
  type AgentSession,
  type TurnResult,
  type TurnHooks,
  createSession,
} from "./agent-loop/types.js";

export { consumeStream, runToolsConcurrently } from "./agent-loop/stream.js";

export { runTurn, runAgent } from "./agent-loop/index.js";

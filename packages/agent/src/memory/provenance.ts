/**
 * Provenance for findings the agent writes into phren.
 *
 * Every write path (explicit tool, auto-capture, anti-patterns, compaction)
 * goes through this so findings are traceable to the session that produced
 * them and can be staleness-aged by the CLI's trust filter.
 */

export interface AgentProvenance {
  source: "agent";
  tool: string;
  session_id?: string;
  model?: string;
}

export function agentProvenance(sessionId?: string | null, model?: string): AgentProvenance {
  return {
    source: "agent",
    tool: "phren-agent",
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(model ? { model } : {}),
  };
}

/**
 * What phren knows about a coding agent running on this machine.
 *
 * phren does not spawn or supervise these; it discovers them from whatever is
 * already managing them — a Herdr workspace, phren-agent's own multi-agent
 * spawner, a tmux session — and joins them onto the knowledge graph by the
 * directory they are working in.
 *
 * The contract is deliberately small and host-agnostic. Anything that can
 * print this shape is a provider, which is why a tmux or Zellij user needs a
 * few lines of shell rather than a change to phren.
 */

export type AgentStatus = "working" | "idle" | "done" | "error";

export interface AgentRecord {
  /** Stable for as long as the agent lives; used to address it. */
  id: string;
  /** Human label, e.g. the pane's title. */
  label: string;
  /** Working directory, which is how the agent joins a phren project. */
  cwd: string;
  status: AgentStatus;
  /** Which agent this is ("claude", "codex", …), when the host knows. */
  kind?: string;
  /** Whether the host considers this the agent the user is looking at. */
  focused?: boolean;
  /**
   * Command that brings this agent to the front, as argv. phren never needs to
   * know what focusing means for a given host — the provider says how.
   */
  focus?: string[];
  /** Which provider produced this record, for the pane and for debugging. */
  provider?: string;
}

/** An agent record joined to the phren project its directory belongs to. */
export interface JoinedAgent extends AgentRecord {
  /** Resolved phren project, or null when the directory is not a phren project. */
  project: string | null;
}

export interface AgentProvider {
  name: string;
  /** Cheap probe. Must not throw and must not block on network or a lock. */
  available(): boolean;
  /** Never throws: a provider that cannot answer returns nothing. */
  list(): AgentRecord[];
}

const STATUSES = new Set<string>(["working", "idle", "done", "error"]);

/**
 * Structural guard for records that arrive from outside phren. These drive a
 * command invocation, so a malformed entry is dropped rather than trusted —
 * the same posture governance takes with its on-disk JSON.
 */
export function isAgentRecord(value: unknown): value is AgentRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  if (typeof rec.id !== "string" || !rec.id) return false;
  if (typeof rec.label !== "string") return false;
  if (typeof rec.cwd !== "string" || !rec.cwd) return false;
  if (typeof rec.status !== "string" || !STATUSES.has(rec.status)) return false;
  if (rec.kind !== undefined && typeof rec.kind !== "string") return false;
  if (rec.focused !== undefined && typeof rec.focused !== "boolean") return false;
  if (rec.focus !== undefined) {
    if (!Array.isArray(rec.focus) || rec.focus.length === 0) return false;
    if (!rec.focus.every((part) => typeof part === "string" && part.length > 0)) return false;
  }
  return true;
}

/**
 * Collect the agents running on this machine and join them onto the graph.
 *
 * This module stays free of heavy imports on purpose: the graph view calls it
 * on a timer, and `cli-registry.ts` treats cold start as a constraint. The
 * project lookup is injected rather than imported, which keeps the FTS index
 * out of this path and makes the join testable without a store.
 */

import { isFeatureEnabled } from "../utils-helpers.js";
import { debugLog } from "../shared.js";
import { errorMessage } from "../utils.js";
import type { AgentProvider, AgentRecord, JoinedAgent } from "./types.js";

/** Off by default, like every other optional feature here. */
export function agentsEnabled(): boolean {
  return isFeatureEnabled("PHREN_FEATURE_AGENTS", false);
}

/** Resolves a working directory to a phren project, or null. */
export type ProjectResolver = (cwd: string) => string | null;

/**
 * Ask every available provider, in order. A provider that throws or hangs is
 * skipped rather than allowed to break a repaint; duplicates by id keep the
 * first answer, so an earlier provider wins.
 */
export function collectAgents(providers: AgentProvider[]): AgentRecord[] {
  const seen = new Set<string>();
  const out: AgentRecord[] = [];
  for (const provider of providers) {
    let records: AgentRecord[] = [];
    try {
      if (!provider.available()) continue;
      records = provider.list();
    } catch (err: unknown) {
      debugLog(`agent provider ${provider.name}: ${errorMessage(err)}`);
      continue;
    }
    for (const record of records) {
      const key = `${record.provider ?? provider.name}:${record.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ provider: provider.name, ...record });
    }
  }
  return out;
}

/**
 * Attach each agent to the phren project its directory belongs to. The
 * resolver is the same one the hooks use, so a git worktree lands on the
 * repository it came from. Agents outside any project keep a null project and
 * still appear in the list.
 */
export function joinAgents(records: AgentRecord[], resolve: ProjectResolver): JoinedAgent[] {
  const cache = new Map<string, string | null>();
  return records.map((record) => {
    let project = cache.get(record.cwd);
    if (project === undefined) {
      try {
        project = resolve(record.cwd);
      } catch (err: unknown) {
        debugLog(`agent join ${record.cwd}: ${errorMessage(err)}`);
        project = null;
      }
      cache.set(record.cwd, project);
    }
    return { ...record, project };
  });
}

/** Sort for display: what you are looking at first, then busy, then the rest. */
export function sortAgents(agents: JoinedAgent[]): JoinedAgent[] {
  const rank = (a: JoinedAgent): number => {
    if (a.focused) return 0;
    if (a.status === "working") return 1;
    if (a.status === "error") return 2;
    if (a.status === "idle") return 3;
    return 4;
  };
  return agents.slice().sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

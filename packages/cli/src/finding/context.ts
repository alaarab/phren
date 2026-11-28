import * as fs from "fs";
import * as path from "path";
import { runtimeSessionsDir } from "../session/utils.js";

interface SessionStateSnapshot {
  sessionId: string;
  project?: string;
  startedAt?: string;
  endedAt?: string;
}

function listActiveSessions(phrenPath: string): SessionStateSnapshot[] {
  const dir = runtimeSessionsDir(phrenPath);
  if (!fs.existsSync(dir)) return [];

  const sessions: SessionStateSnapshot[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith("session-") || !entry.name.endsWith(".json")) continue;
    const fullPath = path.join(dir, entry.name);
    try {
      const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8")) as SessionStateSnapshot;
      if (!parsed.sessionId || parsed.endedAt) continue;
      sessions.push(parsed);
    } catch {
      continue;
    }
  }
  return sessions;
}

function sessionSortValue(state: SessionStateSnapshot): number {
  if (state.startedAt) {
    const parsed = Date.parse(state.startedAt);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

export function resolveFindingSessionId(
  phrenPath: string,
  project: string,
  explicitSessionId?: string,
): string | undefined {
  const trimmed = explicitSessionId?.trim();
  if (trimmed) return trimmed;

  const active = listActiveSessions(phrenPath);
  if (active.length === 0) return undefined;

  const matchingProject = active
    .filter((session) => session.project === project)
    .sort((a, b) => sessionSortValue(b) - sessionSortValue(a));
  if (matchingProject.length > 0) return matchingProject[0].sessionId;
  // Do not attribute findings to an unrelated active session from another project.
  // Missing session provenance is safer than cross-project contamination.
  return undefined;
}

// CONTRACT STUB — worker B owns this file. The orchestrator replaces it with B's version at integration.
// Only the contract signature `dream(project, opts: { dryRun?, mode?, now? }) → DreamResult` (plus `force`,
// which section 3 requires for manual runs while disabled) is relied on. Worker A's surfaces read the result
// loosely (`status`, and counts when present), so B's richer DreamResult fits without changes there.

import type { DreamChangeset } from "./types.js";

export interface DreamOptions {
  dryRun?: boolean;
  mode?: "propose" | "apply";
  now?: Date;
  /** Run even when dreaming is disabled (manual runs only). */
  force?: boolean;
}

export interface DreamResult {
  status: "ok" | "busy" | "disabled" | "error" | string;
  project: string;
  runId?: string;
  changeset?: DreamChangeset;
  error?: string;
}

export async function dream(project: string, _opts: DreamOptions = {}): Promise<DreamResult> {
  return { status: "error", project, error: "CONTRACT STUB: the dream engine is not integrated in this branch." };
}

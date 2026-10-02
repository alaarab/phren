import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { conductorPane, noteConductorSession, runsAgent } from "./conductor-role.js";
import { atomicInPrivateDir, BridgeError, bridgeRoot, type Json, type Target } from "./protocol.js";

declare const CONDUCTOR_SKILL_SOURCE: string | undefined;

export async function conductorBrief(): Promise<string> {
  let source: string | undefined;
  if (typeof CONDUCTOR_SKILL_SOURCE === "string") source = CONDUCTOR_SKILL_SOURCE;
  else {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const candidate of [
      path.join(here, "..", "starter", "global", "skills", "conductor", "SKILL.md"),
      path.join(here, "..", "..", "starter", "global", "skills", "conductor", "SKILL.md"),
    ]) {
      source = await readFile(candidate, "utf8").catch(() => undefined);
      if (source !== undefined) break;
    }
  }
  if (source === undefined) throw new BridgeError(503, "The shipped conductor brief is unavailable. Reinstall Phren Hook.");
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(source);
  const brief = (match?.[1] ?? source).trim();
  if (!brief) throw new BridgeError(503, "The shipped conductor brief is empty. Reinstall Phren Hook.");
  return brief;
}

/** The same shipped brief used by launches, restored for an existing session. */
export async function ensureConductorBrief(brief?: string): Promise<string> {
  const file = path.join(bridgeRoot(), "conductor", "brief.md");
  const content = (brief ?? await conductorBrief()) + "\n";
  if (await readFile(file, "utf8").catch(() => undefined) !== content) await atomicInPrivateDir(file, content);
  return file;
}

/** Only call after the callback has been placed in its live pane. The role
 * follows the terminal, so inherited launch variables cannot confer it. */
export async function conductorContext(target: Target, snapshot: Json): Promise<string | undefined> {
  const pane = await conductorPane(target.server, snapshot);
  if (!runsAgent(pane) || pane.pane_id !== target.pane || pane.agent !== target.source) return undefined;
  const file = await ensureConductorBrief();
  await noteConductorSession(target.server, target.pane, target.session);
  return `Phren role for this turn: conductor. Your role is attached to this live terminal and applies after startup, resume, model changes and compaction. Read the conductor brief at ${JSON.stringify(file)} before coordinating work if it is not already in context.
For questions about running work, start with Phren live_sessions (core: phren_admin action live_sessions; CLI: phren dispatch sessions). It includes linked computers and their sessions. Report unreachable and unlinked computers explicitly. Consult get_tasks and get_project_summary for the relevant projects, and dispatch_returns for worker outcomes.
Use dispatch for a new worker and hand_off for an existing session; preserve delivery IDs and check queued delivery status before retrying. Respect the owner's current limits on delegation, permissions and releases. Verify returns and tests before integrating or marking tasks done. Keep owner replies short and put detailed evidence in tasks. The role grants no additional permissions.`;
}

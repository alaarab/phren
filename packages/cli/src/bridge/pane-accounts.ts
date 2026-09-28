// Which Claude account a pane runs under. Known from the launch (recorded by
// recordPaneAccount), from the hook payload's transcript_path, or from the
// transcript file the pane's process holds open; the file's home decides.
// In memory only: a restarted Hook relearns it from the next poll or hook.
import path from "node:path";
import { claudeAccountRef, claudeHome, claudeHomeOfPath, type AccountRef } from "./claude-accounts.js";

interface Known { terminal?: string; fromFile?: string; launched?: string }
const known = new Map<string, Known>();
const MAX_PANES = 512;

export const paneAccountKey = (server: string, pane: unknown) => `${server}\0${String(pane)}`;

function entry(paneKey: string, terminal?: string): Known {
  let current = known.get(paneKey);
  if (current && terminal && current.terminal && current.terminal !== terminal) { known.delete(paneKey); current = undefined; }
  if (!current) {
    while (known.size >= MAX_PANES) known.delete(known.keys().next().value!);
    current = {}; known.set(paneKey, current);
  }
  if (terminal) current.terminal = terminal;
  return current;
}

/** The account a pane was launched with (`default` or a slug). */
export function recordPaneAccount(paneKey: string, accountId: string, terminal?: string): void {
  entry(paneKey, terminal).launched = accountId;
}

/** A Claude transcript path the pane's session is known to use. */
export function notePaneTranscript(paneKey: string, file: unknown, terminal?: string): void {
  if (typeof file !== "string" || !path.isAbsolute(file) || file.length > 4096) return;
  const home = claudeHomeOfPath(file);
  if (home) entry(paneKey, terminal).fromFile = home.id;
}

/** The pane's account: from its transcript when known, else the recorded launch. */
export function paneAccount(paneKey: string, terminal?: string): AccountRef | undefined {
  const current = known.get(paneKey);
  if (!current || (terminal && current.terminal && current.terminal !== terminal)) return undefined;
  const id = current.fromFile ?? current.launched;
  const home = id ? claudeHome(id) : undefined;
  return home ? claudeAccountRef(home) : undefined;
}

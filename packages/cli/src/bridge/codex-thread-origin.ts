import { open } from "node:fs/promises";
import path from "node:path";

/** Whether a Codex hook callback comes from a thread that is not the pane's
 * own conversation: a `codex exec` started inside the pane (a fanout worker,
 * a review run) or a subagent (the guardian reviewer, a spawned thread). They
 * inherit the pane's variables, so their callbacks name the pane, and each
 * one used to rebind it: the pane's conversation then looked replaced, phone
 * sends were refused as "conversation changed" and queued hand-offs failed.
 * Read from the rollout's first row (`originator`, `source`); a rollout that
 * cannot be read counts as the pane's own. */
export async function codexForeignThread(transcriptPath: unknown): Promise<boolean> {
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath) || !/^rollout-.*\.jsonl$/.test(path.basename(transcriptPath))) return false;
  const file = await open(transcriptPath, "r").catch(() => undefined);
  if (!file) return false;
  try {
    const buffer = Buffer.alloc(4096), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return foreignMeta(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally { await file.close(); }
}

/** The session_meta fields come before its long instructions, so the head of
 * the line is enough; no full parse. */
export function foreignMeta(head: string): boolean {
  if (!head.includes('"session_meta"')) return false;
  return /"originator"\s*:\s*"codex_exec"/.test(head) || /"source"\s*:\s*"exec"/.test(head) || /"source"\s*:\s*\{\s*"subagent"/.test(head);
}

/** Whether a Claude hook callback comes from a headless run (`claude -p`, the
 * Agent SDK) started inside the pane: it inherits HERDR_* and
 * PHREN_DISPATCH_ID, so its callbacks name the pane and overwrite the parent's
 * turn record. Interactive transcripts say `"entrypoint":"cli"`, headless ones
 * `sdk-cli`/`sdk-ts`/`sdk-py`, on the first user row. A transcript that cannot
 * be read, or has a long first prompt, counts as the pane's own. */
export async function claudeHeadlessThread(transcriptPath: unknown): Promise<boolean> {
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath) || !transcriptPath.endsWith(".jsonl")) return false;
  const file = await open(transcriptPath, "r").catch(() => undefined);
  if (!file) return false;
  try {
    const buffer = Buffer.alloc(32_768), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return headlessEntrypoint(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally { await file.close(); }
}

export function headlessEntrypoint(head: string): boolean {
  return /"entrypoint"\s*:\s*"sdk-[a-z]+"/.test(head);
}

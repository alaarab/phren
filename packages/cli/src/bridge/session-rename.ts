import { open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { codexHome } from "../home-paths.js";
import { stripTerminal } from "../terminal-text.js";
import { codexServers } from "./codex-servers.js";
import { paneIdentity, snapshot } from "./herdr.js";
import { emptyComposer } from "./model-switch.js";
import { paneClient, servedPane } from "./opencode-panes.js";
import type { PaneClient } from "./opencode-pane-server.js";
import { BridgeError, id, type Json, objects, type Target } from "./protocol.js";
import { terminalProvider, type TerminalProvider } from "./terminal.js";
import { visibleTerminalChoice } from "./terminal-choice.js";
import { targetTranscriptPath } from "./transcripts.js";

/** Renaming a session from the phone: the pane's and tab's terminal labels,
 * then the harness's own rename where one can be driven remotely. */

/** What the phone may send as a session name: 1 to 80 characters, no control characters. */
export const renameLabel = z.string().trim().min(1).max(80).refine(t => !/[\x00-\x1f\x7f]/.test(t));

export const renameRequest = z.object({ workspaceId: id, tabId: id, paneId: id.optional(), label: renameLabel });

export type NativeMechanism = "slash-command" | "app-server" | "opencode-api" | "none";
export interface NativeResult { harness: string; mechanism: NativeMechanism; applied: boolean; reason?: string }

/** Everything the rename touches outside this file; tests pass their own. */
export interface RenameDeps {
  snapshot(server: string): Promise<Json>;
  identity(server: string, pane: Json): Promise<string | undefined>;
  terminal(): TerminalProvider;
  codexRename(target: Target, label: string): Promise<boolean | undefined>;
  opencodeClient(server: string, pane: string): PaneClient | undefined;
  /** The name Claude's transcript for `target` last carries as its `custom-title`. */
  claudeTitle(target: Target): Promise<string | undefined>;
  /** The name Codex's `session_index.jsonl` last holds for a thread. */
  codexIndexTitle(thread: string): Promise<string | undefined>;
  sleep(ms: number): Promise<void>;
  /** How long a typed rename may take to show in the harness's own records. */
  verifyMs: number;
}

const TAIL_BYTES = 262_144;

/** The last `custom-title` in the tail of a Claude transcript. */
export function lastCustomTitle(text: string): string | undefined {
  for (const line of text.split("\n").reverse()) {
    if (!line.includes('"custom-title"')) continue;
    try {
      const row = JSON.parse(line) as Json;
      if (row.type === "custom-title" && typeof row.customTitle === "string") return row.customTitle;
    } catch { /* a line cut by the tail window */ }
  }
  return undefined;
}

/** The last `thread_name` written for `thread` in a Codex `session_index.jsonl`. */
export function lastIndexedName(text: string, thread: string): string | undefined {
  for (const line of text.split("\n").reverse()) {
    if (!line.includes(thread)) continue;
    try {
      const row = JSON.parse(line) as Json;
      if (row.id === thread && typeof row.thread_name === "string") return row.thread_name;
    } catch { /* a line cut by the tail window */ }
  }
  return undefined;
}

async function tail(file: string): Promise<string | undefined> {
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES), buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally { await handle.close(); }
}

export const defaultRenameDeps: RenameDeps = {
  snapshot,
  identity: (server, pane) => paneIdentity(server, pane, true),
  terminal: terminalProvider,
  async codexRename(target, label) {
    const entry = codexServers.forTarget(target);
    if (!entry) return undefined;
    await codexServers.renameThread(entry, label);
    return true;
  },
  opencodeClient(server, pane) {
    const entry = servedPane(server, pane);
    return entry ? paneClient(entry) : undefined;
  },
  async claudeTitle(target) {
    const text = await tail(await targetTranscriptPath({ ...target, source: "claude" }));
    return text === undefined ? undefined : lastCustomTitle(text);
  },
  async codexIndexTitle(thread) {
    const text = await tail(path.join(codexHome(), "session_index.jsonl"));
    return text === undefined ? undefined : lastIndexedName(text, thread);
  },
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  verifyMs: 4_000,
};

/** The agent pane a rename addresses: the named pane, else the tab's only agent pane, else its only pane. */
export function renamePane(panes: Json[], paneId: string | undefined): { pane: Json; renameTab: boolean } {
  if (!panes.length) throw new BridgeError(409, "The tab changed.");
  const agents = panes.filter(p => p.agent);
  if (paneId) {
    const pane = panes.find(p => p.pane_id === paneId);
    if (!pane) throw new BridgeError(409, "The pane changed.");
    return { pane, renameTab: agents.length ? agents.length === 1 && !!pane.agent : panes.length === 1 };
  }
  if (agents.length === 1) return { pane: agents[0], renameTab: true };
  if (!agents.length && panes.length === 1) return { pane: panes[0], renameTab: true };
  throw new BridgeError(400, "Choose a pane to rename.");
}

/** Types a slash command into an agent pane that is showing an empty composer. */
async function typeCommand(deps: RenameDeps, server: string, pane: Json, text: string): Promise<string | undefined> {
  const terminal = deps.terminal();
  const before = await terminal.readScreen(server, String(pane.pane_id), { scope: "pane", source: "visible", lines: 40, format: "ansi", timeoutMs: 2_000 }).catch(() => "");
  const composer = before.split(/\r?\n/).reverse().find(line => /^\s*[›❯>]/.test(stripTerminal(line)));
  if (!composer || !emptyComposer(composer) || visibleTerminalChoice(stripTerminal(before))) return "the terminal has a draft or an open menu";
  await terminal.prompt(server, String(pane.pane_id), text);
  return undefined;
}

/** Polls `seen` until it holds or the deadline passes. */
async function confirmed(deps: RenameDeps, seen: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + deps.verifyMs;
  do {
    if (await seen().catch(() => false)) return true;
    await deps.sleep(150);
  } while (Date.now() < deadline);
  return false;
}

/** The harness's own rename for the pane's session, never failing the request: a refusal is reported as `reason`. */
async function nativeRename(deps: RenameDeps, server: string, workspace: string, tab: string, pane: Json, label: string): Promise<NativeResult> {
  const harness = typeof pane.agent === "string" && pane.agent ? pane.agent : "none";
  const skip = (mechanism: NativeMechanism, reason: string): NativeResult => ({ harness, mechanism, applied: false, reason });
  if (!["claude", "codex", "opencode"].includes(harness)) return skip("none", "This harness has no remote rename.");
  const paneId = String(pane.pane_id), status = String(pane.agent_status);
  let session: string | undefined;
  try { session = await deps.identity(server, pane); } catch { session = undefined; }
  if (!session && harness !== "opencode") return skip("none", "The session is not identified yet.");
  const target: Target = { server, workspace, tab, pane: paneId, source: harness as Target["source"], session: session ?? "" };
  let mechanism: NativeMechanism = harness === "opencode" ? "opencode-api" : "slash-command";
  try {
    if (harness === "opencode") {
      const client = deps.opencodeClient(server, paneId);
      if (!client) return skip("none", "This OpenCode was not started by the Hook.");
      const chosen = session ?? (await client.currentSession())?.id;
      if (!chosen) return skip("opencode-api", "OpenCode has no session yet.");
      const title = await client.setTitle(chosen, label);
      return title === label ? { harness, mechanism: "opencode-api", applied: true } : skip("opencode-api", "OpenCode did not confirm the new name.");
    }
    if (harness === "codex") {
      mechanism = "app-server";
      const served = await deps.codexRename(target, label);
      if (served) return { harness, mechanism, applied: true };
      mechanism = "slash-command";
    }
    // A typed command runs only where the harness reads it as one: never over a dialog.
    if (["blocked", "waiting", "unknown"].includes(status)) return skip("slash-command", "The agent needs input in the terminal first.");
    if (harness === "codex" && status === "working") return skip("slash-command", "The agent is working.");
    const refused = await typeCommand(deps, server, pane, `/rename ${label}`);
    if (refused) return skip("slash-command", `Not typed: ${refused}.`);
    const applied = await confirmed(deps, harness === "claude" ? async () => (await deps.claudeTitle(target)) === label
      : async () => (await deps.codexIndexTitle(session!)) === label);
    return applied ? { harness, mechanism: "slash-command", applied: true } : skip("slash-command", "The harness did not confirm the new name.");
  } catch (error) {
    return skip(mechanism, error instanceof Error ? error.message.slice(0, 200) : "The rename failed.");
  }
}

/** `POST /v1/sessions/rename`: terminal labels first, then the harness's own name. */
export async function renameSession(server: string, data: Json, deps: RenameDeps = defaultRenameDeps): Promise<Json> {
  const { workspaceId, tabId, paneId, label } = renameRequest.parse(data);
  const s = await deps.snapshot(server);
  if (!objects(s.tabs).some(t => t.tab_id === tabId && t.workspace_id === workspaceId)) throw new BridgeError(409, "The tab changed.");
  const { pane, renameTab } = renamePane(objects(s.panes).filter(p => p.tab_id === tabId && p.workspace_id === workspaceId), paneId);
  const terminal = deps.terminal();
  await terminal.renamePane(server, String(pane.pane_id), label);
  if (renameTab) await terminal.groupAction(server, "rename", { workspace: workspaceId, tab: tabId }, label);
  const native = await nativeRename(deps, server, workspaceId, tabId, pane, label);
  return { ok: true, label, pane: pane.pane_id, native };
}

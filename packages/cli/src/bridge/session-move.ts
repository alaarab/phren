import { saveContinuationIntent } from "./continuation-launch.js";
import type { ConductorSuccessionService } from "./conductor-succession.js";
import { redactPeerHandoff } from "./peer-handoff.js";
// Moving a live session to another agent: the agent in the pane writes a
// hand-off, exits the way it normally does, and the target harness starts in
// the same pane by default, or a new chat that keeps the old agent running.
//
// The hand-off is asked for through the same durable prompt path `hand_off`
// uses, as a reply between two marker lines; the Hook reads it from the
// transcript and saves it. A reply never waits on a permission prompt, which
// a write outside the checkout would in a supervised session. When the agent
// does not answer in time, the hand-off is built from the transcript's tail,
// the git state and the original brief instead, as a worker continued on
// another account is (account-failover.ts).
//
// Nothing is committed, stashed or reset: the uncommitted changes stay in the
// checkout and the hand-off lists them. Each move is recorded in
// `<bridge>/moves/<id>.json`; a dispatching Hook asking about the old pane
// (dispatch-returns.ts `workerStates`) follows the record to the new agent,
// so the dispatch and its receipt carry on as one worker.
import { redactSecretsForLog } from "../content/secrets.js";
import { redactApproval } from "./approval-summary.js";
import { stableComputerName } from "./computer-names.js";
import type { DispatchHost } from "./dispatch-hosts.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { logger } from "../logger.js";
import { quoted, withOriginalBrief } from "./account-failover.js";
import { recordedConductor, runsAgent, transferConductor, type ConductorRecord } from "./conductor-role.js";
import { claudeHome, claudeHomes, DEFAULT_ACCOUNT, type ClaudeHome } from "./claude-accounts.js";
import { DISPATCH_HARNESSES, DispatchService, dispatchProjectDirectory, projectName, moveToSchema, repointDispatchOrigins } from "./dispatch.js";
import { hasUsable, type HarnessInventory } from "./harnesses.js";
import { findPane } from "./herdr.js";
import { briefArrival, briefId, briefRoot, assertUnusedLaunchId, writeLaunchBrief } from "./launch-brief.js";
import { atomic, BridgeError, bridgeRoot, object, startingTargetSchema, targetSchema, type Json, type Provider, type StartingTarget, type Target } from "./protocol.js";
import { finalTurnFromLines, isClaudeUsageLimit, publicAssistant } from "./schedule-watch.js";
import type { TerminalProvider } from "./terminal.js";
import type { HandOffQueue } from "./hand-off-queue.js";

const run = promisify(execFile);

export { moveToSchema };
export type MoveTo = z.infer<typeof moveToSchema>;

export const moveRequestSchema = z.object({
  target: targetSchema,
  to: moveToSchema,
  mode: z.enum(["replace", "new-chat"]).default("replace"),
  /** `resume` switches a Claude conversation to another account on this
   * computer without a hand-off: the transcript is copied into the target
   * account's home and the same conversation resumes there (`claude --resume`),
   * so an account at its usage limit can still switch. `summary-by-target` (a move to another computer):
   * the source is not asked for a hand-off; the new agent there builds one from the copied conversation.
   * A source whose last turn ended on its usage limit is moved this way without asking. */
  continuation: z.enum(["handoff", "resume", "summary-by-target"]).default("handoff"),
  /** Kept on a retry: the same id returns the move already under way. */
  id: z.string().uuid().optional(),
  /** How long the agent gets to write its hand-off before Phren builds one. */
  handoffTimeoutMs: z.number().int().min(5_000).max(900_000).optional(),
}).strict();

const MOVE_STATES = ["handing-off", "exiting", "launching", "linking", "uncertain", "moved", "failed"] as const;
const timestamp = z.string().datetime();
const moveRecordSchema = z.object({
  id: z.string().uuid(),
  state: z.enum(MOVE_STATES),
  createdAt: timestamp, updatedAt: timestamp,
  from: z.object({ target: targetSchema, account: z.string().max(64).optional(), label: z.string().max(200).optional() }).strict(),
  to: moveToSchema,
  computerFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  computerId: z.string().uuid().optional(),
  accountChoice: z.string().max(400).optional(),
  project: projectName.optional(),
  mode: z.enum(["replace", "new-chat"]).optional(),
  /** `resume`: the same conversation under another account here. `summary-by-target`: the source was out of
   * usage, so the agent on the other computer builds the hand-off from the copied conversation. */
  continuation: z.enum(["resume", "summary-by-target"]).optional(),
  modeForced: z.literal("conductor").optional(),
  handedOffTo: z.object({ computer: z.string().optional(), target: z.union([targetSchema, startingTargetSchema]) }).strict().optional(),
  handedOffFrom: z.object({ target: targetSchema, title: z.string().max(200) }).strict().optional(),
  cwd: z.string().max(4096),
  /** The dispatch the moved worker was launched for, as its turn record names it. */
  dispatch: briefId.optional(),
  workerDispatch: briefId.optional(),
  handoff: z.object({ path: z.string().max(4096), source: z.enum(["agent", "fallback"]), reason: z.string().max(300).optional(), chars: z.number().int().nonnegative() }).strict().optional(),
  /** How the old agent ended: its own exit command, an interrupt, or a kill after it hung. */
  exit: z.enum(["clean", "interrupted", "killed"]).optional(),
  placement: z.enum(["same-pane", "adjacent-pane", "peer"]).optional(),
  target: z.union([targetSchema, startingTargetSchema]).optional(),
  paneTarget: targetSchema.omit({ session: true }).optional(),
  linkPending: z.boolean().optional(),
  notice: z.string().max(500).optional(),
  movedAt: timestamp.optional(),
  error: z.string().max(500).optional(),
  recovery: z.object({ attempts: z.number().int().positive(), nextAt: timestamp }).strict().optional(),
}).strict();
export type MoveRecord = z.infer<typeof moveRecordSchema>;

/** What a dispatching Hook records on its receipt when its worker moved. */
export interface MovedWorker {
  id: string; at: string; handoff?: string; computerFingerprint?: string; computerId?: string;
  from: { harness: Provider; account?: string };
  to: MoveTo;
  target: Target | StartingTarget;
}

/** What "stop and hand off now" did: interrupted the step, or why not. `idle`: the agent is on no step,
 * so its request goes in without one; `typed`: the request is being or was typed; `writing`: the agent took
 * it and writes its hand-off; `finished`: the move is past its hand-off, or its request can no longer be
 * delivered (the move then builds a hand-off itself). */
export type MoveInterrupt = { interrupted: true } | { interrupted: false; state: "idle" | "typed" | "writing" | "finished" };

/** The slash command each harness ends its interactive session with. */
const EXIT_COMMANDS: Record<string, string> = { claude: "/exit", codex: "/quit", copilot: "/exit", opencode: "/exit", phren: "/exit" };
const HARNESS_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode", copilot: "Copilot", phren: "phren agent" };

const MOVE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MOVES = 256;
const MAX_RECORD_BYTES = 32_768;
/** The launch brief's limit; a longer hand-off is read from its file. */
const PROMPT_LIMIT = 32_768;

export function movesRoot(): string { return path.join(bridgeRoot(), "moves"); }
const recordFile = (id: string) => path.join(movesRoot(), `${z.string().uuid().parse(id)}.json`);
/** The hand-off sits beside the new agent's brief, in a folder Claude is given read access to. */
export const handoffPath = (id: string) => path.join(briefRoot(), id, "handoff.md");

// A committed hand-over remains observable even while its status file cannot
// be written. Key by full path because one process may access multiple stores.
const landedMoves = new Map<string, MoveRecord>();
let writes: Promise<unknown> = Promise.resolve();
async function saveMove(record: MoveRecord): Promise<void> {
  const run = writes.then(async () => {
    await mkdir(movesRoot(), { recursive: true, mode: 0o700 });
    await atomic(recordFile(record.id), moveRecordSchema.parse(record));
    landedMoves.delete(recordFile(record.id));
  });
  writes = run.catch(() => undefined);
  return run;
}

export async function readMove(id: string): Promise<MoveRecord | undefined> {
  const file = recordFile(id);
  if (landedMoves.has(file)) return structuredClone(landedMoves.get(file)!);
  const info = await lstat(file).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_RECORD_BYTES) return undefined;
  try { return moveRecordSchema.parse(JSON.parse(await readFile(file, "utf8"))); } catch { return undefined; }
}

/** Recent moves, newest first; old ones are removed on the way. */
export async function listMoves(now = Date.now()): Promise<MoveRecord[]> {
  const names = (await readdir(movesRoot()).catch(() => [] as string[])).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
  const records = (await Promise.all(names.map(name => readMove(name.slice(0, -5))))).filter((record): record is MoveRecord => !!record)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const settled = (record: MoveRecord) => record.state === "moved" || record.state === "failed";
  const stale = records.filter((record, index) => settled(record) && (index >= MAX_MOVES || now - Date.parse(record.updatedAt) > MOVE_KEEP_MS));
  await Promise.all(stale.map(record => rm(recordFile(record.id), { force: true }).catch(() => undefined)));
  return records.filter(record => !stale.includes(record));
}

/** The move that took the agent out of `target`'s pane: a target with a
 * conversation matches only that conversation; a starting one, the pane. */
export function moveFrom(records: readonly MoveRecord[], target: { server: string; pane: string; source: string; session?: string }): MoveRecord | undefined {
  return records.find(record => {
    const from = record.from.target;
    return from.server === target.server && from.pane === target.pane && from.source === target.source
      && (target.session === undefined || from.session === target.session);
  });
}

/** Conversation-bound annotations shared by tab and pane overview rows. */
export function moveSessionFields(records: readonly MoveRecord[], target: Target, title?: string): Json {
  const matches = (other: Target | StartingTarget) => other.server === target.server && other.workspace === target.workspace
    && other.tab === target.tab && other.pane === target.pane && other.source === target.source
    && "session" in other && other.session === target.session;
  const outgoing = records.find(record => record.state === "moved" && record.mode === "new-chat" && matches(record.from.target));
  const incoming = records.find(record => record.state === "moved" && record.mode === "new-chat" && !record.to.computer && record.target && matches(record.target));
  const suffix = outgoing ? ` (handed off to ${outgoing.to.harness})` : "";
  return { ...(outgoing?.handedOffTo ? { handedOffTo: outgoing.handedOffTo,
    title: `${(title ?? outgoing.from.label ?? outgoing.from.target.source).replace(/ \(handed off to [^)]+\)$/, "")}${suffix}` } : {}),
    ...(incoming?.handedOffFrom ? { handedOffFrom: incoming.handedOffFrom } : {}) };
}

/** The receipt fields for a finished move. */
export function movedWorker(record: MoveRecord): MovedWorker | undefined {
  if (record.state !== "moved" || !record.target) return undefined;
  return { id: record.id, at: record.movedAt ?? record.updatedAt, ...(record.handoff ? { handoff: record.handoff.path } : {}),
    ...(record.computerFingerprint ? { computerFingerprint: record.computerFingerprint } : {}),
    ...(record.computerId ? { computerId: record.computerId } : {}),
    from: { harness: record.from.target.source, ...(record.from.account ? { account: record.from.account } : {}) }, to: record.to, target: record.target };
}

/** A harness as people name it, with its account and model: "Claude (work, opus)". */
export function harnessName(to: { harness: string; account?: string; model?: string; effort?: string }): string {
  const details = [to.account && to.account !== DEFAULT_ACCOUNT ? `account ${to.account}` : undefined, to.model, to.effort ? `${to.effort} effort` : undefined].filter(Boolean);
  return `${HARNESS_NAMES[to.harness] ?? to.harness}${details.length ? ` (${details.join(", ")})` : ""}`;
}

const markers = (id: string) => {
  const short = id.replaceAll("-", "").slice(0, 8);
  return { begin: `=== PHREN HANDOFF ${short} BEGIN ===`, end: `=== PHREN HANDOFF ${short} END ===` };
};

/** What the moving agent is asked to write. */
export function handoffRequest(id: string, to: MoveTo, mode: "replace" | "new-chat" = "replace"): string {
  const { begin, end } = markers(id);
  return [
    `Phren is moving this session to ${harnessName(to)}, which continues the work in this same folder. Write a hand-off for it now.`,
    "",
    "Do not commit, stash, reset, clean or stop anything. Your uncommitted changes and anything you left running stay as they are; Phren records them.",
    "",
    "Reply with only the hand-off, in Markdown, between these two lines:",
    begin,
    end,
    "",
    "Use these headings:",
    "## Goal: what the owner asked for, in their terms",
    "## Done: what is finished, with commits, PRs and files",
    "## Current state: the branch, each uncommitted change and why it is there, processes or servers you started that are still running, anything half done",
    "## Decisions: what you chose and why, including approaches you ruled out",
    "## Next steps: in order",
    "## Open questions: for the owner, or still undecided",
    "## Key files: paths, a few words each, including files you had open or changed",
    ...(mode === "new-chat" ? ["The target starts in a new chat. Keep this agent running; do not exit after the hand-off."] : []),
    "",
    "Write it in full; do not shorten it. Use no tools once you start it. Phren saves it to a file and starts the next agent with it.",
  ].join("\n");
}

/** The hand-off between the markers in the agent's replies after the request,
 * or undefined while its end marker has not arrived. Code fences around the
 * block are dropped. */
export function extractHandoff(replies: readonly string[], id: string): string | undefined {
  const { begin, end } = markers(id);
  const text = replies.join("\n\n");
  const start = text.lastIndexOf(begin);
  if (start < 0) return undefined;
  const stop = text.indexOf(end, start + begin.length);
  if (stop < 0) return undefined;
  const body = text.slice(start + begin.length, stop).replace(/^\s*```[a-z]*\s*\n/i, "\n").replace(/\n\s*```\s*$/, "\n").trim();
  return body || undefined;
}

/** One message from a conversation's tail. */
export interface TailEntry { role: "owner" | "agent"; text: string }

/** The text an owner's (or another agent's) prompt row carries, without tool results or harness context. */
function userText(raw: Json, source: Provider): string | undefined {
  const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
  const blocks = (content: unknown, types: string[]) => typeof content === "string" ? content
    : Array.isArray(content) ? content.map(object).filter(block => types.includes(String(block.type))).map(block => String(block.text ?? "")).join("\n") : "";
  let text = "";
  if (source === "claude") {
    const message = object(raw.message);
    if (raw.type !== "user" || message.role !== "user" || raw.isMeta === true || raw.isSidechain === true) return undefined;
    text = blocks(message.content, ["text"]);
  } else if (source === "codex") {
    const payload = object(raw.payload);
    if (raw.type !== "response_item" || payload.type !== "message" || payload.role !== "user") return undefined;
    text = blocks(payload.content, ["input_text", "text"]);
  } else if (source === "copilot") {
    if (raw.type !== "user.message" || raw.agentId) return undefined;
    text = String(object(raw.data).content ?? "");
  } else if (source === "opencode") {
    const message = object(object(raw.data).message);
    if (raw.type !== "user/message" || message.role !== "user") return undefined;
    text = blocks(message.content, ["text"]);
  }
  text = text.trim();
  // Harness context and command echoes are not the owner's words.
  if (!text || /^<(environment_context|user_instructions|command-|local-command|task-notification|system-reminder)/.test(text) || text.startsWith("# AGENTS.md")) return undefined;
  return text;
}

/** The owner's prompts and the agent's replies in a transcript's lines, oldest first. */
export function conversationEntries(lines: readonly string[], source: Provider): TailEntry[] {
  const entries: TailEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let raw: Json;
    try { raw = JSON.parse(line) as Json; } catch { continue; }
    const owner = userText(raw, source);
    if (owner) { entries.push({ role: "owner", text: owner }); continue; }
    const agent = publicAssistant(raw, source);
    if (agent) entries.push({ role: "agent", text: agent });
  }
  return entries;
}

/** Where the move's request sits in the conversation, -1 before it arrived. */
function requestIndex(entries: readonly TailEntry[], id: string): number {
  const { begin } = markers(id);
  for (let index = entries.length - 1; index >= 0; index--) if (entries[index].role === "owner" && entries[index].text.includes(begin)) return index;
  return -1;
}

/** The agent's replies after the move's request: the request names the move, so an older hand-off never counts. */
export function repliesAfterRequest(entries: readonly TailEntry[], id: string): string[] {
  const asked = requestIndex(entries, id);
  return asked < 0 ? [] : entries.slice(asked + 1).filter(entry => entry.role === "agent").map(entry => entry.text);
}

/** What `git` shows in the checkout at the move. */
export interface GitState {
  root: string; branch?: string; head?: string; upstream?: string; ahead?: number; behind?: number;
  /** `git status --porcelain` lines: every change, tracked or not. */
  changes: string[];
}

export async function readGitState(directory: string): Promise<GitState | undefined> {
  const git = async (...args: string[]) => (await run("git", ["-C", directory, ...args], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  const root = (await git("rev-parse", "--show-toplevel").catch(() => "")).trim();
  if (!root) return undefined;
  const [branch, head, upstream, status] = await Promise.all([
    git("rev-parse", "--abbrev-ref", "HEAD").then(value => value.trim(), () => ""),
    git("log", "-1", "--format=%h %s").then(value => value.trim(), () => ""),
    git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}").then(value => value.trim(), () => ""),
    git("status", "--porcelain=v1", "--untracked-files=all").catch(() => ""),
  ]);
  const counts = upstream ? (await git("rev-list", "--left-right", "--count", `${upstream}...HEAD`).catch(() => "")).trim().split(/\s+/).map(Number) : [];
  return { root, ...(branch && branch !== "HEAD" ? { branch } : {}), ...(head ? { head } : {}), ...(upstream ? { upstream } : {}),
    ...(counts.length === 2 && counts.every(Number.isFinite) ? { behind: counts[0], ahead: counts[1] } : {}),
    changes: status.split("\n").filter(line => line.trim()) };
}

/** The commands of every process below `pids` (the agent's own children), not the agent itself. */
export async function processesBelow(pids: readonly number[]): Promise<string[]> {
  if (!pids.length || process.platform === "win32") return [];
  const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,args="], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 });
  const rows = stdout.split("\n").map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter((match): match is RegExpExecArray => !!match)
    .map(match => ({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3].trim() }));
  const below = new Set<number>(pids);
  const found: string[] = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (below.has(row.ppid) && !below.has(row.pid)) { below.add(row.pid); found.push(`${row.pid} ${row.args}`); grew = true; }
  }
  return found;
}

/** What Phren itself saw at the move, appended to every hand-off. */
export function observedState(git: GitState | undefined, processes: readonly string[], processCommands = true): string {
  const lines = ["## Checked by Phren at the move", ""];
  if (!git) lines.push("- Not a git checkout, or git could not be read.");
  else {
    const tracking = git.upstream ? ` tracking ${git.upstream}${git.ahead !== undefined ? ` (ahead ${git.ahead}, behind ${git.behind})` : ""}` : ", with no upstream";
    lines.push(`- Branch: ${git.branch ?? "detached HEAD"}${tracking}. HEAD: ${git.head ?? "unknown"}.`);
    if (!git.changes.length) lines.push("- No uncommitted changes.");
    else lines.push(`- Uncommitted changes (${git.changes.length}). The move committed, stashed and reset nothing: they are the previous agent's work in progress, so keep them.`, "", "```", ...git.changes, "```");
  }
  lines.push("");
  if (!processCommands) lines.push(`- The previous agent had ${processes.length} child processes running; process command lines are withheld on cross-computer moves.`);
  else if (processes.length) lines.push(`- Processes the previous agent had running (${processes.length}):`, "", "```", ...processes, "```");
  else lines.push("- The previous agent had no child processes running.");
  return lines.join("\n");
}

/** A hand-off built without the agent: the conversation's tail, the original brief and the git state. */
export function fallbackHandoff(input: { reason: string; from: string; entries: readonly TailEntry[]; original?: string; dispatch?: string; label?: string }): string {
  const lines = [
    `The previous agent (${input.from}) did not write a hand-off: ${input.reason} Phren built this one from the end of its conversation instead.`,
    "Check the checkout and what it already did before doing anything; do not start over.",
    "",
  ];
  if (input.dispatch) lines.push(`It was working on dispatch ${input.dispatch}${input.label ? ` ("${input.label}")` : ""}.`, "");
  const tail = input.entries.slice(-12);
  if (!tail.length) lines.push("Its conversation could not be read.", "");
  else {
    lines.push(`The last ${tail.length} messages of its conversation, oldest first:`, "");
    for (const entry of tail) lines.push(...quoted(entry.role === "owner" ? "Prompt to it" : "Its reply", entry.text));
  }
  const head = lines.join("\n");
  // Written to a file, so the brief is never cut here.
  return input.original ? withOriginalBrief(head, input.original, Number.MAX_SAFE_INTEGER, "the original brief file") : head;
}

/** Whether a Claude conversation's last turn ended on its subscription's usage limit (Claude's own
 * rate-limit row): its agent cannot answer a hand-off request. */
export function sourceOutOfUsage(lines: readonly string[], source: Provider): boolean {
  return source === "claude" && isClaudeUsageLimit(finalTurnFromLines(lines, "claude").error);
}

/** Room left in a cross-computer brief for the copied conversation, once the rest of the hand-off is in. */
const TRANSCRIPT_MARGIN = 2_000;
/** What of the original dispatch brief is kept ahead of the conversation: the oldest turns, which state the task, go first. */
const ORIGINAL_RESERVE = 8_000;

/**
 * The hand-off for a source that does not write one (its account is out of usage, or the owner asked), for a
 * fresh agent on the target computer to build itself: what happened, then as much of the conversation as fits
 * in `room` characters, newest messages kept, oldest first. The target agent writes its own summary from it first.
 */
export function targetSummaryBody(input: { from: string; exhausted: boolean; entries: readonly TailEntry[]; room: number; original?: string; dispatch?: string; label?: string;
  /** Each message as it will be sent (paths replaced, credentials redacted), so it is measured at its sent size. */
  prepare?: (text: string) => string }): string {
  const head = [
    input.exhausted
      ? `The previous agent (${input.from}) is out of usage on its account, so it could not write a hand-off. Phren copied its conversation instead, below, for you to build one from.`
      : `The owner moved the previous agent (${input.from}) here without asking it for a hand-off. Phren copied its conversation instead, below, for you to build one from.`,
    "",
    "First, from this conversation, write yourself a short hand-off: the owner's goal, what is done, what is half done, and the next steps. Then check this checkout against it and continue from there; do not start over.",
    "",
    ...(input.dispatch ? [`It was working on dispatch ${input.dispatch}${input.label ? ` ("${input.label}")` : ""}.`, ""] : []),
  ];
  const summary = (kept: number) => `The last ${kept} of its ${input.entries.length} messages, oldest first:`;
  const kept: string[][] = [];
  // The list's own heading, and room for the original brief and its cut note, are counted up front.
  const reserve = input.original ? Math.min(input.original.length, ORIGINAL_RESERVE) + 200 : 0;
  let used = head.join("\n").length + summary(input.entries.length).length + 2 + reserve;
  for (const entry of [...input.entries].reverse()) {
    // One long message never takes the whole room: its end is what was said last.
    const sent = input.prepare ? input.prepare(entry.text) : entry.text;
    const text = sent.length > 6_000 ? `…${sent.slice(-6_000)}` : sent;
    const block = quoted(entry.role === "owner" ? "Prompt to it" : "Its reply", text);
    const size = block.join("\n").length + 1;
    if (used + size > input.room) break;
    kept.unshift(block); used += size;
  }
  const lines = [...head];
  if (!kept.length) lines.push(input.entries.length ? "Its conversation did not fit beside the rest of this hand-off; ask the owner where it stood." : "Its conversation could not be read; ask the owner where it stood.", "");
  else lines.push(summary(kept.length), "", ...kept.flat());
  const body = lines.join("\n");
  // The original brief takes what room is left, cut with a note when it doesn't fit.
  return input.original ? withOriginalBrief(body, input.original, input.room, "the dispatching computer's brief") : body;
}

/**
 * The prompt another computer gets: full inline text only, since the peer cannot read this Hook's brief path.
 * Commit ids and the complete hand-off are kept, credentials redacted in place rather than through the lossy
 * approval/log summarizer.
 */
function peerPrompt(record: MoveRecord, document: string): string {
  const safeDocument = document.replaceAll(record.cwd, "<source checkout>");
  return redactPeerHandoff(briefText(`Continue the owner's work from this hand-off. This is a different checkout: local uncommitted files and running processes were not copied. Check its branch and files before proceeding.\n\n${safeDocument}`));
}

/** The hand-off file: who moved where and when, the body, then what Phren saw. */
export function handoffDocument(record: MoveRecord, body: string, observed: string, at: string, conductor = false): string {
  return [
    `# Hand-off from ${harnessName({ harness: record.from.target.source, account: record.from.account })} to ${harnessName(record.to)}`,
    "",
    `Moved by Phren at ${at} (move ${record.id}) in ${record.cwd}.${record.dispatch ? ` Dispatch ${record.dispatch}.` : ""}`,
    "",
    ...(record.mode === "new-chat" ? ["## Previous chat", "",
      `Title: ${record.from.label ?? record.from.target.source}`,
      "Target (JSON, for opening the old chat):", "```json", JSON.stringify(record.from.target), "```", ""] : []),
    ...(conductor ? ["## Conductor role", "", "You will become the conductor when the Hook confirms the hand-over; until then don't dispatch or answer workers.", ""] : []),
    body.trim(),
    "",
    observed,
    "",
  ].join("\n");
}

/** The new agent's first prompt: the whole hand-off when it fits the brief, else where to read it. */
export function continuePrompt(document: string, file: string): string {
  const lead = "Phren moved this session to you. The hand-off from the previous agent follows. Continue from here: check the current state first, keep its uncommitted changes, and do not start over.";
  const whole = `${lead}\n\n${document}`;
  if (whole.length <= PROMPT_LIMIT) return whole;
  return `Phren moved this session to you. The previous agent's hand-off is ${document.length} characters, too long for this prompt: read all of ${file} before anything else. Then continue from here: check the current state first, keep its uncommitted changes, and do not start over.`;
}

/** A pane's place without its agent: `findPane` with a source finds it only while that agent runs. */
const placeOf = (target: Target) => ({ workspace: target.workspace, tab: target.tab, pane: target.pane });

/** Control characters other than tab and newline cannot ride in a brief. */
const briefText = (value: string) => value.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

export interface MoverDeps {
  succession?: ConductorSuccessionService;
  snapshot: (server: string) => Promise<Json>;
  /** The conversation the pane runs now. */
  identity: (server: string, pane: Json) => Promise<string | undefined>;
  terminal: Pick<TerminalProvider, "prompt" | "sendKeys" | "processes" | "closePane">;
  /** The `hand_off` delivery path: queued while the agent is busy. */
  deliver: (target: Target, text: string, deliveryId: string) => Promise<Json>;
  /** Starts the new agent (`startSession`), in `into` when given. */
  launch: (server: string, data: Json, options: { into?: { workspaceId: string; tabId: string; paneId: string }; dispatchId?: string; resumeClaude?: string }) => Promise<Json>;
  inventory: () => Promise<HarnessInventory | undefined>;
  /** The conversation's transcript lines, its tail is enough. */
  transcript: (target: Target) => Promise<string[]>;
  /** Copies a Claude conversation into another account's home (`copyClaudeConversation` over its transcript).
   * With `check`, only resolves and validates both ends, so a move is refused before the old agent exits. */
  copyConversation?: (target: Target, to: ClaudeHome, check?: boolean) => Promise<string>;
  git?: (directory: string) => Promise<GitState | undefined>;
  processesBelow?: (pids: readonly number[]) => Promise<string[]>;
  /** The Claude account the pane runs under, when known. */
  paneAccount?: (server: string, pane: Json) => string | undefined;
  /** The dispatch the pane's agent was launched for. */
  paneDispatch?: (server: string, pane: Json) => Promise<string | undefined>;
  /** The text of a brief this computer wrote. */
  brief?: (id: string) => Promise<string | undefined>;
  /** Whether the pane holds this computer's conductor. */
  isConductor?: (server: string, pane: Json) => Promise<boolean>;
  /** Herdr gives a pane its variables only when it is created; tmux sets them on every start. */
  envAtStart?: (server: string) => boolean;
  /** Cleanup after the old agent exited (a Codex pane's app-server). */
  afterExit?: (server: string, pane: string) => Promise<void>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** How long a clean exit, then an interrupt, may take before the agent counts as hung. */
  exitMs?: number;
}

const DEFAULT_HANDOFF_MS = 240_000;

/** Runs moves on the computer that runs the session. A move outlives the
 * request that started it (the Hook answers in seconds); its record says where it is. */
export class SessionMover {
  private readonly cancelled = new Set<string>();
  /** Moves whose held hand-off request was interrupted (one Escape per move). */
  private readonly interrupted = new Set<string>();
  private readonly admissions = new Set<string>();
  private readonly running = new Map<string, Promise<void>>();
  constructor(private readonly deps: MoverDeps) {}

  private get now(): number { return (this.deps.now ?? Date.now)(); }
  private sleep(ms: number): Promise<void> { return (this.deps.sleep ?? (value => new Promise(resolve => setTimeout(resolve, value))))(ms); }
  private get poll(): number { return this.deps.pollMs ?? 2_000; }

  /** Checks the move can happen, records it and starts it. Refuses before anything is typed. */
  async start(input: unknown, caller: { owner?: boolean } = {}): Promise<MoveRecord> {
    const data = moveRequestSchema.parse(input);
    if (data.to.computer && !caller.owner) throw new BridgeError(403, "Only the owner can continue a chat on another computer.");
    const key = `${data.target.server}\0${data.target.pane}`;
    if (this.admissions.has(key)) throw new BridgeError(409, "This session is already being moved.");
    this.admissions.add(key);
    let release: (() => void) | undefined;
    try {
      return await this.admit(data, caller, () => { release = this.deps.succession?.reserveCaller(data.target); });
    } finally { release?.(); this.admissions.delete(key); }
  }

  private async admit(input: unknown, caller: { owner?: boolean }, reserve: () => void): Promise<MoveRecord> {
    const data = moveRequestSchema.parse(input);
    if (data.to.computer && !caller.owner) throw new BridgeError(403, "Only the owner can continue a chat on another computer.");
    if (data.id) {
      const earlier = await readMove(data.id);
      if (earlier) {
        if ((earlier.modeForced === "conductor" || earlier.to.computer) && !caller.owner) throw new BridgeError(403, "Only the owner can move the conductor.");
        const from = earlier.from.target;
        if (from.server !== data.target.server || from.pane !== data.target.pane || from.session !== data.target.session) throw new BridgeError(409, "This move id was already used for another session.");
        return earlier;
      }
    }
    const { target } = data;
    const peer = data.to.computer ? await (await import("./move-computers.js")).movePeer(data.to.computer, stableComputerName()) : undefined;
    const to = { ...data.to };
    if (!peer) delete to.computer;
    // Another computer's agent builds the hand-off; on this one, an exhausted account switches with `resume`.
    if (data.continuation === "summary-by-target" && !peer) throw new BridgeError(409, "summary-by-target continues on another computer; on this one, switch accounts with continuation resume.");
    const active = (await listMoves(this.now)).find(record => record.from.target.server === target.server && record.from.target.pane === target.pane
      && record.state !== "moved" && record.state !== "failed");
    if (active || [...this.running.keys()].some(key => key === `${target.server}\0${target.pane}`)) throw new BridgeError(409, "This session is already being moved.", { code: "move_in_progress" });
    const s = await this.deps.snapshot(target.server);
    const pane = findPane(s, placeOf(target));
    if (!pane) throw new BridgeError(404, "That pane is no longer open.");
    if (pane.agent !== target.source) throw new BridgeError(409, `That pane no longer runs ${HARNESS_NAMES[target.source] ?? target.source}.`);
    const session = await this.deps.identity(target.server, pane).catch(() => undefined);
    if (session && session !== target.session) throw new BridgeError(409, "That pane runs another conversation now.");
    const holdsRole = await this.deps.isConductor?.(target.server, pane) ?? false;
    if (holdsRole && !caller.owner) throw new BridgeError(403, "Only the owner can move the conductor.");
    reserve();
    const conductor = holdsRole ? await recordedConductor() : undefined;
    if (holdsRole && (!conductor || conductor.server !== target.server || conductor.pane !== target.pane)) {
      throw new BridgeError(409, "The conductor changed during the move; nothing was transferred.");
    }
    if (conductor && peer && !this.deps.succession) throw new BridgeError(409, "Update this Hook to move the conductor to another computer.");
    if (conductor && to.harness === "copilot") throw new BridgeError(400, "Copilot cannot run as a conductor.");
    const account = target.source === "claude" ? this.deps.paneAccount?.(target.server, pane) ?? DEFAULT_ACCOUNT : undefined;
    const sameHarness = to.harness === target.source && (to.harness !== "claude" || (to.account ?? account) === account);
    if (!peer && sameHarness && !to.model && !to.effort) throw new BridgeError(400, "The session already runs there. Choose another harness, account, model or effort.");
    if (data.continuation === "resume") {
      if (peer) throw new BridgeError(400, "Switching account keeps the conversation on this computer; continue on another computer with a hand-off.");
      if (target.source !== "claude" || to.harness !== "claude") throw new BridgeError(400, "Only a Claude conversation can switch account.");
      if (!target.session) throw new BridgeError(409, "The conversation has no session id yet, so it cannot resume under another account.");
      if (data.mode === "new-chat") throw new BridgeError(400, "Switching account continues the same conversation; it cannot keep the old chat running.");
      if (conductor) throw new BridgeError(409, "Switching the conductor's account is not supported yet; use Continue in… for the conductor.");
      if (!to.account || to.account === account) throw new BridgeError(400, "Choose another Claude account to switch to.");
      if (!claudeHome(to.account)) throw new BridgeError(409, `No Claude account "${to.account}" on this computer.`, { code: "account_unavailable" });
      if (!this.deps.copyConversation) throw new BridgeError(503, "This Hook cannot switch accounts.");
      await this.deps.copyConversation(target, claudeHome(to.account)!, true);
    }
    // Only harnesses signed in and usable here; an inventory that cannot be read lets the move go on, as a launch does.
    const inventory = peer ? undefined : await this.deps.inventory().catch(() => undefined);
    if (inventory) {
      const availability = hasUsable(inventory, to.harness, to.harness === "claude" ? to.account : undefined);
      if (!availability.ok) {
        const usable = inventory.harnesses.filter(entry => entry.usable && (DISPATCH_HARNESSES as readonly string[]).includes(entry.source)).map(entry => entry.source);
        throw new BridgeError(409, `${HARNESS_NAMES[to.harness]} can't take this session here: ${availability.reason}.${usable.length ? ` Usable here: ${usable.join(", ")}.` : ""}`,
          { code: availability.code });
      }
    }
    const cwd = String(pane.foreground_cwd || pane.cwd || "");
    if (!path.isAbsolute(cwd)) throw new BridgeError(409, "The pane's folder is unknown, so the new agent could not start there.");
    let project: string | undefined;
    let accountChoice: string | undefined;
    let computerId: string | undefined;
    if (peer) {
      const { getProjectDirs } = await import("../phren-paths.js");
      const { phrenStoreRoot } = await import("./transcripts.js");
      const { checkMovePeer } = await import("./move-computers.js");
      // Match the registered checkout, including sessions in its subfolders.
      const sourceDirectory = await realpath(cwd).catch(() => cwd);
      let longest = 0;
      for (const directoryName of getProjectDirs(phrenStoreRoot())) {
        const name = path.basename(directoryName);
        const directory = await dispatchProjectDirectory(name).catch(() => undefined);
        if (directory && directory.length > longest && (sourceDirectory === directory || sourceDirectory.startsWith(directory + path.sep))) { project = name; longest = directory.length; }
      }
      if (!project && conductor) project = "phren-conductor";
      if (!project) throw new BridgeError(409, "The source folder is not a registered project checkout.");
      projectName.parse(project);
      const selected = await checkMovePeer(peer, project, to, !!conductor);
      computerId = selected.computerId;
      if (selected.account) { to.account = selected.account; accountChoice = selected.accountChoice; }
    }
    const dispatch = await this.deps.paneDispatch?.(target.server, pane).catch(() => undefined);
    const workerDispatch = peer && dispatch ? await (await import("./worker-relocation.js")).preflightWorkerRelocation(dispatch, target) : undefined;
    const label = [pane.label, pane.title, pane.terminal_title_stripped, pane.agent_name].find(value => typeof value === "string" && value.trim() && !/^\d+$/.test(value)) as string | undefined;
    const at = new Date(this.now).toISOString();
    const resume = data.continuation === "resume";
    const record: MoveRecord = { id: data.id ?? randomUUID(), state: resume ? "exiting" : "handing-off", createdAt: at, updatedAt: at,
      ...(project ? { project } : {}), mode: conductor || peer ? "new-chat" : data.mode, ...(resume ? { continuation: "resume" as const } : data.continuation === "summary-by-target" ? { continuation: "summary-by-target" as const } : {}), ...(conductor ? { modeForced: "conductor" as const } : {}), from: { target, ...(account ? { account } : {}), ...(label ? { label: label.slice(0, 200) } : {}) }, to, cwd, ...(computerId ? { computerId } : {}), ...(peer?.fingerprint ? { computerFingerprint: peer.fingerprint } : {}), ...(accountChoice ? { accountChoice } : {}),
      ...(dispatch && briefId.safeParse(dispatch).success ? { dispatch } : {}), ...(workerDispatch ? { workerDispatch } : {}) };
    await assertUnusedLaunchId(record.id);
    if (conductor && peer) {
      if (!computerId) throw new BridgeError(409, "The destination did not report its verified Hook identity.");
      await this.deps.succession!.begin(record.id, conductor, target, peer, computerId, record);
    }
    await saveMove(record);
    const key = `${target.server}\0${target.pane}`;
    const work = (resume ? this.switchAccount(record) : this.run(record, data.handoffTimeoutMs ?? DEFAULT_HANDOFF_MS, conductor, peer, project)).finally(() => this.running.delete(key));
    this.running.set(key, work);
    return record;
  }

  /** For tests: the move under way in a pane, until it settles. */
  settled(server: string, pane: string): Promise<void> | undefined { return this.running.get(`${server}\0${pane}`); }

  private async update(record: MoveRecord, change: Partial<MoveRecord>): Promise<void> {
    Object.assign(record, change, { updatedAt: new Date(this.now).toISOString() });
    await saveMove(record);
  }

  private async run(record: MoveRecord, handoffMs: number, conductor: ConductorRecord | undefined, peer?: DispatchHost, project?: string): Promise<void> {
    const from = record.from.target;
    let roleTransferred = false;
    try {
      // What the checkout and the agent's processes look like before it stops.
      const pane = findPane(await this.deps.snapshot(from.server), placeOf(from));
      const pids = pane ? (await this.deps.terminal.processes(from.server, from.pane).catch(() => undefined))?.foregroundPids ?? [] : [];
      const [git, processes] = await Promise.all([(this.deps.git ?? readGitState)(record.cwd).catch(() => undefined),
        (this.deps.processesBelow ?? processesBelow)(pids).catch(() => [] as string[])]);
      // A source out of usage cannot answer a hand-off request: on another computer, the new agent builds it.
      const requested = record.continuation === "summary-by-target";
      const lines = peer ? await this.deps.transcript(from).catch(() => undefined) : [];
      // Asked for by name, the move never launches an agent with no conversation to build from.
      if (requested && !lines?.length) throw new BridgeError(409, "The conversation could not be read, so the agent on the other computer would have nothing to build a hand-off from; the old chat remains open.");
      const exhausted = !!peer && sourceOutOfUsage(lines ?? [], from.source);
      const byTarget = !!peer && (requested || exhausted);
      if (byTarget && !requested) await this.update(record, { continuation: "summary-by-target" });
      const written = byTarget ? { reason: `${exhausted ? "its account is out of usage" : "the owner asked"}, so the agent on ${peer!.name} builds the hand-off from the copied conversation.` }
        : await this.askForHandoff(record, handoffMs);
      const observed = observedState(git, processes, !peer), at = new Date(this.now).toISOString();
      let body: string;
      if (byTarget) {
        const original = record.dispatch ? await this.deps.brief?.(record.dispatch).catch(() => undefined) : undefined;
        const entries = conversationEntries(lines ?? [], from.source);
        const fit = (room: number) => targetSummaryBody({ from: harnessName({ harness: from.source, account: record.from.account }), exhausted,
          entries, room, prepare: text => redactPeerHandoff(text.replaceAll(record.cwd, "<source checkout>")), ...(original ? { original } : {}),
          ...(record.dispatch ? { dispatch: record.dispatch } : {}), ...(record.from.label ? { label: record.from.label } : {}) });
        // What fits beside the rest of the hand-off in the one brief the other computer gets, measured as sent:
        // the checkout path replaced and credentials redacted, either of which can lengthen the text. Messages
        // are prepared that way before they are counted; the refit only catches what the rest of the brief adds.
        let room = PROMPT_LIMIT - peerPrompt(record, handoffDocument(record, "", observed, at, !!conductor)).length - TRANSCRIPT_MARGIN;
        body = fit(room);
        for (let tries = 0; tries < 4; tries++) {
          const over = peerPrompt(record, handoffDocument(record, body, observed, at, !!conductor)).length - PROMPT_LIMIT;
          if (over <= 0) break;
          room -= over + 500; body = fit(room);
        }
      } else {
        const fallback = "text" in written ? undefined : await this.fallback(record, written.reason);
        body = "text" in written ? written.text : record.mode === "new-chat"
          ? `## Goal and current state\n\n${fallback}\n\n## Next steps\n\nContinue the owner's goal above after checking the checkout and the latest agent reply.\n\n## Key files\n\nOpen or changed files are named in the conversation above and the checked Git state below; open editor tabs are not available to the Hook.`
          : fallback!;
      }
      const document = handoffDocument(record, body, observed, at, !!conductor);
      await this.assertNotAborted(record);
      const file = handoffPath(record.id);
      const prompt = briefText(continuePrompt(document, file));
      // The folder is the new agent's brief folder; the hand-off is written into it, whole.
      await writeLaunchBrief({ id: record.id, text: prompt }, this.now, record.from.label);
      await atomic(file, document);
      await this.update(record, { state: record.mode === "new-chat" ? "launching" : "exiting", handoff: { path: file, source: "text" in written ? "agent" : "fallback",
        ...("reason" in written ? { reason: written.reason.slice(0, 300) } : {}), chars: document.length } });
      await this.checkPromotion(record);
      if (record.mode !== "new-chat") {
        const exit = await this.exit(record);
        await this.update(record, { state: "launching", exit });
        await this.deps.afterExit?.(from.server, from.pane).catch(() => undefined);
      }
      let launched: Pick<MoveRecord, "placement" | "target" | "to" | "linkPending" | "notice">;
      if (peer) {
        peer = await (await import("./move-computers.js")).currentMovePeer(peer);
        const target = await this.continueOnPeer(record, peer, project!, document);
        launched = { target, to: record.to, placement: "peer" };
      } else launched = await this.relaunch(record, prompt);
      await this.checkPromotion(record);
      if (conductor && peer) {
        if (!launched.target || !("session" in launched.target)) throw new BridgeError(409, "The prepared successor conversation was not confirmed.");
        await this.deps.succession!.prepared(record.id, launched.target);
        await this.deps.succession!.commit(record.id);
        roleTransferred = true;
        await this.deps.succession!.finish(record.id);
      } else if (conductor) {
        try {
          if (launched.linkPending || !launched.target || !("session" in launched.target)) throw new Error("The new conductor conversation is not linked; the hand-over was not confirmed.");
          const confirmedTarget = launched.target;
          let accepted = false;
          for (const until = this.now + 30_000; this.now < until; await this.sleep(this.poll)) {
            const arrival = (await briefArrival(record.id))?.accepted?.target;
            if (arrival && Object.keys(confirmedTarget).every(key => arrival[key as keyof Target] === confirmedTarget[key as keyof Target])) { accepted = true; break; }
          }
          if (!accepted) throw new Error("The new conductor's hand-off brief was not confirmed within 30 seconds.");
          const place = record.paneTarget;
          const next = place && findPane(await this.deps.snapshot(place.server), place);
          if (!place || !runsAgent(next) || next.agent !== record.to.harness) throw new Error("The new agent is no longer running in its launched pane.");
          if (!["idle", "working"].includes(String(next.agent_status))) throw new Error(`The new conductor is not ready (${String(next.agent_status)}); answer its startup dialog before retrying.`);
          if (typeof next.terminal_id !== "string" || !next.terminal_id) throw new Error("The new pane has no terminal identity for worker returns.");
          const origin = { server: place.server, workspace: place.workspace, tab: place.tab, pane: place.pane,
            agent: record.to.harness, terminal: next.terminal_id };
          await transferConductor(conductor, place.server, next,
            launched.target && "session" in launched.target ? launched.target.session : undefined,
            commit => repointDispatchOrigins(conductor, origin, commit));
          roleTransferred = true;
          const notice = await this.conductorNotice(record, "The Hook confirmed the hand-over; you are now the conductor. Continue coordinating the owner's work and existing workers.", "confirmed");
          if (notice) record.notice = notice;
        } catch (error) {
          if (error instanceof BridgeError) throw error;
          throw new Error(`Conductor role transfer failed. The old chat was left running. ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await this.update(record, { state: "moved", movedAt: new Date(this.now).toISOString(), ...launched,
        ...(record.mode === "new-chat" ? {
          ...(launched.target ? { handedOffTo: { ...(peer ? { computer: peer.name } : {}), target: launched.target } } : {}),
          handedOffFrom: { target: from, title: record.from.label ?? from.source },
        } : {}) });
      logger.info("move", `Moved ${from.source} in pane ${from.pane} to ${harnessName(record.to)} (${launched.placement}); hand-off ${record.handoff?.source}.`);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f]+/g, " ");
      if (roleTransferred) {
        // update() has already populated the complete moved record. The role
        // and worker routes committed; a later status save cannot undo them.
        record.state = peer ? "uncertain" : "moved";
        record.notice = `Conductor moved with worker routing, but saving move status failed: ${message}`.slice(0, 500);
        delete record.error;
        landedMoves.set(recordFile(record.id), record);
        while (landedMoves.size > MAX_MOVES) landedMoves.delete(landedMoves.keys().next().value!);
        await saveMove(record).catch(() => undefined);
        logger.warn("move", record.notice);
        return;
      }
      if (conductor && peer) {
        await this.deps.succession!.abort(record.id).catch(() => undefined);
        const status = await this.deps.succession!.status(record.id).catch(() => undefined);
        if (status?.phase === "committed") {
          await this.update(record, { state: "uncertain", error: "The ownership commit is being reconciled; the previous generation remains fenced." }).catch(() => undefined);
          return;
        }
      }
      if (conductor && record.paneTarget && !peer) {
        record.notice = await this.conductorNotice(record,
          "The conductor hand-over failed; you are not the conductor. The previous conductor keeps coordinating.", "failed")
          ?? "The new chat was told the conductor hand-over failed; it is not the conductor.";
      }
      const stopped = record.exit !== undefined;
      const hint = stopped && record.handoff ? ` The old agent has exited; start ${HARNESS_NAMES[record.to.harness]} in the pane with the hand-off at ${record.handoff.path}.` : "";
      await this.update(record, { state: record.state === "uncertain" ? "uncertain" : "failed", error: `${message}${hint}`.slice(0, 500) }).catch(() => undefined);
      logger.warn("move", `Moving pane ${from.pane} to ${record.to.harness} failed: ${message}`);
    }
  }

  /**
   * "Stop <agent> and hand off now": Escape to the old agent only while the move's hand-off request is
   * still held for it (queued behind the step it is on, not yet typed), so the step stops and the request
   * goes in, and never into the hand-off the agent is writing. Checked and sent under the hand-off queue's
   * lock (`whileQueued`), which is what types the request. `state` says why it did not: the request is
   * being or was typed (`typed`), the agent is writing its hand-off (`writing`), or the move is past it.
   */
  async interrupt(id: string, queue?: Pick<HandOffQueue, "whileQueued">, escape?: (target: Target) => Promise<void>): Promise<MoveInterrupt> {
    const record = await readMove(id);
    if (!record) throw new BridgeError(404, "No move with that id is recorded.");
    if (record.state !== "handing-off") { this.interrupted.delete(id); return { interrupted: false, state: "finished" }; }
    // Without the queue the request was typed the moment it was sent: it is never held.
    if (!queue) return { interrupted: false, state: "typed" };
    const from = record.from.target;
    let answer: MoveInterrupt = { interrupted: true };
    const result = await queue.whileQueued(`move-${id}`, from, async () => {
      // A move that left the hand-off (it timed out and is exiting) needs no Escape from here.
      if ((await readMove(id))?.state !== "handing-off") { answer = { interrupted: false, state: "finished" }; return; }
      // One Escape per move: a second (a double tap, a retry) would land on the stopped agent's empty
      // input, where Claude and Codex take Esc Esc as "go back to an earlier message".
      if (this.interrupted.has(id)) return;
      // An agent not on a step has nothing to stop: its request goes in at the queue's next look.
      const pane = findPane(await this.deps.snapshot(from.server), placeOf(from));
      if (!pane || !["working", "blocked", "waiting", "unknown"].includes(String(pane.agent_status))) { answer = { interrupted: false, state: "idle" }; return; }
      // Marked once it went: an Escape that failed leaves the next tap free to try again.
      await (escape ?? (target => this.deps.terminal.sendKeys(target.server, target.pane, ["esc"])))(from);
      this.interrupted.add(id);
    });
    if (!result.ran) return { interrupted: false, state: result.state === "delivered" ? "writing" : result.state === "failed" ? "finished" : "typed" };
    return answer;
  }

  async abort(id: string): Promise<MoveRecord> {
    const record = await readMove(id);
    if (!record) throw new BridgeError(404, "No move with that id is recorded.");
    if (record.state === "moved") throw new BridgeError(409, "This move is already committed; it cannot be aborted.");
    if (record.modeForced === "conductor" && record.to.computer) {
      await this.deps.succession!.abort(id);
      if ((await this.deps.succession!.status(id)).phase === "committed") throw new BridgeError(409, "This ownership generation is committed; reconcile it instead of rolling back.");
    } else if (record.state !== "handing-off" && record.state !== "failed") throw new BridgeError(409, "This launch may already exist; reconcile it before aborting.");
    this.cancelled.add(id);
    await this.update(record, { state: "failed", error: "The owner aborted this uncommitted move; the original chat keeps its role." });
    return record;
  }
  private async assertNotAborted(record: MoveRecord): Promise<void> {
    if (this.cancelled.has(record.id) || (await readMove(record.id))?.state === "failed" || record.modeForced === "conductor" && record.to.computer && (await this.deps.succession!.status(record.id)).phase === "aborted") throw new BridgeError(409, "This uncommitted move was aborted; no conductor role was transferred.");
  }
  private async continueOnPeer(record: MoveRecord, peer: DispatchHost, project: string, document: string): Promise<Target> {
    const remotePrompt = peerPrompt(record, document);
    if (remotePrompt.length > PROMPT_LIMIT) throw new BridgeError(409, "The hand-off is too long to send in full to another computer; the old chat remains open.");
    const checked = await (await import("./move-computers.js")).checkMovePeer(peer, project, record.to, record.modeForced === "conductor");
    if (record.computerId && checked.computerId !== record.computerId) throw new BridgeError(409, "The destination Hook identity changed during the move; nothing was launched.");
    await this.checkPromotion(record);
    await this.assertNotAborted(record);
    await this.update(record, { state: "uncertain", placement: "peer" });
    const label = redactSecretsForLog(redactPeerHandoff(redactApproval(briefText(record.from.label ?? "Continued chat"))));
    const { computer: _destination, ...destination } = record.to;
    await saveContinuationIntent({ computerId: record.computerId, project, to: destination, label, brief: { id: record.id, text: remotePrompt }, worker: !!record.dispatch, ...(record.workerDispatch ? { workerDispatch: record.workerDispatch } : {}) });
    if (record.modeForced === "conductor") {
      const { computer: _computer, ...to } = record.to;
      await this.deps.succession!.saveLaunch(record.id, { computerId: record.computerId, project, to, label, brief: { id: record.id, text: remotePrompt }, worker: !!record.dispatch, ...(record.workerDispatch ? { workerDispatch: record.workerDispatch } : {}) });
    }
    const target = await new DispatchService().continueChat(peer, project, record.to, { id: record.id, text: remotePrompt }, label, async target => {
      const parsed = targetSchema.safeParse(target);
      const pane = targetSchema.omit({ session: true }).safeParse(object(target).paneTarget);
      if (pane.success) await this.update(record, { state: "uncertain", paneTarget: pane.data, placement: "peer" });
      if (parsed.success) {
        await this.update(record, { state: "uncertain", target: parsed.data, placement: "peer" });
        if (record.modeForced === "conductor") await this.deps.succession!.prepared(record.id, parsed.data);
      }
    }, record.computerId, !!record.dispatch, record.workerDispatch);
    return target;
  }

  /** Startup and tick recovery reuse the receiving Hook's durable move id.
   * No fresh id, brief or pane is created after an uncertain launch. */
  async reconcile(): Promise<void> {
    const transaction = (await (await import("./conductor-role.js")).readRoleState())?.succession;
    if (transaction?.side === "origin" && ["preparing", "prepared"].includes(transaction.phase) && transaction.resume && !await readMove(transaction.id)) await saveMove(moveRecordSchema.parse(transaction.resume));
    for (const record of await listMoves(this.now)) {
      if (["moved", "failed"].includes(record.state) || !record.to.computer || !record.project) continue;
      if (record.recovery && Date.parse(record.recovery.nextAt) > this.now) continue;
      const key = `${record.from.target.server}\0${record.from.target.pane}`;
      if (this.running.has(key) || this.admissions.has(key)) continue;
      const work = (async () => {
        try {
          const { movePeer, currentMovePeer } = await import("./move-computers.js");
          const enrolled = await movePeer(record.to.computer);
          if (!enrolled || enrolled.fingerprint !== record.computerFingerprint) throw new BridgeError(409, "The destination enrollment changed; reconciliation is paused.");
          const peer = await currentMovePeer(enrolled);
          if (record.modeForced === "conductor" && transaction?.id === record.id && transaction.phase === "aborted") {
            await this.update(record, { state: "failed", error: transaction.revoked ? "The owner stopped the delegated conductor; no previous chat regained the role." : "The hand-over was aborted; the previous conductor keeps the role." }); return;
          }
          if (this.now - Date.parse(record.createdAt) >= 10 * 60_000) {
            const placement = await peer.request(`/v1/sessions/move/launch?id=${record.id}`, undefined, 5_000);
            if (placement.state === "not-placed") {
              if (record.modeForced === "conductor") {
                await this.deps.succession!.abort(record.id);
                if ((await this.deps.succession!.status(record.id)).phase === "committed") throw new BridgeError(409, "The ownership is committed; reconciliation cannot abort it.");
              }
              await this.update(record, { state: "failed", error: "The destination confirmed no pane exists after ten minutes. The move was aborted; the original chat keeps its role." }); return;
            }
          }
          if (record.modeForced === "conductor") await this.deps.succession!.ensurePrepared(record.id);
          const document = await readFile(handoffPath(record.id), "utf8").catch(() => undefined);
          if (!document) {
            await this.run(record, DEFAULT_HANDOFF_MS, record.modeForced === "conductor" ? transaction?.previous : undefined, peer, record.project);
            if (record.state === "uncertain") throw new BridgeError(503, record.error ?? "The launch is still uncertain.");
            return;
          }
          const target = await this.continueOnPeer(record, peer, record.project!, document);
          if (record.modeForced === "conductor") {
            const status = await this.deps.succession!.status(record.id);
            if (status.phase !== "committed") {
              await this.deps.succession!.prepared(record.id, target);
              await this.deps.succession!.commit(record.id);
            }
            await this.deps.succession!.finish(record.id);
          }
          await this.update(record, { state: "moved", movedAt: new Date(this.now).toISOString(), target, placement: "peer", error: undefined,
            handedOffTo: { computer: peer.name, target }, handedOffFrom: { target: record.from.target, title: record.from.label ?? record.from.target.source } });
        } catch (error) {
          const attempts = (record.recovery?.attempts ?? 0) + 1;
          const deadline = Date.parse(record.createdAt) + 10 * 60_000;
          const refused = error instanceof BridgeError && error.status >= 400 && error.status < 500;
          let message = String(error instanceof Error ? error.message : error);
          if (refused || this.now >= deadline) {
            if (record.modeForced === "conductor") {
              // abort() reads the durable commit point and cannot roll back a
              // committed generation, including a lost commit acknowledgement.
              await this.deps.succession!.abort(record.id).catch(() => undefined);
              const state = await this.deps.succession!.status(record.id).catch(() => undefined);
              message += state?.phase === "committed" ? " Ownership is committed; the old chat remains fenced. Reconcile conductor status on the original Hook." : state?.phase === "aborted" ? " The uncommitted move was aborted; the original conductor keeps the role." : " Ownership is uncertain; verify the original Hook's generation before changing roles.";
            }
            await this.update(record, { state: "failed", error: message.slice(0, 500) }).catch(() => undefined);
          } else {
            const delay = Math.min(600_000, 5_000 * 2 ** Math.min(attempts - 1, 20));
            await this.update(record, { state: "uncertain", error: message.slice(0, 500), recovery: { attempts, nextAt: new Date(Math.min(this.now + delay, deadline)).toISOString() } }).catch(() => undefined);
          }
        }
      })().finally(() => this.running.delete(key));
      this.running.set(key, work);
    }
  }

  /** An ordinary move never acquires permission to stop a conductor merely
   * because the owner promoted its source while the hand-off was running. */
  private async checkPromotion(record: MoveRecord): Promise<void> {
    if (record.modeForced === "conductor") return;
    const current = await recordedConductor();
    if (current?.server === record.from.target.server && current.pane === record.from.target.pane) {
      throw new BridgeError(409, "The pane became the conductor during the move; nothing was changed.");
    }
  }

  /** Uses the same durable prompt path as the hand-off and its first brief. */
  private async conductorNotice(record: MoveRecord, text: string, outcome: "confirmed" | "failed"): Promise<string | undefined> {
    try {
      const target = targetSchema.safeParse(record.target);
      if (target.success) {
        const sent = await this.deps.deliver(target.data, text, `move-${record.id}-conductor-${outcome}`);
        if (sent.state === "failed" || (sent.ok !== true && sent.queued !== true) || (sent.delivered === false && sent.queued !== true)) {
          throw new Error(String(sent.error ?? "delivery was not confirmed"));
        }
      } else if (record.paneTarget) {
        await this.deps.terminal.prompt(record.paneTarget.server, record.paneTarget.pane, text);
        return `The conductor hand-over ${outcome} notice was typed to the new pane; conversation delivery is unconfirmed.`;
      }
      return undefined;
    } catch (error) {
      return `The conductor hand-over ${outcome}, but the new chat's notice could not be delivered: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
    }
  }

  /** The agent's own hand-off, or why there is none. Fails only when the session itself went away. */
  private async askForHandoff(record: MoveRecord, handoffMs: number): Promise<{ text: string } | { reason: string }> {
    const from = record.from.target;
    const deadline = this.now + handoffMs;
    try {
      const sent = await this.deps.deliver(from, handoffRequest(record.id, record.to, record.mode), `move-${record.id}`);
      // A lost delivery acknowledgement can still have reached the agent;
      // its marked transcript reply is authoritative for the normal window.
      if (sent.state !== "uncertain" && sent.ok !== true && sent.queued !== true) return { reason: `the request could not be delivered (${String(sent.error ?? sent.state ?? "not confirmed")}).` };
    } catch (error) { return { reason: `the request could not be delivered (${error instanceof Error ? error.message : String(error)}).` }; }
    while (this.now < deadline) {
      await this.sleep(this.poll);
      const pane = findPane(await this.deps.snapshot(from.server), placeOf(from));
      if (!pane || pane.agent !== from.source) throw new BridgeError(409, "The session ended before it wrote its hand-off; nothing was started.");
      const lines = await this.deps.transcript(from).catch(() => [] as string[]);
      const text = extractHandoff(repliesAfterRequest(conversationEntries(lines, from.source), record.id), record.id);
      if (!text) continue;
      // Its turn ends with the hand-off; wait for that before typing the exit.
      while (this.now < deadline) {
        const now = findPane(await this.deps.snapshot(from.server), placeOf(from));
        if (!now || now.agent_status !== "working") break;
        await this.sleep(this.poll);
      }
      return { text };
    }
    return { reason: `it did not reply with one within ${Math.round(handoffMs / 1000)} seconds.` };
  }

  private async fallback(record: MoveRecord, reason: string): Promise<string> {
    const from = record.from.target;
    const lines = await this.deps.transcript(from).catch(() => [] as string[]);
    // The move's own request and anything after it are not the work.
    const entries = conversationEntries(lines, from.source);
    const asked = requestIndex(entries, record.id);
    const original = record.dispatch ? await this.deps.brief?.(record.dispatch).catch(() => undefined) : undefined;
    return fallbackHandoff({ reason, from: harnessName({ harness: from.source, account: record.from.account }),
      entries: asked < 0 ? entries : entries.slice(0, asked), ...(original ? { original } : {}),
      ...(record.dispatch ? { dispatch: record.dispatch } : {}), ...(record.from.label ? { label: record.from.label } : {}) });
  }

  /** The same conversation under another Claude account: the old agent exits,
   * its transcript (now final) is copied into the target home, and Claude
   * resumes it there. Nothing is asked of the old agent, so its quota does not matter. */
  private async switchAccount(record: MoveRecord): Promise<void> {
    const from = record.from.target;
    let copied = false;
    try {
      const exit = await this.exit(record);
      await this.update(record, { exit });
      await this.checkPromotion(record);
      const home = claudeHome(record.to.account);
      if (!home) throw new BridgeError(409, `No Claude account "${record.to.account}" on this computer.`);
      await this.deps.copyConversation!(from, home);
      copied = true;
      await this.update(record, { state: "launching" });
      const launched = await this.relaunch(record, { resume: from.session! });
      await this.update(record, { state: "moved", movedAt: new Date(this.now).toISOString(), ...launched });
      logger.info("move", `Switched Claude in pane ${from.pane} from account ${record.from.account ?? DEFAULT_ACCOUNT} to ${record.to.account} (${launched.placement}).`);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f]+/g, " ");
      // Until the copy is complete only the old account holds the conversation.
      const resumeHome = claudeHome(copied ? record.to.account : record.from.account);
      const hint = record.exit !== undefined
        ? ` The old agent has exited; resume it with \`claude --resume ${from.session}\`${resumeHome && !resumeHome.isDefault ? ` under CLAUDE_CONFIG_DIR=${resumeHome.dir}` : ""}.` : "";
      await this.update(record, { state: "failed", error: `${message}${hint}`.slice(0, 500) }).catch(() => undefined);
      logger.warn("move", `Switching the account of pane ${from.pane} failed: ${message}`);
    }
  }

  /** Ends the old agent with its own exit command; an interrupt, then a kill, only when it hangs. */
  private async exit(record: MoveRecord): Promise<"clean" | "interrupted" | "killed"> {
    const from = record.from.target;
    const exitMs = this.deps.exitMs ?? 20_000;
    const gone = async (ms: number) => {
      const until = this.now + ms;
      for (;;) {
        const pane = findPane(await this.deps.snapshot(from.server), placeOf(from));
        if (!pane) throw new BridgeError(409, "The pane closed while the old agent exited; nothing was started.");
        if (pane.agent !== from.source) return true;
        if (this.now >= until) return false;
        await this.sleep(Math.min(this.poll, 500));
      }
    };
    const pane = findPane(await this.deps.snapshot(from.server), placeOf(from));
    // A turn still running (a hand-off that ran late) is stopped first, as Esc in the terminal would.
    if (pane?.agent_status === "working") {
      await this.checkPromotion(record);
      await this.deps.terminal.sendKeys(from.server, from.pane, ["esc"]).catch(() => undefined);
      await this.sleep(1_000);
    }
    await this.checkPromotion(record);
    await this.deps.terminal.prompt(from.server, from.pane, EXIT_COMMANDS[from.source] ?? "/exit").catch(() => undefined);
    if (await gone(exitMs)) return "clean";
    for (let n = 0; n < 2; n++) { await this.checkPromotion(record); await this.deps.terminal.sendKeys(from.server, from.pane, ["ctrl+c"]).catch(() => undefined); await this.sleep(500); }
    if (await gone(5_000)) return "interrupted";
    const { foregroundPids, shellPid } = await this.deps.terminal.processes(from.server, from.pane);
    const agent = foregroundPids.filter(pid => pid !== shellPid);
    const kill = this.deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      await this.checkPromotion(record);
      for (const pid of agent) { try { kill(pid, signal); } catch { /* already gone */ } }
      if (await gone(5_000)) return "killed";
    }
    throw new BridgeError(409, "The old agent did not exit, even when killed; nothing was started.");
  }

  /** Starts the target in the old pane when its shell has what the target needs, else in a new tab beside it. */
  private async relaunch(record: MoveRecord, start: string | { resume: string }): Promise<Pick<MoveRecord, "placement" | "target" | "to" | "linkPending" | "notice">> {
    const prompt = typeof start === "string" ? start : undefined;
    const from = record.from.target;
    const s = await this.deps.snapshot(from.server);
    const pane = findPane(s, placeOf(from));
    if (!pane) throw new BridgeError(409, "The pane closed after the old agent exited.");
    // A Claude target with no account keeps the pane's own, so its shell's CLAUDE_CONFIG_DIR is right.
    const shellAccount = record.from.account ?? DEFAULT_ACCOUNT;
    const account = record.to.harness === "claude" ? record.to.account ?? shellAccount : undefined;
    const samePane = record.mode !== "new-chat" && ((this.deps.envAtStart?.(from.server) ?? false) || record.to.harness !== "claude" || account === shellAccount);
    const data: Json = { kind: record.to.harness, label: record.from.label ?? HARNESS_NAMES[record.to.harness], cwd: record.cwd,
      ...(record.to.model ? { model: record.to.model } : {}), ...(record.to.effort ? { effort: record.to.effort } : {}), ...(account ? { account } : {}),
      ...(prompt === undefined ? {} : { brief: { id: record.id, text: prompt } }), ...(samePane ? {} : { workspaceId: from.workspace }) };
    const into = samePane ? { workspaceId: from.workspace, tabId: from.tab, paneId: from.pane } : undefined;
    await this.checkPromotion(record);
    const launched = await this.deps.launch(from.server, data, { ...(into ? { into } : {}), ...(record.dispatch && record.modeForced !== "conductor" ? { dispatchId: record.dispatch } : {}),
      ...(prompt === undefined ? { resumeClaude: (start as { resume: string }).resume } : {}) });
    // Keep the launched location even if delivering its first prompt fails.
    const paneTarget = targetSchema.omit({ session: true }).parse({ server: from.server,
      workspace: launched.workspaceId, tab: launched.tabId, pane: launched.paneId, source: record.to.harness });
    const launchedTarget = z.union([targetSchema, startingTargetSchema]).safeParse(launched.target);
    await this.update(record, { paneTarget, placement: samePane ? "same-pane" : "adjacent-pane",
      ...(launchedTarget.success ? { target: launchedTarget.data } : {}) });
    // The target that takes no brief at launch (Copilot) gets it typed, as dispatch does.
    if (prompt !== undefined && launched.briefLaunched === false) {
      try {
        const typedTo = targetSchema.safeParse(launched.target);
        if (typedTo.success) {
          const sent = await this.deps.deliver(typedTo.data, prompt, `move-${record.id}-brief`);
          if (sent.state === "failed" || (sent.ok !== true && sent.queued !== true)
            || (sent.delivered === false && sent.queued !== true)) {
            throw new Error(String(sent.error ?? sent.state ?? "delivery was not confirmed"));
          }
        } else await this.deps.terminal.prompt(from.server, paneTarget.pane, prompt);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${record.mode === "new-chat" ? "New chat" : "Target"} started but did not receive the hand-off. The launched pane was left open. ${reason}`);
      }
    }
    if (!samePane && record.mode !== "new-chat") {
      await this.checkPromotion(record);
      await this.deps.terminal.closePane(from.server, from.pane).catch(() => undefined);
    }
    // The account the new agent runs under, also when the move named none.
    const to = account ? { ...record.to, account } : record.to;
    return { to, placement: samePane ? "same-pane" : "adjacent-pane", ...await this.newTarget(record, launched, record.to.harness) };
  }

  /** New chats remain open as linking while the harness establishes its conversation. */
  private async newTarget(record: MoveRecord, launched: Json, source: string): Promise<Pick<MoveRecord, "target" | "linkPending" | "notice">> {
    const server = record.from.target.server;
    const full = targetSchema.safeParse(launched.target);
    if (full.success) return { target: full.data };
    const place = { server, workspace: String(launched.workspaceId), tab: String(launched.tabId), pane: String(launched.paneId), source };
    const newChat = record.mode === "new-chat";
    if (newChat) await this.update(record, { state: "linking" });
    for (const until = this.now + (newChat ? 180_000 : 30_000); this.now < until; await this.sleep(this.poll)) {
      const pane = findPane(await this.deps.snapshot(server).catch(() => ({})), place);
      const session = pane && pane.agent === source ? await this.deps.identity(server, pane).catch(() => undefined) : undefined;
      const target = targetSchema.safeParse({ ...place, session });
      if (target.success) return { target: target.data };
    }
    const starting = startingTargetSchema.safeParse(launched.target);
    return { ...(starting.success ? { target: starting.data } : {}),
      ...(newChat ? { linkPending: true, notice: "New chat started; the conversation link is pending after three minutes. Use the pane target to open it." } : {}) };
  }
}

/** The last `bytes` of a transcript as lines, the first (cut) one dropped. */
export async function transcriptTail(file: string, bytes = 512 * 1024): Promise<string[]> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes), buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    return start > 0 ? lines.slice(1) : lines;
  } finally { await handle.close(); }
}

/**
 * Copies a Claude conversation into another account's home, at the same
 * `projects/<folder key>/<session>.jsonl` path Claude reads it from with
 * `--resume`, together with the session's own folder (subagent transcripts,
 * tool results) when it has one. A copy already there is replaced: the
 * source is the conversation as it stands now. Returns the copied transcript.
 * Both ends are checked against the homes' real `projects` folders, so a
 * symlinked folder inside the target home cannot redirect the write. With
 * `check`, nothing is written.
 */
export async function copyClaudeConversation(file: string, to: ClaudeHome, env: NodeJS.ProcessEnv = process.env, check = false): Promise<string> {
  const real = async (dir: string) => realpath(dir).catch(() => path.resolve(dir));
  const inside = (child: string, parent: string) => child.startsWith(parent + path.sep);
  const source = await real(file);
  // A home's projects folder may be a link elsewhere, as transcriptPath allows.
  const homes = await Promise.all(claudeHomes(env).map(async home => ({ home, dir: await real(home.dir), projects: await real(path.join(home.dir, "projects")) })));
  const longest = (list: typeof homes) => list.sort((a, b) => b.projects.length - a.projects.length)[0];
  const match = longest(homes.filter(item => inside(source, item.projects))) ?? longest(homes.filter(item => inside(source, item.dir)));
  if (!match) throw new BridgeError(409, "The conversation's transcript is not in a Claude home on this computer.");
  const from = match.home;
  if (from.dir === to.dir) throw new BridgeError(400, "The conversation already belongs to that account.");
  const projects = match.projects;
  const relative = path.relative(projects, source);
  if (!relative || !inside(source, projects) || !relative.endsWith(".jsonl")) {
    throw new BridgeError(409, "The conversation's transcript is not under its Claude home's projects folder.");
  }
  const targetProjects = path.join(to.dir, "projects");
  const destination = path.join(targetProjects, relative);
  // The deepest folder that exists on the way must resolve inside the target home's projects folder (or be the home itself).
  const targetRoot = await real(targetProjects);
  let existing = path.dirname(destination);
  while (!(await lstat(existing).catch(() => undefined)) && existing !== path.dirname(existing) && existing !== to.dir) existing = path.dirname(existing);
  const resolved = await real(existing);
  if (resolved !== targetRoot && !inside(resolved, targetRoot) && resolved !== await real(to.dir)) {
    throw new BridgeError(409, "The other account's projects folder points outside its Claude home.");
  }
  if (check) return destination;
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary);
    await rename(temporary, destination);
  } catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
  const folder = source.slice(0, -".jsonl".length);
  if ((await stat(folder).catch(() => undefined))?.isDirectory()) {
    const folderTo = destination.slice(0, -".jsonl".length);
    // A link left at the folder's place is replaced, never followed.
    if ((await lstat(folderTo).catch(() => undefined))?.isSymbolicLink()) await rm(folderTo, { force: true });
    await cp(folder, folderTo, { recursive: true, force: true, verbatimSymlinks: true });
  }
  return destination;
}

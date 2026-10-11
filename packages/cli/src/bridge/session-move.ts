// Moving a live session to another agent: the agent in the pane writes a
// hand-off, exits the way it normally does, and the target harness starts in
// the same pane, in the same folder, with that hand-off as its first prompt.
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
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { logger } from "../logger.js";
import { quoted, withOriginalBrief } from "./account-failover.js";
import { DEFAULT_ACCOUNT } from "./claude-accounts.js";
import { DISPATCH_HARNESSES, moveToSchema } from "./dispatch.js";
import { hasUsable, type HarnessInventory } from "./harnesses.js";
import { findPane } from "./herdr.js";
import { briefId, briefRoot, writeLaunchBrief } from "./launch-brief.js";
import { atomic, BridgeError, bridgeRoot, startingTargetSchema, targetSchema, type Json, type Provider, type StartingTarget, type Target } from "./protocol.js";
import { publicAssistant } from "./schedule-watch.js";
import type { TerminalProvider } from "./terminal.js";

const run = promisify(execFile);

export { moveToSchema };
export type MoveTo = z.infer<typeof moveToSchema>;

export const moveRequestSchema = z.object({
  target: targetSchema,
  to: moveToSchema,
  /** Kept on a retry: the same id returns the move already under way. */
  id: z.string().uuid().optional(),
  /** How long the agent gets to write its hand-off before Phren builds one. */
  handoffTimeoutMs: z.number().int().min(5_000).max(900_000).optional(),
}).strict();

const MOVE_STATES = ["handing-off", "exiting", "launching", "moved", "failed"] as const;
const timestamp = z.string().datetime();
const moveRecordSchema = z.object({
  id: z.string().uuid(),
  state: z.enum(MOVE_STATES),
  createdAt: timestamp, updatedAt: timestamp,
  from: z.object({ target: targetSchema, account: z.string().max(64).optional(), label: z.string().max(200).optional() }).strict(),
  to: moveToSchema,
  cwd: z.string().max(4096),
  /** The dispatch the moved worker was launched for, as its turn record names it. */
  dispatch: briefId.optional(),
  handoff: z.object({ path: z.string().max(4096), source: z.enum(["agent", "fallback"]), reason: z.string().max(300).optional(), chars: z.number().int().nonnegative() }).strict().optional(),
  /** How the old agent ended: its own exit command, an interrupt, or a kill after it hung. */
  exit: z.enum(["clean", "interrupted", "killed"]).optional(),
  placement: z.enum(["same-pane", "adjacent-pane"]).optional(),
  target: z.union([targetSchema, startingTargetSchema]).optional(),
  movedAt: timestamp.optional(),
  error: z.string().max(500).optional(),
}).strict();
export type MoveRecord = z.infer<typeof moveRecordSchema>;

/** What a dispatching Hook records on its receipt when its worker moved. */
export interface MovedWorker {
  id: string; at: string; handoff?: string;
  from: { harness: Provider; account?: string };
  to: MoveTo;
  target: Target | StartingTarget;
}

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

let writes: Promise<unknown> = Promise.resolve();
async function saveMove(record: MoveRecord): Promise<void> {
  const run = writes.then(async () => {
    await mkdir(movesRoot(), { recursive: true, mode: 0o700 });
    await atomic(recordFile(record.id), moveRecordSchema.parse(record));
  });
  writes = run.catch(() => undefined);
  return run;
}

export async function readMove(id: string): Promise<MoveRecord | undefined> {
  const file = recordFile(id);
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

/** The receipt fields for a finished move. */
export function movedWorker(record: MoveRecord): MovedWorker | undefined {
  if (record.state !== "moved" || !record.target) return undefined;
  return { id: record.id, at: record.movedAt ?? record.updatedAt, ...(record.handoff ? { handoff: record.handoff.path } : {}),
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
export function handoffRequest(id: string, to: MoveTo): string {
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
    "## Key files: paths, a few words each",
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
export function observedState(git: GitState | undefined, processes: readonly string[]): string {
  const lines = ["## Checked by Phren at the move", ""];
  if (!git) lines.push("- Not a git checkout, or git could not be read.");
  else {
    const tracking = git.upstream ? ` tracking ${git.upstream}${git.ahead !== undefined ? ` (ahead ${git.ahead}, behind ${git.behind})` : ""}` : ", with no upstream";
    lines.push(`- Branch: ${git.branch ?? "detached HEAD"}${tracking}. HEAD: ${git.head ?? "unknown"}.`);
    if (!git.changes.length) lines.push("- No uncommitted changes.");
    else lines.push(`- Uncommitted changes (${git.changes.length}). The move committed, stashed and reset nothing: they are the previous agent's work in progress, so keep them.`, "", "```", ...git.changes, "```");
  }
  lines.push("");
  if (processes.length) lines.push(`- Processes the previous agent had running (${processes.length}):`, "", "```", ...processes, "```");
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

/** The hand-off file: who moved where and when, the body, then what Phren saw. */
export function handoffDocument(record: MoveRecord, body: string, observed: string, at: string): string {
  return [
    `# Hand-off from ${harnessName({ harness: record.from.target.source, account: record.from.account })} to ${harnessName(record.to)}`,
    "",
    `Moved by Phren at ${at} (move ${record.id}) in ${record.cwd}.${record.dispatch ? ` Dispatch ${record.dispatch}.` : ""}`,
    "",
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
  snapshot: (server: string) => Promise<Json>;
  /** The conversation the pane runs now. */
  identity: (server: string, pane: Json) => Promise<string | undefined>;
  terminal: Pick<TerminalProvider, "prompt" | "sendKeys" | "processes" | "closePane">;
  /** The `hand_off` delivery path: queued while the agent is busy. */
  deliver: (target: Target, text: string, deliveryId: string) => Promise<Json>;
  /** Starts the new agent (`startSession`), in `into` when given. */
  launch: (server: string, data: Json, options: { into?: { workspaceId: string; tabId: string; paneId: string }; dispatchId?: string }) => Promise<Json>;
  inventory: () => Promise<HarnessInventory | undefined>;
  /** The conversation's transcript lines, its tail is enough. */
  transcript: (target: Target) => Promise<string[]>;
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
  private readonly running = new Map<string, Promise<void>>();
  constructor(private readonly deps: MoverDeps) {}

  private get now(): number { return (this.deps.now ?? Date.now)(); }
  private sleep(ms: number): Promise<void> { return (this.deps.sleep ?? (value => new Promise(resolve => setTimeout(resolve, value))))(ms); }
  private get poll(): number { return this.deps.pollMs ?? 2_000; }

  /** Checks the move can happen, records it and starts it. Refuses before anything is typed. */
  async start(input: unknown): Promise<MoveRecord> {
    const data = moveRequestSchema.parse(input);
    if (data.id) {
      const earlier = await readMove(data.id);
      if (earlier) {
        const from = earlier.from.target;
        if (from.server !== data.target.server || from.pane !== data.target.pane || from.session !== data.target.session) throw new BridgeError(409, "This move id was already used for another session.");
        return earlier;
      }
    }
    const { target, to } = data;
    const active = (await listMoves(this.now)).find(record => record.from.target.server === target.server && record.from.target.pane === target.pane
      && record.state !== "moved" && record.state !== "failed");
    if (active || [...this.running.keys()].some(key => key === `${target.server}\0${target.pane}`)) throw new BridgeError(409, "This session is already being moved.", { code: "move_in_progress" });
    const s = await this.deps.snapshot(target.server);
    const pane = findPane(s, placeOf(target));
    if (!pane) throw new BridgeError(404, "That pane is no longer open.");
    if (pane.agent !== target.source) throw new BridgeError(409, `That pane no longer runs ${HARNESS_NAMES[target.source] ?? target.source}.`);
    const session = await this.deps.identity(target.server, pane).catch(() => undefined);
    if (session && session !== target.session) throw new BridgeError(409, "That pane runs another conversation now.");
    if (await this.deps.isConductor?.(target.server, pane).catch(() => false)) throw new BridgeError(409, "This pane is the conductor. Stop it as conductor first, or make the new agent the conductor after starting it.");
    const account = target.source === "claude" ? this.deps.paneAccount?.(target.server, pane) ?? DEFAULT_ACCOUNT : undefined;
    const sameHarness = to.harness === target.source && (to.harness !== "claude" || (to.account ?? account) === account);
    if (sameHarness && !to.model && !to.effort) throw new BridgeError(400, "The session already runs there. Choose another harness, account, model or effort.");
    // Only harnesses signed in and usable here; an inventory that cannot be read lets the move go on, as a launch does.
    const inventory = await this.deps.inventory().catch(() => undefined);
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
    const dispatch = await this.deps.paneDispatch?.(target.server, pane).catch(() => undefined);
    const label = [pane.label, pane.agent_name].find(value => typeof value === "string" && value.trim() && !/^\d+$/.test(value)) as string | undefined;
    const at = new Date(this.now).toISOString();
    const record: MoveRecord = { id: data.id ?? randomUUID(), state: "handing-off", createdAt: at, updatedAt: at,
      from: { target, ...(account ? { account } : {}), ...(label ? { label: label.slice(0, 200) } : {}) }, to, cwd,
      ...(dispatch && briefId.safeParse(dispatch).success ? { dispatch } : {}) };
    await saveMove(record);
    const key = `${target.server}\0${target.pane}`;
    const work = this.run(record, data.handoffTimeoutMs ?? DEFAULT_HANDOFF_MS).finally(() => this.running.delete(key));
    this.running.set(key, work);
    return record;
  }

  /** For tests: the move under way in a pane, until it settles. */
  settled(server: string, pane: string): Promise<void> | undefined { return this.running.get(`${server}\0${pane}`); }

  private async update(record: MoveRecord, change: Partial<MoveRecord>): Promise<void> {
    Object.assign(record, change, { updatedAt: new Date(this.now).toISOString() });
    await saveMove(record);
  }

  private async run(record: MoveRecord, handoffMs: number): Promise<void> {
    const from = record.from.target;
    try {
      // What the checkout and the agent's processes look like before it stops.
      const pane = findPane(await this.deps.snapshot(from.server), placeOf(from));
      const pids = pane ? (await this.deps.terminal.processes(from.server, from.pane).catch(() => undefined))?.foregroundPids ?? [] : [];
      const [git, processes] = await Promise.all([(this.deps.git ?? readGitState)(record.cwd).catch(() => undefined),
        (this.deps.processesBelow ?? processesBelow)(pids).catch(() => [] as string[])]);
      const written = await this.askForHandoff(record, handoffMs);
      const body = "text" in written ? written.text : await this.fallback(record, written.reason);
      const document = handoffDocument(record, body, observedState(git, processes), new Date(this.now).toISOString());
      const file = handoffPath(record.id);
      const prompt = briefText(continuePrompt(document, file));
      // The folder is the new agent's brief folder; the hand-off is written into it, whole.
      await writeLaunchBrief({ id: record.id, text: prompt }, this.now, record.from.label);
      await atomic(file, document);
      await this.update(record, { state: "exiting", handoff: { path: file, source: "text" in written ? "agent" : "fallback",
        ...("reason" in written ? { reason: written.reason.slice(0, 300) } : {}), chars: document.length } });
      const exit = await this.exit(record);
      await this.update(record, { state: "launching", exit });
      await this.deps.afterExit?.(from.server, from.pane).catch(() => undefined);
      const launched = await this.relaunch(record, prompt);
      await this.update(record, { state: "moved", movedAt: new Date(this.now).toISOString(), ...launched });
      logger.info("move", `Moved ${from.source} in pane ${from.pane} to ${harnessName(record.to)} (${launched.placement}); hand-off ${record.handoff?.source}.`);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f]+/g, " ");
      const stopped = record.state === "launching";
      const hint = stopped && record.handoff ? ` The old agent has exited; start ${HARNESS_NAMES[record.to.harness]} in the pane with the hand-off at ${record.handoff.path}.` : "";
      await this.update(record, { state: "failed", error: `${message}${hint}`.slice(0, 500) }).catch(() => undefined);
      logger.warn("move", `Moving pane ${from.pane} to ${record.to.harness} failed: ${message}`);
    }
  }

  /** The agent's own hand-off, or why there is none. Fails only when the session itself went away. */
  private async askForHandoff(record: MoveRecord, handoffMs: number): Promise<{ text: string } | { reason: string }> {
    const from = record.from.target;
    const deadline = this.now + handoffMs;
    try {
      const sent = await this.deps.deliver(from, handoffRequest(record.id, record.to), `move-${record.id}`);
      if (sent.ok !== true && sent.queued !== true) return { reason: `the request could not be delivered (${String(sent.error ?? sent.state ?? "not confirmed")}).` };
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
      await this.deps.terminal.sendKeys(from.server, from.pane, ["esc"]).catch(() => undefined);
      await this.sleep(1_000);
    }
    await this.deps.terminal.prompt(from.server, from.pane, EXIT_COMMANDS[from.source] ?? "/exit").catch(() => undefined);
    if (await gone(exitMs)) return "clean";
    for (let n = 0; n < 2; n++) { await this.deps.terminal.sendKeys(from.server, from.pane, ["ctrl+c"]).catch(() => undefined); await this.sleep(500); }
    if (await gone(5_000)) return "interrupted";
    const { foregroundPids, shellPid } = await this.deps.terminal.processes(from.server, from.pane);
    const agent = foregroundPids.filter(pid => pid !== shellPid);
    const kill = this.deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      for (const pid of agent) { try { kill(pid, signal); } catch { /* already gone */ } }
      if (await gone(5_000)) return "killed";
    }
    throw new BridgeError(409, "The old agent did not exit, even when killed; nothing was started.");
  }

  /** Starts the target in the old pane when its shell has what the target needs, else in a new tab beside it. */
  private async relaunch(record: MoveRecord, prompt: string): Promise<Pick<MoveRecord, "placement" | "target" | "to">> {
    const from = record.from.target;
    const s = await this.deps.snapshot(from.server);
    const pane = findPane(s, placeOf(from));
    if (!pane) throw new BridgeError(409, "The pane closed after the old agent exited.");
    // A Claude target with no account keeps the pane's own, so its shell's CLAUDE_CONFIG_DIR is right.
    const shellAccount = record.from.account ?? DEFAULT_ACCOUNT;
    const account = record.to.harness === "claude" ? record.to.account ?? shellAccount : undefined;
    const samePane = (this.deps.envAtStart?.(from.server) ?? false) || record.to.harness !== "claude" || account === shellAccount;
    const data: Json = { kind: record.to.harness, label: record.from.label ?? HARNESS_NAMES[record.to.harness], cwd: record.cwd,
      ...(record.to.model ? { model: record.to.model } : {}), ...(record.to.effort ? { effort: record.to.effort } : {}), ...(account ? { account } : {}),
      brief: { id: record.id, text: prompt }, ...(samePane ? {} : { workspaceId: from.workspace }) };
    const into = samePane ? { workspaceId: from.workspace, tabId: from.tab, paneId: from.pane } : undefined;
    const launched = await this.deps.launch(from.server, data, { ...(into ? { into } : {}), ...(record.dispatch ? { dispatchId: record.dispatch } : {}) });
    // The target that takes no brief at launch (Copilot) gets it typed, as dispatch does.
    if (launched.briefLaunched === false) {
      const typedTo = targetSchema.safeParse(launched.target);
      if (typedTo.success) await this.deps.deliver(typedTo.data, prompt, `move-${record.id}-brief`).catch(() => undefined);
      else await this.deps.terminal.prompt(from.server, String(launched.paneId), prompt).catch(() => undefined);
    }
    if (!samePane) await this.deps.terminal.closePane(from.server, from.pane).catch(() => undefined);
    // The account the new agent runs under, also when the move named none.
    const to = account ? { ...record.to, account } : record.to;
    return { to, placement: samePane ? "same-pane" : "adjacent-pane", ...await this.newTarget(from.server, launched, record.to.harness) };
  }

  /** The new agent's full target, waiting a little for its conversation id when the launch did not have it yet. */
  private async newTarget(server: string, launched: Json, source: string): Promise<Pick<MoveRecord, "target">> {
    const full = targetSchema.safeParse(launched.target);
    if (full.success) return { target: full.data };
    const place = { server, workspace: String(launched.workspaceId), tab: String(launched.tabId), pane: String(launched.paneId), source };
    for (const until = this.now + 30_000; this.now < until; await this.sleep(this.poll)) {
      const pane = findPane(await this.deps.snapshot(server).catch(() => ({})), place);
      const session = pane && pane.agent === source ? await this.deps.identity(server, pane).catch(() => undefined) : undefined;
      const target = targetSchema.safeParse({ ...place, session });
      if (target.success) return { target: target.data };
    }
    const starting = startingTargetSchema.safeParse(launched.target);
    return starting.success ? { target: starting.data } : {};
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

import { defaultPhrenPath } from "../shared.js";
import { disabledHint } from "../modules/registry.js";
import { activateModules as moduleSnapshot, type ModuleSnapshot } from "../modules/runtime.js";
import { logger } from "../logger.js";
import { request, createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, writeFile, readFile, opendir, rename, chmod, unlink, lstat } from "node:fs/promises";
import { lstatSync, readFileSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BridgeError, bridgeRoot, object, objects, provider, serverName, sessionId, targetSchema, type Json, type Provider, type Target } from "./protocol.js";
import { herdrRoot, rpc, servers, snapshot, trustedDirectory, validateTarget } from "./herdr.js";
import { capturesChanges, ToolChanges } from "./changes.js";
import { phrenStoreRoot, unwrapPastedContent } from "./transcripts.js";
import { archiveFinishedFanouts, blockedFanouts } from "./fanouts.js";
import { ensureGrant, listGrants, matchGrant, type Grant } from "./grants.js";
import { ApprovalPushService } from "./push.js";

const APPROVAL_SWEEP_MS = 2_000;
const APPROVAL_DEBOUNCE_MS = 100;
/** How long a permission ask is held for the phone before it falls back to
 * the terminal. Claude's own hook window is 60 s; a test shortens it. */
const APPROVAL_HOLD_MS = (() => {
  const value = Number(process.env.PHREN_APPROVAL_HOLD_MS);
  return Number.isFinite(value) && value >= 50 && value <= 60_000 ? Math.floor(value) : 55_000;
})();
const FANOUT_SWEEP_MS = 5_000;
const FANOUT_ARCHIVE_MS = 60 * 60 * 1000;

const opencodeSession = /^ses_[0-9A-Za-z]{1,64}$/;
function opencodeApprovalFile(session: string, kind: "request" | "answer"): string | undefined {
  if (!opencodeSession.test(session)) return undefined;
  return path.join(phrenStoreRoot(), ".runtime", "approvals", `opencode-${session}.${kind}.json`);
}
async function* directoryNames(directory: string, limit: number): AsyncGenerator<string> {
  const entries = await opendir(directory).catch(() => undefined);
  if (!entries) return;
  let count = 0;
  for await (const entry of entries) {
    if (count++ >= limit) break;
    yield entry.name;
  }
}

function opencodeRequest(session: string): Json | undefined {
  const file = opencodeApprovalFile(session, "request");
  if (!file) return undefined;
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.size > 65_536) return undefined;
    const value = object(JSON.parse(readFileSync(file, "utf8")));
    if (typeof value.id !== "string" || !value.id || value.sessionID !== session) return undefined;
    if (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) return undefined;
    return value;
  } catch { return undefined; }
}

/** The terminal keys an agent's own dialog accepts. Kept in step with
 * `ANSWER_KEYS` in server.ts; "p" is Codex's "don't ask again" answer. */
const choiceKeys = new Set(["Escape", "Enter", "Up", "Down", "Tab", "y", "n", "p", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
/** A question asks in a few lines; more than this is scrollback above it. */
const QUESTION_LINES = 12;
interface TerminalChoiceOption { label: string; key: string }
/** The actual question a terminal dialog is asking, when its command and
 * options are visible to the Hook: a title, the command it is about, and one
 * row per choice carrying the key that answers it. */
export interface TerminalChoice { title?: string; body?: string; options: TerminalChoiceOption[] }

function choiceKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().toLowerCase();
  if (!text) return undefined;
  if (text === "esc" || text === "escape") return "Escape";
  if (text === "enter" || text === "return") return "Enter";
  if (text === "up" || text === "down" || text === "tab") return text[0].toUpperCase() + text.slice(1);
  return choiceKeys.has(text) ? text : undefined;
}
function commandText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const parts = value.filter((part): part is string => typeof part === "string" && !!part.trim());
    if (parts.length) return parts.join(" ");
  }
  return undefined;
}
function optionLabel(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  const fields = object(value);
  for (const key of ["label", "name", "title", "text", "value"]) {
    if (typeof fields[key] === "string" && fields[key].trim()) return fields[key].trim();
  }
  return undefined;
}
function labeledOption(label: string, key: unknown): TerminalChoiceOption | undefined {
  let resolved = choiceKey(key);
  const trailing = /^(.+?)\s*\(([A-Za-z0-9]+)\)\s*$/.exec(label);
  if (!resolved && trailing) resolved = choiceKey(trailing[2]);
  return resolved ? { label, key: resolved } : undefined;
}
function structuredOptions(value: unknown): TerminalChoiceOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const label = optionLabel(item);
    if (!label) return [];
    const fields = object(item);
    const key = ["key", "shortcut", "hotkey", "accelerator", "value"].map(name => choiceKey(fields[name])).find(Boolean);
    return labeledOption(label, key) ?? [];
  });
}
/** Numbered options as Codex draws them: "1. Yes, proceed (y)", with the
 * cursor marker in front of the highlighted row. Harnesses draw that marker
 * with whatever glyph they like (Codex uses "›"), and missing one costs
 * the option twice over: the row is dropped and its text joins the question. The key in
 * trailing parentheses (y, p, n, esc, enter, a digit) is the answer when
 * present and is cut from the label; otherwise the line's own number answers,
 * so a plain "1. Yes, continue anyway" is still answerable. */
function numberedOptions(text: string): TerminalChoiceOption[] {
  return text.split(/\r?\n/).flatMap(line => {
    const match = /^\s*[>❯›▸▶»•*]?\s*(\d+)[.)]\s+(.+?)\s*$/.exec(line);
    if (!match) return [];
    const label = match[2].trim();
    const trailing = /^(.+?)\s*\(([A-Za-z0-9]+)\)\s*$/.exec(label);
    const key = trailing ? choiceKey(trailing[2]) : undefined;
    if (key && trailing) return [{ label: trailing[1].trim(), key }];
    return labeledOption(label, match[1]) ?? labeledOption(label, undefined) ?? [];
  });
}
/** The question a pane's terminal lines are asking, in the same shape a held
 * permission request carries: every non-empty line above the first numbered
 * row (the "$ command" line included, the "Press enter" hint dropped), joined
 * with newlines, then one option per row keyed by its own key. Undefined
 * without two answerable rows and a title. */
export function visibleTerminalChoice(text: string): TerminalChoice | undefined {
  const options = numberedOptions(text);
  if (options.length < 2) return undefined;
  const lines = text.split(/\r?\n/);
  const firstOption = lines.findIndex(line => /^\s*[>❯›▸▶»•*]?\s*\d+[.)]\s+/.test(line));
  const above = firstOption < 0 ? lines.slice(0, 1) : lines.slice(0, firstOption);
  // Only the question's own block: everything above the last blank line is
  // whatever the agent printed before it asked, and reading a pane of
  // scrollback as the question is worse than reading none of it.
  let start = above.length;
  while (start > 0 && above[start - 1].trim()) start -= 1;
  const question = above.slice(Math.max(start, above.length - QUESTION_LINES));
  const title = question.map(line => line.trim()).filter(line => line && !/^press enter\b/i.test(line)).join("\n").trim();
  if (!title) return undefined;
  return { title: title.slice(0, 4_000), options: options.slice(0, 12) };
}
/** The pane's last non-empty line is a password read: sudo's "[sudo] password
 * for user", or any "… Password:" prompt. */
function passwordLine(text: string): boolean {
  if (text.includes("[sudo] password for")) return true;
  const last = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).pop() ?? "";
  return /password[^\n]*:\s*$/i.test(last);
}
/** The numbered dialog Claude Code and opencode draw straight in the pane when
 * a permission ask falls back to the terminal (no PermissionRequest hook
 * fires): the last non-empty line above the first "1." row is the question,
 * each row is an option keyed by its own number with its text cut at the first
 * " · ", and a footer offering "Esc to cancel" gains the Escape option.
 * Undefined without two numbered rows and a question. */
function numberedDialog(text: string): TerminalChoice | undefined {
  const row = /^\s*[>❯›▸▶»•*]?\s*(\d+)\.\s+(.+?)\s*$/;
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex(line => row.test(line));
  if (first < 0) return undefined;
  const title = lines.slice(0, first).map(line => line.trim()).filter(Boolean).pop();
  if (!title) return undefined;
  const options: TerminalChoiceOption[] = [];
  for (const line of lines.slice(first)) {
    const match = row.exec(line);
    if (!match) continue;
    const label = match[2].split(" · ")[0].trim();
    if (label) options.push({ label, key: match[1] });
  }
  if (options.length < 2) return undefined;
  if (lines.some(line => line.includes("Esc to cancel"))) options.push({ label: "Cancel", key: "Escape" });
  return { title: title.slice(0, 4_000), options: options.slice(0, 12) };
}
/** Read the question a terminal dialog is asking from the request it carries:
 * an explicit options list, or numbered lines inside its text. Undefined when
 * there are not at least two answerable choices. */
export function terminalChoice(input: unknown): TerminalChoice | undefined {
  const fields = object(input), command = commandText(fields.command ?? fields.cmd);
  let options = [fields.options, fields.choices, fields.actions, fields.answers].map(structuredOptions).find(list => list.length >= 2) ?? [];
  if (options.length < 2) {
    const text = [fields.question, fields.description, fields.justification, fields.prompt, fields.message, fields.text, fields.content, fields.display]
      .filter((value): value is string => typeof value === "string").join("\n");
    const parsed = numberedOptions(text);
    if (parsed.length >= 2) options = parsed;
  }
  if (options.length < 2) return undefined;
  const title = [fields.question, fields.description, fields.justification, fields.prompt]
    .find((value): value is string => typeof value === "string" && !!value.trim() && value.trim() !== command);
  if (!title && !command) return undefined;
  return { ...(title ? { title: String(title).slice(0, 4_000) } : {}), ...(command ? { body: command.slice(0, 4_000) } : {}), options: options.slice(0, 12) };
}

/** Claude Code's AskUserQuestion input, normalized to the shape the phone
 * already decodes for a held permission request: one question per entry with
 * its header, multi-select flag and options. Undefined when nothing parses. */
export interface TerminalQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string; preview?: string }[];
}
function terminalQuestions(input: unknown): TerminalQuestion[] | undefined {
  const questions = objects(object(input).questions).flatMap(raw => {
    const question = typeof raw.question === "string" ? raw.question.trim() : "";
    if (!question || question.length > 4_000) return [];
    const options = objects(raw.options).flatMap(option => {
      const label = typeof option.label === "string" ? option.label.trim() : "";
      if (!label || label.length > 2_000) return [];
      return [{ label, ...(typeof option.description === "string" && option.description ? { description: option.description.slice(0, 4_000) } : {}),
        ...(typeof option.preview === "string" && option.preview ? { preview: option.preview.slice(0, 4_000) } : {}) }];
    });
    if (!options.length || options.length > 12) return [];
    return [{ question, ...(typeof raw.header === "string" && raw.header ? { header: raw.header.slice(0, 200) } : {}),
      ...(raw.multiSelect === true ? { multiSelect: true } : {}), options }];
  });
  return questions.length >= 1 && questions.length <= 8 ? questions : undefined;
}
/** The current question of a released AskUserQuestion as a terminal choice:
 * its labels keyed "1".."n", and a "Done" Enter for a multi-select question
 * whose answers are confirmed by leaving it. */
function questionChoice(questions: TerminalQuestion[], index: number): TerminalChoice | undefined {
  const question = questions[index];
  if (!question) return undefined;
  const options = question.options.map((option, position) => ({ label: option.label, key: String(position + 1) }));
  if (question.multiSelect) options.push({ label: "Done", key: "Enter" });
  return { title: question.question, options: options.slice(0, 12) };
}

const localSocket = () => path.join(bridgeRoot(), "agent.sock");
const bindingPath = (server: string, pane: string) => path.join(bridgeRoot(), "bindings", encodeURIComponent(serverName.parse(server)), encodeURIComponent(pane) + ".json");
export async function recordedSession(server: string, pane: Json, pids: number[]): Promise<string | undefined> {
  try {
    const value = object(JSON.parse(await readFile(bindingPath(server, String(pane.pane_id)), "utf8")));
    if (value.terminal !== pane.terminal_id || value.source !== pane.agent || !Array.isArray(value.pids) || !value.pids.some(p => pids.includes(Number(p)))) return undefined;
    return sessionId.parse(value.session);
  } catch { return undefined; }
}

interface Pending { target: Target; response: ServerResponse; tool: string; input: unknown; message: string; choice?: TerminalChoice; expiresAt: string; timer: NodeJS.Timeout; conductor?: { action: "dispatch" | "hand_off"; project?: string; computer?: string } }

/** A conductor `dispatch` or `hand_off` permission ask the Hook can answer
 * itself under a standing grant, or offer the phone two grant-writing answers. */
export function conductorCall(tool: string, input: unknown): Pending["conductor"] | undefined {
  // MCP tool names vary by harness: `dispatch`, `phren.dispatch`,
  // `mcp__phren__dispatch`; phren_admin carries the action in its fields.
  const tail = /(?:^|[.:/]|__)(dispatch|hand_off|phren_admin)$/.exec(tool)?.[1];
  const fields = object(input);
  let action: "dispatch" | "hand_off" | undefined;
  if (tail === "dispatch") action = "dispatch";
  else if (tail === "hand_off") action = "hand_off";
  else if (tail === "phren_admin" && (fields.action === "dispatch" || fields.action === "hand_off")) action = fields.action;
  if (!action) return undefined;
  const project = typeof fields.project === "string" ? fields.project : undefined;
  const computer = typeof fields.computer === "string" ? fields.computer : undefined;
  return { action, ...(project ? { project } : {}), ...(computer ? { computer } : {}) };
}
interface PushBinding { action: string; expiresAt: number }
/** An opencode permission ask the plugin wrote to disk, held here so it can be
 * pushed and answered by binding like a Claude request the Hook holds itself. */
interface OpencodeHeld { target: Target; request: Json; expiresAt: number }
export class PushBindingStore {
  private values = new Map<string, PushBinding>();
  constructor(private now = Date.now, private limit = 128) {}
  add(binding: string, value: PushBinding) {
    for (const [key, item] of this.values) if (item.expiresAt <= this.now()) this.values.delete(key);
    while (this.values.size >= this.limit) this.values.delete(this.values.keys().next().value!);
    this.values.set(binding, value);
  }
  consume(binding: string): PushBinding | undefined {
    const value = this.values.get(binding); this.values.delete(binding);
    return value && value.expiresAt > this.now() ? value : undefined;
  }
  dropAction(action: string) { for (const [key, value] of this.values) if (value.action === action) this.values.delete(key); }
  clear() { this.values.clear(); }
  get size() { return this.values.size; }
}

/** Claude Code's AskUserQuestion is answered by allowing the call with its own
 * input plus `answers` keyed by question text (a label, or labels when the
 * question is multiSelect; any other string is a typed "Other"). The phone may
 * add answers and a free-text `response`; it may not rewrite the questions. */
const questionAnswers = z.looseObject({
  answers: z.record(z.string().min(1).max(4000), z.union([z.string().max(4000), z.array(z.string().max(4000)).min(1).max(24)])).refine(a => Object.keys(a).length > 0),
  response: z.string().max(4000).optional(),
});
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value as Json).sort().map(k => JSON.stringify(k) + ":" + canonical((value as Json)[k])).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
export function answeredQuestionInput(tool: string, input: unknown, updatedInput: unknown): Json {
  if (tool !== "AskUserQuestion") throw new BridgeError(400, "Only a question can be answered with input.");
  if (updatedInput === null || typeof updatedInput !== "object" || Array.isArray(updatedInput)) throw new BridgeError(400, "The answer is not an object.");
  const raw = JSON.stringify(updatedInput);
  if (Buffer.byteLength(raw) > 32_768) throw new BridgeError(400, "The answer is too large.");
  const parsed = questionAnswers.safeParse(updatedInput);
  if (!parsed.success) throw new BridgeError(400, "The answer must add an answers object.");
  const { answers, response, ...rest } = parsed.data;
  if (canonical(rest) !== canonical(object(input))) throw new BridgeError(400, "The answer must keep the original questions.");
  const asked = new Set(objects(object(input).questions).map(q => q.question).filter(q => typeof q === "string"));
  if (Object.keys(answers).some(q => !asked.has(q))) throw new BridgeError(400, "The answer names a question that was not asked.");
  return { ...object(input), answers, ...(response === undefined ? {} : { response }) };
}

/** An explicit foreground overview poll renews interest for a bounded interval.
 * A disconnected phone never leaves future terminal prompts waiting forever. */
export class ApprovalWatchLeases {
  private servers = new Map<string, number>();
  constructor(private now = Date.now) {}
  renew(server: string) {
    for (const [key, expiry] of this.servers) if (expiry <= this.now()) this.servers.delete(key);
    if (this.servers.has(server) || this.servers.size < 64) this.servers.set(server, this.now() + 25_000);
  }
  has(server: string) { return (this.servers.get(server) || 0) > this.now(); }
}
export type DeliveryOutcome = "delivered" | "blocked" | "pending";
interface Delivery { source: Provider; session: string; settle: (outcome: DeliveryOutcome) => void; timer: ReturnType<typeof setTimeout> }

/** What the agent hands its UserPromptSubmit hook is the terminal's pasted
 * form of what Phren typed; compare the words, not the wrapping. */
function promptKey(text: string): string {
  return unwrapPastedContent(text).replace(/\s+/g, " ").trim();
}

/** This socket is deliberately separate from the phone's HTTP pipe. Only local
 * agent callbacks can register identities or create an approval request. */
export class AgentHooks {
  readonly changes = new ToolChanges();
  private pending = new Map<string, Pending>();
  /** Prompts Phren has typed into a pane, by their text, until the agent that
   * actually receives one reports in through UserPromptSubmit. Herdr writes
   * to a pane, not a conversation; the receiving agent's hook is the only
   * party that knows which conversation consumed the text, so it is the one
   * that can refuse it when that is not the conversation the phone meant. */
  private deliveries = new Map<string, Delivery[]>();
  /** The permission request a conversation is drawing in its own terminal
   * because nobody was there to hold it: what the phone shows above its
   * answer keys until the pane stops waiting. `dialog` marks a choice parsed
   * from the pane's own numbered lines, whose answers gain an Enter, and
   * `questions` carries a released AskUserQuestion's normalized question set
   * with the index currently being answered. */
  private terminalPrompts = new Map<string, { tool: string; message: string; choice?: TerminalChoice; questions?: TerminalQuestion[]; questionIndex?: number; dialog?: boolean; at: number }>();
  /** The last time each pane's terminal lines were read for a dialog, so a
   * status tick reads them at most once per three seconds per pane. */
  private dialogReads = new Map<string, number>();
  /** Panes whose last read terminal line is a password prompt, so the status
   * frame can offer the phone's secret sheet only when one is really asking. */
  private passwords = new Map<string, boolean>();
  /** Conversations Claude Code is compacting, by target, until the new context
   * starts. The phone shows the state instead of the summary row's text. */
  private compactingSince = new Map<string, number>();
  /** Panes where Phren just typed a bare slash command: the agent is drawing
   * that command's menu, which Herdr reports as an idle agent, so keys are
   * allowed there for a short while to walk and confirm it. The command text
   * and a one-shot confirmation attempt ride with the window. */
  private menus = new Map<string, { at: number; command?: string; confirmationAttempted?: boolean }>();
  private watching = new Map<string, number>();
  readonly overview = new ApprovalWatchLeases();
  private server?: Server;
  private pushBindings = new PushBindingStore();
  /** opencode permission asks seen on disk, by request id. */
  private opencode = new Map<string, OpencodeHeld>();
  private closed = false;
  private opencodeSweep?: Promise<void>;
  private opencodeLive = new Set<string>();
  private fanoutLive = new Set<string>();
  private fanoutSweeping = false;
  private opencodeWatcher?: FSWatcher;
  private opencodePoll?: NodeJS.Timeout;
  private opencodeDebounce?: NodeJS.Timeout;
  /** Fan-out jobs already pushed as blocked, by job id and blocked timestamp. */
  private fanoutSeen = new Map<string, number>();
  private fanoutTimer?: NodeJS.Timeout;
  private fanoutArchiveTimer?: NodeJS.Timeout;
  constructor(readonly push = new ApprovalPushService(), private modules?: ModuleSnapshot) {}
  private approvalsDirectory(): string { return path.join(phrenStoreRoot(), ".runtime", "approvals"); }
  private scheduleOpencodeSweep() {
    if (this.closed || this.opencodeDebounce) return;
    this.opencodeDebounce = setTimeout(() => { this.opencodeDebounce = undefined; void this.sweepOpencodeApprovals().catch(() => {}); }, APPROVAL_DEBOUNCE_MS);
    this.opencodeDebounce.unref?.();
  }
  /** Read every live opencode request file, map it to a target through the
   * recorded bindings or Herdr's explicit opencode session id, and register it
   * for a push and a push-binding answer. A file that vanished or expired is
   * forgotten. */
  async sweepOpencodeApprovals(): Promise<void> {
    if (this.closed) return;
    if (this.opencodeSweep) return this.opencodeSweep;
    const sweep = this.readOpencodeApprovals();
    this.opencodeSweep = sweep;
    try { await sweep; } finally { this.opencodeSweep = undefined; }
  }
  private async readOpencodeApprovals(): Promise<void> {
    const directory = this.approvalsDirectory();
    const live = this.opencodeLive;
    live.clear();
    for await (const name of directoryNames(directory, 1024)) {
      if (this.closed) return;
      const match = /^opencode-(ses_[0-9A-Za-z]{1,64})\.request\.json$/.exec(name);
      if (!match) continue;
      const request = opencodeRequest(match[1]);
      if (!request) continue;
      const id = String(request.id);
      live.add(id);
      if (this.opencode.has(id)) continue;
      const target = await this.resolveOpencodeTarget(match[1]);
      if (this.closed) return;
      if (!target) continue;
      const expiresAt = typeof request.expiresAt === "string" ? Date.parse(request.expiresAt) : NaN;
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) continue;
      this.opencode.set(id, { target, request, expiresAt });
      if (!this.push.available) continue;
      const binding = randomUUID();
      this.pushBindings.add(binding, { action: id, expiresAt });
      const title = typeof request.title === "string" ? request.title : `Allow ${String(request.type ?? "action")}?`;
      const message = typeof request.message === "string" ? request.message : "";
      // The held request is what stops a later sweep from pushing again; a
      // failed delivery only drops the binding and leaves the card in place.
      void this.push.notify({ binding, provider: "opencode", question: false, expiresAt: String(request.expiresAt), title, message })
        .then(delivered => { if (!delivered) this.pushBindings.dropAction(id); })
        .catch(() => {});
    }
    for (const [id, held] of this.opencode) {
      if (!live.has(id) || held.expiresAt <= Date.now()) { this.opencode.delete(id); this.pushBindings.dropAction(id); }
    }
  }
  /** A session's exact pane. A recorded binding carries the full target; when
   * there is none, Herdr's explicit `ses_` identity names the pane. */
  private async resolveOpencodeTarget(session: string): Promise<Target | undefined> {
    const root = path.join(bridgeRoot(), "bindings");
    for await (const folder of directoryNames(root, 64)) {
      for await (const name of directoryNames(path.join(root, folder), 1024)) {
        if (!name.endsWith(".json")) continue;
        let value: Json;
        try {
          const file = path.join(root, folder, name), info = await lstat(file);
          if (!info.isFile() || info.size > 65_536) continue;
          value = object(JSON.parse(await readFile(file, "utf8")));
        } catch { continue; }
        if (value.source !== "opencode" || value.session !== session) continue;
        if (typeof value.workspace !== "string" || typeof value.tab !== "string") continue;
        const parsed = targetSchema.safeParse({ server: decodeURIComponent(folder), workspace: value.workspace, tab: value.tab,
          pane: decodeURIComponent(name.slice(0, -".json".length)), source: "opencode", session });
        if (parsed.success) return parsed.data;
      }
    }
    const live = await servers().catch(() => [] as Json[]);
    for (const entry of live) {
      const server = String(entry.session);
      const state = await snapshot(server).catch(() => undefined);
      if (!state) continue;
      for (const pane of objects(state.panes)) {
        if (pane.agent !== "opencode") continue;
        const reported = object(pane.agent_session);
        if (reported.kind !== "id" || reported.agent !== "opencode" || reported.value !== session) continue;
        const parsed = targetSchema.safeParse({ server, workspace: pane.workspace_id, tab: pane.tab_id,
          pane: pane.pane_id, source: "opencode", session });
        if (parsed.success) return parsed.data;
      }
    }
    return undefined;
  }
  /** Push once for each fan-out job whose blocked.json the plugin wrote. */
  private async sweepBlockedFanouts(): Promise<void> {
    if (this.closed || this.fanoutSweeping) return;
    this.fanoutSweeping = true;
    try {
      const jobs = await blockedFanouts().catch(() => []);
      if (this.closed) return;
      const live = this.fanoutLive;
      live.clear();
      for (const job of jobs) {
        live.add(job.id);
        const parsed = job.at ? Date.parse(job.at) : 0;
        const stamp = Number.isFinite(parsed) ? parsed : 0;
        if (this.fanoutSeen.get(job.id) === stamp) continue;
        this.fanoutSeen.set(job.id, stamp);
        void this.push.notifyFanoutBlocked({ job: job.id, label: job.label, provider: job.provider, reason: job.reason }).catch(() => {});
      }
      for (const id of this.fanoutSeen.keys()) if (!live.has(id)) this.fanoutSeen.delete(id);
    } finally { this.fanoutSweeping = false; }
  }
  /** Move finished fan-out folders older than a day into the archive; one log
   * line records a sweep that moved or deleted anything, and a sweep that
   * fails never takes the Hook down. */
  private async sweepFanoutArchive(): Promise<void> {
    try {
      const { moved, deleted } = await archiveFinishedFanouts();
      if (!moved.length && !deleted) return;
      logger.info("fanouts", `Archived ${moved.length} finished fan-out job(s); deleted ${deleted} past the archive cap.`);
    } catch { /* The archive sweep must never break the Hook. */ }
  }
  watch(target: Target): () => void {
    const key = JSON.stringify(target);
    this.watching.set(key, (this.watching.get(key) || 0) + 1);
    return () => { const n = (this.watching.get(key) || 1) - 1; if (n) this.watching.set(key, n); else this.watching.delete(key); };
  }
  /** Register a prompt about to be typed into `target`'s pane. The returned
   * promise settles "delivered" once that conversation's own hook submits the
   * text, "blocked" if another conversation in the pane tried to, or "pending"
   * after `waitMs`: a busy agent queues typed input and submits it only when
   * its turn ends, so the record outlives the wait (up to ten minutes) and a
   * late submission to the wrong conversation is still refused. */
  expectDelivery(target: Target, text: string, waitMs = 1_500): Promise<DeliveryOutcome> {
    const key = promptKey(text);
    if (!key) return Promise.resolve("pending");
    return new Promise<DeliveryOutcome>(resolve => {
      let settled = false;
      const list = this.deliveries.get(key) ?? [];
      const remove = () => { const current = this.deliveries.get(key) ?? []; const index = current.indexOf(delivery); if (index >= 0) current.splice(index, 1); if (!current.length) this.deliveries.delete(key); };
      const settle = (outcome: DeliveryOutcome) => { if (!settled) { settled = true; resolve(outcome); } if (outcome !== "pending") { clearTimeout(delivery.timer); remove(); } };
      const delivery: Delivery = { source: target.source, session: target.session, settle, timer: setTimeout(() => settle("pending"), waitMs) };
      delivery.timer.unref?.();
      const expiry = setTimeout(remove, 600_000); expiry.unref?.();
      list.push(delivery); this.deliveries.set(key, list);
      while (this.deliveries.size > 256) this.deliveries.delete(this.deliveries.keys().next().value!);
    });
  }
  /** The conversation `target` just submitted `prompt`. Nothing Phren typed
   * matches: a locally typed prompt, always allowed. Otherwise the oldest
   * matching delivery decides: its own conversation consumes it; any other
   * conversation is told to drop it, so the text is never spoken to the
   * wrong agent and the phone can safely send it again. */
  private submitted(target: Target, prompt: string): Json {
    const list = this.deliveries.get(promptKey(prompt));
    const delivery = list?.[0];
    if (!delivery) return {};
    if (delivery.source === target.source && delivery.session === target.session) { delivery.settle("delivered"); return {}; }
    delivery.settle("blocked");
    return { decision: "block", reason: "Phren sent this message to a different conversation in this pane; it was not delivered here. Send it again from the phone." };
  }
  private rememberTerminalPrompt(target: Target, body: Json) {
    const tool = String(body.tool || "action").slice(0, 200);
    const questions = tool === "AskUserQuestion" ? terminalQuestions(body.input) : undefined;
    const choice = questions ? questionChoice(questions, 0) : terminalChoice(body.input);
    this.terminalPrompts.set(JSON.stringify(target), { tool,
      message: JSON.stringify(body.input || {}, null, 2).slice(0, 32_768), ...(choice ? { choice } : {}),
      ...(questions ? { questions, questionIndex: 0 } : {}), at: Date.now() });
    while (this.terminalPrompts.size > 64) this.terminalPrompts.delete(this.terminalPrompts.keys().next().value!);
  }
  /** The request the agent is showing in its terminal, if one fell through
   * in the last fifteen minutes; the caller only asks while the pane waits. */
  terminalPrompt(target: Target): Json | undefined {
    const key = JSON.stringify(target), entry = this.terminalPrompts.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > 900_000) { this.terminalPrompts.delete(key); return undefined; }
    return { toolName: entry.tool, message: entry.message, ...(entry.choice ? { choice: entry.choice } : {}),
      ...(entry.questions?.length ? { questions: entry.questions, questionIndex: entry.questionIndex ?? 0 } : {}), at: new Date(entry.at).toISOString() };
  }
  clearTerminalPrompt(target: Target) { this.terminalPrompts.delete(JSON.stringify(target)); }
  /** True while the pane's own terminal is reading a password. */
  passwordPrompt(target: Target): boolean { return this.passwords.get(JSON.stringify(target)) === true; }
  /** Claude Code's auto-mode fallback, opencode and Codex draw a numbered
   * dialog in the pane with no PermissionRequest hook behind it. While the pane
   * waits with nothing else to ask, read its last lines (at most once per
   * three seconds per pane) and publish the dialog as a terminal choice; drop
   * it when the pane leaves waiting or the dialog lines vanish. A remembered
   * permission request that is not a dialog keeps the slot untouched. The same
   * read notes whether the terminal is reading a password. */
  async syncTerminalDialog(target: Target, active: boolean): Promise<void> {
    const key = JSON.stringify(target), entry = this.terminalPrompts.get(key);
    // A released AskUserQuestion is answered by its own question card, never
    // by the pane's numbered lines; it is cleared only when the pane stops
    // waiting for it.
    if (entry?.questions?.length) { if (!active) { this.terminalPrompts.delete(key); this.passwords.delete(key); } return; }
    if (entry && !entry.dialog) return;
    if (!active) {
      if (entry) this.terminalPrompts.delete(key);
      this.passwords.delete(key);
      return;
    }
    const now = Date.now();
    if (now - (this.dialogReads.get(key) ?? 0) < 3_000) return;
    this.dialogReads.set(key, now);
    while (this.dialogReads.size > 128) this.dialogReads.delete(this.dialogReads.keys().next().value!);
    const text = await this.paneLines(target);
    this.passwords.set(key, passwordLine(text));
    while (this.passwords.size > 128) this.passwords.delete(this.passwords.keys().next().value!);
    if (entry && !entry.dialog) return;
    // Codex draws "> 1. Yes, proceed (y)" rows; the other fallbacks number
    // rows without a key in the label.
    const dialog = target.source === "codex" ? visibleTerminalChoice(text) : numberedDialog(text);
    if (!dialog?.title) { if (entry) this.terminalPrompts.delete(key); return; }
    this.terminalPrompts.set(key, { tool: "Question", message: dialog.title, choice: dialog, dialog: true, at: now });
    while (this.terminalPrompts.size > 64) this.terminalPrompts.delete(this.terminalPrompts.keys().next().value!);
  }
  /** The phone answers a parsed dialog with the option's own digit, but the
   * pane also needs Enter to submit the selection. Only an answer whose entry
   * came from a parsed dialog gains the extra key. */
  dialogAnswerKeys<K extends string>(target: Target, keys: readonly K[]): (K | "Enter")[] {
    const entry = this.terminalPrompts.get(JSON.stringify(target));
    const digit = keys.some(key => key.length === 1 && key >= "1" && key <= "9");
    return entry?.dialog && digit ? [...keys, "Enter"] : [...keys];
  }
  /** Answer one question of a released AskUserQuestion with the option's own
   * digit: send the chosen digit(s), then Tab to advance to the next
   * question or Enter after the last. The stored question index moves with
   * them and a finished set is cleared. Undefined when the prompt is not a
   * question, so an ordinary key falls through to the usual handling. */
  questionAnswerKeys(target: Target, keys: readonly string[]): string[] | undefined {
    const key = JSON.stringify(target), entry = this.terminalPrompts.get(key);
    if (!entry?.questions?.length) return undefined;
    const digits = keys.filter(value => /^[1-9]$/.test(value));
    if (!digits.length) return undefined;
    const index = Math.min(entry.questionIndex ?? 0, entry.questions.length - 1), next = index + 1;
    if (next >= entry.questions.length) { this.terminalPrompts.delete(key); return [...digits, "Enter"]; }
    entry.questionIndex = next;
    entry.choice = questionChoice(entry.questions, next);
    return [...digits, "Tab"];
  }
  private startCompacting(target: Target) {
    this.compactingSince.set(JSON.stringify(target), Date.now());
    while (this.compactingSince.size > 64) this.compactingSince.delete(this.compactingSince.keys().next().value!);
  }
  private stopCompacting(target: Target) { this.compactingSince.delete(JSON.stringify(target)); }
  /** True while Claude Code is compacting `target`; a boundary older than ten
   * minutes is stale, so a missed SessionStart cannot pin the state forever. */
  compacting(target: Target): boolean {
    const key = JSON.stringify(target), at = this.compactingSince.get(key);
    if (at === undefined) return false;
    if (Date.now() - at > 600_000) { this.compactingSince.delete(key); return false; }
    return true;
  }
  menuOpened(target: Target, command?: string) {
    this.menus.set(JSON.stringify(target), { at: Date.now(), ...(command ? { command } : {}) });
    while (this.menus.size > 64) this.menus.delete(this.menus.keys().next().value!);
  }
  menuOpen(target: Target): boolean {
    const entry = this.menus.get(JSON.stringify(target));
    return entry !== undefined && Date.now() - entry.at < 30_000;
  }
  /** The bare slash command that opened this pane's current menu window. */
  menuCommand(target: Target): string | undefined {
    const entry = this.menus.get(JSON.stringify(target));
    return entry && Date.now() - entry.at < 30_000 ? entry.command : undefined;
  }
  menuClosed(target: Target) { this.menus.delete(JSON.stringify(target)); }
  /** Read what the pane's terminal is currently drawing, ANSI stripped. */
  private async paneLines(target: Target): Promise<string> {
    try {
      const result = object(await rpc(target.server, "agent.read",
        { target: target.pane, source: "visible", lines: 40, strip_ansi: true }, undefined, 2_000));
      const read = object(result.read ?? result);
      return typeof read.text === "string" ? read.text : "";
    } catch { return ""; }
  }
  /** After the phone walks Codex's /permissions menu onto Full Access, the
   * agent draws a second "Enable full access?" confirmation. Watch the pane's
   * terminal lines for it, answer with its own numbered choice, and only then
   * close the menu window. A confirmation that never arrives within three
   * seconds is left open as the visible prompt, published as the terminal
   * choice the phone draws as a question card. Runs at most once per window. */
  async walkMenuConfirmation(target: Target): Promise<{ menuClosed: boolean; waiting?: { message: string; choice?: TerminalChoice } }> {
    const key = JSON.stringify(target), entry = this.menus.get(key);
    if (!entry || entry.confirmationAttempted) return entry ? { menuClosed: false } : { menuClosed: true };
    entry.confirmationAttempted = true;
    const deadline = Date.now() + 3_000;
    for (;;) {
      const lines = await this.paneLines(target);
      if (/\benable full access\b/i.test(lines)) {
        await rpc(target.server, "agent.send_keys", { target: target.pane, keys: ["1", "enter"] });
        this.clearTerminalPrompt(target);
        this.menuClosed(target);
        return { menuClosed: true };
      }
      if (Date.now() >= deadline) {
        const message = lines.trim().slice(0, 32_768) || "The terminal is still waiting for an answer.";
        const choice = visibleTerminalChoice(lines);
        this.terminalPrompts.set(key, { tool: "Permissions", message, ...(choice ? { choice } : {}), at: Date.now() });
        while (this.terminalPrompts.size > 64) this.terminalPrompts.delete(this.terminalPrompts.keys().next().value!);
        return { menuClosed: false, waiting: { message, ...(choice ? { choice } : {}) } };
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
  approval(target: Target): Json | undefined {
    const pending = [...this.pending.entries()].find(([, p]) => JSON.stringify(p.target) === JSON.stringify(target));
    if (pending) return { actionId: pending[0], toolName: pending[1].tool, title: `Allow ${pending[1].tool}?`, message: pending[1].message,
      ...(pending[1].choice ? { choice: pending[1].choice } : {}), expiresAt: pending[1].expiresAt,
      ...(pending[1].conductor ? { conductor: pending[1].conductor } : {}) };
    if (target.source !== "opencode") return undefined;
    const held = [...this.opencode.values()].find(value => JSON.stringify(value.target) === JSON.stringify(target));
    if (held) return { actionId: held.request.id, toolName: held.request.type, title: held.request.title, message: held.request.message, expiresAt: held.request.expiresAt };
    const request = opencodeRequest(target.session);
    return request ? { actionId: request.id, toolName: request.type, title: request.title, message: request.message, expiresAt: request.expiresAt } : undefined;
  }
  pendingPanes(server: string, state: Json): Set<string> {
    const panes = objects(state.panes);
    const pending = new Set([...this.pending.values()].filter(p => p.target.server === server && panes.some(pane => {
      if (pane.pane_id !== p.target.pane || pane.workspace_id !== p.target.workspace || pane.tab_id !== p.target.tab || pane.agent !== p.target.source) return false;
      const reported = object(pane.agent_session);
      return reported.kind !== "id" || (reported.agent === p.target.source && reported.value === p.target.session);
    })).map(p => p.target.pane));
    for (const pane of panes) {
      if (pane.agent !== "opencode") continue;
      const reported = object(pane.agent_session);
      if (reported.kind === "id" && reported.agent === "opencode" && typeof reported.value === "string" && opencodeRequest(reported.value)) {
        pending.add(String(pane.pane_id));
      }
    }
    return pending;
  }
  async answer(target: Target, id: string, decision: unknown, updatedInput?: unknown) {
    if (target.source === "opencode") {
      if (!["approve", "deny"].includes(String(decision))) throw new BridgeError(400, "The approval answer is not valid.");
      const file = opencodeApprovalFile(target.session, "answer");
      if (!file) throw new BridgeError(400, "Invalid conversation identity.");
      await validateTarget(target);
      if (opencodeRequest(target.session)?.id !== id) throw new BridgeError(409, "This approval is no longer pending.");
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = file + "." + randomUUID();
      await writeFile(temporary, JSON.stringify({ id, decision }), { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
      this.opencode.delete(id); this.pushBindings.dropAction(id);
      return;
    }
    const entry = this.pending.get(id);
    if (!entry || JSON.stringify(entry.target) !== JSON.stringify(target)) throw new BridgeError(409, "This approval is no longer pending.");
    const grantAnswer = entry.conductor && (decision === "allow-project" || decision === "allow-everywhere") ? decision : undefined;
    if (grantAnswer && !entry.conductor) throw new BridgeError(400, "Only a conductor dispatch or hand-off can write a grant.");
    const effective = grantAnswer ? "approve" : decision;
    if (!["approve", "deny"].includes(String(effective))) throw new BridgeError(409, "This approval is no longer pending.");
    if (updatedInput !== undefined && effective !== "approve") throw new BridgeError(400, "Answers go with an approval.");
    const answered = updatedInput === undefined ? undefined : answeredQuestionInput(entry.tool, entry.input, updatedInput);
    await validateTarget(target);
    if (this.pending.get(id) !== entry || entry.response.destroyed) throw new BridgeError(409, "This approval is no longer pending.");
    if (grantAnswer) {
      const conductor = entry.conductor!;
      if (grantAnswer === "allow-project" && !conductor.project) throw new BridgeError(400, "This call has no project to scope a grant to.");
      await ensureGrant({
        scope: grantAnswer === "allow-everywhere" ? "global" : `project:${conductor.project}`,
        actions: [conductor.action],
        ...(conductor.computer && conductor.computer !== "anywhere" ? { computers: [conductor.computer] } : {}),
      });
    }
    if (this.pending.get(id) !== entry || entry.response.destroyed) throw new BridgeError(409, "This approval is no longer pending.");
    this.pending.delete(id); this.dropPushBindings(id); clearTimeout(entry.timer);
    entry.response.end(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: {
      behavior: effective === "approve" ? "allow" : "deny", ...(effective === "deny" ? { message: "Declined in Phren." } : {}),
      ...(answered ? { updatedInput: answered } : {}),
    } } }));
  }
  /** A held approval that is really a terminal dialog, answered from the
   * phone with its own keys: let the callback fall back to the terminal at
   * once instead of leaving the card up until the 55-second timer. */
  releaseChoice(target: Target) {
    for (const [id, entry] of this.pending) {
      if (!entry.choice || JSON.stringify(entry.target) !== JSON.stringify(target)) continue;
      this.pending.delete(id); this.dropPushBindings(id); clearTimeout(entry.timer);
      if (!entry.response.destroyed) entry.response.end("{}");
    }
  }
  async answerPush(binding: string, decision: unknown) {
    if (!["approve", "deny"].includes(String(decision))) throw new BridgeError(400, "The approval answer is not valid.");
    const linked = this.pushBindings.consume(binding);
    if (!linked) throw new BridgeError(409, "This approval is no longer pending.");
    const pending = this.pending.get(linked.action);
    if (pending) { await this.answer(pending.target, linked.action, decision); return; }
    const held = this.opencode.get(linked.action);
    if (held) { await this.answer(held.target, linked.action, decision); return; }
    throw new BridgeError(409, "This approval is no longer pending.");
  }
  private dropPushBindings(action: string) {
    this.pushBindings.dropAction(action);
  }
  async start() {
    await this.push.start();
    // The public helper singleton was already checked before this is called.
    const previous = await lstat(localSocket()).catch(() => undefined);
    if (previous) {
      if (!previous.isSocket() || previous.uid !== process.getuid?.()) throw new Error("Unexpected agent callback socket.");
      await unlink(localSocket());
    }
    this.server = createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json");
      try {
        if (req.method !== "POST" || req.url !== "/hook") throw new Error("Invalid callback");
        let size = 0; const chunks: Buffer[] = [];
        for await (const bytes of req) { size += bytes.length; if (size > 1_048_576) throw new Error("Oversized hook"); chunks.push(bytes); }
        const body = object(JSON.parse(Buffer.concat(chunks).toString())), target = targetSchema.parse(body.target);
        if (this.modules?.has("git") === false && ["PreToolUse", "PostToolUse"].includes(String(body.event))) {
          res.statusCode = 404; res.end(JSON.stringify({ error: disabledHint("git") })); return;
        }
        const s = await snapshot(target.server);
        const pane = objects(s.panes).find(p => p.pane_id === target.pane && p.tab_id === target.tab && p.workspace_id === target.workspace);
        if (!pane || (pane.agent && pane.agent !== target.source)) throw new Error("The pane changed");
        const info = object((await rpc(target.server, "pane.process_info", { pane_id: target.pane })).process_info);
        const pids = objects(info.foreground_processes).map(p => p.pid).filter(p => Number.isSafeInteger(p));
        if (!pids.length) throw new Error("No foreground process");
        const file = bindingPath(target.server, target.pane); await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const temporary = file + "." + randomUUID();
        await writeFile(temporary, JSON.stringify({ terminal: pane.terminal_id, source: target.source, session: target.session, pids,
          workspace: target.workspace, tab: target.tab }), { mode: 0o600, flag: "wx" });
        await rename(temporary, file);
        // What a shell call changed on disk: snapshot before, diff after.
        const input = typeof body.input === "string" ? { patch: body.input } : object(body.input), command = [input.command, input.cmd].find(v => typeof v === "string") as string | undefined;
        // A shell call by name, or any tool whose input is a command line —
        // Codex has renamed its shell tool more than once.
        if (body.event === "PreCompact") { this.startCompacting(target); res.end("{}"); return; }
        if (["SessionStart", "UserPromptSubmit", "Stop"].includes(String(body.event))) this.stopCompacting(target);
        if (body.event === "UserPromptSubmit") {
          res.end(JSON.stringify(typeof body.prompt === "string" ? this.submitted(target, body.prompt.slice(0, 65_536)) : {})); return;
        }
        if ((this.modules?.has("git") ?? true) && ["PreToolUse", "PostToolUse"].includes(String(body.event)) && capturesChanges(String(body.tool), input)) {
          const conversation = `${target.source}:${target.session}`, id = String(body.toolUseId || "").slice(0, 200);
          if (body.event === "PreToolUse") await this.changes.before(conversation, id, typeof body.cwd === "string" && path.isAbsolute(body.cwd) ? body.cwd : await trustedDirectory(pane), command ?? "", input);
          else await this.changes.after(conversation, id);
          res.end("{}"); return;
        }
        if (body.event === "PermissionRequest") this.terminalPrompts.delete(JSON.stringify(target));
        if (body.event === "PermissionRequest") {
          const conductor = conductorCall(String(body.tool || "action"), body.input);
          if (conductor) {
            // A standing grant answers the call before it becomes an approval card.
            const grant = matchGrant(await listGrants().catch(() => [] as Grant[]), {
              action: conductor.action, project: conductor.project, computer: conductor.computer,
            });
            if (grant) {
              res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }));
              return;
            }
          }
        }
        if (body.event !== "PermissionRequest" || target.source === "copilot"
          || (!this.watching.has(JSON.stringify(target)) && !this.overview.has(target.server) && !this.push.available)) {
          if (body.event === "PermissionRequest") this.rememberTerminalPrompt(target, body);
          res.end("{}"); return;
        }
        // A foreground watcher or configured push device can hold the callback.
        // Timeouts always return control to the ordinary terminal prompt.
        if (this.pending.size >= 64) { res.end("{}"); return; }
        const action = randomUUID();
        const conductor = body.event === "PermissionRequest" ? conductorCall(String(body.tool || "action"), body.input) : undefined;
        const locallyWatched = this.watching.has(JSON.stringify(target)) || this.overview.has(target.server);
        const timer = setTimeout(() => { this.pending.delete(action); this.dropPushBindings(action); this.rememberTerminalPrompt(target, body); res.end("{}"); }, APPROVAL_HOLD_MS);
        const expiresAt = new Date(Date.now() + APPROVAL_HOLD_MS).toISOString();
        const choice = terminalChoice(body.input);
        this.pending.set(action, { target, response: res, tool: String(body.tool || "action").slice(0, 200), input: body.input,
          message: JSON.stringify(body.input || {}, null, 2).slice(0, 32_768), ...(choice ? { choice } : {}), expiresAt, timer,
          ...(conductor ? { conductor } : {}) });
        res.on("close", () => { clearTimeout(timer); this.pending.delete(action); this.dropPushBindings(action); });
        if (this.push.available) {
          const binding = randomUUID();
          this.pushBindings.add(binding, { action, expiresAt: Date.parse(expiresAt) });
          void this.push.notify({ binding, provider: target.source, question: body.tool === "AskUserQuestion", expiresAt }).catch(() => false).then(delivered => {
            if (!delivered) {
              this.pushBindings.consume(binding);
              const pending = this.pending.get(action);
              if (!locallyWatched && pending) { clearTimeout(pending.timer); this.pending.delete(action); res.end("{}"); }
            }
          });
        }
      } catch { if (!res.headersSent) res.statusCode = 400; res.end("{}"); }
    });
    this.server.requestTimeout = 65_000;
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(localSocket(), () => resolve()); });
    await chmod(localSocket(), 0o600);
    // A permission ask the opencode plugin writes must reach the phone even
    // when nobody is polling; fs.watch catches the atomic rename, and a slow
    // poll covers a watcher that a platform drops.
    await mkdir(this.approvalsDirectory(), { recursive: true, mode: 0o700 }).catch(() => {});
    try {
      this.opencodeWatcher = watch(this.approvalsDirectory(), { persistent: false }, () => this.scheduleOpencodeSweep());
      this.opencodeWatcher.on("error", () => { this.opencodeWatcher?.close(); this.opencodeWatcher = undefined; });
    } catch { this.opencodeWatcher = undefined; }
    this.opencodePoll = setInterval(() => this.scheduleOpencodeSweep(), APPROVAL_SWEEP_MS);
    this.opencodePoll.unref?.();
    this.fanoutTimer = setInterval(() => { void this.sweepBlockedFanouts(); }, FANOUT_SWEEP_MS);
    this.fanoutTimer.unref?.();
    // The archive sweep runs once at start so a long-dormant store clears
    // immediately, then hourly.
    void this.sweepFanoutArchive();
    this.fanoutArchiveTimer = setInterval(() => { void this.sweepFanoutArchive(); }, FANOUT_ARCHIVE_MS);
    this.fanoutArchiveTimer.unref?.();
    this.scheduleOpencodeSweep();
    void this.sweepBlockedFanouts();
  }
  close() {
    this.closed = true;
    void this.changes.close().catch(() => {});
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.response.end("{}"); }
    this.pending.clear(); this.server?.close(); this.server?.closeAllConnections();
    this.pushBindings.clear();
    this.opencode.clear();
    if (this.opencodeDebounce) clearTimeout(this.opencodeDebounce);
    if (this.opencodePoll) clearInterval(this.opencodePoll);
    this.opencodeWatcher?.close(); this.opencodeWatcher = undefined;
    if (this.fanoutTimer) clearInterval(this.fanoutTimer);
    if (this.fanoutArchiveTimer) clearInterval(this.fanoutArchiveTimer);
    this.fanoutSeen.clear();
  }
}

export async function agentHook(source: Provider) {
  provider.parse(source);
  // A missing helper must never prevent the coding agent from running.
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_SOCKET_PATH) return;
  const socket = path.resolve(process.env.HERDR_SOCKET_PATH), root = path.resolve(herdrRoot());
  const server = socket === path.join(root, "herdr.sock") ? "default"
    : socket.startsWith(path.join(root, "sessions") + path.sep) ? path.basename(path.dirname(socket)) : undefined;
  if (!server) return;
  let input = "";
  for await (const chunk of process.stdin) { input += chunk.toString(); if (input.length > 1_048_576) return; }
  const value = object(JSON.parse(input));
  if (value.agent_id || value.agentId || value.isSidechain || value.is_sidechain) return;
  const target = targetSchema.parse({ server, workspace: process.env.HERDR_WORKSPACE_ID, tab: process.env.HERDR_TAB_ID,
    pane: process.env.HERDR_PANE_ID, source, session: value.session_id || value.sessionId });
  const event = String(value.hook_event_name || "SessionStart");
  const modules = moduleSnapshot(defaultPhrenPath(), undefined, true);
  if (!modules.has("hook") || (event.endsWith("ToolUse") && !modules.has("git"))) return;
  const data = JSON.stringify({ target, event, tool: value.tool_name, input: value.tool_input, toolUseId: value.tool_use_id, cwd: value.cwd,
    ...(event === "UserPromptSubmit" && typeof value.prompt === "string" ? { prompt: value.prompt.slice(0, 65_536) } : {}) });
  await new Promise<void>(resolve => {
    const req = request({ socketPath: localSocket(), path: "/hook", method: "POST", timeout: event === "PermissionRequest" ? 58_000 : event.endsWith("ToolUse") ? 8_000 : 1500,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, res => {
      let result = "";
      res.on("data", chunk => { result += chunk.toString(); if (result.length > 16_384) req.destroy(); });
      // Only a decision reaches the agent: an approval answer, or a refusal of
      // a prompt Phren meant for another conversation. An empty reply says nothing.
      res.on("end", () => { if (res.statusCode === 200 && (event === "PermissionRequest" || (event === "UserPromptSubmit" && result.includes("\"decision\"")))) process.stdout.write(result); resolve(); });
      res.on("error", () => resolve());
    });
    req.on("error", () => resolve()); req.on("timeout", () => { req.destroy(); resolve(); }); req.end(data);
  });
}

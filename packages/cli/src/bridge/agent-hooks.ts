import { defaultPhrenPath } from "../shared.js";
import { disabledHint } from "../modules/registry.js";
import { activateModules as moduleSnapshot, type ModuleSnapshot } from "../modules/runtime.js";
import { logger } from "../logger.js";
import { request, createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, writeFile, readFile, readdir, rename, chmod, unlink, lstat } from "node:fs/promises";
import { readFileSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BridgeError, bridgeRoot, object, objects, provider, serverName, sessionId, targetSchema, type Json, type Provider, type Target } from "./protocol.js";
import { herdrRoot, rpc, servers, snapshot, trustedDirectory, validateTarget } from "./herdr.js";
import { capturesChanges, ToolChanges } from "./changes.js";
import { phrenStoreRoot, unwrapPastedContent } from "./transcripts.js";
import { archiveFinishedFanouts, blockedFanouts } from "./fanouts.js";
import { ApprovalPushService } from "./push.js";

const APPROVAL_SWEEP_MS = 2_000;
const APPROVAL_DEBOUNCE_MS = 100;
const FANOUT_SWEEP_MS = 5_000;
const FANOUT_ARCHIVE_MS = 60 * 60 * 1000;

const opencodeSession = /^ses_[0-9A-Za-z]{1,64}$/;
function opencodeApprovalFile(session: string, kind: "request" | "answer"): string | undefined {
  if (!opencodeSession.test(session)) return undefined;
  return path.join(phrenStoreRoot(), ".runtime", "approvals", `opencode-${session}.${kind}.json`);
}
function opencodeRequest(session: string): Json | undefined {
  const file = opencodeApprovalFile(session, "request");
  if (!file) return undefined;
  try {
    const value = object(JSON.parse(readFileSync(file, "utf8")));
    if (typeof value.id !== "string" || !value.id || value.sessionID !== session) return undefined;
    if (typeof value.expiresAt === "string" && Date.parse(value.expiresAt) <= Date.now()) return undefined;
    return value;
  } catch { return undefined; }
}

/** The terminal keys an agent's own dialog accepts. Kept in step with
 * `ANSWER_KEYS` in server.ts; "p" is Codex's "don't ask again" answer. */
const choiceKeys = new Set(["Escape", "Enter", "Up", "Down", "Tab", "y", "n", "p", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
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
/** Numbered options as Codex draws them: "1. Yes, proceed (y)". */
function numberedOptions(text: string): TerminalChoiceOption[] {
  return text.split(/\r?\n/).flatMap(line => {
    const match = /^\s*\d+[.)]\s+(.+?)\s*$/.exec(line);
    if (!match) return [];
    return labeledOption(match[1].trim(), undefined) ?? [];
  });
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

const localSocket = () => path.join(bridgeRoot(), "agent.sock");
const bindingPath = (server: string, pane: string) => path.join(bridgeRoot(), "bindings", encodeURIComponent(serverName.parse(server)), encodeURIComponent(pane) + ".json");
export async function recordedSession(server: string, pane: Json, pids: number[]): Promise<string | undefined> {
  try {
    const value = object(JSON.parse(await readFile(bindingPath(server, String(pane.pane_id)), "utf8")));
    if (value.terminal !== pane.terminal_id || value.source !== pane.agent || !Array.isArray(value.pids) || !value.pids.some(p => pids.includes(Number(p)))) return undefined;
    return sessionId.parse(value.session);
  } catch { return undefined; }
}

interface Pending { target: Target; response: ServerResponse; tool: string; input: unknown; message: string; choice?: TerminalChoice; expiresAt: string; timer: NodeJS.Timeout }
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
   * answer keys until the pane stops waiting. */
  private terminalPrompts = new Map<string, { tool: string; message: string; choice?: TerminalChoice; at: number }>();
  /** Conversations Claude Code is compacting, by target, until the new context
   * starts. The phone shows the state instead of the summary row's text. */
  private compactingSince = new Map<string, number>();
  /** Panes where Phren just typed a bare slash command: the agent is drawing
   * that command's menu, which Herdr reports as an idle agent, so keys are
   * allowed there for a short while to walk and confirm it. */
  private menus = new Map<string, number>();
  private watching = new Map<string, number>();
  readonly overview = new ApprovalWatchLeases();
  private server?: Server;
  private pushBindings = new PushBindingStore();
  /** opencode permission asks seen on disk, by request id. */
  private opencode = new Map<string, OpencodeHeld>();
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
    if (this.opencodeDebounce) return;
    this.opencodeDebounce = setTimeout(() => { this.opencodeDebounce = undefined; void this.sweepOpencodeApprovals(); }, APPROVAL_DEBOUNCE_MS);
    this.opencodeDebounce.unref?.();
  }
  /** Read every live opencode request file, map it to a target through the
   * recorded bindings or Herdr's explicit opencode session id, and register it
   * for a push and a push-binding answer. A file that vanished or expired is
   * forgotten. */
  async sweepOpencodeApprovals(): Promise<void> {
    const directory = this.approvalsDirectory();
    let entries: string[] = [];
    try { entries = await readdir(directory); } catch { /* Nothing to watch yet. */ }
    const live = new Set<string>();
    for (const name of entries) {
      const match = /^opencode-(ses_[0-9A-Za-z]{1,64})\.request\.json$/.exec(name);
      if (!match) continue;
      const request = opencodeRequest(match[1]);
      if (!request) continue;
      const id = String(request.id);
      live.add(id);
      if (this.opencode.has(id)) continue;
      const target = await this.resolveOpencodeTarget(match[1]);
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
    let folders: string[] = [];
    try { folders = await readdir(root); } catch { /* No bindings yet. */ }
    for (const folder of folders) {
      let names: string[] = [];
      try { names = await readdir(path.join(root, folder)); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        let value: Json;
        try { value = object(JSON.parse(await readFile(path.join(root, folder, name), "utf8"))); } catch { continue; }
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
    const jobs = await blockedFanouts().catch(() => []);
    const live = new Set<string>();
    for (const job of jobs) {
      live.add(job.id);
      const stamp = job.at ? Date.parse(job.at) : 0;
      if (this.fanoutSeen.get(job.id) === stamp) continue;
      this.fanoutSeen.set(job.id, stamp);
      void this.push.notifyFanoutBlocked({ job: job.id, label: job.label, provider: job.provider, reason: job.reason }).catch(() => {});
    }
    for (const id of this.fanoutSeen.keys()) if (!live.has(id)) this.fanoutSeen.delete(id);
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
    const choice = terminalChoice(body.input);
    this.terminalPrompts.set(JSON.stringify(target), { tool: String(body.tool || "action").slice(0, 200),
      message: JSON.stringify(body.input || {}, null, 2).slice(0, 32_768), ...(choice ? { choice } : {}), at: Date.now() });
    while (this.terminalPrompts.size > 64) this.terminalPrompts.delete(this.terminalPrompts.keys().next().value!);
  }
  /** The request the agent is showing in its terminal, if one fell through
   * in the last fifteen minutes; the caller only asks while the pane waits. */
  terminalPrompt(target: Target): Json | undefined {
    const key = JSON.stringify(target), entry = this.terminalPrompts.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > 900_000) { this.terminalPrompts.delete(key); return undefined; }
    return { toolName: entry.tool, message: entry.message, ...(entry.choice ? { choice: entry.choice } : {}), at: new Date(entry.at).toISOString() };
  }
  clearTerminalPrompt(target: Target) { this.terminalPrompts.delete(JSON.stringify(target)); }
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
  menuOpened(target: Target) {
    this.menus.set(JSON.stringify(target), Date.now());
    while (this.menus.size > 64) this.menus.delete(this.menus.keys().next().value!);
  }
  menuOpen(target: Target): boolean {
    const at = this.menus.get(JSON.stringify(target));
    return at !== undefined && Date.now() - at < 30_000;
  }
  menuClosed(target: Target) { this.menus.delete(JSON.stringify(target)); }
  approval(target: Target): Json | undefined {
    const pending = [...this.pending.entries()].find(([, p]) => JSON.stringify(p.target) === JSON.stringify(target));
    if (pending) return { actionId: pending[0], toolName: pending[1].tool, title: `Allow ${pending[1].tool}?`, message: pending[1].message,
      ...(pending[1].choice ? { choice: pending[1].choice } : {}), expiresAt: pending[1].expiresAt };
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
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = file + "." + randomUUID();
      await writeFile(temporary, JSON.stringify({ id, decision }), { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
      this.opencode.delete(id); this.pushBindings.dropAction(id);
      return;
    }
    const entry = this.pending.get(id);
    if (!entry || JSON.stringify(entry.target) !== JSON.stringify(target) || !["approve", "deny"].includes(String(decision))) throw new BridgeError(409, "This approval is no longer pending.");
    if (updatedInput !== undefined && decision !== "approve") throw new BridgeError(400, "Answers go with an approval.");
    const answered = updatedInput === undefined ? undefined : answeredQuestionInput(entry.tool, entry.input, updatedInput);
    await validateTarget(target);
    if (this.pending.get(id) !== entry || entry.response.destroyed) throw new BridgeError(409, "This approval is no longer pending.");
    this.pending.delete(id); this.dropPushBindings(id); clearTimeout(entry.timer);
    entry.response.end(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: {
      behavior: decision === "approve" ? "allow" : "deny", ...(decision === "deny" ? { message: "Declined in Phren." } : {}),
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
        if (body.event !== "PermissionRequest" || target.source === "copilot"
          || (!this.watching.has(JSON.stringify(target)) && !this.overview.has(target.server) && !this.push.available)) {
          if (body.event === "PermissionRequest") this.rememberTerminalPrompt(target, body);
          res.end("{}"); return;
        }
        // A foreground watcher or configured push device can hold the callback.
        // Timeouts always return control to the ordinary terminal prompt.
        if (this.pending.size >= 64) { res.end("{}"); return; }
        const action = randomUUID();
        const locallyWatched = this.watching.has(JSON.stringify(target)) || this.overview.has(target.server);
        const timer = setTimeout(() => { this.pending.delete(action); this.dropPushBindings(action); this.rememberTerminalPrompt(target, body); res.end("{}"); }, 55_000);
        const expiresAt = new Date(Date.now() + 55_000).toISOString();
        const choice = terminalChoice(body.input);
        this.pending.set(action, { target, response: res, tool: String(body.tool || "action").slice(0, 200), input: body.input,
          message: JSON.stringify(body.input || {}, null, 2).slice(0, 32_768), ...(choice ? { choice } : {}), expiresAt, timer });
        res.on("close", () => { clearTimeout(timer); this.pending.delete(action); this.dropPushBindings(action); });
        if (this.push.available) {
          const binding = randomUUID();
          this.pushBindings.add(binding, { action, expiresAt: Date.parse(expiresAt) });
          void this.push.notify({ binding, provider: target.source, question: body.tool === "AskUserQuestion", expiresAt }).then(delivered => {
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

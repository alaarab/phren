import { defaultPhrenPath } from "../shared.js";
import { disabledHint } from "../modules/registry.js";
import { activateModules as moduleSnapshot, type ModuleSnapshot } from "../modules/runtime.js";
import { logger } from "../logger.js";
import { request, createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, chmod, unlink, lstat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicInPrivateDir, BridgeError, bridgeRoot, object, objects, provider, targetSchema, type Json, type Provider, type Target } from "./protocol.js";
import { findPane, herdrPaneFromEnv, knownPanes, servers, snapshot, trustedDirectory, validateTarget } from "./herdr.js";
import { terminalProvider } from "./terminal.js";
import { readPaneText } from "./pane-text.js";
import { capturesChanges, ToolChanges } from "./changes.js";
import { phrenStoreRoot, unwrapPastedContent } from "./transcripts.js";
import { archiveFinishedFanouts, blockedFanouts, fanoutAsking } from "./fanouts.js";
import { ensureGrant, listGrants, matchGrant, type Grant } from "./grants.js";
import { ApprovalPushService } from "./push.js";
import { intervalFromEnv } from "./limits.js";
import { answerClaudeQuestionDialog, claudeQuestionDialog, type DialogAnswer, type DialogQuestion } from "./claude-question-dialog.js";
import { answeredQuestionInput, numberedDialog, opencodePermissionDialog, passwordLine, permissionPrompt, questionChoice, terminalChoice, terminalQuestions, visibleTerminalChoice,
  type TerminalChoice, type TerminalQuestion } from "./terminal-choice.js";
import { directoryNames, opencodeApprovalFile, opencodeRequest, readOpencodeRequest } from "./opencode-approvals.js";
import { ApprovalWatchLeases, bindingPath, localSocket, PushBindingStore } from "./agent-hook-stores.js";
import { eventStatus, notePaneStatus, settleBlockedPane } from "./pane-status.js";
import { tmuxPaneFromEnv } from "./terminal-tmux.js";
import { countTick } from "./metrics.js";

export { permissionPrompt, terminalChoice, visibleTerminalChoice, type TerminalChoice, type TerminalQuestion } from "./terminal-choice.js";
export { ApprovalWatchLeases, PushBindingStore, recordedSession } from "./agent-hook-stores.js";

const APPROVAL_SWEEP_MS = 2_000;
/** How recent the Herdr snapshots must be for the poll to trust "no opencode pane". */
const OPENCODE_PANES_FRESH_MS = 15_000;
const APPROVAL_DEBOUNCE_MS = 100;
/** How long a permission ask is held for the phone before it falls back to
 * the terminal. Claude's own hook window is 60 s; a test shortens it. */
const APPROVAL_HOLD_MS = (() => {
  const value = Number(process.env.PHREN_APPROVAL_HOLD_MS);
  return Number.isFinite(value) && value >= 50 && value <= 60_000 ? Math.floor(value) : 55_000;
})();
/** A pane's terminal dialog is read at most once per this window. */
const DIALOG_READ_MS = intervalFromEnv("PHREN_DIALOG_THROTTLE_MS", 3_000);
const AGENT_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode", copilot: "Copilot", phren: "phren" };
/** How long a pushed terminal dialog can be answered from its notification. */
const DIALOG_PUSH_MS = 10 * 60_000;
const FANOUT_SWEEP_MS = 5_000;
const FANOUT_ARCHIVE_MS = 60 * 60 * 1000;

interface Pending { target: Target; response: ServerResponse; tool: string; input: unknown; message: string; title?: string; choice?: TerminalChoice; expiresAt: string; timer: NodeJS.Timeout; conductor?: { action: "dispatch" | "hand_off"; project?: string; computer?: string } }

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

/** An opencode permission ask the plugin wrote to disk, held here so it can be
 * pushed and answered by binding like a Claude request the Hook holds itself.
 * A fan-out worker's ask is shown on its parent conversation under an action
 * id of the parent's shape, and still answers the worker's own session; with
 * no parent pane in reach it is answered from its push alone. */
interface OpencodeHeld { target?: Target; request: Json; expiresAt: number; fanout?: { session: string; actionId: string } }

export type DeliveryOutcome = "delivered" | "blocked" | "pending";
interface Delivery { source: Provider; session: string; settle: (outcome: DeliveryOutcome) => void; timer: ReturnType<typeof setTimeout>; late?: (outcome: DeliveryOutcome) => void }

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
  private terminalPrompts = new Map<string, { tool: string; message: string; choice?: TerminalChoice; questions?: TerminalQuestion[]; questionIndex?: number; dialog?: boolean; released?: boolean; at: number }>();
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
  /** Held asks that were pushed: action -> when the notification expires. */
  private pushedHolds = new Map<string, number>();
  /** Pushed asks whose hold ended with the request left in the terminal. */
  private releasedHolds = new Map<string, { action: string; expiresAt: number }>();
  /** Terminal dialogs pushed to phones: by pane, the dialog last pushed; by
   * action, what an answer from the notification types. */
  private dialogPushes = new Map<string, { action: string; title: string }>();
  private dialogActions = new Map<string, { target: Target; choice: TerminalChoice; expiresAt: number }>();
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
    countTick("opencode-sweep");
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
      const request = await readOpencodeRequest(match[1]);
      if (!request) continue;
      const id = String(request.id);
      live.add(id);
      if (this.opencode.has(id)) continue;
      // The launcher names the fan-out job; its manifest, not the request,
      // says which worker session and parent conversation it belongs to.
      const asking = request.fanout === undefined ? undefined : await fanoutAsking(request.fanout, match[1]);
      if (request.fanout !== undefined && !asking) continue;
      const target = asking ? await this.resolveTarget(asking.parent.provider, asking.parent.session) : await this.resolveTarget("opencode", match[1]);
      if (this.closed) return;
      if (!target && !asking) continue;
      const expiresAt = typeof request.expiresAt === "string" ? Date.parse(request.expiresAt) : NaN;
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) continue;
      // The answer route checks an action id by the parent's source: a UUID
      // for Claude and Codex, a plain token for opencode.
      const fanout = asking ? { session: match[1], actionId: asking.parent.provider === "opencode" ? randomUUID().replaceAll("-", "") : randomUUID() } : undefined;
      this.opencode.set(id, { ...(target ? { target } : {}), request, expiresAt, ...(fanout ? { fanout } : {}) });
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
   * there is none, Herdr's explicit session identity names the pane. */
  private async resolveTarget(source: Provider, session: string): Promise<Target | undefined> {
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
        if (value.source !== source || value.session !== session) continue;
        if (typeof value.workspace !== "string" || typeof value.tab !== "string") continue;
        const parsed = targetSchema.safeParse({ server: decodeURIComponent(folder), workspace: value.workspace, tab: value.tab,
          pane: decodeURIComponent(name.slice(0, -".json".length)), source, session });
        if (parsed.success) return parsed.data;
      }
    }
    const live = await servers().catch(() => [] as Json[]);
    for (const entry of live) {
      const server = String(entry.session);
      const state = await snapshot(server).catch(() => undefined);
      if (!state) continue;
      for (const pane of objects(state.panes)) {
        if (pane.agent !== source) continue;
        const reported = object(pane.agent_session);
        if (reported.kind !== "id" || reported.agent !== source || reported.value !== session) continue;
        const parsed = targetSchema.safeParse({ server, workspace: pane.workspace_id, tab: pane.tab_id,
          pane: pane.pane_id, source, session });
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
      const settle = (outcome: DeliveryOutcome) => {
        if (!settled) { settled = true; resolve(outcome); } else if (outcome !== "pending") delivery.late?.(outcome);
        if (outcome !== "pending") { clearTimeout(delivery.timer); remove(); }
      };
      const delivery: Delivery = { source: target.source, session: target.session, settle, timer: setTimeout(() => settle("pending"), waitMs) };
      delivery.timer.unref?.();
      const expiry = setTimeout(remove, 600_000); expiry.unref?.();
      list.push(delivery); this.deliveries.set(key, list);
      while (this.deliveries.size > 256) this.deliveries.delete(this.deliveries.keys().next().value!);
    });
  }
  /** A prompt Phren typed into `target` that its conversation has not submitted yet. */
  deliveryPending(target: Target, text: string): boolean {
    return !!this.deliveries.get(promptKey(text))?.some(entry => entry.source === target.source && entry.session === target.session);
  }
  /** Wait again for a delivery `expectDelivery` already reported pending,
   * after the Hook pressed Enter a second time. */
  awaitLateDelivery(target: Target, text: string, waitMs = 2_500): Promise<DeliveryOutcome> {
    const delivery = this.deliveries.get(promptKey(text))?.find(entry => entry.source === target.source && entry.session === target.session);
    if (!delivery) return Promise.resolve("pending");
    return new Promise<DeliveryOutcome>(resolve => {
      const timer = setTimeout(() => { delivery.late = undefined; resolve("pending"); }, waitMs);
      timer.unref?.();
      delivery.late = outcome => { clearTimeout(timer); delivery.late = undefined; resolve(outcome); };
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
    const held = [...this.pending.values()].find(p => JSON.stringify(p.target) === key);
    // A held Codex permission can already have real choices in its pane.
    // Refresh those before publishing the approval, even while it is held.
    if (held && target.source === "codex") {
      const now = Date.now();
      if (now - (this.dialogReads.get(key) ?? 0) < DIALOG_READ_MS) return;
      this.dialogReads.set(key, now);
      const prompt = permissionPrompt(held.tool, held.input, await this.paneLines(target));
      if ([...this.pending.values()].includes(held)) {
        held.choice = prompt.choice;
        held.title = prompt.title;
        if (held.choice) this.terminalPrompts.set(key, { tool: held.tool, message: held.message, choice: held.choice, dialog: true, at: now });
        else this.terminalPrompts.delete(key);
      }
      return;
    }
    // A released AskUserQuestion is answered by its own question card, never
    // by the pane's numbered lines. It is cleared when the pane stops waiting
    // or no longer draws a question (answered or cancelled in the terminal).
    const question = !!entry?.questions?.length;
    if (question && !active) { this.terminalPrompts.delete(key); this.passwords.delete(key); return; }
    // A released permission request that carried its own choices keeps them;
    // one without (a Bash or MCP call) reads the pane's rows below.
    if (!question && entry && !entry.dialog && entry.choice && !entry.released) return;
    if (!active) {
      if (entry) this.terminalPrompts.delete(key);
      this.passwords.delete(key);
      return;
    }
    const now = Date.now();
    if (now - (this.dialogReads.get(key) ?? 0) < DIALOG_READ_MS) return;
    this.dialogReads.set(key, now);
    while (this.dialogReads.size > 128) this.dialogReads.delete(this.dialogReads.keys().next().value!);
    const text = await this.paneLines(target);
    this.passwords.set(key, passwordLine(text));
    while (this.passwords.size > 128) this.passwords.delete(this.passwords.keys().next().value!);
    // Claude's AskUserQuestion dialog is answered from the question itself
    // (the held request, the remembered one, or the transcript's), never as
    // a numbered dialog: its digits advance on their own and a trailing
    // Enter would land on the next tab.
    if (target.source === "claude" && claudeQuestionDialog(text)) {
      if (entry && !question) this.terminalPrompts.delete(key);
      return;
    }
    if (question) { this.terminalPrompts.delete(key); return; }
    // Codex draws "> 1. Yes, proceed (y)" rows and Copilot a boxed select
    // with a cursor row, both answered by moving to a row; the other
    // fallbacks number rows without a key in the label.
    const dialog = ["codex", "copilot"].includes(target.source) ? visibleTerminalChoice(text)
      // OpenCode's prompt is one row of options; its cursor is only a color.
      : target.source === "opencode" ? opencodePermissionDialog(await this.paneAnsi(target))?.choice ?? numberedDialog(text)
      : numberedDialog(text);
    if (entry && !entry.dialog) {
      // The permission the pane still shows after its hook let go: keep the
      // request's own details and answer it with the dialog's rows, so the
      // phone can approve it long after the hold ended, as Moshi does. Not a
      // `dialog`: Claude takes a row's digit at once, and an Enter after it
      // could land on the next permission.
      if (dialog?.title) { entry.choice = dialog; entry.released = true; }
      else {
        if (entry.released) { delete entry.choice; delete entry.released; }
        settleBlockedPane(target.server, target.pane);
      }
      return;
    }
    // No dialog left: a request answered in the terminal itself.
    if (!dialog?.title) { if (entry) this.terminalPrompts.delete(key); settleBlockedPane(target.server, target.pane); return; }
    this.terminalPrompts.set(key, { tool: "Question", message: dialog.title, choice: dialog, dialog: true, at: now });
    while (this.terminalPrompts.size > 64) this.terminalPrompts.delete(this.terminalPrompts.keys().next().value!);
  }
  /** Resolve a phone option identifier. Real shortcuts retain their key path;
   * keyless rows are reached and verified before returning Enter to the route. */
  async dialogAnswerKeys<K extends string>(target: Target, keys: readonly K[]): Promise<(K | "Enter")[]> {
    const entry = this.terminalPrompts.get(JSON.stringify(target));
    const choice = entry?.choice;
    const option = choice?.options.find(option => keys.includes(option.key as K));
    if (choice && option?.hasKey === false) {
      if (keys.length !== 1) throw new BridgeError(409, "Choose one terminal option at a time.");
      await this.moveDialogHighlight(target, choice, option.key);
      return ["Enter"];
    }
    const digit = keys.some(key => key.length === 1 && key >= "1" && key <= "9");
    if (digit && !option && choice?.options.some(option => option.hasKey === false)) {
      throw new BridgeError(409, "That terminal option is no longer available. Open terminal to choose an option.");
    }
    return entry?.dialog && digit ? [...keys, "Enter"] : [...keys];
  }
  async moveDialogHighlight(target: Target, expected: TerminalChoice, key: string, beforeKeys?: () => Promise<void>): Promise<void> {
    if (target.source === "opencode") { await this.selectOpencodeOnce(target, expected, beforeKeys); return; }
    const intended = expected.options.findIndex(option => option.key === key);
    let current = visibleTerminalChoice(await this.paneLines(target));
    // A held permission can expose just the asking sentence from the title.
    // Anchor subsequent reads to the entire live title, including its command.
    const title = current?.title;
    const matches = (choice: TerminalChoice | undefined): choice is TerminalChoice & { highlightedIndex: number } => !!choice
      && choice.highlightedIndex !== undefined && choice.title === title
      && (title === expected.title || !!expected.title && !!title?.split("\n").includes(expected.title))
      && JSON.stringify(choice.options) === JSON.stringify(expected.options);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!matches(current)) break;
      await validateTarget(target, false, true);
      const difference = intended - current.highlightedIndex;
      if (!difference) return;
      await beforeKeys?.();
      await terminalProvider().sendKeys(target.server, target.pane, Array<string>(Math.abs(difference)).fill(difference > 0 ? "down" : "up"));
      await new Promise(resolve => setTimeout(resolve, 150));
      current = visibleTerminalChoice(await this.paneLines(target));
      if (matches(current) && current.highlightedIndex === intended) {
        // Pane reads and cursor movement can outlive the session the phone
        // selected. Check its fresh identity before permitting confirmation.
        await validateTarget(target, false, true);
        return;
      }
    }
    throw new BridgeError(409, "Could not move and verify the terminal selection. Open terminal to choose this option.");
  }
  /** Put OpenCode's cursor on Allow once, the row's first option: ← as many
   * times as the cursor sits to its right, then read the colors again. The
   * same prompt must still be showing, or nothing more is sent. */
  private async selectOpencodeOnce(target: Target, expected: TerminalChoice, beforeKeys?: () => Promise<void>): Promise<void> {
    const read = async () => opencodePermissionDialog(await this.paneAnsi(target));
    const current = await read();
    if (current && current.choice.title === expected.title && current.selected !== undefined) {
      await validateTarget(target, false, true);
      if (current.selected > 0) {
        await beforeKeys?.();
        await terminalProvider().sendKeys(target.server, target.pane, Array<string>(current.selected).fill("left"));
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      const moved = current.selected > 0 ? await read() : current;
      if (moved && moved.choice.title === expected.title && moved.selected === 0) { await validateTarget(target, false, true); return; }
    }
    throw new BridgeError(409, "Could not move and verify the terminal selection. Open terminal to choose this option.");
  }
  /** Answer Claude's AskUserQuestion dialog in the pane: every question in
   * `answers` from `from` on, then the set's submission when `submit`. The
   * walk reads the pane before and after each key, so a dialog on another
   * tab, a changed question or a missed key stops it with nothing stray
   * typed. A finished set clears the remembered question. */
  async answerClaudeQuestions(target: Target, questions: DialogQuestion[], answers: DialogAnswer[], options: { from?: number; submit?: boolean } = {}): Promise<void> {
    const key = JSON.stringify(target);
    await answerClaudeQuestionDialog({
      read: () => this.paneLines(target),
      keys: async keys => {
        if (!keys.length) return;
        await validateTarget(target, false, true);
        await terminalProvider().sendKeys(target.server, target.pane, keys);
      },
    }, questions, answers, options);
    this.dialogReads.delete(key);
    if (options.submit ?? true) this.terminalPrompts.delete(key);
  }
  /** An older phone answers a released AskUserQuestion one question at a
   * time with the chosen digits through `/v1/keys`. Walk that question with
   * the same verified steps and submit after the last. False when the
   * prompt is not a remembered question, so the keys take the usual path. */
  async answerReleasedQuestion(target: Target, keys: readonly string[]): Promise<boolean> {
    const key = JSON.stringify(target), entry = this.terminalPrompts.get(key);
    if (target.source !== "claude" || !entry?.questions?.length) return false;
    const digits = keys.filter(value => /^[1-9]$/.test(value));
    if (!digits.length) return false;
    const index = Math.min(entry.questionIndex ?? 0, entry.questions.length - 1), last = index + 1 >= entry.questions.length;
    await this.answerClaudeQuestions(target, entry.questions, [{ options: digits.map(digit => Number(digit) - 1) }], { from: index, submit: last });
    if (!last) { entry.questionIndex = index + 1; entry.choice = questionChoice(entry.questions, index + 1); }
    return true;
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
  /** The pane with its colors, for dialogs whose cursor is only a color. */
  paneAnsi(target: Target): Promise<string> {
    return readPaneText(target.server, target.pane, { scope: "agent", source: "visible", lines: 40, stripAnsi: false, format: "ansi", timeoutMs: 2_000 });
  }
  /** Read what the pane draws, stripping ANSI unless placeholder styling is needed. */
  paneLines(target: Target, stripAnsi = true): Promise<string> {
    return readPaneText(target.server, target.pane, { scope: "agent", source: "visible", lines: 40, stripAnsi, timeoutMs: 2_000 });
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
      const choice = visibleTerminalChoice(lines);
      if (choice && /\benable full access\b/i.test(choice.title ?? "")) {
        const option = choice.options[0];
        if (option.hasKey === false) await this.moveDialogHighlight(target, choice, option.key);
        await validateTarget(target, false, true);
        await terminalProvider().sendKeys(target.server, target.pane, option.hasKey === false ? ["enter"] : [option.key.toLowerCase(), "enter"]);
        this.clearTerminalPrompt(target);
        this.menuClosed(target);
        return { menuClosed: true };
      }
      if (Date.now() >= deadline) {
        const message = lines.trim().slice(0, 32_768) || "The terminal is still waiting for an answer.";
        this.terminalPrompts.set(key, { tool: "Permissions", message, ...(choice ? { choice } : {}), at: Date.now() });
        while (this.terminalPrompts.size > 64) this.terminalPrompts.delete(this.terminalPrompts.keys().next().value!);
        return { menuClosed: false, waiting: { message, ...(choice ? { choice } : {}) } };
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
  approval(target: Target): Json | undefined {
    const pending = [...this.pending.entries()].find(([, p]) => JSON.stringify(p.target) === JSON.stringify(target));
    if (pending) return { actionId: pending[0], toolName: pending[1].tool, title: pending[1].choice?.title ?? pending[1].title, message: pending[1].message,
      details: pending[1].message, terminalOnly: target.source === "codex" && !pending[1].choice,
      ...(pending[1].choice ? { choice: pending[1].choice } : {}), expiresAt: pending[1].expiresAt,
      ...(pending[1].conductor ? { conductor: pending[1].conductor } : {}) };
    const own = target.source === "opencode" ? this.opencodeApproval(target) : undefined;
    if (own) return own;
    // A fan-out worker this conversation started is waiting on the owner.
    const worker = this.fanoutHeld(target)[0];
    return worker?.fanout ? { actionId: worker.fanout.actionId, toolName: worker.request.type, title: worker.request.title,
      message: worker.request.message, expiresAt: worker.request.expiresAt } : undefined;
  }
  private opencodeApproval(target: Target): Json | undefined {
    const held = [...this.opencode.values()].find(value => !value.fanout && JSON.stringify(value.target) === JSON.stringify(target));
    if (held) return { actionId: held.request.id, toolName: held.request.type, title: held.request.title, message: held.request.message, expiresAt: held.request.expiresAt };
    const request = opencodeRequest(target.session);
    return request ? { actionId: request.id, toolName: request.type, title: request.title, message: request.message, expiresAt: request.expiresAt } : undefined;
  }
  /** Live fan-out worker asks shown on this parent conversation, oldest first. */
  private fanoutHeld(target: Target): OpencodeHeld[] {
    const key = JSON.stringify(target);
    return [...this.opencode.values()].filter(value => value.fanout && value.target && JSON.stringify(value.target) === key
      && value.expiresAt > Date.now() && opencodeRequest(value.fanout.session)?.id === value.request.id);
  }
  pendingPanes(server: string, state: Json): Set<string> {
    const panes = objects(state.panes);
    const pending = new Set([...this.pending.values()].filter(p => p.target.server === server && panes.some(pane => {
      if (pane.pane_id !== p.target.pane || pane.workspace_id !== p.target.workspace || pane.tab_id !== p.target.tab || pane.agent !== p.target.source) return false;
      const reported = object(pane.agent_session);
      return reported.kind !== "id" || (reported.agent === p.target.source && reported.value === p.target.session);
    })).map(p => p.target.pane));
    // A permission or dialog the pane still draws after its hook let go.
    for (const [key, entry] of this.terminalPrompts) {
      if (!entry.choice || entry.questions?.length || Date.now() - entry.at > 900_000) continue;
      const target = JSON.parse(key) as Target;
      if (target.server !== server) continue;
      if (panes.some(pane => pane.pane_id === target.pane && pane.workspace_id === target.workspace && pane.tab_id === target.tab
        && pane.agent === target.source && ["waiting", "blocked"].includes(String(pane.agent_status)))) pending.add(target.pane);
    }
    for (const pane of panes) {
      if (pane.agent !== "opencode") continue;
      const reported = object(pane.agent_session);
      if (reported.kind === "id" && reported.agent === "opencode" && typeof reported.value === "string" && opencodeRequest(reported.value)) {
        pending.add(String(pane.pane_id));
      }
    }
    for (const held of this.opencode.values()) {
      const parent = held.target;
      if (!held.fanout || !parent || parent.server !== server) continue;
      if (panes.some(pane => pane.pane_id === parent.pane && pane.workspace_id === parent.workspace && pane.tab_id === parent.tab)
          && this.fanoutHeld(parent).length) pending.add(parent.pane);
    }
    return pending;
  }
  /** Hands the owner's answer to the fan-out launcher waiting on the worker's session. */
  private async answerFanout(id: string, held: OpencodeHeld, decision: unknown) {
    if (!["approve", "deny"].includes(String(decision))) throw new BridgeError(400, "The approval answer is not valid.");
    const file = held.fanout && opencodeApprovalFile(held.fanout.session, "answer");
    if (!held.fanout || !file || opencodeRequest(held.fanout.session)?.id !== id) throw new BridgeError(409, "This approval is no longer pending.");
    await atomicInPrivateDir(file, JSON.stringify({ id, decision }));
    this.opencode.delete(id); this.pushBindings.dropAction(id);
  }
  async answer(target: Target, id: string, decision: unknown, updatedInput?: unknown) {
    const worker = [...this.opencode.entries()].find(([, held]) => held.fanout?.actionId === id && JSON.stringify(held.target) === JSON.stringify(target));
    if (worker) {
      if (updatedInput !== undefined) throw new BridgeError(400, "Answers go with an approval.");
      await validateTarget(target);
      await this.answerFanout(worker[0], worker[1], decision);
      return;
    }
    if (target.source === "opencode") {
      if (!["approve", "deny"].includes(String(decision))) throw new BridgeError(400, "The approval answer is not valid.");
      const file = opencodeApprovalFile(target.session, "answer");
      if (!file) throw new BridgeError(400, "Invalid conversation identity.");
      await validateTarget(target);
      if (opencodeRequest(target.session)?.id !== id) throw new BridgeError(409, "This approval is no longer pending.");
      await atomicInPrivateDir(file, JSON.stringify({ id, decision }));
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
    settleBlockedPane(entry.target.server, entry.target.pane, 0);
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
  /** The phone's Esc or Cancel on a question the Hook holds. A held
   * AskUserQuestion has no terminal choice, so `releaseChoice` never lets it
   * go and the terminal stays frozen until the hold timer; decline it now so
   * Claude moves on. True when a held question was cancelled. */
  cancelHeldQuestion(target: Target): boolean {
    let cancelled = false;
    for (const [id, entry] of this.pending) {
      if (entry.tool !== "AskUserQuestion" || JSON.stringify(entry.target) !== JSON.stringify(target)) continue;
      this.pending.delete(id); this.dropPushBindings(id); clearTimeout(entry.timer);
      if (!entry.response.destroyed) entry.response.end(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "The user cancelled this question in Phren without answering." } } }));
      cancelled = true;
    }
    return cancelled;
  }
  async answerPush(binding: string, decision: unknown) {
    if (!["approve", "deny"].includes(String(decision))) throw new BridgeError(400, "The approval answer is not valid.");
    const linked = this.pushBindings.consume(binding);
    if (!linked) throw new BridgeError(409, "This approval is no longer pending.");
    const pending = this.pending.get(linked.action);
    if (pending) { await this.answer(pending.target, linked.action, decision); return; }
    const released = [...this.releasedHolds].find(([, hold]) => hold.action === linked.action);
    if (released && !this.dialogActions.has(linked.action)) {
      // The hold just ended: read the pane now rather than wait for the tick.
      const target = JSON.parse(released[0]) as Target;
      await this.syncTerminalDialog(target, true).catch(() => {});
      const entry = this.terminalPrompts.get(released[0]);
      if (entry?.choice?.title) this.adoptReleasedHold(released[0], target, entry.choice, entry.choice.title);
    }
    if (this.dialogActions.has(linked.action)) { await this.answerDialog(linked.action, decision as "approve" | "deny"); return; }
    const held = this.opencode.get(linked.action);
    // The binding is the single-use proof for a worker's ask, whose parent
    // may not be in any pane the Hook can see.
    if (held?.fanout) { await this.answerFanout(linked.action, held, decision); return; }
    if (held?.target) { await this.answer(held.target, linked.action, decision); return; }
    throw new BridgeError(409, "This approval is no longer pending.");
  }
  /** Where a pushed ask lives, without answering it: the phone opens that
   * session's details when the notification itself is tapped. */
  pushTarget(binding: string): Target | undefined {
    const action = this.pushBindings.peek(binding)?.action;
    if (!action) return undefined;
    const held = this.pending.get(action)?.target ?? this.dialogActions.get(action)?.target ?? this.opencode.get(action)?.target;
    if (held) return held;
    const released = [...this.releasedHolds].find(([, hold]) => hold.action === action);
    return released ? JSON.parse(released[0]) as Target : undefined;
  }
  /** Every waiting pane on this computer, each Hook tick, whether or not a
   * phone watches: an approval an agent draws as a numbered dialog in its
   * terminal (Claude's fallback prompts, Codex, OpenCode, Copilot) has no
   * hook behind it, so this is the only way it reaches a phone with phren
   * closed. Each dialog is pushed once; a pane that stops waiting drops it. */
  async observeWaitingPanes(server: string, panes: Json[], resolve: (pane: Json) => Promise<Target | undefined>): Promise<void> {
    const waiting = new Set<string>();
    for (const pane of panes) {
      if (!pane.agent || !["waiting", "blocked"].includes(String(pane.agent_status))) continue;
      const target = await resolve(pane).catch(() => undefined);
      if (!target) continue;
      const key = JSON.stringify(target);
      waiting.add(key);
      // A request its own hook already holds was pushed on arrival.
      if ([...this.pending.values()].some(held => JSON.stringify(held.target) === key)) continue;
      // Read the dialog even with no push device: the overview marks the
      // tab as needing permission from it, and the phone answers it there.
      await this.syncTerminalDialog(target, true).catch(() => {});
      if (!this.push.available) continue;
      const entry = this.terminalPrompts.get(key);
      const title = entry?.dialog || entry?.released ? entry.choice?.title : undefined;
      if (!entry?.choice || !title) { this.dropDialogPush(key); continue; }
      if (this.dialogPushes.get(key)?.title === title) continue;
      this.dropDialogPush(key);
      // Its own notification is already on the phone: answer that one.
      if (this.adoptReleasedHold(key, target, entry.choice, title)) continue;
      const action = `dialog-${randomUUID()}`, binding = randomUUID(), expiresAt = Date.now() + DIALOG_PUSH_MS;
      this.dialogPushes.set(key, { action, title });
      this.dialogActions.set(action, { target, choice: entry.choice, expiresAt });
      this.pushBindings.add(binding, { action, expiresAt });
      void this.push.notify({ binding, provider: target.source, question: false, expiresAt: new Date(expiresAt).toISOString(),
        title: `${AGENT_NAMES[target.source] ?? "An agent"} needs your approval`, message: title.slice(0, 1_000) })
        .then(delivered => { if (!delivered) this.dropDialogPush(key); }).catch(() => this.dropDialogPush(key));
    }
    for (const [key, hold] of this.releasedHolds) {
      // Answered in the terminal, or expired: the notification can no longer act.
      if ((!waiting.has(key) && JSON.parse(key).server === server) || hold.expiresAt <= Date.now()) {
        this.dropPushBindings(hold.action); this.releasedHolds.delete(key);
      }
    }
    for (const [key, pushed] of this.dialogPushes) {
      if (!waiting.has(key) && JSON.parse(key).server === server) { this.dialogActions.delete(pushed.action); this.dropPushBindings(pushed.action); this.dialogPushes.delete(key); }
    }
  }
  private adoptReleasedHold(key: string, target: Target, choice: TerminalChoice, title: string): boolean {
    const hold = this.releasedHolds.get(key);
    this.releasedHolds.delete(key);
    if (!hold || hold.expiresAt <= Date.now()) return false;
    this.dialogPushes.set(key, { action: hold.action, title });
    this.dialogActions.set(hold.action, { target, choice, expiresAt: hold.expiresAt });
    return true;
  }
  private dropDialogPush(key: string) {
    const pushed = this.dialogPushes.get(key);
    if (!pushed) return;
    this.dialogActions.delete(pushed.action); this.dropPushBindings(pushed.action); this.dialogPushes.delete(key);
  }
  /** Approve picks the dialog's yes/allow row (else its first), Deny its
   * no/deny row (else Escape), typed as the pane's own keys. */
  private async answerDialog(action: string, decision: "approve" | "deny") {
    const dialog = this.dialogActions.get(action);
    if (!dialog || dialog.expiresAt <= Date.now()) throw new BridgeError(409, "This approval is no longer pending.");
    const key = JSON.stringify(dialog.target);
    await validateTarget(dialog.target, false, true);
    const live = this.terminalPrompts.get(key)?.choice;
    if (!live || live.title !== dialog.choice.title) { this.dropDialogPush(key); throw new BridgeError(409, "That question in the terminal has changed. Open phren to answer it."); }
    const option = decision === "approve"
      ? live.options.find(row => /^(yes|allow|approve|proceed|continue|run)\b/i.test(row.label)) ?? live.options[0]
      : live.options.find(row => /^(no|deny|reject|don'?t|cancel|skip)\b/i.test(row.label));
    const keys = option ? await this.dialogAnswerKeys(dialog.target, [option.key]) : ["Escape"];
    await terminalProvider().sendKeys(dialog.target.server, dialog.target.pane, keys.map(key => key === "Enter" ? "enter" : key === "Escape" ? "esc" : key.toLowerCase()));
    this.clearTerminalPrompt(dialog.target);
    this.dropDialogPush(key);
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
        const pane = findPane(s, { workspace: target.workspace, tab: target.tab, pane: target.pane });
        if (!pane || (pane.agent && pane.agent !== target.source)) throw new Error("The pane changed");
        const pids = (await terminalProvider().processes(target.server, target.pane)).foregroundPids;
        if (!pids.length) throw new Error("No foreground process");
        await atomicInPrivateDir(bindingPath(target.server, target.pane), JSON.stringify({ terminal: pane.terminal_id, source: target.source,
          session: target.session, pids, workspace: target.workspace, tab: target.tab, event: String(body.event).slice(0, 64), at: new Date().toISOString() }));
        // A terminal that does not watch its agents (tmux) takes the agent's
        // status from these events.
        const status = eventStatus(body.event);
        if (status && typeof pane.terminal_id === "string") notePaneStatus(target.server, target.pane, pane.terminal_id, status);
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
        this.dialogReads.delete(JSON.stringify(target));
        const conductor = body.event === "PermissionRequest" ? conductorCall(String(body.tool || "action"), body.input) : undefined;
        const locallyWatched = this.watching.has(JSON.stringify(target)) || this.overview.has(target.server);
        // When the hold ends the request stays in the terminal. A pushed
        // notification keeps working: its binding waits for the pane's dialog
        // and then answers that, instead of going dead with the hold.
        let released = false;
        const timer = setTimeout(() => {
          released = true; this.pending.delete(action); this.rememberTerminalPrompt(target, body);
          if (this.pushedHolds.has(action)) this.releasedHolds.set(JSON.stringify(target), { action, expiresAt: this.pushedHolds.get(action)! });
          this.pushedHolds.delete(action);
          res.end("{}");
        }, APPROVAL_HOLD_MS);
        const expiresAt = new Date(Date.now() + APPROVAL_HOLD_MS).toISOString();
        const { choice, title } = permissionPrompt(String(body.tool || "action"), body.input);
        this.pending.set(action, { target, response: res, tool: String(body.tool || "action").slice(0, 200), input: body.input, title,
          message: JSON.stringify(body.input || {}, null, 2).slice(0, 32_768), ...(choice ? { choice } : {}), expiresAt, timer,
          ...(conductor ? { conductor } : {}) });
        res.on("close", () => { clearTimeout(timer); this.pending.delete(action); this.pushedHolds.delete(action); if (!released) this.dropPushBindings(action); });
        if (this.push.available) {
          const binding = randomUUID(), pushExpiresAt = Date.now() + DIALOG_PUSH_MS;
          this.pushBindings.add(binding, { action, expiresAt: pushExpiresAt });
          this.pushedHolds.set(action, pushExpiresAt);
          void this.push.notify({ binding, provider: target.source, question: body.tool === "AskUserQuestion",
            expiresAt: new Date(pushExpiresAt).toISOString() }).catch(() => false).then(delivered => {
            if (!delivered) {
              this.pushBindings.consume(binding); this.pushedHolds.delete(action);
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
    // The poll backs up the watcher. It skips while nothing is held and every
    // running Herdr server's recent snapshot shows no opencode pane; a new
    // request file still reaches the sweep through the watcher.
    this.opencodePoll = setInterval(() => {
      countTick("opencode-approvals");
      const panes = this.opencodeWatcher && !this.opencode.size ? knownPanes(OPENCODE_PANES_FRESH_MS) : undefined;
      if (panes && !panes.some(pane => pane.agent === "opencode")) return;
      this.scheduleOpencodeSweep();
    }, APPROVAL_SWEEP_MS);
    this.opencodePoll.unref?.();
    this.fanoutTimer = setInterval(() => { countTick("fanout-blocked"); void this.sweepBlockedFanouts(); }, FANOUT_SWEEP_MS);
    this.fanoutTimer.unref?.();
    // The archive sweep runs once at start so a long-dormant store clears
    // immediately, then hourly.
    void this.sweepFanoutArchive();
    this.fanoutArchiveTimer = setInterval(() => { countTick("fanout-archive"); void this.sweepFanoutArchive(); }, FANOUT_ARCHIVE_MS);
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
  // Inside Herdr only Herdr's pane counts; elsewhere a tmux pane does.
  const place = process.env.HERDR_ENV === "1" ? (process.env.HERDR_SOCKET_PATH ? herdrPaneFromEnv() : undefined) : await tmuxPaneFromEnv();
  if (!place) return;
  let input = "";
  for await (const chunk of process.stdin) { input += chunk.toString(); if (input.length > 1_048_576) return; }
  const value = object(JSON.parse(input));
  if (value.agent_id || value.agentId || value.isSidechain || value.is_sidechain) return;
  const target = targetSchema.parse({ server: place.server, workspace: place.workspace, tab: place.tab,
    pane: place.pane, source, session: value.session_id || value.sessionId });
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

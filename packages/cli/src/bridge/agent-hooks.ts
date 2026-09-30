import { defaultPhrenPath } from "../shared.js";
import { disabledHint } from "../modules/registry.js";
import { activateModules as moduleSnapshot, type ModuleSnapshot } from "../modules/runtime.js";
import { logger } from "../logger.js";
import { request, createServer, type Server } from "node:http";
import { mkdir, readFile, chmod, unlink, lstat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { atomicInPrivateDir, BridgeError, bridgeRoot, object, objects, provider, targetSchema, type Json, type Provider, type Target } from "./protocol.js";
import { findPane, knownPanes, paneForCodexSession, servers, snapshot, trustedDirectory, validateTarget } from "./herdr.js";
import { underCodexDaemon } from "./codex-daemon.js";
import { codexAutoReview } from "./codex-review-mode.js";
import { terminalPaneFromEnv, terminalProvider } from "./terminal.js";
import { readPaneText } from "./pane-text.js";
import { capturesChanges, ToolChanges } from "./changes.js";
import { phrenStoreRoot, unwrapPastedContent } from "./transcripts.js";
import { archiveFinishedFanouts, blockedFanouts, fanoutAsking } from "./fanouts.js";
import { ensureGrant, findGrant } from "./grants.js";
import { ApprovalPushService } from "./push.js";
import { approvalSummary, type RequestKind } from "./approval-summary.js";
import { computerDisplayName } from "./pair.js";
import { intervalFromEnv } from "./limits.js";
import { answerClaudeQuestionDialog, claudeQuestionDialog, type DialogAnswer, type DialogQuestion } from "./claude-question-dialog.js";
import { answeredQuestionInput, numberedDialog, opencodePermissionDialog, passwordLine, permissionPrompt, questionChoice, terminalChoice, terminalQuestions, visibleTerminalChoice,
  type TerminalChoice, type TerminalQuestion } from "./terminal-choice.js";
import { directoryNames, opencodeApprovalFile, opencodeRequest, readOpencodeRequest } from "./opencode-approvals.js";
import { allowOpencodeToolEverywhere } from "./opencode-permissions.js";
import { ApprovalWatchLeases, bindingPath, localSocket, PushBindingStore } from "./agent-hook-stores.js";
import { notePaneTranscript, paneAccountKey } from "./pane-accounts.js";
import { eventStatus, notePaneStatus, settleBlockedPane } from "./pane-status.js";
import { noteTurn as recordTurn } from "./turn-records.js";
import { countTick } from "./metrics.js";
import { briefId, briefIdInPrompt, briefLabel, DISPATCH_ID_ENV, recordBriefArrival } from "./launch-brief.js";
import { SudoBroker } from "./sudo.js";
import type { AppServerRequestId, PendingServerRequest } from "./codex-app-server.js";
import { CODEX_SERVER_ENV, codexServerId, codexServers } from "./codex-servers.js";
import { paneClient, paneKey, PaneServerWatcher, rootSession, servedPane, type PaneAsks } from "./opencode-panes.js";
import type { OpenCodeQuestion, PaneClient, PaneServerEntry } from "./opencode-pane-server.js";

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
/** How long a pushed terminal dialog can be answered from its notification. */
const DIALOG_PUSH_MS = 10 * 60_000;
const FANOUT_SWEEP_MS = 5_000;
/** How far ahead a served OpenCode pane's ask expires. OpenCode waits for as
 * long as it takes, so this is only a horizon: every listing that still
 * returns the ask (each ask event, reconnect and the Hook's 5 s tick) moves it
 * forward, and the card goes only when the ask is gone or the pane is dead. */
const SERVED_ASK_MS = 60 * 60_000;
const FANOUT_ARCHIVE_MS = 60 * 60 * 1000;

/** Where a held request's answer goes: the callback's HTTP response, or the
 * reply to a Codex app-server request (codex-servers.ts). Either takes the
 * PermissionRequest-shaped JSON; "{}" gives the request back to the terminal. */
interface HeldReply { end(body: string): unknown; readonly destroyed: boolean }
interface Pending { target: Target; response: HeldReply; tool: string; input: unknown; message: string; request: string; requestKind: RequestKind; title?: string; choice?: TerminalChoice; expiresAt: string; timer?: NodeJS.Timeout; conductor?: { action: "dispatch" | "hand_off"; project?: string; computer?: string };
  /** A server request of the Hook's own Codex app-server: answered over RPC, never held on a timer. */
  appServer?: { requestId: AppServerRequestId; answer: (result: Json) => void } }

/** The approval card's tool and input for an app-server request, in the
 * shapes `approvalSummary` and the phone already read for Codex's hook.
 * Undefined for questions (`item/tool/requestUserInput`) and MCP
 * elicitations, which stay in the pane. */
export function appServerApproval(request: PendingServerRequest): { tool: string; input: Json } | undefined {
  const params = request.params;
  const reason = typeof params.reason === "string" && params.reason ? { reason: params.reason } : {};
  if (request.method === "item/commandExecution/requestApproval") {
    return { tool: "Bash", input: { ...(typeof params.command === "string" ? { command: params.command } : {}),
      ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}), ...reason } };
  }
  if (request.method === "item/fileChange/requestApproval") {
    const changes = objects(params.changes);
    const verb = (change: Json) => object(change.kind).type === "add" ? "Add" : object(change.kind).type === "delete" ? "Delete" : "Update";
    const patch = changes.filter(change => typeof change.path === "string").map(change => `*** ${verb(change)} File: ${change.path}`).join("\n");
    return { tool: "apply_patch", input: { ...(patch ? { patch } : {}), ...(typeof params.grantRoot === "string" ? { grantRoot: params.grantRoot } : {}), ...reason } };
  }
  if (request.method === "item/permissions/requestApproval") return { tool: "Permissions", input: { permissions: params.permissions ?? {}, ...reason } };
  return undefined;
}

/** The app-server's answer for the phone's allow or deny (T3's
 * CodexSessionRuntime shapes: accept / decline, a permission grant or none). */
export function appServerDecision(request: PendingServerRequest, allow: boolean): Json {
  if (request.method === "item/permissions/requestApproval") return { permissions: allow ? object(request.params.permissions) : {}, scope: "turn" };
  return { decision: allow ? "accept" : "decline" };
}

/** What a dispatched worker's Hook tells the dispatching Hook it is waiting on:
 * a card without the request's full message or details, which can run to 32 KB
 * and cross SSH on every poll. */
export interface ForwardedApproval { actionId: string; tool: string; title?: string; request?: string; requestKind?: RequestKind; expiresAt?: string;
  /** The pane is drawing this as a terminal dialog; the answer types its keys. */
  terminal?: true; conductor?: Pending["conductor"];
  /** This Hook already pushed the request to a phone, so the dispatching Hook does not push it again. */
  pushed?: true }

/** How long a dispatching Hook's poll keeps a worker pane's permission asks held. */
const DISPATCH_LEASE_MS = 45_000;

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
interface OpencodeHeld { target?: Target; request: Json; requestLine: string; expiresAt: number; fanout?: { session: string; actionId: string };
  /** The served pane (`paneKey`) whose OpenCode server listed this ask; answered over its HTTP API. */
  served?: { key: string; server: string; pane: string } }
/** A structured question a served OpenCode pane is asking. */
interface ServedQuestion { key: string; server: string; pane: string; target?: Target; question: OpenCodeQuestion; questions: TerminalQuestion[]; at: number }

/** The decisions an OpenCode permission ask offers the phone. OpenCode's
 * `always` covers the current session, so both grant answers reply `always`;
 * `allow-everywhere` additionally writes an allow rule into the user's
 * OpenCode config. Advertised as the approval card's `options`, the same
 * shape the phone already renders for a provider-supplied option list. */
export const OPENCODE_APPROVAL_OPTIONS: Json[] = [
  { label: "Allow once", decision: "approve" },
  { label: "Allow for this project", decision: "allow-project" },
  { label: "Allow everywhere", decision: "allow-everywhere" },
  { label: "Deny", decision: "deny" },
];

/** The OpenCode permission reply a card decision maps to: both grant scopes
 * are `always`, a plain approve is `once`, a deny is `reject`. Undefined for
 * anything else. */
export function opencodePermissionReply(decision: unknown): "once" | "always" | "reject" | undefined {
  if (decision === "approve") return "once";
  if (decision === "deny") return "reject";
  if (decision === "allow-project" || decision === "allow-everywhere") return "always";
  return undefined;
}

export type DeliveryOutcome = "delivered" | "blocked" | "pending";
interface Delivery { source: Provider; session: string; settle: (outcome: DeliveryOutcome) => void; timer: ReturnType<typeof setTimeout>; late?: (outcome: DeliveryOutcome) => void }
/** A phone message the Hook answered as delivered or queued, kept under the
 * phone's delivery id so the phone can ask what became of it by that id.
 * Holds a hash of the prompt's words, never the prompt. */
interface TrackedDelivery { source: Provider; session: string; key: string; state: "queued" | "delivered" | "blocked"; at: number }
export type TrackedState = TrackedDelivery["state"] | "unknown";
/** As long as a typed prompt's own record guards it (`expectDelivery`). */
const TRACK_MS = 600_000;

/** What the agent hands its UserPromptSubmit hook is the terminal's pasted
 * form of what Phren typed; compare the words, not the wrapping. Claude Code
 * also takes each attached picture's path line out of the text and puts an
 * "[Image #N]" label at the front, so neither side keeps picture paths or
 * labels. */
function promptKey(text: string): string {
  return unwrapPastedContent(text).split("\n").filter(line => !PICTURE_PATH_LINE.test(line)).join("\n")
    .replace(/\[Image #\d+\]/g, " ").replace(/\s+/g, " ").trim();
}
const PICTURE_PATH_LINE = /^\s*\/.*\.(?:png|jpe?g|gif|webp)\s*$/i;
const trackKey = (text: string) => createHash("sha256").update(promptKey(text)).digest("hex");

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
  /** Phone messages by delivery id, until TRACK_MS: see `trackDelivery`. */
  private tracked = new Map<string, TrackedDelivery>();
  /** The permission request a conversation is drawing in its own terminal
   * because nobody was there to hold it: what the phone shows above its
   * answer keys until the pane stops waiting. `dialog` marks a choice parsed
   * from the pane's own numbered lines, whose answers gain an Enter, and
   * `questions` carries a released AskUserQuestion's normalized question set
   * with the index currently being answered. */
  private terminalPrompts = new Map<string, { tool: string; message: string; request?: string; requestKind?: RequestKind; choice?: TerminalChoice; questions?: TerminalQuestion[]; questionIndex?: number; dialog?: boolean; released?: boolean; at: number }>();
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
  /** Terminal dialogs offered to a dispatching Hook, by pane: the `dialog-` action minted for the dialog's current title. */
  private forwardedDialogs = new Map<string, { action: string; title: string; body?: string }>();
  /** Requests this Hook pushed to its own phone on behalf of a dispatched worker on another computer: action -> the answer to send back. */
  private forwardedPushes = new Map<string, (decision: "approve" | "deny") => Promise<void>>();
  /** Panes a dispatching Hook polled lately (`server\npane\nsource` -> expiry). */
  private dispatchLeases = new Map<string, number>();
  /** opencode permission asks seen on disk or listed by a served pane, by request id. */
  private opencode = new Map<string, OpencodeHeld>();
  /** Questions served OpenCode panes are asking, by question id. */
  private servedQuestions = new Map<string, ServedQuestion>();
  /** One event subscription per served OpenCode pane; ticked with the Hook. */
  readonly paneServers = new PaneServerWatcher({ asks: (entry, client, asks) => this.servedAsks(entry, client, asks), gone: key => this.servedGone(key) });
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
  /** The name the phone paired with (macOS Computer Name), for approval alerts;
   * the short host name until that lookup answers. */
  private computerName = hostname().replace(/\.local$/i, "").split(".")[0] || "Computer";
  /** sudo -A requests from askpass, answered from the phone (sudo.ts). */
  readonly sudo: SudoBroker;
  constructor(readonly push = new ApprovalPushService(), private modules?: ModuleSnapshot) {
    void computerDisplayName().then(name => { this.computerName = name; }, () => {});
    this.sudo = new SudoBroker({ computer: () => this.computerName, push, label: briefLabel,
      describe: async place => {
        const s = await snapshot(place.server);
        const pane = findPane(s, place);
        if (!pane) return undefined;
        const tab = objects(s.tabs).find(item => item.tab_id === place.tab && item.workspace_id === place.workspace);
        const workspace = objects(s.workspaces).find(item => item.workspace_id === place.workspace);
        const label = [tab?.label, workspace?.label].find(value => typeof value === "string" && value.trim()) as string | undefined;
        return { ...(typeof pane.agent === "string" ? { source: pane.agent } : {}), ...(label ? { label } : {}) };
      } });
  }
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
      const pane = target && !asking?.worktree ? findPane(await snapshot(target.server).catch(() => ({})),
        { workspace: target.workspace, tab: target.tab, pane: target.pane, source: target.source }) : undefined;
      const cwd = asking?.worktree ?? (pane ? await trustedDirectory(pane).catch(() => undefined) : undefined);
      const summary = approvalSummary({ tool: String(request.type ?? ""), input: request, message: typeof request.message === "string" ? request.message : undefined, cwd });
      // The answer route checks an action id by the parent's source: a UUID
      // for Claude and Codex, a plain token for opencode.
      const fanout = asking ? { session: match[1], actionId: asking.parent.provider === "opencode" ? randomUUID().replaceAll("-", "") : randomUUID() } : undefined;
      this.opencode.set(id, { ...(target ? { target } : {}), request, requestLine: summary.request, expiresAt, ...(fanout ? { fanout } : {}) });
      if (!this.push.available) continue;
      const binding = randomUUID();
      this.pushBindings.add(binding, { action: id, expiresAt });
      // The held request is what stops a later sweep from pushing again; a
      // failed delivery only drops the binding and leaves the card in place.
      void this.push.notify({ binding, provider: "opencode", question: false, expiresAt: String(request.expiresAt),
        ...(cwd ? { project: path.basename(cwd) } : {}), computer: this.computerName, ...summary })
        .then(delivered => { if (!delivered) this.pushBindings.dropAction(id); })
        .catch(() => {});
    }
    for (const [id, held] of this.opencode) {
      if (held.served) continue;
      if (!live.has(id) || held.expiresAt <= Date.now()) { this.opencode.delete(id); this.pushBindings.dropAction(id); }
    }
  }
  /** The pane a served OpenCode ask belongs to, as the phone names it: the
   * pane's place from its terminal, and the root of the asking session (a
   * subagent's ask shows on the conversation the pane shows). */
  private async servedTarget(entry: PaneServerEntry, client: PaneClient, session: unknown): Promise<Target | undefined> {
    if (typeof session !== "string") return undefined;
    const root = await rootSession(client, session);
    const state = await snapshot(entry.server).catch(() => undefined);
    const pane = objects(state?.panes).find(value => value.pane_id === entry.pane);
    if (!pane) return undefined;
    const parsed = targetSchema.safeParse({ server: entry.server, workspace: pane.workspace_id, tab: pane.tab_id, pane: entry.pane, source: "opencode", session: root });
    return parsed.success ? parsed.data : undefined;
  }
  /** Everything a served pane is asking right now. New asks become the same
   * cards (and pushes) as the plugin's file asks; asks no longer listed were
   * answered in the TUI or went away, and their cards go with them. */
  async servedAsks(entry: PaneServerEntry, client: PaneClient, asks: PaneAsks): Promise<void> {
    if (this.closed) return;
    const key = paneKey(entry), where = { key, server: entry.server, pane: entry.pane };
    const expiresAt = Date.now() + SERVED_ASK_MS;
    const permissions = new Set<string>();
    for (const ask of asks.permissions) {
      if (typeof ask.id !== "string" || !/^[A-Za-z0-9_]{1,200}$/.test(ask.id)) continue;
      permissions.add(ask.id);
      const known = this.opencode.get(ask.id);
      if (known) {
        if (known.served?.key === key) {
          known.expiresAt = expiresAt; known.request.expiresAt = new Date(expiresAt).toISOString();
          this.pushBindings.extendAction(ask.id, expiresAt);
        }
        continue;
      }
      const target = await this.servedTarget(entry, client, ask.sessionID).catch(() => undefined);
      if (this.closed) return;
      const type = typeof ask.permission === "string" && ask.permission ? ask.permission.slice(0, 200) : "action";
      const patterns = (Array.isArray(ask.patterns) ? ask.patterns : []).filter((value): value is string => typeof value === "string").slice(0, 32);
      const metadata = object((ask as unknown as Json).metadata);
      const detail = [patterns.join(", "), metadata.command, metadata.description, metadata.filepath, metadata.path, metadata.url]
        .find((value): value is string => typeof value === "string" && !!value);
      const message = (detail ? `${type}: ${detail}` : `opencode asks to use ${type}.`).slice(0, 2000);
      const request: Json = { id: ask.id, sessionID: ask.sessionID, type, title: `Allow ${type}?`, message, pattern: patterns,
        ...(typeof metadata.command === "string" ? { metadata: { command: metadata.command } } : {}), expiresAt: new Date(expiresAt).toISOString() };
      const summary = approvalSummary({ tool: type, input: request, message, cwd: entry.directory });
      this.opencode.set(ask.id, { ...(target ? { target } : {}), request, requestLine: summary.request, expiresAt, served: where });
      if (!this.push.available) continue;
      const binding = randomUUID();
      this.pushBindings.add(binding, { action: ask.id, expiresAt });
      void this.push.notify({ binding, provider: "opencode", question: false, expiresAt: String(request.expiresAt),
        project: path.basename(entry.directory), computer: this.computerName, ...summary })
        .then(delivered => { if (!delivered) this.pushBindings.dropAction(ask.id); })
        .catch(() => {});
    }
    for (const [id, held] of this.opencode) {
      if (held.served?.key === key && !permissions.has(id)) { this.opencode.delete(id); this.pushBindings.dropAction(id); }
    }
    const questions = new Set<string>();
    for (const ask of asks.questions) {
      if (typeof ask.id !== "string" || !/^[A-Za-z0-9_]{1,200}$/.test(ask.id)) continue;
      questions.add(ask.id);
      if (this.servedQuestions.has(ask.id)) continue;
      const raw = Array.isArray(ask.questions) ? ask.questions : [];
      // OpenCode's `multiple` is the phone's multiSelect. A set the phone
      // cannot show whole stays in the TUI.
      const mapped = terminalQuestions({ questions: raw.map(value => ({ ...object(value), multiSelect: object(value).multiple === true })) });
      if (!mapped || mapped.length !== raw.length) continue;
      const target = await this.servedTarget(entry, client, ask.sessionID).catch(() => undefined);
      if (this.closed) return;
      this.servedQuestions.set(ask.id, { ...where, ...(target ? { target } : {}), question: ask, questions: mapped, at: Date.now() });
      while (this.servedQuestions.size > 64) this.servedQuestions.delete(this.servedQuestions.keys().next().value!);
    }
    for (const [id, held] of this.servedQuestions) if (held.key === key && !questions.has(id)) this.servedQuestions.delete(id);
  }
  /** A served pane's process is gone: nothing it asked can be answered. */
  servedGone(key: string): void {
    for (const [id, held] of this.opencode) if (held.served?.key === key) { this.opencode.delete(id); this.pushBindings.dropAction(id); }
    for (const [id, held] of this.servedQuestions) if (held.key === key) this.servedQuestions.delete(id);
  }
  /** The question a served OpenCode pane is asking, in the shape the phone
   * answers Claude's AskUserQuestion with (`/v1/questions/answer`). */
  servedQuestion(target: Target): Json | undefined {
    if (target.source !== "opencode") return undefined;
    const key = JSON.stringify(target);
    const held = [...this.servedQuestions.values()].find(value => value.target && JSON.stringify(value.target) === key);
    if (!held) return undefined;
    const title = held.questions[0].question;
    return { toolName: "AskUserQuestion", actionId: held.question.id, message: title,
      request: approvalSummary({ tool: "Question", message: title, question: true }).request,
      choice: questionChoice(held.questions, 0), questions: held.questions, questionIndex: 0, at: new Date(held.at).toISOString() };
  }
  private servedClient(server: string, pane: string): PaneClient {
    const entry = servedPane(server, pane);
    if (!entry) throw new BridgeError(409, "This approval is no longer pending.");
    return paneClient(entry);
  }
  /** Answers a served pane's permission ask over its own API. */
  private async answerServed(id: string, held: OpencodeHeld, decision: unknown): Promise<void> {
    const reply = opencodePermissionReply(decision);
    if (!reply) throw new BridgeError(400, "The approval answer is not valid.");
    const served = held.served!;
    const client = this.servedClient(served.server, served.pane);
    // Everywhere writes the user's config before the pane is unblocked, so a
    // failed write leaves the ask answerable rather than half-answered.
    if (decision === "allow-everywhere") await allowOpencodeToolEverywhere(held.request.type);
    try { await client.replyPermission(id, reply); }
    catch { throw new BridgeError(409, "This approval is no longer pending."); }
    this.opencode.delete(id); this.pushBindings.dropAction(id);
  }
  /** The phone's answers to a served pane's question: the labels it chose
   * (and a typed answer) per question, for exactly the questions it shows. */
  async answerServedQuestion(target: Target, questions: DialogQuestion[], answers: DialogAnswer[]): Promise<void> {
    const key = JSON.stringify(target);
    const found = [...this.servedQuestions.entries()].find(([, value]) => value.target && JSON.stringify(value.target) === key);
    if (!found) throw new BridgeError(409, "This question is no longer pending.");
    const [id, held] = found;
    const same = held.questions.length === questions.length && held.questions.every((question, index) =>
      question.question === questions[index].question.trim()
      && question.options.length === questions[index].options.length
      && question.options.every((option, position) => option.label === questions[index].options[position].label.trim()));
    if (!same) throw new BridgeError(409, "That question has changed. Open phren to answer it.");
    await validateTarget(target);
    const labels = answers.map((answer, index) => [...answer.options.map(option => held.questions[index].options[option].label), ...(answer.text ? [answer.text] : [])]);
    try { await this.servedClient(held.server, held.pane).replyQuestion(id, labels); }
    catch { throw new BridgeError(409, "This question is no longer pending."); }
    this.servedQuestions.delete(id);
  }
  /** Keys the phone sends to a served OpenCode pane that its API answers
   * better than the terminal: Esc declines a pending question or stops a
   * working turn (`session.abort`), and a digit answers a pending
   * single-question, single-choice set. False leaves the keys to the pane. */
  async servedKeys(target: Target, keys: readonly string[], status: string): Promise<boolean> {
    if (target.source !== "opencode") return false;
    const entry = servedPane(target.server, target.pane);
    if (!entry) return false;
    const client = paneClient(entry), key = JSON.stringify(target);
    const question = [...this.servedQuestions.entries()].find(([, value]) => value.target && JSON.stringify(value.target) === key);
    const escape = keys.length > 0 && keys.every(value => value === "Escape");
    if (question && escape) {
      await client.rejectQuestion(question[0]).catch(() => { throw new BridgeError(409, "This question is no longer pending."); });
      this.servedQuestions.delete(question[0]);
      return true;
    }
    if (question && keys.length === 1 && /^[1-9]$/.test(keys[0]) && question[1].questions.length === 1 && !question[1].questions[0].multiSelect) {
      const option = question[1].questions[0].options[Number(keys[0]) - 1];
      if (!option) throw new BridgeError(400, "Choose an available answer.");
      await client.replyQuestion(question[0], [[option.label]]).catch(() => { throw new BridgeError(409, "This question is no longer pending."); });
      this.servedQuestions.delete(question[0]);
      return true;
    }
    if (escape && status === "working") {
      // A failed abort leaves Esc to the terminal, as before.
      return client.abort(target.session).then(done => done === true, () => false);
    }
    return false;
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
  expectDelivery(target: Target, text: string, waitMs = 1_500, signal?: AbortSignal): Promise<DeliveryOutcome> {
    const key = promptKey(text);
    if (!key || signal?.aborted) return Promise.resolve("pending");
    return new Promise<DeliveryOutcome>(resolve => {
      let settled = false;
      const list = this.deliveries.get(key) ?? [];
      const remove = () => {
        signal?.removeEventListener("abort", cancel);
        const current = this.deliveries.get(key) ?? []; const index = current.indexOf(delivery);
        if (index >= 0) current.splice(index, 1);
        if (!current.length) this.deliveries.delete(key);
      };
      const settle = (outcome: DeliveryOutcome) => {
        if (!settled) { settled = true; resolve(outcome); } else if (outcome !== "pending") delivery.late?.(outcome);
        if (outcome !== "pending") { clearTimeout(delivery.timer); remove(); }
      };
      const delivery: Delivery = { source: target.source, session: target.session, settle, timer: setTimeout(() => settle("pending"), waitMs) };
      // Only cancel after a provider explicitly refused before writing. A
      // possibly delivered paste keeps its guard against the wrong session.
      const cancel = () => { clearTimeout(delivery.timer); settle("pending"); remove(); };
      signal?.addEventListener("abort", cancel, { once: true });
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
  /** Remember a phone message's outcome under its delivery id. A queued one
   * is tracked only while its typed record still waits for the agent's hook,
   * so the hook's later answer always reaches it (`settleTracked`). */
  trackDelivery(id: string, target: Target, text: string, state: "queued" | "delivered"): void {
    if (state === "queued" && !this.deliveryPending(target, text)) return;
    const now = Date.now();
    for (const [key, entry] of this.tracked) if (now - entry.at > TRACK_MS) this.tracked.delete(key);
    while (this.tracked.size >= 512) this.tracked.delete(this.tracked.keys().next().value!);
    this.tracked.set(id, { source: target.source, session: target.session, key: trackKey(text), state, at: now });
  }
  /** What became of the phone message `id` sent to `target`'s conversation:
   * queued until the agent submits it, then delivered, or blocked when
   * another conversation in the pane took it. Unknown when the Hook did not
   * track it, it was for another conversation, or it is older than TRACK_MS. */
  deliveryState(id: string, target: Target): TrackedState {
    const entry = this.tracked.get(id);
    return entry && entry.source === target.source && entry.session === target.session && Date.now() - entry.at <= TRACK_MS ? entry.state : "unknown";
  }
  /** The oldest queued message tracked for `delivery`'s conversation with these words. */
  private settleTracked(delivery: Delivery, prompt: string, state: "delivered" | "blocked"): void {
    const key = trackKey(prompt);
    const entry = [...this.tracked.values()].find(item => item.state === "queued" && item.key === key && item.source === delivery.source && item.session === delivery.session);
    if (entry) entry.state = state;
  }
  /** The conversation `target` just submitted `prompt`. Nothing Phren typed
   * matches: a locally typed prompt, always allowed. Otherwise the oldest
   * matching delivery decides: its own conversation consumes it; any other
   * conversation is told to drop it, so the text is never spoken to the
   * wrong agent and the phone can safely send it again. */
  private submitted(target: Target, prompt: string): Json {
    const list = this.deliveries.get(promptKey(prompt));
    // The same words sent to two conversations at once: each one's own
    // submission settles its own record, not whichever was typed first.
    const delivery = list?.find(entry => entry.source === target.source && entry.session === target.session) ?? list?.[0];
    if (!delivery) return {};
    const own = delivery.source === target.source && delivery.session === target.session;
    this.settleTracked(delivery, prompt, own ? "delivered" : "blocked");
    if (own) { delivery.settle("delivered"); return {}; }
    delivery.settle("blocked");
    return { decision: "block", reason: "Phren sent this message to a different conversation in this pane; it was not delivered here. Send it again from the phone." };
  }
  /** The conversation's own turn events, for dispatch returns (turn-records.ts).
   * A failed write never fails the agent's callback. */
  private async recordTurn(target: Target, pane: Json, body: Json, dispatch?: string) {
    if (typeof pane.terminal_id !== "string") return;
    await recordTurn(target.server, target.pane, { event: String(body.event), terminal: pane.terminal_id, source: target.source, session: target.session,
      ...(dispatch ? { dispatch } : {}),
      ...(typeof body.background === "number" ? { background: body.background } : {}),
      ...(typeof body.reply === "string" ? { reply: body.reply } : {}) }).catch(() => undefined);
  }
  private rememberTerminalPrompt(target: Target, body: Json) {
    const tool = String(body.tool || "action").slice(0, 200);
    const questions = tool === "AskUserQuestion" ? terminalQuestions(body.input) : undefined;
    const choice = questions ? questionChoice(questions, 0) : terminalChoice(body.input);
    const summary = approvalSummary({ tool, input: body.input, question: tool === "AskUserQuestion" });
    this.terminalPrompts.set(JSON.stringify(target), { tool,
      message: JSON.stringify(body.input || {}, null, 2).slice(0, 32_768), ...(choice ? { choice } : {}),
      ...summary,
      ...(questions ? { questions, questionIndex: 0 } : {}), at: Date.now() });
    while (this.terminalPrompts.size > 64) this.terminalPrompts.delete(this.terminalPrompts.keys().next().value!);
  }
  /** The request the agent is showing in its terminal, if one fell through
   * in the last fifteen minutes; the caller only asks while the pane waits. */
  terminalPrompt(target: Target): Json | undefined {
    const key = JSON.stringify(target), entry = this.terminalPrompts.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > 900_000) { this.terminalPrompts.delete(key); return undefined; }
    return { toolName: entry.tool, message: entry.message, ...(entry.request ? { request: entry.request } : {}), ...(entry.choice ? { choice: entry.choice } : {}),
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
    // A served OpenCode pane lists its asks over its API; its screen is not read.
    if (target.source === "opencode" && servedPane(target.server, target.pane)) { if (entry) this.terminalPrompts.delete(key); return; }
    const held = [...this.pending.values()].find(p => JSON.stringify(p.target) === key);
    // A held Codex permission can already have real choices in its pane.
    // Refresh those before publishing the approval, even while it is held.
    // One the Hook's own app-server asked is answered over RPC, not in the pane.
    if (held?.appServer) return;
    if (held && target.source === "codex") {
      const now = Date.now();
      if (now - (this.dialogReads.get(key) ?? 0) < DIALOG_READ_MS) return;
      this.dialogReads.set(key, now);
      const prompt = permissionPrompt(held.tool, held.input, await this.paneLines(target));
      if ([...this.pending.values()].includes(held)) {
        held.choice = prompt.choice;
        held.title = prompt.title;
        if (held.choice) this.terminalPrompts.set(key, { tool: held.tool, message: held.message,
          request: held.request, requestKind: held.requestKind, choice: held.choice, dialog: true, at: now });
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
    const dialog = await this.screenDialog(target, text);
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
    this.terminalPrompts.set(key, { tool: "Question", message: dialog.title,
      ...approvalSummary({ tool: "Question", message: dialog.title }),
      choice: dialog, dialog: true, at: now });
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
      request: pending[1].request,
      details: pending[1].message, terminalOnly: target.source === "codex" && !pending[1].choice && !pending[1].appServer,
      ...(pending[1].choice ? { choice: pending[1].choice } : {}),
      // An app-server request waits for as long as it takes: its card never runs out.
      expiresAt: pending[1].appServer ? new Date(Math.max(Date.parse(pending[1].expiresAt), Date.now() + DIALOG_PUSH_MS)).toISOString() : pending[1].expiresAt,
      ...(pending[1].conductor ? { conductor: pending[1].conductor } : {}) };
    const own = target.source === "opencode" ? this.opencodeApproval(target) : undefined;
    if (own) return own;
    // A fan-out worker this conversation started is waiting on the owner.
    const worker = this.fanoutHeld(target)[0];
    return worker?.fanout ? { actionId: worker.fanout.actionId, toolName: worker.request.type, title: worker.request.title,
      message: worker.request.message, request: worker.requestLine, expiresAt: worker.request.expiresAt, options: OPENCODE_APPROVAL_OPTIONS } : undefined;
  }
  private opencodeApproval(target: Target): Json | undefined {
    const held = [...this.opencode.values()].find(value => !value.fanout && JSON.stringify(value.target) === JSON.stringify(target));
    if (held) return { actionId: held.request.id, toolName: held.request.type, title: held.request.title, message: held.request.message, request: held.requestLine, expiresAt: held.request.expiresAt, options: OPENCODE_APPROVAL_OPTIONS };
    const request = opencodeRequest(target.session);
    return request ? { actionId: request.id, toolName: request.type, title: request.title, message: request.message,
      request: approvalSummary({ tool: String(request.type ?? ""), input: request, message: typeof request.message === "string" ? request.message : undefined }).request,
      expiresAt: request.expiresAt, options: OPENCODE_APPROVAL_OPTIONS } : undefined;
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
    // A served OpenCode pane's permission or question, listed by its server.
    const served = [...[...this.opencode.values()].filter(held => held.served).map(held => held.target), ...[...this.servedQuestions.values()].map(held => held.target)];
    for (const at of served) {
      if (!at || at.server !== server) continue;
      if (panes.some(pane => pane.pane_id === at.pane && pane.workspace_id === at.workspace && pane.tab_id === at.tab && pane.agent === "opencode")) pending.add(at.pane);
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
    const reply = opencodePermissionReply(decision);
    if (!reply) throw new BridgeError(400, "The approval answer is not valid.");
    const file = held.fanout && opencodeApprovalFile(held.fanout.session, "answer");
    if (!held.fanout || !file || opencodeRequest(held.fanout.session)?.id !== id) throw new BridgeError(409, "This approval is no longer pending.");
    if (decision === "allow-everywhere") await allowOpencodeToolEverywhere(held.request.type);
    // The launcher reads the same approve/deny/always vocabulary the plugin does.
    await atomicInPrivateDir(file, JSON.stringify({ id, decision: decision === "approve" || decision === "deny" ? decision : "always" }));
    this.opencode.delete(id); this.pushBindings.dropAction(id);
  }
  async answer(target: Target, id: string, decision: unknown, updatedInput?: unknown) {
    // A terminal dialog offered to a dispatching Hook (`workerApproval`) or pushed: answered with the pane's own keys.
    if (id.startsWith("dialog-")) {
      const dialog = this.dialogActions.get(id);
      if (!dialog || JSON.stringify(dialog.target) !== JSON.stringify(target)) throw new BridgeError(409, "This approval is no longer pending.");
      if (updatedInput !== undefined || !["approve", "deny"].includes(String(decision))) throw new BridgeError(400, "The approval answer is not valid.");
      await this.answerDialog(id, decision as "approve" | "deny");
      this.dropForwardedDialog(JSON.stringify(target));
      return;
    }
    const worker = [...this.opencode.entries()].find(([, held]) => held.fanout?.actionId === id && JSON.stringify(held.target) === JSON.stringify(target));
    if (worker) {
      if (updatedInput !== undefined) throw new BridgeError(400, "Answers go with an approval.");
      await validateTarget(target);
      await this.answerFanout(worker[0], worker[1], decision);
      return;
    }
    const served = target.source === "opencode" ? this.opencode.get(id) : undefined;
    if (served?.served) {
      if (updatedInput !== undefined) throw new BridgeError(400, "Answers go with an approval.");
      if (!served.target || JSON.stringify(served.target) !== JSON.stringify(target)) throw new BridgeError(409, "This approval is no longer pending.");
      await validateTarget(target);
      await this.answerServed(id, served, decision);
      return;
    }
    if (target.source === "opencode") {
      const reply = opencodePermissionReply(decision);
      if (!reply) throw new BridgeError(400, "The approval answer is not valid.");
      const file = opencodeApprovalFile(target.session, "answer");
      if (!file) throw new BridgeError(400, "Invalid conversation identity.");
      await validateTarget(target);
      const request = opencodeRequest(target.session);
      if (request?.id !== id) throw new BridgeError(409, "This approval is no longer pending.");
      // Everywhere also writes the user's OpenCode config, before the plugin
      // is unblocked so a failed write leaves the ask answerable.
      if (decision === "allow-everywhere") await allowOpencodeToolEverywhere(request.type);
      await atomicInPrivateDir(file, JSON.stringify({ id, decision: decision === "approve" || decision === "deny" ? decision : "always" }));
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
    // A worker's request on another computer: the callback answers it there.
    const forwarded = this.forwardedPushes.get(linked.action);
    if (forwarded) { this.forwardedPushes.delete(linked.action); await forwarded(decision as "approve" | "deny"); return; }
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
    // A served pane's ask is answered over its own API, target or not.
    if (held?.served) { await this.answerServed(linked.action, held, decision); return; }
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
      // A served OpenCode pane's asks were pushed as its server listed them.
      if (target.source === "opencode" && servedPane(target.server, target.pane)) continue;
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
      const cwd = await trustedDirectory(pane).catch(() => undefined);
      const summary = entry.request ? { request: entry.request, requestKind: entry.requestKind ?? "other" }
        : approvalSummary({ tool: entry.tool, message: title });
      void this.push.notify({ binding, provider: target.source, question: entry.tool === "AskUserQuestion", expiresAt: new Date(expiresAt).toISOString(),
        ...(cwd ? { project: path.basename(cwd) } : {}), computer: this.computerName, ...summary })
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
    for (const key of this.forwardedDialogs.keys()) if (!waiting.has(key) && JSON.parse(key).server === server) this.dropForwardedDialog(key);
  }
  /** Keeps the held asks of these dispatched panes for the dispatching Hook's
   * next polls: without a phone, a watcher or push here, a worker's request
   * would go straight to its terminal and only its `blocked` state would
   * reach the conductor. Keyed by pane, since a worker that has not yet
   * reported a conversation has no session. */
  leaseDispatch(targets: readonly { server: string; pane: string; source: string }[]): void {
    const now = Date.now();
    for (const [key, expiry] of this.dispatchLeases) if (expiry <= now) this.dispatchLeases.delete(key);
    for (const target of targets) {
      const key = `${target.server}\n${target.pane}\n${target.source}`;
      this.dispatchLeases.delete(key);
      while (this.dispatchLeases.size >= 256) this.dispatchLeases.delete(this.dispatchLeases.keys().next().value!);
      this.dispatchLeases.set(key, now + DISPATCH_LEASE_MS);
    }
  }
  private dispatchLeased(target: Target): boolean {
    return (this.dispatchLeases.get(`${target.server}\n${target.pane}\n${target.source}`) ?? 0) > Date.now();
  }
  private dropForwardedDialog(key: string) {
    const forwarded = this.forwardedDialogs.get(key);
    if (!forwarded) return;
    this.forwardedDialogs.delete(key);
    if (this.dialogPushes.get(key)?.action !== forwarded.action) this.dialogActions.delete(forwarded.action);
  }
  /** What this pane's worker is waiting on, for the dispatching Hook: the held
   * or app-server request, else the terminal dialog the pane draws (offered
   * under a `dialog-` action the answer route accepts). */
  workerApproval(target: Target): ForwardedApproval | undefined {
    const clip = (value: unknown, max: number) => typeof value === "string" && value ? value.slice(0, max) : undefined;
    const held = this.approval(target);
    if (held) {
      const actionId = String(held.actionId), pending = this.pending.get(actionId);
      const pushed = pending ? this.pushedHolds.has(actionId) || (!!pending.appServer && this.push.available) : this.push.available;
      const title = clip(held.title, 200), request = clip(held.request, 500), expiresAt = clip(held.expiresAt, 40);
      const conductor = held.conductor as Pending["conductor"] | undefined;
      return { actionId, tool: clip(held.toolName, 200) ?? "action", ...(title ? { title } : {}), ...(request ? { request } : {}),
        ...(pending ? { requestKind: pending.requestKind } : {}), ...(expiresAt ? { expiresAt } : {}), ...(conductor ? { conductor } : {}), ...(pushed ? { pushed: true as const } : {}) };
    }
    const key = JSON.stringify(target), entry = this.terminalPrompts.get(key);
    const title = entry && (entry.dialog || entry.released) ? entry.choice?.title : undefined;
    if (!entry?.choice || !title) return undefined;
    const pushedDialog = this.dialogPushes.get(key);
    // A dialog is the same one only with the same title and command: Claude and Codex share generic titles.
    const pushedAction = pushedDialog && this.dialogActions.get(pushedDialog.action);
    let action = pushedDialog?.title === title && pushedAction && pushedAction.choice.body === entry.choice.body ? pushedDialog.action : undefined;
    if (!action) {
      const known = this.forwardedDialogs.get(key);
      if (known?.title === title && known.body === entry.choice.body && (this.dialogActions.get(known.action)?.expiresAt ?? 0) > Date.now()) action = known.action;
      else {
        this.dropForwardedDialog(key);
        while (this.forwardedDialogs.size >= 64) this.dropForwardedDialog(this.forwardedDialogs.keys().next().value!);
        action = `dialog-${randomUUID()}`;
        this.forwardedDialogs.set(key, { action, title, body: entry.choice.body });
        this.dialogActions.set(action, { target, choice: entry.choice, expiresAt: Date.now() + DIALOG_PUSH_MS });
      }
    }
    const request = clip(entry.request ?? approvalSummary({ tool: entry.tool, message: title }).request, 500);
    return { actionId: action, tool: entry.tool.slice(0, 200), title: title.slice(0, 200), ...(request ? { request } : {}),
      ...(entry.requestKind ? { requestKind: entry.requestKind } : {}),
      expiresAt: new Date(this.dialogActions.get(action)!.expiresAt).toISOString(), terminal: true,
      ...(pushedDialog?.action === action ? { pushed: true as const } : {}) };
  }
  /** A worker's request on another computer, sent to this Hook's own phone:
   * the notification's answer calls `answer`, which sends it back over the
   * dispatch path. */
  pushForwarded(summary: { provider: string; computer: string; project?: string; request: string; requestKind?: RequestKind },
    answer: (decision: "approve" | "deny") => Promise<void>): void {
    if (!this.push.available || this.closed) return;
    const action = `forward-${randomUUID()}`, binding = randomUUID(), expiresAt = Date.now() + DIALOG_PUSH_MS;
    while (this.forwardedPushes.size >= 64) {
      const oldest = this.forwardedPushes.keys().next().value!;
      this.forwardedPushes.delete(oldest); this.dropPushBindings(oldest);
    }
    this.forwardedPushes.set(action, answer);
    this.pushBindings.add(binding, { action, expiresAt });
    const drop = () => { this.forwardedPushes.delete(action); this.dropPushBindings(action); };
    void this.push.notify({ binding, provider: summary.provider, question: false, expiresAt: new Date(expiresAt).toISOString(),
      ...(summary.project ? { project: summary.project } : {}), computer: summary.computer, request: summary.request,
      ...(summary.requestKind ? { requestKind: summary.requestKind } : {}) })
      .then(delivered => { if (!delivered) drop(); }).catch(drop);
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
  /** The dialog a pane's screen shows now. Codex draws "> 1. Yes, proceed (y)"
   * rows and Copilot a boxed select with a cursor row, both answered by moving
   * to a row; OpenCode's prompt is one row of options whose cursor is only a
   * color; the other fallbacks number rows without a key in the label. */
  private async screenDialog(target: Target, text: string) {
    return ["codex", "copilot"].includes(target.source) ? visibleTerminalChoice(text)
      : target.source === "opencode" ? opencodePermissionDialog(await this.paneAnsi(target))?.choice ?? numberedDialog(text)
      : numberedDialog(text);
  }
  /** Approve picks the dialog's yes/allow row (else its first), Deny its
   * no/deny row (else Escape), typed as the pane's own keys. */
  private async answerDialog(action: string, decision: "approve" | "deny") {
    const dialog = this.dialogActions.get(action);
    if (!dialog || dialog.expiresAt <= Date.now()) throw new BridgeError(409, "This approval is no longer pending.");
    // Claimed before any await: a second answer for the same dialog gets a 409 instead of typing the keys twice.
    this.dialogActions.delete(action);
    const key = JSON.stringify(dialog.target);
    try { await validateTarget(dialog.target, false, true); } catch (error) {
      if (!this.dialogActions.has(action)) this.dialogActions.set(action, dialog);
      throw error;
    }
    // Read the screen now, not the activity tick's cached prompt: in the seconds
    // since that tick the dialog may have been answered and replaced by another
    // with the same title, and the keys must only ever answer the one forwarded.
    const live = await this.screenDialog(dialog.target, await this.paneLines(dialog.target));
    if (!live || live.title !== dialog.choice.title || live.body !== dialog.choice.body) { this.dropDialogPush(key); throw new BridgeError(409, "That question in the terminal has changed. Open phren to answer it."); }
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
  /** A server request from one of the Hook's own Codex app-servers: an
   * approval card like a held PermissionRequest, pushed the same way, but
   * with no hold timer. The request stays parked in Codex until someone
   * answers it, here or in the pane's TUI (`codexResolved`). */
  codexRequest(target: Target, request: PendingServerRequest, answer: (result: Json) => void): void {
    const shown = appServerApproval(request);
    if (!shown || this.closed) return;
    // Replayed after a reconnect: the card stays, answered through the new connection.
    const known = [...this.pending.values()].find(entry => entry.appServer?.requestId === request.requestId && JSON.stringify(entry.target) === JSON.stringify(target));
    if (known?.appServer) { known.appServer.answer = answer; return; }
    const action = randomUUID();
    const held = { requestId: request.requestId, answer };
    const reply = { destroyed: false, end(body: string) {
      if (reply.destroyed) return;
      reply.destroyed = true;
      // "{}" gives the request back to the pane: it stays parked in Codex.
      const behavior = object(object(object((() => { try { return JSON.parse(body); } catch { return {}; } })()).hookSpecificOutput).decision).behavior;
      if (behavior === "allow" || behavior === "deny") held.answer(appServerDecision(request, behavior === "allow"));
    } };
    const cwd = typeof request.params.cwd === "string" && path.isAbsolute(request.params.cwd) ? request.params.cwd : undefined;
    const summary = approvalSummary({ tool: shown.tool, input: shown.input, cwd });
    const expiresAt = Date.now() + DIALOG_PUSH_MS;
    this.pending.set(action, { target, response: reply, tool: shown.tool, input: shown.input, message: JSON.stringify(shown.input, null, 2).slice(0, 32_768),
      ...summary, expiresAt: new Date(expiresAt).toISOString(), appServer: held });
    while (this.pending.size > 64) this.pending.delete(this.pending.keys().next().value!);
    if (!this.push.available) return;
    const binding = randomUUID();
    this.pushBindings.add(binding, { action, expiresAt });
    void this.push.notify({ binding, provider: "codex", question: false, expiresAt: new Date(expiresAt).toISOString(),
      ...(cwd ? { project: path.basename(cwd) } : {}), computer: this.computerName, ...summary })
      .then(delivered => { if (!delivered) this.pushBindings.consume(binding); }).catch(() => {});
  }
  /** Another client (the pane's TUI) answered the request, or this one declined it. */
  codexResolved(target: Target, requestId: AppServerRequestId): void {
    for (const [action, entry] of this.pending) {
      if (entry.appServer?.requestId !== requestId || JSON.stringify(entry.target) !== JSON.stringify(target)) continue;
      this.pending.delete(action); this.dropPushBindings(action);
      (entry.response as { destroyed: boolean }).destroyed = true;
      settleBlockedPane(target.server, target.pane, 0);
    }
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
        if (req.method === "POST" && req.url === "/sudo") { await this.sudo.handle(req, res); return; }
        if (req.method !== "POST" || req.url !== "/hook") throw new Error("Invalid callback");
        let size = 0; const chunks: Buffer[] = [];
        for await (const bytes of req) { size += bytes.length; if (size > 1_048_576) throw new Error("Oversized hook"); chunks.push(bytes); }
        const body = object(JSON.parse(Buffer.concat(chunks).toString()));
        let target = targetSchema.parse(body.target);
        if (this.modules?.has("git") === false && ["PreToolUse", "PostToolUse"].includes(String(body.event))) {
          res.statusCode = 404; res.end(JSON.stringify({ error: disabledHint("git") })); return;
        }
        // A callback Codex's app-server daemon ran names the pane that started
        // the daemon, not the conversation's. Place it by the conversation the
        // Hook proves each pane shows, and never record a binding from it.
        const daemon = body.daemon === true;
        if (daemon) {
          if (target.source !== "codex") throw new Error("Invalid callback");
          const placed = await paneForCodexSession(target.server, target.session, typeof body.cwd === "string" && path.isAbsolute(body.cwd) ? body.cwd : undefined);
          if (!placed) { res.end("{}"); return; }
          target = targetSchema.parse({ ...target, workspace: placed.workspace_id, tab: placed.tab_id, pane: placed.pane_id });
        }
        const s = await snapshot(target.server);
        const pane = findPane(s, { workspace: target.workspace, tab: target.tab, pane: target.pane });
        if (!pane || (pane.agent && pane.agent !== target.source)) throw new Error("The pane changed");
        const pids = (await terminalProvider().processes(target.server, target.pane)).foregroundPids;
        if (!pids.length) throw new Error("No foreground process");
        if (!daemon && target.source === "claude") notePaneTranscript(paneAccountKey(target.server, target.pane), body.transcript, String(pane.terminal_id ?? ""));
        if (!daemon) await atomicInPrivateDir(bindingPath(target.server, target.pane), JSON.stringify({ terminal: pane.terminal_id, source: target.source,
          session: target.session, pids, workspace: target.workspace, tab: target.tab, event: String(body.event).slice(0, 64), at: new Date().toISOString() }));
        // A terminal that does not watch its agents (tmux) takes the agent's
        // status from these events.
        // Codex's automatic reviewer decides this request on its own: it is
        // not a question for the owner, so nothing is held, pushed or
        // remembered and the pane is not marked blocked. If Codex hands the
        // request back to the owner it draws its approval dialog, which the
        // waiting-pane dialog read picks up and pushes like any other.
        const autoReview = body.event === "PermissionRequest" && target.source === "codex" && body.autoReview === true;
        const status = autoReview ? undefined : eventStatus(body.event);
        if (status && typeof pane.terminal_id === "string") notePaneStatus(target.server, target.pane, pane.terminal_id, status);
        // What a shell call changed on disk: snapshot before, diff after.
        const input = typeof body.input === "string" ? { patch: body.input } : object(body.input), command = [input.command, input.cmd].find(v => typeof v === "string") as string | undefined;
        // A shell call by name, or any tool whose input is a command line —
        // Codex has renamed its shell tool more than once.
        // A launched brief's receipt: the worker's own hook names its dispatch
        // id (from its environment, or the brief path in its first prompt when
        // Codex's shared daemon ran the hook with another pane's variables).
        let dispatch: string | undefined;
        if (body.event === "SessionStart" || body.event === "UserPromptSubmit") {
          const named = !daemon && briefId.safeParse(body.dispatchId).success ? String(body.dispatchId) : undefined;
          dispatch = named ?? (typeof body.prompt === "string" ? briefIdInPrompt(body.prompt) : undefined);
          if (dispatch) await recordBriefArrival(dispatch, String(body.event), target).catch(() => undefined);
        }
        // `/new` or `/resume` in a pane on the Hook's own Codex server: follow
        // the TUI to its new thread. Only a callback trusted to name its pane.
        if (body.event === "SessionStart" && target.source === "codex" && !daemon) codexServers.follow(target.server, target.pane, target.session);
        if (body.event === "PreCompact") { this.startCompacting(target); res.end("{}"); return; }
        if (["SessionStart", "UserPromptSubmit", "Stop"].includes(String(body.event))) this.stopCompacting(target);
        if (body.event === "UserPromptSubmit") {
          const answer = typeof body.prompt === "string" ? this.submitted(target, body.prompt.slice(0, 65_536)) : {};
          // A prompt refused here never starts a turn in this conversation.
          if (answer.decision !== "block") await this.recordTurn(target, pane, body, dispatch);
          res.end(JSON.stringify(answer)); return;
        }
        if (body.event === "SessionStart" || body.event === "Stop") await this.recordTurn(target, pane, body, dispatch);
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
            const grant = await findGrant({
              action: conductor.action, project: conductor.project, computer: conductor.computer,
            }).catch(() => undefined);
            if (grant) {
              res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }));
              return;
            }
          }
        }
        if (autoReview) { res.end("{}"); return; }
        // A thread on the Hook's own Codex app-server: the request reaches
        // this Hook as a server request with no time limit, so the callback
        // lets Codex ask for it at once instead of holding a second card.
        if (body.event === "PermissionRequest" && target.source === "codex" && codexServers.forThread(target.session)) { res.end("{}"); return; }
        if (body.event !== "PermissionRequest" || target.source === "copilot"
          || (!this.watching.has(JSON.stringify(target)) && !this.overview.has(target.server) && !this.push.available && !this.dispatchLeased(target))) {
          if (body.event === "PermissionRequest") this.rememberTerminalPrompt(target, body);
          res.end("{}"); return;
        }
        // A foreground watcher or configured push device can hold the callback.
        // Timeouts always return control to the ordinary terminal prompt.
        if (this.pending.size >= 64) { res.end("{}"); return; }
        const action = randomUUID();
        this.dialogReads.delete(JSON.stringify(target));
        const conductor = body.event === "PermissionRequest" ? conductorCall(String(body.tool || "action"), body.input) : undefined;
        const locallyWatched = this.watching.has(JSON.stringify(target)) || this.overview.has(target.server) || this.dispatchLeased(target);
        const cwd = typeof body.cwd === "string" && path.isAbsolute(body.cwd) ? body.cwd : await trustedDirectory(pane).catch(() => undefined);
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
        const summary = approvalSummary({ tool: String(body.tool || "action"), input: body.input, cwd, question: body.tool === "AskUserQuestion" });
        this.pending.set(action, { target, response: res, tool: String(body.tool || "action").slice(0, 200), input: body.input, title,
          message: JSON.stringify(body.input || {}, null, 2).slice(0, 32_768), ...summary, ...(choice ? { choice } : {}), expiresAt, timer,
          ...(conductor ? { conductor } : {}) });
        res.on("close", () => { clearTimeout(timer); this.pending.delete(action); this.pushedHolds.delete(action); if (!released) this.dropPushBindings(action); });
        if (this.push.available) {
          const binding = randomUUID(), pushExpiresAt = Date.now() + DIALOG_PUSH_MS;
          this.pushBindings.add(binding, { action, expiresAt: pushExpiresAt });
          this.pushedHolds.set(action, pushExpiresAt);
          void this.push.notify({ binding, provider: target.source, question: body.tool === "AskUserQuestion",
            expiresAt: new Date(pushExpiresAt).toISOString(), ...(cwd ? { project: path.basename(cwd) } : {}), computer: this.computerName, ...summary }).catch(() => false).then(delivered => {
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
    this.paneServers.tick();
  }
  close() {
    this.closed = true;
    this.sudo.close();
    void this.changes.close().catch(() => {});
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.response.end("{}"); }
    this.pending.clear(); this.server?.close(); this.server?.closeAllConnections();
    this.pushBindings.clear();
    this.opencode.clear(); this.forwardedPushes.clear();
    this.paneServers.close(); this.servedQuestions.clear();
    if (this.opencodeDebounce) clearTimeout(this.opencodeDebounce);
    if (this.opencodePoll) clearInterval(this.opencodePoll);
    this.opencodeWatcher?.close(); this.opencodeWatcher = undefined;
    if (this.fanoutTimer) clearInterval(this.fanoutTimer);
    if (this.fanoutArchiveTimer) clearInterval(this.fanoutArchiveTimer);
    this.fanoutSeen.clear();
  }
}

/** What a Stop payload says about the turn it ends: the harness's last
 * assistant message (Claude, Codex) and, from Claude Code, the background
 * tasks still in flight, which will wake the conversation again when they
 * finish. Absent fields are left out, so the Hook falls back to the transcript. */
export function stopFacts(value: Json): { background?: number; reply?: string } {
  const tasks = Array.isArray(value.background_tasks)
    ? value.background_tasks.filter(task => !["completed", "failed", "killed", "stopped"].includes(String(object(task).status))) : undefined;
  return { ...(tasks ? { background: tasks.length } : {}),
    ...(typeof value.last_assistant_message === "string" && value.last_assistant_message.trim() ? { reply: value.last_assistant_message.slice(0, 16_384) } : {}) };
}

export async function agentHook(source: Provider) {
  provider.parse(source);
  // A missing helper must never prevent the coding agent from running.
  // Inside Herdr only Herdr's pane counts; elsewhere a tmux pane does.
  const place = await terminalPaneFromEnv();
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
  // Codex 0.157 runs hooks inside its shared app-server daemon, whose pane
  // variables belong to whichever pane first started it.
  // The Hook's own per-pane app-server (codex-servers.ts) runs its hooks
  // with that pane's variables, so they are trusted like a pane's own.
  const ownServer = source === "codex" && codexServerId.safeParse(process.env[CODEX_SERVER_ENV]).success;
  const daemon = source === "codex" && !ownServer && await underCodexDaemon().catch(() => false);
  // Codex asks this hook before its automatic reviewer: say when that
  // reviewer, not the owner, will decide.
  const autoReview = source === "codex" && event === "PermissionRequest" && await codexAutoReview(value.transcript_path);
  // A worker the Hook launched with its brief carries that dispatch's id. A
  // daemon's variables belong to another pane, so it sends none.
  const dispatchId = !daemon && (event === "SessionStart" || event === "UserPromptSubmit") && briefId.safeParse(process.env[DISPATCH_ID_ENV]).success
    ? process.env[DISPATCH_ID_ENV] : undefined;
  const data = JSON.stringify({ target, event, ...(daemon ? { daemon: true } : {}), ...(autoReview ? { autoReview: true } : {}), ...(dispatchId ? { dispatchId } : {}),
    ...(source === "claude" && typeof value.transcript_path === "string" ? { transcript: value.transcript_path.slice(0, 4096) } : {}),
    tool: value.tool_name, input: value.tool_input, toolUseId: value.tool_use_id, cwd: value.cwd,
    ...(event === "UserPromptSubmit" && typeof value.prompt === "string" ? { prompt: value.prompt.slice(0, 65_536) } : {}),
    ...(event === "Stop" ? stopFacts(value) : {}) });
  await new Promise<void>(resolve => {
    const req = request({ socketPath: localSocket(), path: "/hook", method: "POST", timeout: event === "PermissionRequest" ? 58_000 : event.endsWith("ToolUse") ? 8_000 : 12_000,
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

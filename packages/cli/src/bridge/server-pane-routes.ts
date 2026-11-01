import { checkpointRoute } from "./checkpoints.js";
import { turnQueueRoute, type TurnQueue } from "./turn-queue.js";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { EXPECTED_REPOSITORY_REQUIRED, isGitWriteRoute, type GitWriteDiagnostics } from "./git-write-policy.js";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { AgentHooks } from "./agent-hooks.js";
import { TURN_ENDED_WITHOUT_IT, type DeliveryOutcome } from "./prompt-deliveries.js";
import { claudeSubagentView } from "./claude-suggestion.js";
import type { DialogAnswer, DialogQuestion } from "./claude-question-dialog.js";
import { gitBranches, gitDiscard, gitLog, gitPulls, gitShow, gitStage, gitStatus, gitTree, gitUnstage } from "./git.js";
import { fanoutWorktrees } from "./fanouts.js";
import { gitWorktrees, resolveWorktree, type WorktreeWorker } from "./git-worktrees.js";
import { previewWorktreeRemoval, removeWorktree, type WorktreeRemovalLiveSession } from "./git-worktree-remove.js";
import { gitCommit, gitHostToken, gitMergeRequest, gitPullRequest, gitPush } from "./git-publish.js";
import { gitCheckout, gitFetch, gitPull } from "./git-sync.js";
import { gitApply, gitFile, sessionChanges } from "./git-review.js";
import { findPane, paneAgentName, paneChatState, paneIdentity, serversStrict, snapshot, startingPane, trustedDirectory, validateStartingTarget, validateTarget } from "./herdr.js";
import { agentNotReady, terminalProvider } from "./terminal.js";
import { AppServerRpcError } from "./codex-app-server.js";
import { CodexServerUnavailable, codexServers } from "./codex-servers.js";
import { refuseWorkingSlash, type ModelSwitcher } from "./model-switch.js";
import { PERMISSION_MODE_VALUES, refuseAgentOrigin, type PermissionModeSwitcher } from "./permission-mode.js";
import type { SettingsSwitcher } from "./settings-switch.js";
import { sessionWebServers } from "./session-servers.js";
import { type PromptGuards, takesPrompt } from "./session-activity.js";
import { gitRoot, repositoryDiff, withGitReadDeadline } from "./projects.js";
import { BridgeError, type Json, MAX_FRAME, object, objects, serverName, startingTargetSchema, type Target, targetSchema } from "./protocol.js";
import type { CodexQuestions } from "./questions.js";
import { childAgent, childAgentTree, conversationNamedPaths, targetTranscriptPath, type ChildAgentRelation } from "./transcripts.js";
import { sideQuestionText, type SideQuestions } from "./side-questions.js";
import { saveUpload } from "./uploads.js";
import { writeRepoFile } from "./file-write.js";
import { fileSearchSchema, listRepositoryFiles, searchRepository } from "./file-search.js";
import { deliveryIdSchema, PromptOnce, promptScope } from "./prompt-once.js";
import { promptWithStartupRetry } from "./prompt-startup.js";
import { sendServedPrompt, servedPane } from "./opencode-panes.js";
import { claudeSuggestionShown } from "./claude-suggestion.js";
import { claudeQueueAction, transcriptTail } from "./claude-queue.js";

/** Routes that act on one pane's conversation: prompts, answer keys, typed
 * secrets, uploads, diffs, git, approvals and questions. A starting pane (no
 * conversation yet) takes keys, a secret or a first prompt. */

export interface PaneRouteContext {
  turnQueue?: TurnQueue;
  gitWrites?: GitWriteDiagnostics;
  agentHooks: AgentHooks;
  modelSwitcher: ModelSwitcher;
  settingsSwitcher: SettingsSwitcher;
  permissionModeSwitcher: PermissionModeSwitcher;
  codexQuestions: CodexQuestions;
  sideQuestions: SideQuestions;
}

export /** A file from the phone: a plain name and base64 bytes, bounded. */
function uploadBody(data: Json): { name: string; bytes: Buffer } {
  const name = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_ .()-]{0,199}$/).refine(n => !n.includes("..")).parse(data.name);
  const encoded = z.string().max(11_184_812).regex(/^[A-Za-z0-9+/]*={0,2}$/).parse(data.data);
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > MAX_FRAME) throw new BridgeError(413, "The file is empty or too large.");
  return { name, bytes };
}

/** The repository a git route acts on: the pane's trusted directory, a
 * spawned child's own worktree exactly as /v1/diff resolves it, or one of the
 * pane repository's other worktrees as `/v1/git/worktrees` lists it. */
export async function gitRepository(pane: Json, target: Target, child: unknown, worktree?: unknown): Promise<string> {
  const id = z.string().regex(/^[a-f0-9]{32}$/).optional().parse(child);
  if (worktree !== undefined && worktree !== null) {
    if (id !== undefined) throw new BridgeError(400, "Choose a child agent or a worktree, not both.");
    return resolveWorktree(await trustedDirectory(pane), worktree);
  }
  if (id !== undefined) {
    const relation = childAgent(await childAgentTree(target.source, target.session), id);
    if (!relation) throw new BridgeError(404, "That agent is not part of this conversation.");
    if (!relation.cwd) throw new BridgeError(409, "This agent has no recorded checkout. Its parent repository cannot be substituted.");
    return trustedDirectory({ cwd: relation.cwd });
  }
  return trustedDirectory(pane);
}

/** Who might be editing each worktree: this conversation's agents with a
 * checkout of their own (so the phone can open that agent), then every
 * fan-out manifest by its recorded worktree. Best effort; a missing
 * transcript or manifest only leaves a worktree unlabelled. */
async function worktreeWorkers(target: Target): Promise<WorktreeWorker[]> {
  const workers: WorktreeWorker[] = [];
  const visit = (nodes: ChildAgentRelation[]) => {
    for (const node of nodes) {
      if (node.remote === undefined && node.cwd) workers.push({ cwd: node.cwd, label: node.path, provider: node.provider, child: node.id, state: node.state });
      visit(node.children);
    }
  };
  visit(await childAgentTree(target.source, target.session).catch(() => []));
  for (const job of await fanoutWorktrees().catch(() => [])) workers.push({ cwd: job.worktree, label: job.label, provider: job.provider, state: job.state });
  workers.push(...herdrWorktreeWorkers(await snapshot(target.server).catch((): Json => ({}))));
  return workers;
}

/** Agents running in this Herdr server's panes, by the folder each works in:
 * an agent launched into a new worktree from the phone is named here. Listed
 * last, so a sub-agent or fan-out manifest for the same folder wins a tie. */
export function herdrWorktreeWorkers(s: Json): WorktreeWorker[] {
  const workers: WorktreeWorker[] = [];
  for (const pane of objects(s.panes)) {
    const cwd = pane.foreground_cwd || pane.cwd;
    if (typeof pane.agent !== "string" || typeof cwd !== "string" || !path.isAbsolute(cwd)) continue;
    const name = paneAgentName(s, pane);
    workers.push({ cwd, label: name || pane.agent, provider: pane.agent,
      ...(typeof pane.agent_status === "string" ? { state: pane.agent_status } : {}) });
  }
  return workers;
}

/** Every live pane on a server with the folder it is running in, for a
 * worktree-removal preview's session check. */
function paneSessions(s: Json): WorktreeRemovalLiveSession[] {
  const sessions: WorktreeRemovalLiveSession[] = [];
  for (const pane of objects(s.panes)) {
    const cwd = typeof pane.foreground_cwd === "string" ? pane.foreground_cwd : pane.cwd;
    if (typeof cwd !== "string" || !cwd) {
      throw new BridgeError(503, "Could not determine a live pane's directory.", { code: "worktree-session-check-failed" });
    }
    const label = [pane.title, pane.label, paneAgentName(s, pane)].find(value => typeof value === "string" && value) as string | undefined;
    sessions.push({ pane: String(pane.pane_id), title: label || String(pane.pane_id), cwd });
  }
  return sessions;
}

/** A snapshot of a server that has stopped since discovery has no panes; any
 * other failure leaves session discovery incomplete and must fail the request. */
function stoppedServer(error: unknown): boolean {
  if (!(error instanceof BridgeError)) return false;
  const code = String(error.details?.code ?? "");
  return code === "herdr-not-running" || code === "herdr-stale-socket" || code === "not_running";
}

/** Every live pane on every running terminal server, including the requesting
 * one even when discovery left it out. A server that cannot be read, or any
 * discovery failure, fails the request: removal is never allowed on an
 * incomplete session check. */
async function allPaneSessions(requested: string[] = []): Promise<WorktreeRemovalLiveSession[]> {
  const running = await serversStrict();
  const names = [...new Set([...requested, ...running.map(server => String(server.session)).filter(Boolean)])];
  const snapshots = await Promise.all(names.map(async (name): Promise<Json> => {
    try { return await snapshot(name); }
    catch (error) { if (stoppedServer(error)) return { panes: [] }; throw error; }
  }));
  return snapshots.flatMap(paneSessions);
}

/** The pane a worktree-removal request names: the full target when the app
 * sends one, else the contract's optional server/pane pair. With no pane the
 * Hook's own folder stands in. */
async function worktreeRemovalContext(data: Json): Promise<{ cwd: string; paneRoot?: string; sessions: WorktreeRemovalLiveSession[] }> {
  const target = targetSchema.safeParse(data.target);
  if (target.success) {
    const pane = await validateTarget(target.data);
    const cwd = await trustedDirectory(pane);
    return { cwd, paneRoot: await gitRoot(cwd), sessions: await allPaneSessions([target.data.server]) };
  }
  const server = serverName.parse(typeof data.server === "string" && data.server ? data.server : "default");
  const paneId = z.string().min(1).max(200).optional().parse(data.pane);
  if (paneId === undefined) {
    // No pane names the repository, so the Hook's own folder does; every
    // session on every running server is still checked for one inside it.
    const cwd = process.cwd();
    return { cwd, paneRoot: await gitRoot(cwd), sessions: await allPaneSessions([server]) };
  }
  const s = await snapshot(server);
  const pane = objects(s.panes).find(item => item.pane_id === paneId);
  if (!pane) throw new BridgeError(404, "That pane is not running on this computer.");
  const cwd = await trustedDirectory(pane);
  return { cwd, paneRoot: await gitRoot(cwd), sessions: await allPaneSessions([server]) };
}

/** The phone can press these and nothing else; never a typed string.
 * `AltUp` is Codex's "edit/answer the last queued follow-up": it opens the
 * queue, after which the option key (or typed text) is the answer. */
const ANSWER_KEYS = ["Escape", "Enter", "Up", "Down", "Tab", "AltUp", "y", "n", "p", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
const HERDR_KEYS: Partial<Record<(typeof ANSWER_KEYS)[number], string>> = { Escape: "esc", Enter: "enter", Up: "up", Down: "down", Tab: "tab", AltUp: "alt+Up" };

// A question or label may wrap onto several lines; the pane shows them joined.
const questionText = z.string().trim().min(1).max(4000).refine(t => !/[\x00-\x08\x0b-\x1f\x7f]/.test(t));
const claudeQuestionBody = z.object({
  questions: z.array(z.object({ question: questionText, multiSelect: z.boolean().optional(), options: z.array(questionText).min(1).max(8) })).min(1).max(8),
  answers: z.array(z.object({ optionIndexes: z.array(z.number().int().nonnegative()).max(8),
    text: z.string().max(1000).refine(t => !/[\x00-\x1f\x7f]/.test(t)).optional() })).min(1).max(8),
});
/** The phone's answer to Claude's AskUserQuestion: one answer per question,
 * a single option or a typed answer for a single-select question, any
 * options plus an optional typed answer for a multi-select one. */
function claudeQuestionAnswer(data: unknown): { questions: DialogQuestion[]; answers: DialogAnswer[] } {
  const body = claudeQuestionBody.parse(data);
  if (body.answers.length !== body.questions.length) throw new BridgeError(400, "Answer every question.");
  const answers = body.answers.map((answer, index) => {
    const question = body.questions[index], options = [...new Set(answer.optionIndexes)], text = answer.text?.trim() ?? "";
    if (options.some(option => option >= question.options.length)) throw new BridgeError(400, "Choose an available answer.");
    if (question.multiSelect ? !options.length && !text : options.length + (text ? 1 : 0) !== 1) {
      throw new BridgeError(400, question.multiSelect ? "Choose at least one answer." : "Choose one answer for each question.");
    }
    return { options, ...(text ? { text } : {}) };
  });
  return { questions: body.questions.map(q => ({ question: q.question, multiSelect: q.multiSelect, options: q.options.map(label => ({ label })) })), answers };
}

/** A secret typed into a terminal prompt: printable, bounded, never logged. */
const secretText = z.string().min(1).max(256).refine(t => !/[\x00-\x1f\x7f]/.test(t));

/** What `takesPrompt` checks before typing into a Claude pane Herdr reads working: nothing structured
 * pending there and no dialog on its screen. */
export function promptGuards(agentHooks: Pick<AgentHooks, "approval" | "terminalPrompt" | "servedQuestion">, target: Target): PromptGuards {
  return { held: () => !!(agentHooks.approval(target) || agentHooks.terminalPrompt(target) || agentHooks.servedQuestion(target)),
    screen: () => terminalProvider().readScreen(target.server, target.pane, { scope: "pane", source: "visible", lines: 40, format: "ansi", timeoutMs: 2_000 }) };
}

/** Whether a hand-off would relay the Claude pane's own prompt suggestion: the dim guess at the owner's next message
 * that Claude draws in its empty input box. Read as plain text it looks like an owner message left unsent, Enter does
 * not submit it, and a conductor watching panes relayed three of them as the owner's words, one a merge instruction
 * the owner never gave (2026-10-18). An unreadable screen does not refuse. */
async function relaysSuggestion(target: Target, text: string): Promise<boolean> {
  let screen = "";
  try { screen = await terminalProvider().readScreen(target.server, target.pane, { scope: "pane", source: "visible", lines: 40, format: "ansi", timeoutMs: 2_000 }); } catch { return false; }
  const shown = claudeSuggestionShown(screen);
  // Case is kept (file and branch names differ by it); a leading voice marker says nothing about who wrote the words.
  const plain = (value: string) => value.replace(/\s+/g, " ").trim().replace(/^\[voice\]\s*/i, "");
  if (shown === undefined) return false;
  // A narrow pane cuts a long suggestion with "…": its visible part, with or without the mark, is all a screen read shows.
  const words = plain(text), cut = shown.endsWith("…") ? plain(shown.slice(0, -1)) : undefined;
  return words === plain(shown) || (cut !== undefined && (words === cut || words === `${cut}…` || words === `${cut} …`));
}

/** Herdr answered the request with a refusal (a 409 carrying its own error code): it performed nothing. */
const herdrRefused = (error: unknown) => error instanceof BridgeError && error.status === 409 && typeof error.details?.herdrCode === "string";

/** An idle agent that has not taken typed text within the first wait
 * likely lost the Enter while it redrew (an update notice, a resize): the
 * text sits in its input line. Press Enter once more and wait again. A
 * pane that turned working took it; one still idle is reported unsubmitted,
 * so the phone shows the message as not sent instead of waiting forever. */
async function resubmitIfIdle(agentHooks: AgentHooks, target: Target, text: string): Promise<DeliveryOutcome | "unsubmitted"> {
  const status = async () => { try { return String(findPane(await snapshot(target.server), target)?.agent_status ?? "unknown"); } catch { return "unknown"; } };
  // A pane that turned working started a turn: its UserPromptSubmit is on its way (the agent runs its
  // other hooks too). Wait for it rather than answering "queued" for a message the agent took.
  if (await status() === "working") return await agentHooks.deliveries.awaitLate(target, text);
  const late = agentHooks.deliveries.awaitLate(target, text);
  await terminalProvider().sendKeys(target.server, target.pane, ["enter"]);
  const outcome = await late;
  if (outcome !== "pending") return outcome;
  return await status() === "working" ? "pending" : "unsubmitted";
}

/** A Claude pane showing a subagent's view (its empty input reads "Message
 * @<agent>…") takes typed text for that subagent, so a phone message never
 * reached the turn and failed when it ended (owner, 2026-10-21). Escape returns
 * to the main view. It is pressed once, only while that view shows: in the main
 * view Escape would interrupt the turn, so a view still showing after it is left
 * as it is and logged. True when the view was left. */
export async function leaveClaudeSubagentView(agentHooks: Pick<AgentHooks, "paneAnsi">, target: Target, waitMs = 250): Promise<boolean> {
  if (target.source !== "claude") return false;
  const shows = async () => {
    let screen: string | undefined;
    try { screen = await agentHooks.paneAnsi?.(target); } catch { screen = undefined; }
    return screen !== undefined && claudeSubagentView(screen);
  };
  if (!await shows()) return false;
  process.stderr.write(`phren hook: ${target.server}:${target.pane} shows a subagent view; Escape back to the conversation before typing\n`);
  await terminalProvider().sendKeys(target.server, target.pane, ["esc"]);
  await sleep(waitMs);
  if (!await shows()) return true;
  process.stderr.write(`phren hook: ${target.server}:${target.pane} still shows a subagent view after Escape; not pressing it again\n`);
  return false;
}

/** A phone message the turn ended without, in a Claude pane that now shows a
 * subagent's view (opened while the message waited): leave the view and type
 * it again under the same delivery id, once. Any other outcome, a changed
 * pane, or ten minutes end the watch. */
export function retryAfterSubagentView(agentHooks: AgentHooks, target: Target, terminal: unknown, text: string, id: string,
  intervalMs = 2_000, limitMs = 600_000, escapeWaitMs = 250): void {
  const started = Date.now();
  const look = async () => {
    if (Date.now() - started > limitMs) return;
    const status = agentHooks.deliveries.status(id, target);
    if (status.state !== "failed") { if (status.state !== "delivered") schedule(); return; }
    if (status.reason !== TURN_ENDED_WITHOUT_IT) return;
    // The same conversation, as the route checks it: a /clear or /resume in the
    // same terminal is another conversation, never given the old message.
    // A refusal (409: the conversation changed or the pane went) ends the watch;
    // a look that failed for now (a timeout) or an agent busy again waits.
    let pane: Json | undefined;
    try { pane = await validateTarget(target, true, true); } catch (error) {
      if (error instanceof BridgeError && error.status === 409) return;
      schedule(); return;
    }
    if (!pane || pane.terminal_id !== terminal) return;
    if (!["idle", "done"].includes(String(pane.agent_status))) { schedule(); return; }
    if (!await leaveClaudeSubagentView(agentHooks, target, escapeWaitMs)) return;
    // Checked again with nothing awaited before the record is replaced: a retry
    // from the phone may have delivered it meanwhile.
    const now = agentHooks.deliveries.status(id, target);
    if (now.state !== "failed" || now.reason !== TURN_ENDED_WITHOUT_IT) return;
    process.stderr.write(`phren hook: retrying phone message ${id} in the conversation after leaving the subagent view\n`);
    const expected = agentHooks.deliveries.expect(target, text, 1_500, undefined, id, typeof terminal === "string" ? terminal : undefined);
    await terminalProvider().prompt(target.server, target.pane, text);
    if (await expected === "pending") await resubmitIfIdle(agentHooks, target, text);
  };
  const schedule = () => { const timer = setTimeout(() => void look().catch(() => undefined), intervalMs); timer.unref?.(); };
  schedule();
}

/** A busy Claude Code queues typed text on Enter, but after a long paste
 * ("paste again to expand") it can swallow that Enter and leave the text in
 * its input line, where it stays after the turn ends. Follow the pane: once
 * it has stayed finished for two looks while the prompt is still unsubmitted,
 * press Enter once. A closed or replaced pane, a delivery the conversation
 * took, or ten minutes end the watch; a pane asking for input is never answered. */
export function followQueuedDelivery(agentHooks: AgentHooks, target: Target, terminal: unknown, text: string, intervalMs = 2_000): void {
  const started = Date.now();
  let finishedLooks = 0;
  const look = async () => {
    if (!agentHooks.deliveries.pending(target, text) || Date.now() - started > 600_000) return;
    let pane: Json | undefined;
    try { pane = findPane(await snapshot(target.server), target); } catch { pane = undefined; }
    if (!pane) { schedule(); return; }
    if (pane.terminal_id !== terminal) return;
    const status = String(pane.agent_status);
    finishedLooks = status === "idle" || status === "done" ? finishedLooks + 1 : 0;
    if (finishedLooks >= 2) { await resubmitIfIdle(agentHooks, target, text).catch(() => undefined); return; }
    schedule();
  };
  const schedule = () => { const timer = setTimeout(() => void look(), intervalMs); timer.unref?.(); };
  schedule();
}

/** A fresh Claude Code that took its first prompt starts working. One that
 * stays idle kept the brief in its input line (a long paste can swallow the
 * Enter): press Enter once, only while it is idle, so a dialog is never
 * answered. False when it still has not started. */
async function submitStartingPrompt(server: string, target: { workspace: string; tab: string; pane: string }, terminal: unknown, looks = 4, intervalMs = 500): Promise<boolean> {
  const status = async () => {
    try { const pane = findPane(await snapshot(server), target); return pane && pane.terminal_id === terminal ? String(pane.agent_status) : "gone"; }
    catch { return "unknown"; }
  };
  const settled = async () => {
    for (let look = 0; look < looks; look++) {
      await sleep(intervalMs);
      const current = await status();
      if (current !== "idle" && current !== "done") return current;
    }
    return "idle";
  };
  const first = await settled();
  if (first !== "idle") return first !== "gone";
  await terminalProvider().sendKeys(server, target.pane, ["enter"]);
  const second = await settled();
  return second !== "idle" && second !== "gone";
}

/** One key per character; Herdr's send_keys takes single characters and named
 * keys only, and a tty password read is corrupted by a bracketed paste. */
function secretKeys(text: string): string[] {
  return [...text].map(character => character === " " ? "space" : character);
}

/** Type a secret, then submit it. A chunk that may already have reached the
 * terminal is never resent; the phone is told to check it by hand. */
async function typeSecret(server: string, pane: string, text: string): Promise<void> {
  const keys = secretKeys(text);
  let sent = false;
  for (let index = 0; index < keys.length; index += 32) {
    try {
      await terminalProvider().sendKeys(server, pane, keys.slice(index, index + 32));
      sent = true;
    } catch (error) {
      if (sent) throw new BridgeError(502, "The password may have been typed only partly; check the terminal.");
      throw error;
    }
  }
  try {
    await terminalProvider().sendKeys(server, pane, ["enter"]);
  } catch (error) {
    if (sent) throw new BridgeError(502, "The password may have been typed only partly; check the terminal.");
    throw error;
  }
}

const promptOnce = new PromptOnce();

/** A prompt for an OpenCode pane the Hook started with its own server: sent
 * over that API into the conversation the TUI shows (a new one, shown first,
 * when it has none) and confirmed by the user turn appearing there. Undefined
 * when the pane has no server entry, the text is a slash command (the TUI's
 * own menus), or nothing reached OpenCode; the caller then types it. */
async function servedPrompt(target: { server: string; pane: string; source: string }, session: string | undefined, text: string, typing: () => void | Promise<void>): Promise<Json | undefined> {
  if (target.source !== "opencode" || text.trim().startsWith("/")) return undefined;
  const entry = servedPane(target.server, target.pane);
  if (!entry) return undefined;
  await typing();
  const sent = await sendServedPrompt(entry, session, text);
  if (!sent.sent) return undefined;
  return sent.delivered ? { ok: true, delivered: true } : { ok: true, deliveryUncertain: true };
}

/** A known message's reply by its id: `state` plus the legacy flags. */
function deliveryReply(agentHooks: AgentHooks, id: string, target: Json, text: string): Json | undefined {
  const parsed = targetSchema.safeParse(target);
  if (!parsed.success) return undefined;
  if (!agentHooks.deliveries.sameMessage(id, parsed.data, text)) throw new BridgeError(409, "This message id was already used for a different message.");
  const status = agentHooks.deliveries.status(id, parsed.data);
  if (status.state === "unknown") return undefined;
  return { ok: status.state !== "failed", state: status.state, ...(status.state === "delivered" ? { delivered: true } : {}),
    ...(status.state === "queued" ? { queued: true } : {}), ...(status.reason ? { reason: status.reason } : {}) };
}

export async function paneRoute(ctx: PaneRouteContext, url: URL, data: Json, response: ServerResponse, headers: IncomingHttpHeaders = {}): Promise<unknown> {
  if (url.pathname === "/v1/prompt/after-turn" || url.pathname.startsWith("/v1/prompt/after-turn/")) {
    if (!ctx.turnQueue) throw new BridgeError(404, "This Hook has no after-turn queue.");
    return turnQueueRoute(ctx.turnQueue, url.pathname, data);
  }
  if (isGitWriteRoute(url.pathname) && data.expectedRepository === undefined) {
    ctx.gitWrites?.record(url.pathname, headers);
    if (EXPECTED_REPOSITORY_REQUIRED) throw new BridgeError(400, "This app is too old to change Git safely. Update it.", { code: "expected-repository-required" });
  }
  if (["/v1/diff", "/v1/git/status", "/v1/git/worktrees"].includes(url.pathname)) {
    return withGitReadDeadline(() => paneRouteOnce(ctx, url, data, response, () => {}));
  }
  if (url.pathname !== "/v1/prompt") return paneRouteOnce(ctx, url, data, response, () => {});
  // A retried send carries its first attempt's id; the Hook answers it with
  // that attempt's reply instead of typing the message a second time.
  const id = deliveryIdSchema.parse(data.deliveryId);
  const scope = promptScope(object(data.target), String(data.text ?? ""));
  // The Hook keeps each message's state by its id (prompt-deliveries.ts), so
  // a retry, even after a Hook restart, answers with where the message is
  // now. Only a failed one is typed again, under the same id.
  const known = id ? deliveryReply(ctx.agentHooks, id, object(data.target), String(data.text ?? "")) : undefined;
  if (known && known.state !== "failed") return { ...known, replayed: true };
  if (known) promptOnce.forget(id!);
  return promptOnce.run(id, scope, async typing => object(await paneRouteOnce(ctx, url, data, response, typing)));
}

export async function paneRouteOnce(ctx: PaneRouteContext, url: URL, data: Json, response: ServerResponse, typing: () => void | Promise<void>): Promise<unknown> {
  const { agentHooks, modelSwitcher, settingsSwitcher, permissionModeSwitcher, codexQuestions, sideQuestions } = ctx;
  let result: unknown;
  if (url.pathname === "/v1/git/worktrees/remove/preview" || url.pathname === "/v1/git/worktrees/remove") {
    const worktree = z.string().max(64).parse(data.worktree);
    const { cwd, paneRoot, sessions } = await worktreeRemovalContext(data);
    if (url.pathname.endsWith("/preview")) result = await previewWorktreeRemoval(cwd, worktree, { paneRoot, sessions });
    else result = await removeWorktree(cwd, worktree, z.string().min(1).max(128).parse(data.token), { paneRoot, sessions });
  } else if (url.pathname === "/v1/keys" && object(data.target).starting === true) {
    // A folder-trust or login prompt comes before the agent has a
    // conversation; the phone answers it on the starting binding.
    const target = startingTargetSchema.parse(data.target);
    const pane = await startingPane(target);
    const keys = z.array(z.enum(ANSWER_KEYS)).min(1).max(4).parse(data.keys);
    if (!["blocked", "waiting", "unknown"].includes(String(pane.agent_status))) throw new BridgeError(409, "This agent is not waiting for an answer.");
    await terminalProvider().sendKeys(target.server, target.pane, keys.map(key => HERDR_KEYS[key] ?? key));
    result = { ok: true };
  } else if (url.pathname === "/v1/secret" && object(data.target).starting === true) {
    // A password the terminal is reading before the agent has a
    // conversation is typed the same way as one after it.
    const target = startingTargetSchema.parse(data.target);
    const pane = await startingPane(target);
    const text = secretText.parse(data.text);
    if (!["blocked", "waiting", "unknown"].includes(String(pane.agent_status))) throw new BridgeError(409, "This agent is not waiting for an answer.");
    await typeSecret(target.server, target.pane, text);
    result = { ok: true };
  } else if (url.pathname === "/v1/prompt" && object(data.target).starting === true) {
    const target = startingTargetSchema.parse(data.target);
    const pane = await validateStartingTarget(target);
    if (typeof pane.startingSession === "string") {
      const resolved = { ...target, session: pane.startingSession };
      modelSwitcher.assertAvailable(resolved); settingsSwitcher.assertAvailable(resolved); sideQuestions.assertAvailable(resolved);
    }
    const text = z.string().min(1).max(32768).refine(t => !/[\x00-\x08\x0b-\x1f\x7f]/.test(t)).parse(data.text);
    refuseWorkingSlash(pane, text);
    const served = await servedPrompt(target, undefined, text, typing);
    if (served) return served;
    await typing();
    await promptWithStartupRetry(() => terminalProvider().prompt(target.server, target.pane, text), async () => {
      const current = await validateStartingTarget(target);
      if (current.terminal_id !== pane.terminal_id) throw new BridgeError(409, "This agent pane changed. Reopen the chat.");
      if (typeof current.startingSession === "string") {
        const resolved = { ...target, session: current.startingSession };
        modelSwitcher.assertAvailable(resolved); settingsSwitcher.assertAvailable(resolved); sideQuestions.assertAvailable(resolved);
      }
      refuseWorkingSlash(current, text);
    });
    // A dispatched worker's brief is often long enough for Claude Code to
    // swallow the Enter; a slash command opens a menu an Enter would answer.
    const submitted = target.source !== "claude" || text.trim().startsWith("/")
      || await submitStartingPrompt(target.server, target, pane.terminal_id);
    if (!submitted) result = { ok: true, deliveryUncertain: true, unsubmitted: true };
    else {
      // A first prompt may create its transcript immediately. Recheck the
      // terminal/process binding, not the absence of a session. Never retry.
      let confirmed = false;
      try {
        const current = findPane(await snapshot(target.server), target);
        confirmed = !!current && current.terminal_id === pane.terminal_id && (await paneChatState(target.server, current)).startingToken === target.startingToken;
      } catch { /* Already delivered; an uncertain reply must not resend. */ }
      result = { ok: true, ...(!confirmed ? { deliveryUncertain: true } : {}) };
    }
  } else {
  const target = targetSchema.parse(data.target);
  // Uploads store bytes without answering or interrupting the agent.
  // They still require fresh identity, just like prompt mutations.
  const sendsInput = ["/v1/prompt", "/v1/prompt/queue", "/v1/keys", "/v1/secret", "/v1/model", "/v1/settings", "/v1/agents/permission-mode"].includes(url.pathname);
  if (sendsInput) { modelSwitcher.assertAvailable(target); settingsSwitcher.assertAvailable(target); permissionModeSwitcher.assertAvailable(target); sideQuestions.assertAvailable(target); }
  // A key press is how a prompt the agent draws in its terminal gets
  // answered, so keys are the one input allowed while the agent is
  // blocked or waiting; the status check below is theirs alone.
  const pane = await validateTarget(target, false, sendsInput || url.pathname === "/v1/upload");
  if (sendsInput) { modelSwitcher.assertAvailable(target); settingsSwitcher.assertAvailable(target); permissionModeSwitcher.assertAvailable(target); sideQuestions.assertAvailable(target); }
  if (url.pathname === "/v1/prompt") {
    // A waiting agent takes typed text only when nothing structured
    // is pending there: an approval the Hook holds or saw, or a
    // status Herdr cannot read. Otherwise the answer keys are the way.
    const status = String(pane.agent_status);
    // A Claude lead waiting on its background agents takes a prompt though Herdr reads it working (`takesPrompt`).
    if (data.hookQueued === true && !await takesPrompt(target.server, pane, target.session, promptGuards(agentHooks, target))) throw new BridgeError(409, "The worker is busy; the hand-off remains queued.", { code: "hand-off-busy" });
    if (data.hookQueued === true && target.source === "claude" && typeof data.text === "string" && await relaysSuggestion(target, data.text)) {
      throw new BridgeError(409, "That text is Claude's own suggested next prompt, drawn dim in the agent's empty input box. The owner did not send it, so it was not typed.", { code: "prompt-suggestion" });
    }
    if (status === "unknown" || (["blocked", "waiting"].includes(status) && (agentHooks.approval(target) || agentHooks.terminalPrompt(target) || agentHooks.servedQuestion(target)))) {
      throw new BridgeError(409, "This agent needs input in the terminal first.");
    }
    const text = typeof data.text === "string" && data.text && data.text.length <= 32768 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(data.text) ? data.text : undefined;
    const served = text === undefined ? undefined : await servedPrompt(target, target.session, text, typing);
    if (served?.delivered && text) agentHooks.deliveries.delivered(deliveryIdSchema.parse(data.deliveryId), target, text);
    if (served) return served;
  }
  if (url.pathname === "/v1/prompt") {
    const text = z.string().min(1).max(32768).refine(t => !/[\x00-\x08\x0b-\x1f\x7f]/.test(t)).parse(data.text);
    // Herdr types into the pane; the agent that receives the text
    // confirms or refuses it through its UserPromptSubmit hook, by
    // conversation. That is the binding Herdr's own API lacks.
    // A working agent queues typed text and submits it when its turn
    // ends, which can be minutes away; waiting for that only delays
    // the phone. The record still guards the paste for ten minutes.
    // Claude Code is the exception: it takes a message typed mid-turn at
    // once and runs UserPromptSubmit about a third of a second later, so a
    // busy Claude gets the idle wait and the phone a confirmed delivery.
    refuseWorkingSlash(pane, text, target.source);
    if (sideQuestionText(target.source, text) !== undefined) {
      // Claude's `/btw` runs beside the turn and never reaches the transcript:
      // the Hook reads its panel and the answer arrives as a side-answer frame.
      await typing();
      return { ok: true, delivered: true, sideQuestion: await sideQuestions.ask(target, pane, text) };
    }
    if (target.source === "codex" && /^\s*\/model\s+\S/i.test(text)) throw new BridgeError(422, "Use the model picker to switch Codex models.");
    // A Codex pane on the Hook's own app-server takes the prompt on its
    // thread, as the TUI takes Enter: steered into a running turn, else a new
    // turn; nothing is typed. The turn id only says Codex has it: the model
    // reads it at its next step, possibly after a long tool call, and Codex's
    // UserPromptSubmit says when. Until then it is queued, like typed text. A slash
    // command is the TUI's own and is still typed. An unreachable server
    // sent nothing, so the pane is typed into instead; a request that may
    // have reached it is reported uncertain and never retried.
    const owned = text.trim().startsWith("/") ? undefined : codexServers.forTarget(target);
    if (owned) {
      await typing();
      const id = deliveryIdSchema.parse(data.deliveryId), refused = new AbortController();
      // An idle thread starts the turn and confirms in about two seconds; a
      // running one takes the text only after its current step.
      const taken = agentHooks.deliveries.expect(target, text, owned.activeTurn ? 300 : 4_000, refused.signal, id, typeof pane.terminal_id === "string" ? pane.terminal_id : undefined);
      try {
        const { turnId } = await codexServers.send(owned, text);
        if (await taken === "delivered") return { ok: true, delivered: true, state: "delivered", turnId };
        if (id) agentHooks.deliveries.queue(id, target);
        return { ok: true, queued: true, ...(id ? { state: "queued" } : {}), turnId };
      } catch (error) {
        if (error instanceof AppServerRpcError) { refused.abort(); throw new BridgeError(409, `Codex refused the message: ${error.message}`, { promptNotSent: true }); }
        if (error instanceof CodexServerUnavailable) refused.abort();
        else { if (id) agentHooks.deliveries.queue(id, target); return { ok: true, deliveryUncertain: true, ...(id ? { state: "queued" } : {}) }; }
      }
    }
    const deliveryId = deliveryIdSchema.parse(data.deliveryId);
    let busy = String(pane.agent_status) === "working";
    let outcome: DeliveryOutcome | "unsubmitted" = await promptWithStartupRetry(async () => {
      const refused = new AbortController();
      const expected = agentHooks.deliveries.expect(target, text, busy && target.source !== "claude" ? 300 : 1_500, refused.signal, deliveryId,
        typeof pane.terminal_id === "string" ? pane.terminal_id : undefined);
      let typed = false;
      try {
        await typing(); typed = true;
        await leaveClaudeSubagentView(agentHooks, target);
        await terminalProvider().prompt(target.server, target.pane, text);
      } catch (error) {
        // Nothing reached the pane: the reservation failed first, the agent was not ready, or Herdr refused the
        // request (its `agent.prompt` is one call). The record goes, or it would hold the pane's hand-offs.
        if (!typed || agentNotReady(error) || herdrRefused(error)) refused.abort();
        if (agentNotReady(error) || herdrRefused(error)) {
          const refusal = error as BridgeError;
          throw new BridgeError(refusal.status, refusal.message, { ...refusal.details, promptNotSent: true });
        }
        throw error;
      }
      return expected;
    }, async () => {
      // The same conversation can move to another terminal instance. A
      // retry must retain both bindings and all input reservations.
      const current = await validateTarget(target, true, true);
      if (current.terminal_id !== pane.terminal_id) throw new BridgeError(409, "This agent pane changed. Reopen the chat.");
      modelSwitcher.assertAvailable(target); settingsSwitcher.assertAvailable(target); sideQuestions.assertAvailable(target);
      refuseWorkingSlash(current, text, target.source);
      busy = String(current.agent_status) === "working";
    }, data.hookQueued === true ? 0 : 20_000);
    // Only Claude confirms plain prompts through its hook, and a slash
    // command opens a menu that a second Enter would answer.
    if (outcome === "pending" && target.source === "claude" && !text.trim().startsWith("/")) {
      if (!busy) outcome = await resubmitIfIdle(agentHooks, target, text);
      else followQueuedDelivery(agentHooks, target, pane.terminal_id, text);
    }
    if (deliveryId && target.source === "claude" && outcome !== "delivered") retryAfterSubagentView(agentHooks, target, pane.terminal_id, text, deliveryId);
    // A bare slash command opens the agent's own menu; the phone may
    // walk it with keys for the next half minute. The command rides
    // along so a Codex /permissions walk can find its confirmation.
    if (/^\/[a-z][a-z0-9_-]*$/i.test(text.trim())) agentHooks.menuOpened(target, text.trim());
    if (outcome === "delivered") result = { ok: true, delivered: true, state: "delivered" };
    else if (outcome === "unsubmitted") {
      const reason = "The agent did not take the message; it may still be in its input line.";
      if (deliveryId) agentHooks.deliveries.fail(deliveryId, target, reason);
      result = { ok: true, deliveryUncertain: true, unsubmitted: true, ...(deliveryId ? { state: "failed", reason } : {}) };
    } else {
      // The agent has not submitted it yet: a busy agent holds typed input
      // until its turn ends. The record is bound to the pane, so whichever
      // conversation is there then takes it, and the Hook fails it loudly if
      // the agent closes, restarts or ends its turn without it. A failed
      // identity probe still says deliveryUncertain to phones without
      // `paneDeliveries`. Never retried here.
      let confirmed = false;
      try {
        const current = findPane(await snapshot(target.server), target);
        confirmed = !!current && current.terminal_id === pane.terminal_id && await paneIdentity(target.server, current, true) === target.session;
      } catch { /* No reliable post-delivery identity. */ }
      // The hook can take it while the identity probe runs.
      const late = deliveryId ? agentHooks.deliveries.status(deliveryId, target).state : "unknown";
      if (late === "delivered") result = { ok: true, delivered: true, state: "delivered" };
      else {
        if (deliveryId) agentHooks.deliveries.queue(deliveryId, target);
        result = { ok: true, ...(!confirmed ? { deliveryUncertain: true } : { queued: true }), ...(deliveryId ? { state: "queued" } : {}) };
      }
    }
  } else if (url.pathname === "/v1/prompt/status") {
    // Asked by the phone's own delivery id, so no text is matched again.
    const id = deliveryIdSchema.parse(data.deliveryId);
    if (!id) throw new BridgeError(400, "Name the message by its deliveryId.");
    // Bound to the pane: the conversation that took it may be a newer one.
    result = { ok: true, ...agentHooks.deliveries.status(id, target) };
  } else if (url.pathname === "/v1/prompt/queue") {
    // The messages a busy agent holds in its own queue: sent to the running
    // turn now, or withdrawn unsent. Only Claude Code's queue can be reached;
    // a pane the Hook types into for any other harness has none it can act on.
    // The owner's words: an agent may not send or discard another pane's queue.
    if (data && typeof data === "object" && "origin" in data) throw new BridgeError(403, "Only the owner sends or cancels queued messages, from the phone.");
    const action = z.enum(["send-now", "withdraw"]).parse(data.action);
    if (target.source !== "claude") throw new BridgeError(409, "Only Claude Code's queued messages can be sent now or withdrawn.", { code: "queue-unsupported" });
    const guards = promptGuards(agentHooks, target);
    const transcript = await targetTranscriptPath(target);
    result = await claudeQueueAction(action, String(pane.agent_status), { held: guards.held!, screen: guards.screen!,
      transcript: () => transcriptTail(transcript), sendKeys: keys => terminalProvider().sendKeys(target.server, target.pane, keys), sleep: ms => sleep(ms) });
  } else if (url.pathname === "/v1/side-question/dismiss") {
    result = sideQuestions.dismiss(target, z.string().uuid().parse(data.id));
  } else if (url.pathname === "/v1/model") {
    result = await modelSwitcher.switch(target, data);
  } else if (url.pathname === "/v1/settings") {
    result = await settingsSwitcher.switch(target, data);
  } else if (url.pathname === "/v1/agents/permission-mode") {
    // The owner's own choice from the phone: no authority ceiling applies.
    // An agent's call carries its pane as `origin` and is refused, so no
    // agent can raise its own or another pane's mode past its ceiling.
    refuseAgentOrigin(data && typeof data === "object" && "origin" in data ? data.origin ?? null : undefined);
    result = await permissionModeSwitcher.set(target, z.enum(PERMISSION_MODE_VALUES).parse(data.mode));
  } else if (url.pathname === "/v1/keys" && await agentHooks.servedKeys(target, z.array(z.enum(ANSWER_KEYS)).min(1).max(4).parse(data.keys), String(pane.agent_status))) {
    // A served OpenCode pane: Esc aborts its turn or declines its question,
    // a digit answers its question, over its own API.
    result = { ok: true };
  } else if (url.pathname === "/v1/keys") {
    const keys = z.array(z.enum(ANSWER_KEYS)).min(1).max(4).parse(data.keys);
    const status = String(pane.agent_status), menu = agentHooks.menuOpen(target);
    // A prompt the Hook itself saw go by (a permission request it could
    // not hold) is being answered even when Herdr reads the pane as
    // working or idle; Herdr's status lags the agent's own dialog.
    const holding = menu || !!agentHooks.terminalPrompt(target);
    // Esc on a question the Hook still holds declines it at once, whatever
    // Herdr reads the pane as: an esc typed into the held pane does nothing.
    const cancelled = keys.every(key => key === "Escape") && agentHooks.cancelHeldQuestion(target);
    // Escape interrupts a working agent. Everything else answers a
    // prompt the agent is holding: a menu, a y/n, a trust question.
    if (!cancelled && !holding && (keys.every(key => key === "Escape") ? !["working", "blocked", "waiting", "unknown"].includes(status)
      : !["blocked", "waiting", "unknown"].includes(status))) throw new BridgeError(409, keys.every(key => key === "Escape") ? "This agent is no longer working." : "This agent is not waiting for an answer.");
    // Esc on a working Codex pane the Hook runs on its own app-server:
    // decline the thread's parked requests, then interrupt the turn.
    const owned = !cancelled && !holding && keys.every(key => key === "Escape") ? codexServers.forTarget(target) : undefined;
    if (cancelled) {
      result = { ok: true };
    } else if (owned && await codexServers.interrupt(owned).catch(() => false)) {
      agentHooks.clearTerminalPrompt(target);
      result = { ok: true, interrupted: true };
    // An older phone answers a released AskUserQuestion one question at
    // a time with its digits; the Hook walks that question in the pane
    // and submits the set after the last.
    } else if (await agentHooks.answerReleasedQuestion(target, keys)) {
      result = { ok: true };
    } else {
      // Keyless choices move and verify the highlight before Enter;
      // the phone sends the option identifier through the same route.
      const answerKeys = await agentHooks.dialogAnswerKeys(target, keys);
      await terminalProvider().sendKeys(target.server, target.pane, answerKeys.map(key => HERDR_KEYS[key] ?? key));
      // A remembered prompt is answered by any key but a cursor move; the
      // menu window stays open through Enter because some choices (Codex
      // full access) open a second confirmation the Hook now walks itself.
      if (keys.some(key => key !== "Up" && key !== "Down" && key !== "Tab")) { agentHooks.clearTerminalPrompt(target); agentHooks.releaseChoice(target); }
      if (keys.includes("Escape")) agentHooks.menuClosed(target);
      // Enter on Codex's /permissions menu may open "Enable full access?".
      // Watch the pane's lines for it, answer its visible option, and only
      // then close the window; a prompt that never arrives is reported as
      // still waiting with the visible text for the phone's question card.
      if (answerKeys.includes("Enter") && menu && target.source === "codex"
        && (agentHooks.menuCommand(target) ?? "").toLowerCase() === "/permissions") {
        const walk = await agentHooks.walkMenuConfirmation(target);
        result = { ok: true, ...(walk.menuClosed ? { menuClosed: true } : {}),
          ...(walk.waiting ? { waiting: walk.waiting } : {}) };
      } else result = { ok: true };
    }
  } else if (url.pathname === "/v1/secret") {
    // A password the terminal is reading (sudo, a login) cannot be
    // pasted: bracketed paste corrupts a tty read, so it is typed a
    // character at a time. The Hook never logs, echoes or stores it.
    const text = secretText.parse(data.text);
    if (!["blocked", "waiting", "unknown"].includes(String(pane.agent_status))) throw new BridgeError(409, "This agent is not waiting for an answer.");
    await typeSecret(target.server, target.pane, text);
    agentHooks.clearTerminalPrompt(target);
    result = { ok: true };
  } else if (url.pathname === "/v1/upload") {
    const { name, bytes } = uploadBody(data);
    result = { ok: true, path: await saveUpload(target.session, name, bytes) };
  } else if (url.pathname === "/v1/web-servers/session") {
    // This session's own servers only; the machine-wide list is /v1/web-servers.
    result = await sessionWebServers(target, pane);
  } else if (url.pathname === "/v1/diff") {
    const child = z.string().regex(/^[a-f0-9]{32}$/).optional().parse(data.child);
    if (data.worktree !== undefined) {
      // Another worktree of the pane's repository: the whole checkout.
      result = await repositoryDiff(await gitRepository(pane, target, data.child, data.worktree), [], []);
    } else if (child !== undefined) {
      result = await repositoryDiff(await gitRepository(pane, target, child), [], []);
    } else {
      const cwd = await trustedDirectory(pane), paths = z.array(z.string().max(4096)).max(24).optional().parse(data.paths) ?? [];
      const abort = new AbortController();
      response.once("close", () => { if (!response.writableEnded) abort.abort(); });
      const allowed = paths.length ? await agentHooks.changes.recordedPaths(`${target.source}:${target.session}`) : [];
      if (paths.length) {
        try { allowed.push(...await conversationNamedPaths(await targetTranscriptPath(target), target.source, cwd, abort.signal)); }
        catch { abort.signal.throwIfAborted(); /* Missing transcripts grant no extra paths; recorded scope still works. */ }
      }
      result = await repositoryDiff(cwd, paths, allowed);
    }
  }
  else if (url.pathname === "/v1/files/write") {
    // The desktop editor's save, inside the pane's repository (or a child's worktree).
    const cwd = await gitRepository(pane, target, data.child, data.worktree);
    const repository = await gitRoot(cwd);
    if (!repository) throw new BridgeError(409, "This pane is not in a project repository.");
    result = await writeRepoFile(repository, z.string().max(4096).parse(data.path), z.string().parse(data.content),
      data.version === undefined ? undefined : z.string().max(200).parse(data.version));
  }
  else if (url.pathname === "/v1/files/list") {
    // Every file path in the repository, for the desktop editor's quick open.
    const repository = await gitRoot(await gitRepository(pane, target, data.child, data.worktree));
    if (!repository) throw new BridgeError(409, "This pane is not in a project repository.");
    result = await listRepositoryFiles(repository);
  }
  else if (url.pathname === "/v1/files/search") {
    // The desktop editor's find in files, over the same repository.
    const repository = await gitRoot(await gitRepository(pane, target, data.child, data.worktree));
    if (!repository) throw new BridgeError(409, "This pane is not in a project repository.");
    result = await searchRepository(repository, fileSearchSchema.parse({
      query: data.query, regex: data.regex, caseSensitive: data.caseSensitive, wholeWord: data.wholeWord, include: data.include, limit: data.limit,
    }));
  }
  else if (url.pathname.startsWith("/v1/git/")) {
    // Git routes read the pane's repository, or a spawned child's own
    // worktree, exactly as /v1/diff resolves it.
    const checkpoint = url.pathname.startsWith("/v1/git/checkpoints");
    if (checkpoint && (data.child !== undefined || data.worktree !== undefined)) throw new BridgeError(400, "Checkpoints belong to the pane checkout; child and worktree selectors are unsupported.");
    let cwd = await gitRepository(pane, target, data.child, data.worktree);
    if (isGitWriteRoute(url.pathname)
      && data.expectedRepository !== undefined) {
      const expected = z.string().min(1).max(4096).refine(value => path.isAbsolute(value) && !value.includes("\0"), "Expected an absolute repository path.").parse(data.expectedRepository);
      const root = await gitRoot(cwd);
      if (root !== expected) throw new BridgeError(409, "This pane's checkout changed. Refresh Changes before writing.", { code: "git-checkout-changed" });
      cwd = root; // Execute in the validated root, never a path selected by the client.
    }
    if (checkpoint) result = await checkpointRoute(cwd, target, url.pathname === "/v1/git/checkpoints" ? "list" : url.pathname.slice("/v1/git/checkpoints/".length), data,
      async () => {
        const current = await validateTarget(target, false, true);
        if (await gitRoot(await trustedDirectory(current)) !== await gitRoot(cwd)) throw new BridgeError(409, "This pane’s checkout changed. Refresh Changes before writing.", { code: "git-checkout-changed" });
        return current;
      });
    else if (url.pathname === "/v1/git/status") result = await gitStatus(cwd, z.string().min(1).max(4096).optional().parse(data.untrackedPath));
    else if (url.pathname === "/v1/git/worktrees") result = await gitWorktrees(cwd, await worktreeWorkers(target));
    else if (url.pathname === "/v1/git/log") result = await gitLog(cwd, z.coerce.number().int().min(1).max(200).optional().parse(data.limit) ?? 60, z.string().min(1).max(512).optional().parse(data.ref));
    else if (url.pathname === "/v1/git/branches") result = await gitBranches(cwd);
    else if (url.pathname === "/v1/git/pulls") result = await gitPulls(cwd);
    else if (url.pathname === "/v1/git/tree") result = await gitTree(cwd, z.string().max(4096).optional().parse(data.path) ?? "", z.boolean().optional().parse(data.ignored) ?? false);
    else if (url.pathname === "/v1/git/stage") result = await gitStage(cwd, data.paths, z.boolean().optional().parse(data.confirmBulk) ?? false);
    else if (url.pathname === "/v1/git/unstage") result = await gitUnstage(cwd, data.paths);
    else if (url.pathname === "/v1/git/discard") result = await gitDiscard(cwd, data.paths);
    else if (url.pathname === "/v1/git/commit") result = await gitCommit(cwd, data.message);
    else if (url.pathname === "/v1/git/push") result = await gitPush(cwd, data.confirmDefault);
    else if (url.pathname === "/v1/git/pr") result = await gitPullRequest(cwd, data.draft);
    else if (url.pathname === "/v1/git/pr/merge") result = await gitMergeRequest(cwd, data);
    else if (url.pathname === "/v1/git/host-token") result = await gitHostToken(cwd, data);
    else if (url.pathname === "/v1/git/show") result = await gitShow(cwd, data.sha);
    else if (url.pathname === "/v1/git/checkout") result = await gitCheckout(cwd, data);
    else if (url.pathname === "/v1/git/fetch") result = await gitFetch(cwd);
    else if (url.pathname === "/v1/git/pull") result = await gitPull(cwd);
    else if (url.pathname === "/v1/git/file") result = await gitFile(cwd, data.ref, data.path);
    else if (url.pathname === "/v1/git/apply") result = await gitApply(cwd, data.patch, data.reverse);
    else if (url.pathname === "/v1/git/session-changes") {
      // This conversation's own recorded edits, in the repository the route resolved.
      const root = await gitRoot(cwd);
      if (!root) throw new BridgeError(409, "This pane is not in a Git repository.", { code: "git-not-repository" });
      result = sessionChanges(root, await agentHooks.changes.history(`${target.source}:${target.session}`));
    }
    else throw new BridgeError(404, "Unknown Phren Hook route.");
  }
  else if (url.pathname === "/v1/approvals/answer") {
    const actionId = target.source === "opencode"
      ? z.string().regex(/^[A-Za-z0-9_]{1,200}$/).parse(data.actionId)
      : z.union([z.string().uuid(), z.string().regex(/^dialog-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)]).parse(data.actionId);
    await agentHooks.answer(target, actionId, data.decision, data.updatedInput); result = { ok: true };
  } else if (url.pathname === "/v1/questions/answer") {
    // Only a Codex answer can carry the phone's uploads (codex-questions).
    if (target.source !== "codex" && Array.isArray(data.attachments) && data.attachments.length) throw new BridgeError(400, "This question takes no attachments.");
    if (target.source === "claude") {
      // Claude's AskUserQuestion, answered in its terminal dialog: the
      // phone names the questions it shows, and the Hook answers only a
      // pane that is drawing exactly those.
      const { questions, answers } = claudeQuestionAnswer(data);
      await agentHooks.answerClaudeQuestions(target, questions, answers);
    } else if (target.source === "opencode") {
      // A served OpenCode pane's question, answered over its own API.
      const { questions, answers } = claudeQuestionAnswer(data);
      await agentHooks.answerServedQuestion(target, questions, answers);
    } else await codexQuestions.answer(target, data);
    result = { ok: true };
  }
  else throw new BridgeError(404, "Unknown Phren Hook route.");
  }
  return result;
}

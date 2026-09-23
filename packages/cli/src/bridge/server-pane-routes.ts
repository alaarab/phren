import type { ServerResponse } from "node:http";
import { z } from "zod";
import type { AgentHooks } from "./agent-hooks.js";
import { gitBranches, gitDiscard, gitLog, gitPulls, gitStage, gitStatus, gitTree, gitUnstage } from "./git.js";
import { fanoutWorktrees } from "./fanouts.js";
import { gitWorktrees, resolveWorktree, type WorktreeWorker } from "./git-worktrees.js";
import { gitCommit, gitPullRequest, gitPush } from "./git-publish.js";
import { findPane, paneChatState, paneIdentity, rpc, snapshot, startingPane, trustedDirectory, validateStartingTarget, validateTarget } from "./herdr.js";
import { refuseWorkingSlash, type ModelSwitcher } from "./model-switch.js";
import { repositoryDiff } from "./projects.js";
import { BridgeError, type Json, MAX_FRAME, object, startingTargetSchema, type Target, targetSchema } from "./protocol.js";
import type { CodexQuestions } from "./questions.js";
import { childAgent, childAgentTree, conversationNamedPaths, transcriptPath, type ChildAgentRelation } from "./transcripts.js";
import { sideQuestionText, type SideQuestions } from "./side-questions.js";
import { saveUpload } from "./uploads.js";

/** Routes that act on one pane's conversation: prompts, answer keys, typed
 * secrets, uploads, diffs, git, approvals and questions. A starting pane (no
 * conversation yet) takes keys, a secret or a first prompt. */

export interface PaneRouteContext {
  agentHooks: AgentHooks;
  modelSwitcher: ModelSwitcher;
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
    return relation.cwd ?? await trustedDirectory(pane);
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
  return workers;
}

/** The phone can press these and nothing else; never a typed string.
 * `AltUp` is Codex's "edit/answer the last queued follow-up": it opens the
 * queue, after which the option key (or typed text) is the answer. */
const ANSWER_KEYS = ["Escape", "Enter", "Up", "Down", "Tab", "AltUp", "y", "n", "p", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
const HERDR_KEYS: Partial<Record<(typeof ANSWER_KEYS)[number], string>> = { Escape: "esc", Enter: "enter", Up: "up", Down: "down", Tab: "tab", AltUp: "alt+Up" };

/** A secret typed into a terminal prompt: printable, bounded, never logged. */
const secretText = z.string().min(1).max(256).refine(t => !/[\x00-\x1f\x7f]/.test(t));

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
      await rpc(server, "agent.send_keys", { target: pane, keys: keys.slice(index, index + 32) });
      sent = true;
    } catch (error) {
      if (sent) throw new BridgeError(502, "The password may have been typed only partly; check the terminal.");
      throw error;
    }
  }
  try {
    await rpc(server, "agent.send_keys", { target: pane, keys: ["enter"] });
  } catch (error) {
    if (sent) throw new BridgeError(502, "The password may have been typed only partly; check the terminal.");
    throw error;
  }
}

export async function paneRoute(ctx: PaneRouteContext, url: URL, data: Json, response: ServerResponse): Promise<unknown> {
  const { agentHooks, modelSwitcher, codexQuestions, sideQuestions } = ctx;
  let result: unknown;
  if (url.pathname === "/v1/keys" && object(data.target).starting === true) {
    // A folder-trust or login prompt comes before the agent has a
    // conversation; the phone answers it on the starting binding.
    const target = startingTargetSchema.parse(data.target);
    const pane = await startingPane(target);
    const keys = z.array(z.enum(ANSWER_KEYS)).min(1).max(4).parse(data.keys);
    if (!["blocked", "waiting", "unknown"].includes(String(pane.agent_status))) throw new BridgeError(409, "This agent is not waiting for an answer.");
    await rpc(target.server, "agent.send_keys", { target: target.pane, keys: keys.map(key => HERDR_KEYS[key] ?? key) });
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
    const text = z.string().min(1).max(32768).refine(t => !/[\x00-\x08\x0b-\x1f\x7f]/.test(t)).parse(data.text);
    refuseWorkingSlash(pane, text);
    await rpc(target.server, "agent.prompt", { target: target.pane, text });
    // A first prompt may create its transcript immediately. Recheck the
    // terminal/process binding, not the absence of a session. Never retry.
    let confirmed = false;
    try {
      const current = findPane(await snapshot(target.server), target);
      confirmed = !!current && current.terminal_id === pane.terminal_id && (await paneChatState(target.server, current)).startingToken === target.startingToken;
    } catch { /* Already delivered; an uncertain reply must not resend. */ }
    result = { ok: true, ...(!confirmed ? { deliveryUncertain: true } : {}) };
  } else {
  const target = targetSchema.parse(data.target);
  // Uploads store bytes without answering or interrupting the agent.
  // They still require fresh identity, just like prompt mutations.
  const sendsInput = ["/v1/prompt", "/v1/keys", "/v1/secret", "/v1/model"].includes(url.pathname);
  if (sendsInput) { modelSwitcher.assertAvailable(target); sideQuestions.assertAvailable(target); }
  // A key press is how a prompt the agent draws in its terminal gets
  // answered, so keys are the one input allowed while the agent is
  // blocked or waiting; the status check below is theirs alone.
  const pane = await validateTarget(target, false, sendsInput || url.pathname === "/v1/upload");
  if (sendsInput) { modelSwitcher.assertAvailable(target); sideQuestions.assertAvailable(target); }
  if (url.pathname === "/v1/prompt") {
    // A waiting agent takes typed text only when nothing structured
    // is pending there: an approval the Hook holds or saw, or a
    // status Herdr cannot read. Otherwise the answer keys are the way.
    const status = String(pane.agent_status);
    if (status === "unknown" || (["blocked", "waiting"].includes(status) && (agentHooks.approval(target) || agentHooks.terminalPrompt(target)))) {
      throw new BridgeError(409, "This agent needs input in the terminal first.");
    }
  }
  if (url.pathname === "/v1/prompt") {
    const text = z.string().min(1).max(32768).refine(t => !/[\x00-\x08\x0b-\x1f\x7f]/.test(t)).parse(data.text);
    // Herdr types into the pane; the agent that receives the text
    // confirms or refuses it through its UserPromptSubmit hook, by
    // conversation. That is the binding Herdr's own API lacks.
    // A working agent queues typed text and submits it when its turn
    // ends, which can be minutes away; waiting for that only delays
    // the phone. The record still guards the paste for ten minutes.
    refuseWorkingSlash(pane, text, target.source);
    if (sideQuestionText(target.source, text) !== undefined) {
      // Claude's `/btw` runs beside the turn and never reaches the transcript:
      // the Hook reads its panel and the answer arrives as a side-answer frame.
      return { ok: true, delivered: true, sideQuestion: await sideQuestions.ask(target, pane, text) };
    }
    if (target.source === "codex" && /^\s*\/model\s+\S/i.test(text)) throw new BridgeError(422, "Use the model picker to switch Codex models.");
    const expected = agentHooks.expectDelivery(target, text, String(pane.agent_status) === "working" ? 300 : 1_500);
    await rpc(target.server, "agent.prompt", { target: target.pane, text });
    const outcome = await expected;
    if (outcome === "blocked") throw new BridgeError(409, "The conversation in this pane changed; the message was not delivered. Reopen the chat and send it again.");
    // A bare slash command opens the agent's own menu; the phone may
    // walk it with keys for the next half minute. The command rides
    // along so a Codex /permissions walk can find its confirmation.
    if (/^\/[a-z][a-z0-9_-]*$/i.test(text.trim())) agentHooks.menuOpened(target, text.trim());
    if (outcome === "delivered") { result = { ok: true, delivered: true }; }
    else {
      // The agent has not submitted it yet (a busy agent queues typed
      // input). Recheck fresh identity and never retry; a late
      // submission to another conversation is still refused above.
      let confirmed = false;
      try {
        const current = findPane(await snapshot(target.server), target);
        confirmed = !!current && current.terminal_id === pane.terminal_id && await paneIdentity(target.server, current, true) === target.session;
      } catch { /* No reliable post-delivery identity. */ }
      result = { ok: true, ...(!confirmed ? { deliveryUncertain: true } : {}) };
    }
  } else if (url.pathname === "/v1/side-question/dismiss") {
    result = sideQuestions.dismiss(target, z.string().uuid().parse(data.id));
  } else if (url.pathname === "/v1/model") {
    result = await modelSwitcher.switch(target, data);
  } else if (url.pathname === "/v1/keys") {
    const keys = z.array(z.enum(ANSWER_KEYS)).min(1).max(4).parse(data.keys);
    const status = String(pane.agent_status), menu = agentHooks.menuOpen(target);
    // A prompt the Hook itself saw go by (a permission request it could
    // not hold) is being answered even when Herdr reads the pane as
    // working or idle; Herdr's status lags the agent's own dialog.
    const holding = menu || !!agentHooks.terminalPrompt(target);
    // Escape interrupts a working agent. Everything else answers a
    // prompt the agent is holding: a menu, a y/n, a trust question.
    if (!holding && (keys.every(key => key === "Escape") ? !["working", "blocked", "waiting", "unknown"].includes(status)
      : !["blocked", "waiting", "unknown"].includes(status))) throw new BridgeError(409, keys.every(key => key === "Escape") ? "This agent is no longer working." : "This agent is not waiting for an answer.");
    // A released AskUserQuestion is answered one question at a time:
    // the Hook sends the chosen digit, then Tab to advance or Enter
    // after the last, and clears the prompt when the set is done.
    const question = agentHooks.questionAnswerKeys(target, keys);
    if (question) {
      await rpc(target.server, "agent.send_keys", { target: target.pane, keys: question.map(key => HERDR_KEYS[key as (typeof ANSWER_KEYS)[number]] ?? key) });
      result = { ok: true };
    } else {
      // Keyless choices move and verify the highlight before Enter;
      // the phone sends the option identifier through the same route.
      const answerKeys = await agentHooks.dialogAnswerKeys(target, keys);
      await rpc(target.server, "agent.send_keys", { target: target.pane, keys: answerKeys.map(key => HERDR_KEYS[key] ?? key) });
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
  } else if (url.pathname === "/v1/diff") {
    const child = z.string().regex(/^[a-f0-9]{32}$/).optional().parse(data.child);
    if (data.worktree !== undefined) {
      // Another worktree of the pane's repository: the whole checkout.
      result = await repositoryDiff(await gitRepository(pane, target, data.child, data.worktree), [], []);
    } else if (child !== undefined) {
      // A spawned agent: its own worktree for a fan-out, otherwise the
      // parent's checkout. The whole repository, no phone-named paths.
      const relation = childAgent(await childAgentTree(target.source, target.session), child);
      if (!relation) throw new BridgeError(404, "That agent is not part of this conversation.");
      result = await repositoryDiff(relation.cwd ?? await trustedDirectory(pane), [], []);
    } else {
      const cwd = await trustedDirectory(pane), paths = z.array(z.string().max(4096)).max(24).optional().parse(data.paths) ?? [];
      const abort = new AbortController();
      response.once("close", () => { if (!response.writableEnded) abort.abort(); });
      const allowed = paths.length ? await agentHooks.changes.recordedPaths(`${target.source}:${target.session}`) : [];
      if (paths.length) {
        try { allowed.push(...await conversationNamedPaths(await transcriptPath(target.source, target.session), target.source, cwd, abort.signal)); }
        catch { abort.signal.throwIfAborted(); /* Missing transcripts grant no extra paths; recorded scope still works. */ }
      }
      result = await repositoryDiff(cwd, paths, allowed);
    }
  }
  else if (url.pathname.startsWith("/v1/git/")) {
    // Git routes read the pane's repository, or a spawned child's own
    // worktree, exactly as /v1/diff resolves it.
    const cwd = await gitRepository(pane, target, data.child, data.worktree);
    if (url.pathname === "/v1/git/status") result = await gitStatus(cwd);
    else if (url.pathname === "/v1/git/worktrees") result = await gitWorktrees(cwd, await worktreeWorkers(target));
    else if (url.pathname === "/v1/git/log") result = await gitLog(cwd, z.coerce.number().int().min(1).max(200).optional().parse(data.limit) ?? 60, z.string().min(1).max(512).optional().parse(data.ref));
    else if (url.pathname === "/v1/git/branches") result = await gitBranches(cwd);
    else if (url.pathname === "/v1/git/pulls") result = await gitPulls(cwd);
    else if (url.pathname === "/v1/git/tree") result = await gitTree(cwd, z.string().max(4096).optional().parse(data.path) ?? "", z.boolean().optional().parse(data.ignored) ?? false);
    else if (url.pathname === "/v1/git/stage") result = await gitStage(cwd, data.paths);
    else if (url.pathname === "/v1/git/unstage") result = await gitUnstage(cwd, data.paths);
    else if (url.pathname === "/v1/git/discard") result = await gitDiscard(cwd, data.paths);
    else if (url.pathname === "/v1/git/commit") result = await gitCommit(cwd, data.message);
    else if (url.pathname === "/v1/git/push") result = await gitPush(cwd, data.confirmDefault);
    else if (url.pathname === "/v1/git/pr") result = await gitPullRequest(cwd, data.draft);
    else throw new BridgeError(404, "Unknown Phren Hook route.");
  }
  else if (url.pathname === "/v1/approvals/answer") {
    const actionId = target.source === "opencode"
      ? z.string().regex(/^[A-Za-z0-9_]{1,200}$/).parse(data.actionId)
      : z.string().uuid().parse(data.actionId);
    await agentHooks.answer(target, actionId, data.decision, data.updatedInput); result = { ok: true };
  } else if (url.pathname === "/v1/questions/answer") {
    await codexQuestions.answer(target, data); result = { ok: true };
  }
  else throw new BridgeError(404, "Unknown Phren Hook route.");
  }
  return result;
}

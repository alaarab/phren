import { WebSocket } from "ws";
import { z } from "zod";
import { logger } from "../logger.js";
import type { AgentHooks } from "./agent-hooks.js";
import { queuedQuestion, threadHealth } from "./codex-threads.js";
import { SNAPSHOT_SHARE_MS, trustedDirectory, validateTarget } from "./herdr.js";
import { repositoryBranch } from "./projects.js";
import { BridgeError, type Json, MAX_FRAME, object, type Provider, type Target, targetFromURL } from "./protocol.js";
import type { CodexQuestions } from "./questions.js";
import type { HookInfo } from "./server-routes.js";
import type { SideQuestions } from "./side-questions.js";
import { TranscriptPreviewStream } from "./transcript-preview.js";
import { childAgent, childAgentTree, refreshTranscript, TranscriptReader, transcriptPath } from "./transcripts.js";
import type { ModuleSnapshot } from "../modules/runtime.js";
import { countTick } from "./metrics.js";

/** The WebSocket transcript and status streams: the backlog, appended rows and
 * previews on a tick loop, older pages on request, and the pane's status. */

export interface StreamContext {
  modules: ModuleSnapshot;
  agentHooks: AgentHooks;
  codexQuestions: CodexQuestions;
  sideQuestions?: SideQuestions;
  info: HookInfo;
  activeCapabilities: Record<string, unknown>;
}

export type TranscriptStreams = ReturnType<typeof transcriptStreams>;

function send(socket: WebSocket, frame: unknown) {
  if (socket.readyState !== WebSocket.OPEN) return;
  const data = JSON.stringify(frame);
  if (Buffer.byteLength(data) > MAX_FRAME || socket.bufferedAmount > MAX_FRAME) { socket.close(1009, "Reconnect to resume the conversation"); return; }
  socket.send(data);
}

/**
 * Why a transcript or status stream closed. Only a real target change (the
 * 409 validation) says the conversation changed; I/O, parse and git failures
 * keep their own words, with absolute paths cut to their last component and
 * the reason bounded to WebSocket's 123-byte close limit.
 */
export function streamCloseReason(error: unknown): string {
  if (error instanceof BridgeError && error.status === 409) return "The conversation changed; refresh";
  const code = (error as NodeJS.ErrnoException)?.code;
  const first = (error instanceof Error ? error.message : String(error)).split("\n")[0]
    .replace(/[\x00-\x1f\x7f]/g, " ").replace(/(?:~|\/)[^\s'",:]*\/([^\s'",:/]+)/g, "$1").trim();
  let reason = error instanceof BridgeError ? first
    : `Stream failed: ${typeof code === "string" && !first.startsWith(code) ? `${code} ` : ""}${first || "unknown error"}`;
  while (Buffer.byteLength(reason) > 123) reason = reason.slice(0, -1);
  return reason;
}

export function transcriptStreams(ctx: StreamContext) {
  const { modules, agentHooks, codexQuestions, sideQuestions, info, activeCapabilities } = ctx;
  /** A conversation the agent has identified but not written yet (Claude
   * Code creates its file on the first turn) is an empty transcript, not a
   * missing one: `reader` stays undefined until the file appears. */
  async function conversationReader(target: Target): Promise<{ reader?: TranscriptReader; source: Provider; session: string }> {
    try {
      const reader = new TranscriptReader(await transcriptPath(target.source, target.session), target.source, undefined, modules.has("git") ? agentHooks.changes.view(`${target.source}:${target.session}`) : undefined);
      return { reader, source: target.source, session: target.session };
    } catch (error) {
      if (error instanceof BridgeError && error.status === 404) return { source: target.source, session: target.session };
      throw error;
    }
  }
  const emptyPage = { entries: [], totalLines: 0, startLine: 0, hasMore: false, reset: true };
  /** The transcript of an agent the conversation spawned. The child is a
   * parent-scoped id from `/v1/subagents`; the file is only ever reached
   * through the relation, never by a path or session the phone names. */
  async function childConversationReader(target: Target, child: string) {
    const relation = childAgent(await childAgentTree(target.source, target.session), child);
    if (!relation) throw new BridgeError(404, "This child agent does not belong to the selected conversation.");
    const reader = new TranscriptReader(relation.transcript, relation.provider, undefined, undefined, relation.provider === "claude", relation.cwd);
    return { reader, source: relation.provider, session: relation.id };
  }
  async function stream(client: WebSocket, url: URL) {
    const abort = new AbortController();
    let reader: TranscriptReader | undefined, timer: ReturnType<typeof setInterval> | undefined;
    let unwatch: (() => void) | undefined;
    let busy = false, ready = false, first = true;
    let awaitingTranscript = false, lastTranscriptLookup = 0;
    let initialPane: Json;
    const pending: number[] = [];
    const stop = () => { abort.abort(); clearInterval(timer); unwatch?.(); pending.length = 0; };
    client.once("close", stop); client.once("error", stop);
    // Even rejected upgrades may already contain invalid WebSocket frames.
    // Handle their errors before parsing any untrusted destination fields.
    const target = targetFromURL(url);
    const previews = new TranscriptPreviewStream(target);
    // A child agent's transcript streams through the same socket, bound to
    // the parent conversation: the parent target is what gets revalidated
    // each tick, and the frames name the child by its parent-scoped id.
    const child = url.pathname === "/v1/transcripts" ? url.searchParams.get("child") : null;
    const cursor = url.pathname === "/v1/transcripts" ? url.searchParams.get("afterLine") : null;
    // Side answers (Claude's `/btw`) ride the parent conversation's stream
    // for a phone that asked for them; an older phone rejects unknown frames.
    const sideAnswers = url.pathname === "/v1/transcripts" && child === null && url.searchParams.get("sideAnswers") === "1";
    const sentSide = new Map<string, number>();
    // The first frame stays a backlog for protocol compatibility, but a
    // reconnect only reads rows beyond the phone's retained raw-line cursor.
    let resumeAfterLine = cursor === null ? undefined : z.coerce.number().int().nonnegative().max(4_294_967_295).parse(cursor);
    let conversation = { source: target.source, session: target.session };
    // The transcript file of a fresh conversation appears with its first
    // turn; until then the socket carries an empty backlog and keeps looking.
    const findTranscript = async () => {
      if (Date.now() - lastTranscriptLookup < 2_000) return;
      lastTranscriptLookup = Date.now();
      const opened = await conversationReader(target);
      if (opened.reader) { reader = opened.reader; conversation = { source: opened.source, session: opened.session }; awaitingTranscript = false; }
    };
    const tick = async () => {
      if (busy || !ready || abort.signal.aborted) return; busy = true;
      try {
        if (first || pending.length === 0) {
          const pane = first ? initialPane : await validateTarget(target, false, false, SNAPSHOT_SHARE_MS);
          if (awaitingTranscript) await findTranscript();
          if (awaitingTranscript) {
            if (first) send(client, { ...emptyPage, type: "backlog", ...conversation });
          } else if (reader) {
            await refreshTranscript(reader.file, conversation.source, conversation.session);
            if (first && child === null && target.source === "claude" && resumeAfterLine !== undefined) {
              // A reconnect cursor can omit the current user row entirely.
              // Seed only ephemeral turn state from the bounded recent tail.
              previews.observe((await new TranscriptReader(reader.file, conversation.source).read(undefined, abort.signal)).entries);
            }
            const page = resumeAfterLine === undefined
              ? await reader.read(undefined, abort.signal)
              : await reader.readAfter(resumeAfterLine, abort.signal);
            resumeAfterLine = undefined;
            if (child === null) previews.observe(page.entries, page.reset);
            const preview = child === null ? await previews.update(pane.agent_status, reader.file) : undefined;
            // `activityVerb` stays for phones that predate `activity`.
            const activity = previews.activity ? { activityVerb: previews.activity.verb, activity: { ...previews.activity } }
              : previews.verb ? { activityVerb: previews.verb } : {};
            if (first || page.entries.length || page.reset) send(client, { ...page, ...preview, ...activity, type: first || page.reset ? "backlog" : "append", ...conversation });
            else if (preview) send(client, { type: "preview", ...conversation, ...preview, ...activity });
          } else {
            let pendingApproval = agentHooks.approval(target);
            const pendingQuestions = target.source === "codex" ? await codexQuestions.pending(target).catch(() => undefined) : undefined;
            const cwd = await trustedDirectory(pane).catch(() => undefined);
            const branch = modules.has("git") && cwd ? await repositoryBranch(cwd) : undefined;
            const waiting = !pendingApproval && ["blocked", "waiting"].includes(String(pane.agent_status));
            // Claude Code's auto-mode fallback, opencode and Codex draw a
            // numbered dialog in the pane with no PermissionRequest hook
            // behind it: read the pane (at most once per three seconds) and
            // publish the dialog as the same terminal choice shape the phone
            // answers. Codex also resolves the real terminal choices for a held
            // approval; a structured question keeps its own answer channel.
            if (["claude", "opencode", "codex"].includes(target.source)) {
              await agentHooks.syncTerminalDialog(target, waiting && !pendingQuestions?.length);
              pendingApproval = agentHooks.approval(target);
            }
            const hookPrompt = waiting ? agentHooks.terminalPrompt(target) : undefined;
            // Codex 0.155's queued follow-up question never becomes a held
            // PermissionRequest: it lives as a thread item the terminal shows
            // under "Queued follow-up inputs". With nothing else to ask, read
            // its text and options and publish them as the same choice shape
            // the phone already answers with keys (alt+up, then the option).
            const terminalPrompt = hookPrompt
              ?? (waiting && target.source === "codex" && !pendingQuestions?.length
                ? await queuedQuestion(target.session).then(queued => queued ? {
                    toolName: "Question", message: queued.title, queued: true,
                    choice: { title: queued.title, options: queued.options },
                  } : undefined).catch(() => undefined)
                : undefined);
            const historyHealth = target.source === "codex" ? await threadHealth(target.session, pane.agent_status) : { stalled: false };
            send(client, { agentStatus: { source: target.source, session: target.session,
              status: pendingApproval ? "waiting" : pane.agent_status, pendingApproval, pendingQuestions, terminalPrompt,
              ...(waiting && agentHooks.passwordPrompt(target) ? { passwordPrompt: true } : {}),
              compacting: agentHooks.compacting(target),
              ...(historyHealth.stalled ? { historyStalled: true, historyStalledSince: historyHealth.since } : {}),
              modules: info.modules, store: info.store, profile: info.profile, generation: info.generation,
              capabilities: { ...activeCapabilities, asyncQuestions: target.source === "codex" && codexQuestions.available }, branch } });
          }
          if (sideAnswers && sideQuestions) {
            for (const { revision, ...side } of sideQuestions.list(target)) {
              if (sentSide.get(side.id) === revision) continue;
              sentSide.set(side.id, revision);
              send(client, { type: "side-answer", ...conversation, ...side });
            }
          }
          first = false;
        }
        while (pending.length && reader && !abort.signal.aborted) {
          const before = pending.shift()!;
          await validateTarget(target, false, false, SNAPSHOT_SHARE_MS);
          const page = await reader.read(before, abort.signal);
          send(client, { ...page, type: "older", ...conversation });
        }
      } catch (error) {
        const reason = streamCloseReason(error);
        if (!(error instanceof BridgeError && error.status === 409)) logger.warn("stream", `${url.pathname} closed: ${reason}`);
        stop(); client.close(1011, reason);
      }
      finally { busy = false; if (pending.length) void tick(); }
    };
    client.on("message", bytes => {
      try {
        const message = object(JSON.parse(bytes.toString()));
        if (message.type !== "older" || url.pathname !== "/v1/transcripts" || abort.signal.aborted) return;
        const before = z.number().int().positive().parse(message.beforeLine);
        if (pending.length >= 8) throw new Error("History queue is full");
        if (!pending.includes(before)) pending.push(before);
        void tick();
      } catch { stop(); client.close(1008, "Invalid history request"); }
    });
    try {
      initialPane = await validateTarget(target);
      if (abort.signal.aborted) return;
      unwatch = agentHooks.watch(target);
      if (url.pathname === "/v1/transcripts") {
        const opened = child === null ? await conversationReader(target) : await childConversationReader(target, child);
        reader = opened.reader; conversation = { source: opened.source, session: opened.session };
        awaitingTranscript = child === null && !reader; lastTranscriptLookup = Date.now();
      }
      if (abort.signal.aborted) { stop(); return; }
      ready = true;
      timer = setInterval(() => { countTick(url.pathname === "/v1/transcripts" ? "stream-transcripts" : "stream-status"); void tick(); }, reader || awaitingTranscript ? 500 : 1500);
      await tick();
    } catch (error) { stop(); throw error; }
  }
  return { conversationReader, childConversationReader, emptyPage, stream };
}

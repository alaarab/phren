import { object, objects, type Json } from "./protocol.js";
import { withTranscriptIndex } from "./transcript-index.js";
import { visibleClaudeEvent } from "./transcript-claude.js";

interface Ask { id: string; assistant: string; at: number }
interface State { revision: string; lines: number; pending: Map<string, Ask>; resolved: Set<string> }
const states = new Map<string, State>();

/** Reconcile synchronous Claude questions from the conversation's own records.
 * Async Codex questions have a different lifetime and never enter this path. */
export async function claudeQuestionResolutions(file: string, boundary?: number, signal?: AbortSignal): Promise<ReadonlySet<string>> {
  return withTranscriptIndex(file, async (handle, index) => {
    const cached = states.get(file);
    const current = cached?.revision === index.revision && cached.lines <= index.lines ? cached : undefined;
    if (current?.lines === index.lines && (boundary === undefined || ![...current.pending.values()].some(ask => ask.at <= boundary))) return current.resolved;
    const state: State = { revision: index.revision, lines: index.lines,
      pending: new Map(current?.pending), resolved: new Set(current?.resolved) };
    const resolve = (id: string) => { state.pending.delete(id); state.resolved.add(id); };
    // Scan newest first with only two newer assistant identities. Once both
    // differ, every older synchronous question has necessarily been left.
    // Retain no transcript bodies or per-row copy, even on an initial scan.
    const assistants = new Set<string>(), results = new Set<string>(), added = new Map<string, Ask>();
    let owner = false;
    const movedOn = (ask: Ask) => owner || results.has(ask.id) || [...assistants].some(id => id !== ask.assistant);
    for await (const row of index.rows(handle, index.lines, current?.lines ?? 0, signal)) {
      signal?.throwIfAborted();
      if (!row.bytes) continue;
      try {
        const raw = object(JSON.parse(row.bytes.toString()));
        if (raw.isSidechain === true || raw.isMeta === true) continue;
        const visible = visibleClaudeEvent(raw);
        if (!visible || visible.phrenQueued === true || visible.phrenExecution === "background" || visible.isCompactSummary === true) continue;
        const message = object(visible.message), blocks = objects(message.content);
        if (visible.type === "assistant") {
          const assistant = String(message.id ?? raw.uuid ?? row.line);
          for (const block of blocks) if (block.type === "tool_use" && block.name === "AskUserQuestion" && typeof block.id === "string") {
            const ask = { id: block.id, assistant, at: Date.parse(String(raw.timestamp)) };
            if (movedOn(ask)) resolve(ask.id);
            else if (!state.resolved.has(ask.id)) added.set(ask.id, ask);
          }
          if (assistants.size < 2) assistants.add(assistant);
          if (assistants.size === 2) results.clear();
        }
        if (assistants.size < 2) for (const block of blocks) {
          if (block.type === "tool_result" && typeof block.tool_use_id === "string") results.add(block.tool_use_id);
        }
        if (visible.type === "user" && (typeof message.content === "string"
          || blocks.some(block => ["text", "image"].includes(String(block.type)))) && !blocks.some(block => block.type === "tool_result")) owner = true;
      } catch { /* Partial/malformed records say nothing. */ }
    }
    for (const ask of state.pending.values()) if (movedOn(ask)) resolve(ask.id);
    for (const [id, ask] of added) if (!state.resolved.has(id)) state.pending.set(id, ask);
    if (boundary !== undefined) for (const ask of state.pending.values()) {
      if (Number.isFinite(ask.at) && ask.at <= boundary) resolve(ask.id);
    }
    states.delete(file); states.set(file, state);
    while (states.size > 32) states.delete(states.keys().next().value!);
    return state.resolved;
  }, signal);
}

/** An explicit resolution, never an invented answer. Keep it with the original
 * question's stable row so backlog, reconnects and pagination agree. Existing
 * clients already understand identity-matched tool_result blocks. */
export function projectClaudeQuestionResolutions(raw: Json, resolved: ReadonlySet<string>): Json {
  const message = object(raw.message), blocks = objects(message.content);
  const results = blocks.filter(block => block.type === "tool_use" && block.name === "AskUserQuestion"
    && typeof block.id === "string" && resolved.has(block.id)).map(block => ({ type: "tool_result", tool_use_id: block.id,
      is_error: true, content: "This question is no longer pending.", phren_resolution: true }));
  return results.length ? { ...raw, message: { ...message, content: [...blocks, ...results] } } : raw;
}

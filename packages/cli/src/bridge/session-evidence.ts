import type { AgentHooks } from "./agent-hooks.js";
import type { CodexQuestions } from "./questions.js";
import { type Json, type Provider, type Target, provider, bridgeRoot } from "./protocol.js";
import { childAgentTree, runningChildAgents } from "./transcripts.js";
import { readFinalTurn } from "./schedule-watch.js";
import { paneRecord, type EffectiveStatusInput } from "./session-activity.js";
import { turnPhase, type TurnRecord } from "./turn-records.js";
const CHILD_ACTIVITY_CACHE_MS = 5_000;
interface ChildActivity { runningChildren: number; childProviders: Provider[] }
const childActivityCache = new Map<string, { at: number; pending: boolean; result: Promise<ChildActivity> }>();

export async function childActivity(source: Provider, session: string): Promise<ChildActivity> {
  const key = `${source}\0${session}`, now = Date.now(), cached = childActivityCache.get(key);
  // A slow tree still belongs to the next overview. Expiring an in-flight
  // read every five seconds starts it over before any answer can be reused.
  if (cached && (cached.pending || now - cached.at < CHILD_ACTIVITY_CACHE_MS)) return cached.result;
  const result = childAgentTree(source, session).then(tree => {
    const running = runningChildAgents(tree);
    return { runningChildren: running.length, childProviders: [...new Set(running.map(child => child.provider))].sort() };
  }).catch(() => ({ runningChildren: 0, childProviders: [] as Provider[] }));
  const entry = { at: now, pending: true, result };
  void result.then(() => { entry.at = Date.now(); entry.pending = false; });
  childActivityCache.set(key, entry);
  while (childActivityCache.size > 128) childActivityCache.delete(childActivityCache.keys().next().value!);
  return result;
}

/** Wait for optional enrichment without holding transcript delivery indefinitely. */
async function bounded<T>(work: Promise<T>, ms = 100): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work.catch(() => undefined), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms); })]); }
  finally { clearTimeout(timer); }
}

/** Evidence already in memory must not wait on children, transcripts or dialogs. */
export function availablePaneEvidence(server: string, pane: Json, session: string, record?: TurnRecord, hooks?: AgentHooks): EffectiveStatusInput {
  const target: Target = { server, pane: String(pane.pane_id), workspace: String(pane.workspace_id), tab: String(pane.tab_id), source: pane.agent as Provider, session };
  const held = !!(hooks?.approval?.(target) || hooks?.servedQuestion?.(target));
  return { paneStatus: pane.agent_status, record, held, dialog: !!hooks?.terminalPrompt?.(target) };
}

const finalReads = new Map<string, ReturnType<typeof readFinalTurn>>();
function finalEvidence(record: TurnRecord): ReturnType<typeof readFinalTurn> {
  if (record.source === "phren") return Promise.resolve(undefined);
  const key = `${bridgeRoot()}:${record.source}:${record.session}:${record.stop?.seq}`, cached = finalReads.get(key);
  if (cached) return cached;
  const result = readFinalTurn(record.source, record.session).catch(() => undefined);
  finalReads.set(key, result);
  void result.then(() => { if (finalReads.get(key) === result) finalReads.delete(key); });
  while (finalReads.size > 128) finalReads.delete(finalReads.keys().next().value!);
  return result;
}

/** Every caller gets the same guarded foreground evidence, with whatever
 * enrichment is ready inside one bounded window. Late work never mutates it. */
export async function effectivePaneEvidence(server: string, pane: Json, session: string,
  hooks?: AgentHooks, questions?: CodexQuestions, knownRecord?: TurnRecord): Promise<EffectiveStatusInput & { children?: ChildActivity }> {
  const record = knownRecord ?? await bounded(paneRecord(server, pane, session));
  const phase = record ? turnPhase(record) : undefined;
  const target: Target = { server, pane: String(pane.pane_id), workspace: String(pane.workspace_id), tab: String(pane.tab_id), source: pane.agent as Provider, session };
  let children: ChildActivity | undefined, final: Awaited<ReturnType<typeof readFinalTurn>>;
  let question = false;
  await bounded(Promise.all([
    record && phase?.phase === "ended" ? finalEvidence(record).then(value => { final = value; }) : undefined,
    provider.safeParse(pane.agent).success ? childActivity(pane.agent as Provider, session).then(value => { children = value; }) : undefined,
    hooks?.syncTerminalDialog?.(target, ["blocked", "waiting"].includes(String(pane.agent_status)) || phase?.phase === "working"),
    pane.agent === "codex" ? questions?.pending(target).then(value => { question = !!value?.length; }) : undefined,
  ]));
  const available = availablePaneEvidence(server, pane, session, record, hooks);
  return { ...available, final, children, runningChildren: children?.runningChildren, held: available.held || question };
}

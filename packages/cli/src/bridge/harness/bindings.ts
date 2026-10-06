import { RunnerAdapter, runnerForPane, runnerRequest } from "./runner-client.js";
import { codexServers } from "../codex-servers.js";
import { paneClient, servedPane } from "../opencode-panes.js";
import { validateTarget } from "../herdr.js";
import type { Target } from "../protocol.js";
import { CodexAppServerAdapter, OpenCodeServeAdapter, PaneTypingAdapter } from "./direct.js";
import type { HarnessAdapter, PaneBinding } from "./contract.js";
import type { AgentHooks } from "../agent-hooks.js";
import { objects, targetSchema, BridgeError } from "../protocol.js";
let requestSink: Pick<AgentHooks, "harnessRequest" | "harnessResolved"> | undefined;
const knownRequests = new Map<string, Set<string>>();
export function setHarnessRequestSink(sink?: typeof requestSink) { requestSink = sink; if (!sink) knownRequests.clear(); }
/** Reconcile durable parked requests after a Hook restart without replaying prompts. */
export async function observeHarnessRequests(server: string, panes: Record<string, unknown>[]) {
  if (!requestSink) return;
  const seen = new Set<string>();
  for (const pane of panes) {
    const entry = await runnerForPane(server, pane); if (!entry) continue;
    const parsed = targetSchema.safeParse({ server, pane: entry.pane, workspace: pane.workspace_id, tab: pane.tab_id, source: entry.source, session: entry.session });
    if (!parsed.success) continue;
    const target = parsed.data, key = JSON.stringify(target); seen.add(key);
    const previous = knownRequests.get(key) ?? new Set<string>();
    try {
      const reply = await runnerRequest(entry, "requests"), current = new Set<string>();
      for (const request of objects(reply.requests)) {
        if (typeof request.requestId !== "string") continue; current.add(request.requestId);
        requestSink.harnessRequest(target, request.requestId, String(request.tool ?? "Action"), typeof request.input === "object" && request.input ? request.input as Record<string, unknown> : {},
          async response => (await runnerRequest(entry, request.kind === "user-input" ? "input" : "approval", { requestId: request.requestId, response })).ok === true);
      }
      for (const request of previous) if (!current.has(request)) requestSink.harnessResolved(target, request);
      knownRequests.set(key, current);
    } catch { /* One unreachable runner must not hide another worker's asks. */ }
  }
  for (const [key, requests] of knownRequests) {
    const target = targetSchema.parse(JSON.parse(key));
    if (target.server !== server || seen.has(key)) continue;
    for (const request of requests) requestSink.harnessResolved(target, request);
    knownRequests.delete(key);
  }
}

const adapters = new Map<string, { adapter: HarnessAdapter; session: string; terminal?: string; lastUsed: number }>();
const key = (target: Target) => `${target.server}\0${target.pane}`;
/** An SDK/ACP worker registers only after its launch has a verified pane/session binding. */
export function bindHarness(target: Target, adapter: HarnessAdapter, terminal?: string) {
  const previous = adapters.get(key(target));
  if (previous && previous.adapter !== adapter) throw new Error("The pane already has a structured harness owner.");
  adapters.set(key(target), { adapter, session: target.session, terminal, lastUsed: Date.now() });
}
export async function unbindHarness(target: Target) { const bound = adapters.get(key(target)); if (!bound || bound.session !== target.session) return; adapters.delete(key(target)); await bound.adapter.close(); }
export async function boundHarness(target: Target, expectedOwner?: unknown): Promise<HarnessAdapter> {
  const pane = await validateTarget(target, false, true), terminal = typeof pane.terminal_id === "string" ? pane.terminal_id : undefined;
  const previous = adapters.get(key(target));
  const runner = await runnerForPane(target.server, pane);
  if (expectedOwner !== undefined && (!runner || runner.ownerId !== expectedOwner || runner.session !== target.session)) throw new BridgeError(409, "The structured worker owner changed. Refresh this exact session before continuing.");
  const sameRunner = !previous || !(previous.adapter instanceof RunnerAdapter) || runner?.ownerId === previous.adapter.entry.ownerId;
  if (previous && sameRunner && previous.session === target.session && previous.terminal === terminal) { previous.lastUsed = Date.now(); return previous.adapter; }
  if (previous) { adapters.delete(key(target)); await previous.adapter.close(); }
  // Direct backends retain their existing launch, permissions and approval owners.
  const binding: PaneBinding = { server: target.server, pane: target.pane, ...(terminal ? { terminal } : {}) };
  const codex = codexServers.forTarget(target);
  const served = target.source === "opencode" ? servedPane(target.server, target.pane) : undefined;
  const adapter: HarnessAdapter = runner ? new RunnerAdapter(runner) : codex ? new CodexAppServerAdapter(await codexServers.adapterClient(codex), {}, binding, target.session)
    : served ? new OpenCodeServeAdapter(paneClient(served), binding, target.session) : new PaneTypingAdapter(binding, target.session);
  // A second thread/session would leave the observed TUI; launches own creation.
  adapter.capabilities.startSession = false;
  adapters.set(key(target), { adapter, session: target.session, terminal, lastUsed: Date.now() });
  // Cached direct connections are observations, never a reason to stop an owner's worker.
  if (adapters.size > 128) {
    const stale = [...adapters.entries()].filter(([id]) => id !== key(target)).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (stale) { adapters.delete(stale[0]); await stale[1].adapter.close(); }
  }
  return adapter;
}
export async function harnessInfo(target: Target) {
  const adapter = await boundHarness(target);
  return { version: 1, ...(adapter instanceof RunnerAdapter ? { nativeSession: adapter.entry.nativeSession, ownerId: adapter.entry.ownerId } : {}), provider: adapter.provider, session: target.session, pane: { server: target.server, pane: target.pane }, capabilities: { ...adapter.capabilities } };
}

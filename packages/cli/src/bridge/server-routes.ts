import type { IncomingMessage, ServerResponse } from "node:http";
import { harnessInventoryWithin, launchCheckOff } from "./harnesses.js";
import path from "node:path";
import { z } from "zod";
import { saveCodeNote } from "./code-note.js";
import type { FanoutMessages } from "./fanout-messages.js";
import { handOff } from "./hand-off.js";
import type { ModuleSnapshot } from "../modules/runtime.js";
import { BUILTIN_MODULES, disabledHint } from "../modules/registry.js";
import type { ActivityJournal } from "./activity.js";
import type { AgentHooks } from "./agent-hooks.js";
import { homeDir } from "../home-paths.js";
import { resolveCodeStore, CodeRoutes } from "./code-routes.js";
import type { WorkspaceContextUsage } from "./context.js";
import { type DispatchService, dispatchProjectDirectory, dispatchStatus, originPaneSchema } from "./dispatch.js";
import { type DispatchReturns, hookWorkers } from "./dispatch-returns.js";
import { remoteChildren } from "./dispatch-tree.js";
import { briefArrival, briefId } from "./launch-brief.js";
import { addGrant, listNamedGrants, removeGrant } from "./grants.js";
import { clearProjectAuthority, confirmAuthority, listConfirmations, projectAuthority, readAuthority, setProjectAuthority } from "./authority.js";
import { readComputers } from "./computer-identity.js";
import { optionalHookPeers, peerRequest } from "./peers.js";
import { candidateRepos, enrollProject } from "./enroll.js";
import { browseFiles } from "./files.js";
import { MAX_FILE_RANGE, rangeInteger, readFileRange } from "./file-range.js";
import { storeRoute } from "./memory-store.js";
import { markBackground, paneRecord, recordedBackground, recordTitle } from "./session-activity.js";
import { paneAccountField, paneChatState, panes, servers, snapshot, validateTarget, workspaceSnapshot } from "./herdr.js";
import type { LaunchLimiter } from "./limits.js";
import { locateProject } from "./locate.js";
import { gitRoot, launchDirectory, repositoryBranch, webServers } from "./projects.js";
import { BridgeError, bridgeRoot, type Json, MAX_FRAME, object, objects, PROTOCOL, provider, type Provider, serverName, targetFromURL, targetSchema } from "./protocol.js";
import type { CodexQuestions } from "./questions.js";
import { bootedSimulators, type SimulatorAction, simulatorAct, simulatorApps, simulatorScreenshot } from "./simulators.js";
import type { TabActivityStore } from "./tab-activity.js";
import { childAgentTree, historicalImage, publicChildAgents, refreshTranscript, targetTranscriptPath } from "./transcripts.js";
import { listUploads, saveUpload, uploadImage } from "./uploads.js";
import type { ModelCatalog } from "./models.js";
import type { ModelSwitcher } from "./model-switch.js";
import type { SettingsSwitcher } from "./settings-switch.js";
import type { SideQuestions } from "./side-questions.js";
import { currentModel, currentStep } from "./steps.js";
import { type AccountUsageReader, usageForCaller } from "./usage.js";
import type { ResourceMonitor } from "./resources.js";
import type { Scheduler } from "./schedules.js";
import { healthDetails, listsCaller } from "./health.js";
import { defaultPhrenPath } from "../shared.js";
import { loadCodePackage, loadedFrom } from "../modules/code-package.js";
import { gitRepository, paneRoute, uploadBody } from "./server-pane-routes.js";
import { renameSession } from "./session-rename.js";
import { launchSession, localConductor, workspaceAction } from "./server-launch.js";
import type { TranscriptStreams } from "./server-stream.js";
import { hookMetrics } from "./metrics.js";
import { SPEECH_FORMATS, streamSpeech } from "./speech.js";
import { readSpeechKey } from "./speech-key.js";
import { DEFAULT_SPEECH_VOICE, listSpeechVoices, resolveSpeechVoice } from "./speech-voice.js";
import { terminalKind, terminalMux } from "./terminal.js";
import { muxListForClient, muxReplyForClient, typedMuxRequest } from "./mux-wire.js";

/** The Hook's HTTP API over its Unix socket: module gating, the GET routes,
 * the POST routes that are not bound to one pane, and grant deletion. */

/** What /v1/health reports about this computer and its Hook. */
export interface HookInfo {
  product: string;
  protocol: number;
  version: string;
  computer: { id: string; name: string; aliases?: string[] };
  capabilities: Record<string, unknown>;
  modules: Record<string, string>;
  store: string;
  profile: string;
  generation: string;
  readonly load: { average: number; cpus: number };
  readonly gatewayMs: number | undefined;
}

export interface RouteContext {
  version: string;
  modules: ModuleSnapshot;
  info: HookInfo;
  computerID: string;
  scheduleStore: string;
  scheduler?: Scheduler;
  dispatches?: DispatchService;
  returns?: DispatchReturns;
  agentHooks: AgentHooks;
  journal: ActivityJournal;
  tabActivity: TabActivityStore;
  contextUsage: WorkspaceContextUsage;
  modelCatalog: ModelCatalog;
  modelSwitcher: ModelSwitcher;
  settingsSwitcher: SettingsSwitcher;
  sideQuestions: SideQuestions;
  accountUsage: AccountUsageReader;
  resources: ResourceMonitor;
  codexQuestions: CodexQuestions;
  launches: LaunchLimiter;
  locatedDirectories: Set<string>;
  fanoutMessages: FanoutMessages;
  canary: (trigger: "manual" | "daily") => Promise<unknown>;
  streams: TranscriptStreams;
}

const CHILD_ACTIVITY_CACHE_MS = 5_000;
/** How long the overview waits for per-tab git and transcript reads; the phone gives up at 20 s. */
export const OVERVIEW_ENRICH_BUDGET_MS = 5_000;
interface ChildActivity { runningChildren: number; childProviders: Provider[] }
const childActivityCache = new Map<string, { at: number; result: Promise<ChildActivity> }>();

async function childActivity(source: Provider, session: string): Promise<ChildActivity> {
  const key = `${source}\0${session}`, now = Date.now(), cached = childActivityCache.get(key);
  if (cached && now - cached.at < CHILD_ACTIVITY_CACHE_MS) return cached.result;
  const result = childAgentTree(source, session).then(tree => {
    const running = tree.flatMap(function visit(child): typeof tree {
      return [child, ...child.children.flatMap(visit)];
    }).filter(child => child.state === "running");
    return { runningChildren: running.length, childProviders: [...new Set(running.map(child => child.provider))].sort() };
  }).catch(() => ({ runningChildren: 0, childProviders: [] as Provider[] }));
  childActivityCache.set(key, { at: now, result });
  while (childActivityCache.size > 128) childActivityCache.delete(childActivityCache.keys().next().value!);
  return result;
}

export const capabilities = { transcript: true, progress: true, images: true, prompt: true, stop: true,
  terminal: "ssh-pty", shell: "ssh-pty", herdr: true, sessionRename: true, diff: true, webServers: true, webPreview: "ssh-exec", activity: true,
  approvals: true, questions: false, accountUsage: true, providers: ["codex", "claude", "copilot", "opencode"],
  files: true, repositoryFiles: true, subagents: true, sideQuestions: true, dispatch: true, approvalPush: "direct-apns", simulators: process.platform === "darwin", code: true, overviewStream: true, speech: true, speechTimestamps: true, speechVoices: true, speechFormats: [...SPEECH_FORMATS], transcribe: true, memoryStore: true, promptOnce: true, promptStatus: true, resources: true };

export function capabilitiesForModules(snapshot: ModuleSnapshot): Record<string, unknown> {
  const allowed = new Set(snapshot.modules.flatMap(module => module.capabilities));
  const result: Record<string, unknown> = Object.fromEntries(Object.entries(capabilities).filter(([name]) => allowed.has(name)));
  for (const name of ["memory", "tasks", "hook", "git", "schedules"]) if (snapshot.has(name)) result[name] = true;
  return result;
}

export function requireRoute(snapshot: ModuleSnapshot, method: string, route: string): void {
  const owner = BUILTIN_MODULES.find(module => module.hookRoutes.some(entry => entry.method === method && entry.path === route));
  if (owner && !snapshot.has(owner.name)) throw new BridgeError(404, disabledHint(owner.name));
}

/** Whether the Hook can load @phren/code and, if so, from where. Reported by
 * /v1/health so a phone can explain a missing code package. */
async function codePackageStatus(store: string, enabled: boolean): Promise<Record<string, unknown>> {
  if (!enabled) return { missing: true };
  const code = await loadCodePackage(store);
  const from = loadedFrom();
  return code && from ? { loadedFrom: from } : { missing: true };
}

async function body(request: IncomingMessage): Promise<Json> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 11_500_000) throw new BridgeError(413, "Request is too large.");
    chunks.push(chunk);
  }
  return object(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
}

export function selectedServer(url: URL): string {
  const mux = url.searchParams.get("mux");
  const selected = mux ? /^(herdr|tmux):(.+)$/.exec(mux) : undefined;
  if (mux && !selected) throw new BridgeError(400, "Select a terminal source.");
  const explicit = url.searchParams.get("server");
  if (explicit && selected && explicit !== selected[2]) throw new BridgeError(400, "Conflicting terminal sources.");
  const server = serverName.parse(explicit || selected?.[2] || "default");
  // Old phones used herdr:tmux. Keep that alias, but a typed tmux id must
  // never silently route to a Herdr session with the same server name.
  if (selected?.[1] === "tmux" && terminalKind(server) !== "tmux") {
    throw new BridgeError(409, "This terminal source changed. Refresh the computer.", { code: "mux-kind-mismatch" });
  }
  return server;
}

/**
 * The overview a phone draws for one Herdr server: every tab with its agent,
 * target, branch, model, running children and current step, from one
 * `session.snapshot`. `GET /v1/workspaces` passes a fresh snapshot; the
 * `/v1/overview` stream passes the shared one it already holds.
 */
export type WorkspacesReader = (server: string, s: Json, watchApprovals: boolean) => Promise<Json>;

export function workspacesReader(ctx: Pick<RouteContext, "modules" | "info" | "agentHooks" | "journal" | "tabActivity" | "contextUsage">): WorkspacesReader {
  const { modules, info, agentHooks, journal, tabActivity, contextUsage } = ctx;
  return async (server, s, watchApprovals) => {
    const lastChanged = await tabActivity.observe(server, s);
    if (watchApprovals) agentHooks.overview.renew(server);
    const context = await contextUsage.read(server, s);
    await journal.record(server, objects(s.panes));
    const chatStates = new Map(await Promise.all(objects(s.panes).filter(p => p.agent).map(async p =>
      [p, await paneChatState(server, p, { tokenWhenIdentified: false }).catch((): Json => ({}))] as const)));
    const workspaces = workspaceSnapshot(s, context, agentHooks.pendingPanes(server, s), lastChanged);
    // The branch each tab's agent is on, for the session cards.
    const agentsByTab = new Map<string, Json[]>();
    for (const pane of objects(s.panes)) {
      if (!pane.agent) continue;
      const key = JSON.stringify([pane.workspace_id, pane.tab_id]);
      const agents = agentsByTab.get(key) ?? [];
      agents.push(pane); agentsByTab.set(key, agents);
    }
    const tabs = objects(workspaces.groups).flatMap(group => objects(group.children).map(tab => ({ group, tab })));
    // What a chat needs to open (the exact conversation) comes straight from the
    // chat states; everything below it is decoration.
    for (const { group, tab } of tabs) {
      const agents = agentsByTab.get(JSON.stringify([group.id, tab.id])) ?? [];
      if (agents.length !== 1) continue;
      const chat = chatStates.get(agents[0]);
      if (chat?.starting === true) tab.starting = true;
      // After the identity probe above, which is what learns a pane's transcript.
      Object.assign(tab, paneAccountField(server, agents[0]));
      if (typeof chat?.sessionId === "string" && provider.safeParse(agents[0].agent).success) {
        tab.target = { server, workspace: group.id, tab: tab.id, pane: agents[0].pane_id, source: agents[0].agent, session: chat.sessionId };
      }
    }
    // Branch, model, children and current step read git and transcripts. On a
    // starved machine (load 230 on 10 cores, 2026-09-24) that took longer than
    // the phone waits, so the computer read as offline. The overview answers
    // within its budget with whatever decoration is ready; a later read fills in.
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<void>(resolve => { timer = setTimeout(resolve, OVERVIEW_ENRICH_BUDGET_MS); });
    // First, each pane's own turn record (one small file): whether its ended
    // turn still has background work, and which dispatch it is. It runs ahead
    // of the slower reads so the status does not flicker between answers, but
    // inside the budget, so a stuck disk cannot hold the overview either.
    const records = Promise.all(tabs.map(async ({ group, tab }) => {
      const agents = agentsByTab.get(JSON.stringify([group.id, tab.id])) ?? [];
      const session = agents.length === 1 && object(tab.target).session;
      const record = typeof session === "string" ? await paneRecord(server, agents[0], session) : undefined;
      const title = await recordTitle(record, { paneLabel: tab.paneLabel, harnessTitle: tab.title, tabLabel: tab.label, workspaceLabel: group.label, fallbackLabel: tab.label });
      if (expired) return;
      markBackground(tab, recordedBackground(record));
      tab.title = title;
    }));
    let nextTab = 0;
    const enrich = records.then(() => Promise.all(Array.from({ length: Math.min(4, tabs.length) }, async () => {
      while (!expired && nextTab < tabs.length) {
        const { group, tab } = tabs[nextTab++];
        const agents = agentsByTab.get(JSON.stringify([group.id, tab.id])) ?? [];
        const found: Json = {};
        if (modules.has("git") && typeof tab.cwd === "string" && tab.agent) found.branch = await repositoryBranch(tab.cwd);
        if (agents.length === 1 && provider.safeParse(agents[0].agent).success) {
          const session = chatStates.get(agents[0])?.sessionId;
          found.runningChildren = 0; found.childProviders = [];
          if (typeof session === "string") {
            const source = agents[0].agent as Provider;
            const [model, children] = await Promise.all([
              currentModel(source, session).catch(() => undefined), childActivity(source, session),
            ]);
            if (model) found.model = model;
            found.runningChildren = children.runningChildren; found.childProviders = children.childProviders;
            if (agents[0].agent_status === "working") {
              const step = await currentStep(source, session).catch(() => undefined);
              if (step) found.currentStep = step;
            }
          }
        }
        // A row finished after the answer left belongs to the next read.
        if (!expired) {
          Object.assign(tab, Object.fromEntries(Object.entries(found).filter(([, value]) => value !== undefined)));
          // Codex subagents and fanout jobs keep an idle-looking session working too.
          markBackground(tab, typeof found.runningChildren === "number" ? found.runningChildren : undefined);
        }
      }
    })));
    await Promise.race([enrich, budget]);
    expired = true; clearTimeout(timer);
    const mux = terminalMux(server);
    return { ...workspaces, kind: mux.kind, mux, phren: info };
  };
}

/** One read-only GET to every linked peer, each answer or its error by computer name. */
async function fromPeers(route: string): Promise<{ peers: Json[]; peerError?: string }> {
  const { peers, peerError } = await optionalHookPeers();
  const answers = await Promise.all(peers.map(async peer => {
    try { return { name: peer.name, ...await peerRequest(peer, route, undefined, 15_000) }; }
    catch (error) {
      const code = error instanceof BridgeError && typeof error.details?.code === "string" ? error.details.code : undefined;
      const older = error instanceof BridgeError && error.status === 404;
      return { name: peer.name, error: older ? "This computer's Hook predates this report; update it with phren bridge update." : error instanceof Error ? error.message.slice(0, 300) : "Unavailable", ...(code ? { code } : {}) };
    }
  }));
  return { peers: answers, ...(peerError ? { peerError } : {}) };
}

export function createRouteHandler(ctx: RouteContext): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const { version, modules, info, computerID, scheduleStore, scheduler, dispatches, agentHooks, journal,
    modelCatalog, accountUsage, resources, launches, locatedDirectories, fanoutMessages, canary } = ctx;
  const { conversationReader, childConversationReader, emptyPage } = ctx.streams;
  const readWorkspaces = workspacesReader(ctx);
  return async (request, response) => {
    response.setHeader("X-Phren-Protocol", String(PROTOCOL));
    response.setHeader("Cache-Control", "no-store");
    try {
      const url = new URL(request.url || "/", "http://phren.local");
      if (url.origin !== "http://phren.local") throw new BridgeError(400, "Invalid request origin.");
      requireRoute(modules, request.method ?? "", url.pathname);
      let result: unknown;
      if (url.pathname.startsWith("/v1/store/")) {
        result = await storeRoute(modules.store, request.method ?? "", url, request.method === "POST" ? await body(request) : undefined);
      } else if (request.method === "GET") {
        switch (url.pathname) {
          case "/v1/health": result = { ...info, codePackage: await codePackageStatus(scheduleStore, modules.has("code")) }; break;
          case "/v1/metrics": result = hookMetrics.snapshot(); break;
          case "/v1/health/details": result = await healthDetails({ hookVersion: version, computerId: computerID, store: scheduleStore,
            scheduler: scheduler ? { running: true, lastTickAt: scheduler.lastTickAt } : undefined, push: agentHooks.push.status }); break;
          case "/v1/health/peers": {
            // A peer's health probe asks whether this computer lists it back.
            const caller = z.object({ name: z.string().max(253).optional(), hostKey: z.string().max(512).optional() })
              .parse({ name: url.searchParams.get("name") ?? undefined, hostKey: url.searchParams.get("hostKey") ?? undefined });
            result = { computer: info.computer, version, ...await listsCaller(caller) }; break;
          }
          case "/v1/dispatch": result = { dispatches: await dispatchStatus() }; break;
          // Receiving side of a launched brief: what the worker's hooks reported for it.
          case "/v1/dispatch/arrival": result = { arrival: await briefArrival(briefId.parse(url.searchParams.get("id"))) ?? null }; break;
          case "/v1/conductor/grants": result = { grants: await listNamedGrants() }; break;
          // The owner's release authority policy, which conductors read and quote in briefs.
          case "/v1/authority": {
            const policy = await readAuthority();
            const project = url.searchParams.get("project");
            result = project !== null ? { authority: projectAuthority(policy, z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/).parse(project)) }
              : { source: policy.source, ...(policy.updatedAt ? { updatedAt: policy.updatedAt } : {}), ...(policy.updatedBy ? { updatedBy: policy.updatedBy } : {}),
                projects: Object.keys(policy.projects).sort().map(name => projectAuthority(policy, name)), confirmations: await listConfirmations() };
            break;
          }
          // One row per real computer, however many names machines.yaml and the network give it.
          case "/v1/computers": { const { computers, peerError } = await readComputers({ probe: true, local: { id: info.computer.id } });
            result = { computers, ...(peerError ? { peerError } : {}) }; break; }
          // Asked by linked peers before they start a conductor: one per connected group.
          case "/v1/conductor": result = { computer: info.computer, conductor: await localConductor() ?? null }; break;
          // Bounded like capacity: a cold `claude auth status` per home can take seconds. Without
          // `harnesses` the phone treats the computer as unknown and offers everything; the probe keeps
          // running, so the next request answers from cache.
          case "/v1/harnesses": result = await harnessInventoryWithin(2_500) ?? { pending: true }; break;
          case "/v1/dispatch/capacity": {
            const live = await servers();
            const snapshots = await Promise.all(live.map(server => snapshot(String(server.session))));
            result = { product: "phren-hook", protocol: PROTOCOL, computer: info.computer, servers: live.map(server => server.session),
              working: snapshots.reduce((sum, value) => sum + objects(value.panes).filter(pane => pane.agent && pane.agent_status === "working").length, 0),
              // Bounded so a peer's capacity probe never waits on a cold `claude auth status`; missing means unknown.
              // PHREN_LAUNCH_CHECK=off turns this Hook's availability checks off, including what it advertises to dispatch.
              ...(launchCheckOff() ? {} : await harnessInventoryWithin(2_500).then(inventory => inventory ? { harnesses: inventory.harnesses } : {})) };
            break;
          }
          case "/v1/speech/voices": {
            // The phone's voice picker: this computer's setting and the voices its account has.
            const key = await readSpeechKey();
            if (!key) throw new BridgeError(503, "Spoken replies aren't set up on this computer: it has no ElevenLabs key.", { code: "speech-unconfigured" });
            const current = await resolveSpeechVoice();
            result = { voice: current.voice, source: current.source, defaultVoice: DEFAULT_SPEECH_VOICE, voices: await listSpeechVoices(key) };
            break;
          }
          case "/v1/muxes": result = { muxes: muxListForClient(await servers(), url.searchParams.get("typed") === "1") }; break;
          case "/v1/activity": result = { events: await journal.recent() }; break;
          case "/v1/web-servers": result = { servers: await webServers() }; break;
          case "/v1/simulators": result = { simulators: await bootedSimulators() }; break;
          case "/v1/simulators/screenshot": {
            const bytes = await simulatorScreenshot(String(url.searchParams.get("udid") ?? ""));
            response.setHeader("Content-Type", "image/png"); response.end(bytes); return;
          }
          case "/v1/files": result = { files: await listUploads("files") }; break;
          case "/v1/files/range": {
            let root: string;
            if (url.searchParams.get("scope") === "uploads") {
              root = path.join(bridgeRoot(), "uploads");
            } else if (url.searchParams.has("session")) {
              const target = targetFromURL(url), pane = await validateTarget(target);
              const cwd = await gitRepository(pane, target, url.searchParams.get("child") ?? undefined, url.searchParams.get("worktree") ?? undefined);
              const repository = await gitRoot(cwd);
              if (!repository) throw new BridgeError(409, "This pane is not in a project repository.");
              root = repository;
            } else {
              const candidates = await locateProject(url.searchParams.get("project") ?? "", await journal.recent());
              const directory = url.searchParams.get("directory");
              const candidate = directory ? candidates.find(item => item.directory === directory) : candidates[0];
              if (!candidate) throw new BridgeError(404, "This project folder is not available on this computer.");
              root = candidate.directory;
            }
            result = await readFileRange(root, url.searchParams.get("path") ?? "",
              rangeInteger(url.searchParams.get("offset"), 0), rangeInteger(url.searchParams.get("length"), MAX_FILE_RANGE),
              url.searchParams.get("version") ?? undefined);
            break;
          }
          case "/v1/models": result = { models: await modelCatalog.list(String(url.searchParams.get("source") ?? ""), url.searchParams.get("account") ?? undefined) }; break;
          case "/v1/projects/files": {
            const candidates = await locateProject(String(url.searchParams.get("project") ?? ""), await journal.recent());
            const directory = url.searchParams.get("directory");
            const candidate = directory ? candidates.find(item => item.directory === directory) : candidates[0];
            if (!candidate) throw new BridgeError(404, "This project folder is not available on this computer.");
            result = await browseFiles(candidate.directory, url.searchParams.get("path") ?? ""); break;
          }
          case "/v1/uploads/image": {
            // A picture the phone sent, as the transcript names it by path.
            const bytes = await uploadImage(String(url.searchParams.get("path") ?? ""));
            response.setHeader("Content-Type", "application/octet-stream"); response.end(bytes); return;
          }
          case "/v1/simulators/apps": result = { apps: await simulatorApps(String(url.searchParams.get("udid") ?? "")) }; break;
          case "/v1/usage": {
            // A phone built before OpenCode Go rejects the whole response when it
            // meets a source it does not know, so a client names the sources it
            // understands and an older one gets the original four.
            const known = new Set((url.searchParams.get("sources") ?? "codex,claude,opencode,openrouter").split(",").map(s => s.trim()).filter(Boolean));
            // A phone built before Go's plan windows rejects a Go window with a
            // percentage and no dollar limit (and the whole answer with it), so
            // they go only to callers that ask with `goPlan=1`; others keep the
            // Go account and its message without windows.
            const goPlan = url.searchParams.get("goPlan") === "1";
            // Likewise one `claude` row: a phone that shipped before accounts refuses
            // two rows with one source, so extra Claude homes come only with `accounts=all`.
            const allAccounts = url.searchParams.get("accounts") === "all";
            const usage = await accountUsage.read(known, allAccounts);
            result = { ...usage, accounts: usageForCaller(usage.accounts, known, goPlan) };
            // `peers=1` (the memory-free `phren usage`): each linked computer's own answer too.
            if (url.searchParams.get("peers") === "1") result = { ...result as Json, computer: info.computer,
              ...await fromPeers(`/v1/usage?${new URLSearchParams({ sources: [...known].join(","), ...(goPlan ? { goPlan: "1" } : {}), ...(allAccounts ? { accounts: "all" } : {}) })}`) };
            break;
          }
          case "/v1/resources": {
            result = { computer: info.computer, resources: await resources.read() };
            if (url.searchParams.get("peers") === "1") result = { ...result as Json, ...await fromPeers("/v1/resources") };
            break;
          }
          case "/v1/push/status": result = agentHooks.push.status; break;
          case "/v1/projects/locate": {
            const candidates = await locateProject(String(url.searchParams.get("project") ?? ""), await journal.recent());
            for (const candidate of candidates) {
              locatedDirectories.delete(candidate.directory); locatedDirectories.add(candidate.directory);
              if (locatedDirectories.size > 128) locatedDirectories.delete(locatedDirectories.values().next().value!);
            }
            result = { candidates }; break;
          }
          case "/v1/projects/repos": result = { repos: await candidateRepos(await journal.recent()) }; break;
          case "/v1/workspaces": {
            const server = selectedServer(url);
            result = muxReplyForClient(await readWorkspaces(server, await snapshot(server), url.searchParams.get("watchApprovals") === "1"), typedMuxRequest(url));
            break;
          }
          case "/v1/workspaces/panes": result = muxReplyForClient(await panes(selectedServer(url), url.searchParams.get("groupId") || "", url.searchParams.get("childId") || ""), typedMuxRequest(url)); break;
          case "/v1/transcripts/blob": {
            const target = targetFromURL(url); await validateTarget(target);
            const inner = url.searchParams.get("inner");
            const bytes = await historicalImage(await targetTranscriptPath(target), Number(url.searchParams.get("line")), Number(url.searchParams.get("block")), target.source, inner === null ? undefined : Number(inner));
            response.setHeader("Content-Type", "application/octet-stream"); response.end(bytes); return;
          }
          case "/v1/transcripts/history": {
            const target = targetFromURL(url);
            const before = z.coerce.number().int().positive().parse(url.searchParams.get("beforeLine"));
            const abort = new AbortController();
            response.once("close", () => { if (!response.writableEnded) abort.abort(); });
            await validateTarget(target);
            const child = url.searchParams.get("child");
            const { reader, source, session } = child === null ? await conversationReader(target) : await childConversationReader(target, child);
            if (reader) await refreshTranscript(reader.file, source, session);
            const page = reader ? await reader.read(before, abort.signal) : emptyPage;
            result = { ...page, type: "older", source, session }; break;
          }
          case "/v1/subagents": {
            const target = targetFromURL(url); await validateTarget(target);
            const local = await childAgentTree(target.source, target.session, 0, new Set(), computerID);
            let remote: Awaited<ReturnType<typeof remoteChildren>> = [];
            let peerError: string | undefined;
            if (url.searchParams.get("remote") !== "0") {
              const { peers, peerError: reason } = await optionalHookPeers();
              peerError = reason;
              remote = await remoteChildren({ provider: target.source, session: target.session, computer: computerID },
                // A worker whose turn finished shows as a completed lead.
                (await dispatchStatus()).map(receipt => receipt.worker?.state === "done" ? { ...receipt, status: "completed" } : receipt), async receipt => {
                  const peer = peers.find(candidate => candidate.name === receipt.computer);
                  const remoteTarget = targetSchema.safeParse(receipt.target);
                  if (!peer || !remoteTarget.success) return;
                  const query = new URLSearchParams(Object.entries(remoteTarget.data).map(([key, value]) => [key, String(value)]));
                  query.set("remote", "0");
                  const snapshot = await peerRequest(peer, `/v1/subagents?${query}`);
                  return { target: remoteTarget.data, computer: snapshot.computer,
                    agents: Array.isArray(snapshot.agents) ? snapshot.agents : [] };
                });
            }
            result = { computer: info.computer, agents: publicChildAgents([...local, ...remote]), ...(peerError ? { peerError } : {}) }; break;
          }
          case "/v1/subagents/messages": {
            result = await fanoutMessages.list(targetFromURL(url), url.searchParams.get("child")); break;
          }
          case "/v1/subagents/transcript": {
            const target = targetFromURL(url); await validateTarget(target);
            const { reader, source, session } = await childConversationReader(target, z.string().parse(url.searchParams.get("child")));
            const page = await reader.read();
            result = { ...page, type: "backlog", source, session }; break;
          }
          case "/v1/code/tree": result = await (new CodeRoutes(await resolveCodeStore(scheduleStore, url.searchParams.get("store")))).tree(url.searchParams.get("project"), url.searchParams.get("directory")); break;
          case "/v1/code/changed": result = await (new CodeRoutes(await resolveCodeStore(scheduleStore, url.searchParams.get("store")))).whatChanged(url.searchParams.get("project")); break;
          case "/v1/code/change-counts": result = await (new CodeRoutes(await resolveCodeStore(scheduleStore, url.searchParams.get("store")))).changeCounts(url.searchParams.get("project"), url.searchParams.get("paths")); break;
          case "/v1/code/usage-page": result = await (new CodeRoutes(await resolveCodeStore(scheduleStore, url.searchParams.get("store")))).usagePage(url.searchParams.get("project"), {
            kind: url.searchParams.get("kind"), file: url.searchParams.get("file"), directory: url.searchParams.get("directory"),
            offset: url.searchParams.get("offset"), limit: url.searchParams.get("limit"), end: url.searchParams.get("end"),
          }); break;
          case "/v1/code/status": result = await (new CodeRoutes(await resolveCodeStore(scheduleStore, url.searchParams.get("store")))).status(url.searchParams.get("project")); break;
          case "/v1/code/search": result = await (new CodeRoutes(await resolveCodeStore(scheduleStore, url.searchParams.get("store")))).search(url.searchParams.get("project"), url.searchParams.get("q"), url.searchParams.get("kind"), url.searchParams.get("limit"), url.searchParams.get("directory")); break;
          case "/v1/code/outline-summary": result = await (new CodeRoutes(await resolveCodeStore(scheduleStore, url.searchParams.get("store")))).outlineSummary(url.searchParams.get("project"), url.searchParams.get("paths")); break;
          case "/v1/code/file-references": result = await (new CodeRoutes(await resolveCodeStore(scheduleStore, url.searchParams.get("store")))).fileReferences(url.searchParams.get("project"), url.searchParams.get("path")); break;
          case "/v1/code/outline": result = await (new CodeRoutes(await resolveCodeStore(scheduleStore, url.searchParams.get("store")))).outline(url.searchParams.get("project"), url.searchParams.get("path")); break;
          case "/v1/code/definition": result = await (new CodeRoutes(await resolveCodeStore(scheduleStore, url.searchParams.get("store")))).definition(url.searchParams.get("project"), (url.searchParams.get("name") ?? url.searchParams.get("symbol"))); break;
          case "/v1/code/references": result = await (new CodeRoutes(await resolveCodeStore(scheduleStore, url.searchParams.get("store")))).references(url.searchParams.get("project"), (url.searchParams.get("name") ?? url.searchParams.get("symbol")), url.searchParams.get("limit")); break;
          case "/v1/code/usage": result = await (new CodeRoutes(await resolveCodeStore(scheduleStore, url.searchParams.get("store")))).usage(url.searchParams.get("project"), url.searchParams.get("top")); break;
          default: throw new BridgeError(404, "Unknown Phren Hook route.");
        }
      } else if (request.method === "POST") {
        const data = await body(request);
        if (url.pathname === "/v1/subagents/resume") {
          result = await fanoutMessages.send(data);
        } else if (url.pathname === "/v1/subagents/archive-finished") {
          result = await fanoutMessages.archiveFinished(data);
        } else if (url.pathname === "/v1/code/disable") {
          result = await (new CodeRoutes(await resolveCodeStore(scheduleStore, typeof data.store === "string" ? data.store : undefined, true)))
            .disable(z.string().parse(data.project));
        } else if (url.pathname === "/v1/code/reindex") {
          result = await (new CodeRoutes(await resolveCodeStore(scheduleStore, typeof data.store === "string" ? data.store : undefined, true)))
            .reindex(z.string().parse(data.project));
        } else if (url.pathname === "/v1/code/note") {
          result = await saveCodeNote(await resolveCodeStore(scheduleStore, typeof data.store === "string" ? data.store : undefined, true), data, dispatches ? async (note, prompt) => {
            if (note.target && "session" in note.target) return handOff({ session: note.target.session, project: note.project, text: prompt });
            return dispatches.dispatch({ computer: "anywhere", project: note.project,
              harness: note.target && "harness" in note.target ? note.target.harness : "codex", prompt, label: `Code note: ${note.symbol}`.slice(0, 200) });
          } : undefined);
        } else if (url.pathname === "/v1/sessions/rename") {
          result = await renameSession(selectedServer(url), data);
        } else if (url.pathname === "/v1/schedules") {
          result = await scheduler!.statuses();
        } else if (url.pathname === "/v1/schedules/run") {
          const input = z.object({ project: z.string().min(1).max(200), id: z.string().regex(/^[a-f0-9]{8}$/) }).parse(data);
          result = { ok: true, run: await scheduler!.launchNow(input.project, input.id) };
        } else if (url.pathname === "/v1/schedules/history") {
          const input = z.object({ project: z.string().min(1).max(200).optional(), id: z.string().regex(/^[a-f0-9]{8}$/).optional(),
            limit: z.number().int().min(1).max(500).optional() }).parse(data);
          result = { runs: await scheduler!.history(input) };
        } else if (url.pathname === "/v1/canary") {
          result = await canary("manual");
        } else if (url.pathname === "/v1/speech") {
          // Audio, not JSON: the route writes its own response.
          await streamSpeech(data, response);
          return;
        } else if (url.pathname === "/v1/dispatch") {
          // `origin` is the caller's own pane, added by the MCP tool or CLI from Herdr's variables.
          const { origin, ...brief } = data;
          result = await dispatches!.dispatch(brief, origin);
        } else if (url.pathname === "/v1/dispatch/workers") {
          result = await hookWorkers(agentHooks)(data);
        } else if (url.pathname === "/v1/dispatch/returns") {
          result = { returns: await ctx.returns!.take() };
        } else if (url.pathname === "/v1/dispatch/approve") {
          const body = z.object({ id: z.string().uuid(), decision: z.enum(["approve", "deny"]), actionId: z.string().min(1).max(200), origin: originPaneSchema.optional() }).strict().parse(data);
          await ctx.returns!.answerApproval(body.id, body.decision, body.actionId, body.origin); result = { ok: true };
        } else if (url.pathname === "/v1/conductor/grants") {
          result = { ok: true, grant: await addGrant(data) };
        } else if (url.pathname === "/v1/authority" || url.pathname === "/v1/authority/confirm") {
          // The owner writes the policy from the phone; an agent's call names its pane.
          if (data.origin !== undefined) throw new BridgeError(403, "Only the owner changes the release authority policy, from the phone or `phren authority` in their own terminal.");
          result = url.pathname === "/v1/authority" ? { ok: true, authority: await setProjectAuthority(data, "phone") }
            : { ok: true, confirmation: await confirmAuthority(data, "phone") };
        } else if (url.pathname === "/v1/push/register") {
          // Registration is kept for when a key is added; the reply says whether push works now.
          await agentHooks.push.register(data); result = { ok: true, configured: agentHooks.push.status.configured };
        } else if (url.pathname === "/v1/push/answer") {
          await agentHooks.answerPush(z.string().uuid().parse(data.binding), data.decision); result = { ok: true };
        } else if (url.pathname === "/v1/push/target") {
          // A tapped notification opens its session; the binding stays unspent.
          const target = agentHooks.pushTarget(z.string().uuid().parse(data.binding));
          if (!target) throw new BridgeError(409, "This approval is no longer pending.");
          result = { target: { server: target.server, workspace: target.workspace, tab: target.tab, pane: target.pane, source: target.source } };
        } else if (url.pathname === "/v1/files") {
          // Files the phone keeps on this computer, outside any session.
          const { name, bytes } = uploadBody(data);
          result = { ok: true, path: await saveUpload("files", name, bytes) };
        } else if (url.pathname === "/v1/projects/add") {
          // Enrolling a repository with phren from the phone: an existing
          // checkout, or a clone. Serialized like launches — one at a time.
          result = await launches.run(async () => enrollProject(z.object({ directory: z.string().max(4096).optional(), cloneUrl: z.string().max(512).optional() }).parse(data)));
        } else if (url.pathname === "/v1/simulators/action") {
          result = await simulatorAct(z.string().parse(data.udid), z.object({ action: z.string(), bundleId: z.string().optional(), url: z.string().optional(), x: z.number().optional(), y: z.number().optional(), text: z.string().optional(), submit: z.boolean().optional() }).parse(data) as unknown as SimulatorAction);
        } else {
        if (url.pathname === "/v1/workspaces/launch") {
          result = await launches.run(async () => {
            if (data.role === "conductor" && !modules.has("conductor")) throw new BridgeError(404, disabledHint("conductor"));
            if (data.project !== undefined && data.cwd !== undefined) throw new BridgeError(400, "Choose project or cwd, not both.");
            // A conductor belongs to no one project: without a folder it starts in
            // this computer's phren store and dispatches into any project from there.
            const storeRooted = data.role === "conductor" && data.project === undefined && (data.cwd === undefined || data.cwd === "");
            const cwd = storeRooted ? await launchDirectory(defaultPhrenPath(), [], [defaultPhrenPath()])
              : data.project !== undefined ? await dispatchProjectDirectory(data.project)
              : await launchDirectory(data.cwd, await journal.recent(), locatedDirectories);
            // A project the Hook resolved (a dispatch) is a folder it may trust; a folder the phone named is not.
            return launchSession(selectedServer(url), { ...data, cwd }, { trustFolder: data.project !== undefined });
          });
        } else if (url.pathname.startsWith("/v1/workspaces/")) {
          const operation = url.pathname.split("/").at(-1)!;
          result = operation === "create" ? await launches.run(async () => workspaceAction(selectedServer(url), operation,
            { ...data, cwd: await launchDirectory(data.cwd ?? homeDir(), await journal.recent(), locatedDirectories) }))
            : await workspaceAction(selectedServer(url), operation, data);
        } else {
          result = await paneRoute(ctx, url, data, response);
        }
      }
      } else if (request.method === "DELETE") {
        if (url.pathname !== "/v1/conductor/grants" && url.pathname !== "/v1/authority") throw new BridgeError(404, "Unknown Phren Hook route.");
        const data = await body(request);
        if (url.pathname === "/v1/authority") {
          if (data.origin !== undefined) throw new BridgeError(403, "Only the owner changes the release authority policy, from the phone or `phren authority` in their own terminal.");
          result = { ok: true, authority: await clearProjectAuthority(data, "phone") };
        } else result = { ok: true, grant: await removeGrant(data) };
      } else throw new BridgeError(405, "Unsupported request method.");
      const payload = JSON.stringify(result);
      if (Buffer.byteLength(payload) > MAX_FRAME) throw new BridgeError(413, "The response is too large.");
      response.setHeader("Content-Type", "application/json"); response.end(payload);
    } catch (error) {
      response.statusCode = error instanceof BridgeError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ error: error instanceof BridgeError ? error.message : "Phren Hook could not complete this request. Run phren bridge doctor on the computer.",
        ...(error instanceof BridgeError ? error.details : {}) }));
    }
  };
}

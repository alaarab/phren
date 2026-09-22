import { saveCodeNote } from "./code-note.js";
import { handOff } from "./hand-off.js";
import { activateModules as moduleSnapshot, type ModuleSnapshot } from "../modules/runtime.js";
import { BUILTIN_MODULES, disabledHint } from "../modules/registry.js";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { cpus, hostname, loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { ActivityJournal } from "./activity.js";
import { AgentHooks } from "./agent-hooks.js";
import { homeDirectory, startChangeRetention } from "./changes.js";
import { CodeReindexer, CodeRoutes } from "./code-routes.js";
import { queuedQuestion, threadHealth } from "./codex-threads.js";
import { WorkspaceContextUsage } from "./context.js";
import { DispatchService, dispatchProjectDirectory, dispatchStatus } from "./dispatch.js";
import { remoteChildren } from "./dispatch-tree.js";
import { addGrant, listGrants, removeGrant } from "./grants.js";
import { hookPeers, peerRequest } from "./peers.js";
import { candidateRepos, enrollProject } from "./enroll.js";
import { browseFiles } from "./files.js";
import { gitBranches, gitDiscard, gitLog, gitPulls, gitStage, gitStatus, gitTree, gitUnstage } from "./git.js";
import { paneChatState, paneIdentity, panes, rpc, servers, snapshot, trustedDirectory, validateStartingTarget, validateTarget, workspaceSnapshot, startingPane } from "./herdr.js";
import { LaunchLimiter } from "./limits.js";
import { locateProject } from "./locate.js";
import { launchDirectory, repositoryBranch, repositoryDiff, webServers } from "./projects.js";
import { atomic, BridgeError, bridgeRoot, id, type Json, MAX_FRAME, object, objects, PROTOCOL, provider, type Provider, serverName, socketPath, startingTargetSchema, type Target, targetFromURL, targetSchema } from "./protocol.js";
import { CodexQuestions } from "./questions.js";
import { bootedSimulators, type SimulatorAction, simulatorAct, simulatorApps, simulatorScreenshot } from "./simulators.js";
import { TabActivityStore } from "./tab-activity.js";
import { childAgent, childAgentTree, conversationNamedPaths, historicalImage, publicChildAgents, refreshTranscript, TranscriptReader, transcriptPath } from "./transcripts.js";
import { listUploads, saveUpload, uploadImage } from "./uploads.js";
import { ModelCatalog } from "./models.js";
import { currentModel, currentStep } from "./steps.js";
import { AccountUsageReader } from "./usage.js";
import { createScheduleLauncher, Scheduler, scheduleRunsFile } from "./schedules.js";
import { defaultPhrenPath } from "../shared.js";
import { loadCodePackage, loadedFrom } from "../modules/code-package.js";

const CHILD_ACTIVITY_CACHE_MS = 5_000;
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
  terminal: "ssh-pty", shell: "ssh-pty", herdr: true, diff: true, webServers: true, webPreview: "ssh-exec", activity: true,
  approvals: true, questions: false, accountUsage: true, providers: ["codex", "claude", "copilot", "opencode"],
  files: true, repositoryFiles: true, subagents: true, dispatch: true, approvalPush: "direct-apns", simulators: process.platform === "darwin", code: true };

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


/** A file from the phone: a plain name and base64 bytes, bounded. */
function uploadBody(data: Json): { name: string; bytes: Buffer } {
  const name = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_ .()-]{0,199}$/).refine(n => !n.includes("..")).parse(data.name);
  const encoded = z.string().max(11_184_812).regex(/^[A-Za-z0-9+/]*={0,2}$/).parse(data.data);
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > MAX_FRAME) throw new BridgeError(413, "The file is empty or too large.");
  return { name, bytes };
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

function selectedServer(url: URL): string {
  const mux = url.searchParams.get("mux");
  if (mux && !mux.startsWith("herdr:")) throw new BridgeError(400, "Select a Herdr server.");
  return serverName.parse(url.searchParams.get("server") || mux?.slice(6) || "default");
}

function send(socket: WebSocket, frame: unknown) {
  if (socket.readyState !== WebSocket.OPEN) return;
  const data = JSON.stringify(frame);
  if (Buffer.byteLength(data) > MAX_FRAME || socket.bufferedAmount > MAX_FRAME) { socket.close(1009, "Reconnect to resume the conversation"); return; }
  socket.send(data);
}

/** The repository a git route acts on: the pane's trusted directory, or a
 * spawned child's own worktree exactly as /v1/diff resolves it. */
async function gitRepository(pane: Json, target: Target, child: unknown): Promise<string> {
  const id = z.string().regex(/^[a-f0-9]{32}$/).optional().parse(child);
  if (id !== undefined) {
    const relation = childAgent(await childAgentTree(target.source, target.session), id);
    if (!relation) throw new BridgeError(404, "That agent is not part of this conversation.");
    return relation.cwd ?? await trustedDirectory(pane);
  }
  return trustedDirectory(pane);
}

export async function serve(version: string): Promise<void> {
  process.umask(0o077);
  const modules = moduleSnapshot(defaultPhrenPath(), undefined, true);
  if (!modules.has("hook")) throw new BridgeError(404, disabledHint("hook"));
  const activeCapabilities = capabilitiesForModules(modules);
  const root = bridgeRoot();
  await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
  let computerID: string;
  const identityFile = path.join(root, "computer-id");
  try { computerID = (await readFile(identityFile, "utf8")).trim(); }
  catch { computerID = randomUUID(); await writeFile(identityFile, computerID, { flag: "wx", mode: 0o600 }); }
  const launches = new LaunchLimiter();
  const dispatches = modules.has("conductor")
    ? new DispatchService({ computerID, validateParentTarget: target => validateTarget(target, false, true) })
    : undefined;
  const locatedDirectories = new Set<string>();
  const journal = new ActivityJournal();
  const agentHooks = new AgentHooks(undefined, modules);
  const modelCatalog = new ModelCatalog();
  const contextUsage = new WorkspaceContextUsage();
  const accountUsage = new AccountUsageReader();
  const tabActivity = new TabActivityStore();
  const codexQuestions = new CodexQuestions();
  const scheduleStore = defaultPhrenPath();
  const scheduler = modules.has("schedules") ? new Scheduler({ now: () => new Date(), store: scheduleStore, runsFile: scheduleRunsFile(),
    launch: createScheduleLauncher((server, data) => launchSession(server, data), scheduleStore),
    push: { notify: value => agentHooks.push.notifySchedule(value) },
    locateProject: async project => (await locateProject(project, await journal.recent()))[0]?.directory }) : undefined;
  const codeRoutes = modules.has("code") ? new CodeRoutes(scheduleStore) : undefined;
  // The code module follows the git module's recorded file changes: an
  // incremental re-index after a save, a full one after a branch switch.
  const codeReindexer = codeRoutes ? new CodeReindexer({ store: scheduleStore }) : undefined;
  if (codeReindexer) agentHooks.changes.onRecord = files => codeReindexer.record(files);
  // The node gateway writes its own cost after the first response byte, so a
  // health read reflects the most recent node-path connection, if any.
  function gatewayTiming(): number | undefined {
    try {
      const parsed = JSON.parse(readFileSync(path.join(root, "gateway.json"), "utf8")) as { ms?: unknown };
      if (typeof parsed.ms === "number" && Number.isFinite(parsed.ms) && parsed.ms >= 0) return Math.round(parsed.ms);
    } catch { /* the node gateway has not answered yet */ }
    return undefined;
  }
  const info = { product: "phren-hook", protocol: PROTOCOL, version, computer: { id: computerID, name: hostname() }, capabilities: activeCapabilities,
    modules: Object.fromEntries(modules.modules.map(module => [module.name, module.version])),
    store: modules.store, profile: modules.profile, generation: modules.generation,
    get load() { return { average: Number(loadavg()[0].toFixed(2)), cpus: cpus().length }; },
    get gatewayMs() { return gatewayTiming(); } };
  const old = await lstat(socketPath()).catch(() => null);
  if (old) {
    if (!old.isSocket() || (process.getuid && old.uid !== process.getuid())) throw new Error("Refusing to replace an unexpected hook socket.");
    // The service manager owns process lifetime. Only remove a stale socket.
    const { connect } = await import("node:net");
    const live = await new Promise<boolean>(resolve => { const s = connect(socketPath()); s.on("connect", () => { s.destroy(); resolve(true); }); s.on("error", () => resolve(false)); });
    if (live) throw new Error("Phren Hook is already running.");
    await unlink(socketPath());
  }

  const stopRetention = modules.has("git") ? await startChangeRetention() : () => {};
  if (modules.has("git")) await rm(path.join(root, "changes-scratch"), { recursive: true, force: true });
  const http = createServer(async (request, response) => {
    response.setHeader("X-Phren-Protocol", String(PROTOCOL));
    response.setHeader("Cache-Control", "no-store");
    try {
      const url = new URL(request.url || "/", "http://phren.local");
      if (url.origin !== "http://phren.local") throw new BridgeError(400, "Invalid request origin.");
      requireRoute(modules, request.method ?? "", url.pathname);
      let result: unknown;
      if (request.method === "GET") {
        switch (url.pathname) {
          case "/v1/health": result = { ...info, codePackage: await codePackageStatus(scheduleStore, modules.has("code")) }; break;
          case "/v1/dispatch": result = { dispatches: await dispatchStatus() }; break;
          case "/v1/conductor/grants": result = { grants: await listGrants() }; break;
          case "/v1/dispatch/capacity": {
            const live = await servers();
            const snapshots = await Promise.all(live.map(server => snapshot(String(server.session))));
            result = { product: "phren-hook", protocol: PROTOCOL, computer: info.computer, servers: live.map(server => server.session),
              working: snapshots.reduce((sum, value) => sum + objects(value.panes).filter(pane => pane.agent && pane.agent_status === "working").length, 0) };
            break;
          }
          case "/v1/muxes": result = { muxes: await servers() }; break;
          case "/v1/activity": result = { events: await journal.recent() }; break;
          case "/v1/web-servers": result = { servers: await webServers() }; break;
          case "/v1/simulators": result = { simulators: await bootedSimulators() }; break;
          case "/v1/simulators/screenshot": {
            const bytes = await simulatorScreenshot(String(url.searchParams.get("udid") ?? ""));
            response.setHeader("Content-Type", "image/png"); response.end(bytes); return;
          }
          case "/v1/files": result = { files: await listUploads("files") }; break;
          case "/v1/models": result = { models: await modelCatalog.list(String(url.searchParams.get("source") ?? "")) }; break;
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
            const usage = await accountUsage.read();
            result = { ...usage, accounts: usage.accounts.filter(account => known.has(account.source)) };
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
            const server = selectedServer(url), s = await snapshot(server);
            const lastChanged = await tabActivity.observe(server, s);
            if (url.searchParams.get("watchApprovals") === "1") agentHooks.overview.renew(server);
            const context = await contextUsage.read(server, s);
            await journal.record(server, objects(s.panes));
            const chatStates = new Map(await Promise.all(objects(s.panes).filter(p => p.agent).map(async p =>
              [p, await paneChatState(server, p).catch((): Json => ({}))] as const)));
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
            let nextTab = 0;
            // Bound transcript and git work across tabs. Each worker owns one
            // response row; snapshot order and target validation are unchanged.
            await Promise.all(Array.from({ length: Math.min(4, tabs.length) }, async () => {
              while (nextTab < tabs.length) {
                const { group, tab } = tabs[nextTab++];
                const agents = agentsByTab.get(JSON.stringify([group.id, tab.id])) ?? [];
                if (agents.length === 1) {
                  const chat = chatStates.get(agents[0]);
                  if (chat?.starting === true) tab.starting = true;
                  if (typeof chat?.sessionId === "string" && provider.safeParse(agents[0].agent).success) {
                    tab.target = { server, workspace: group.id, tab: tab.id, pane: agents[0].pane_id,
                      source: agents[0].agent, session: chat.sessionId };
                  }
                }
                if (modules.has("git") && typeof tab.cwd === "string" && tab.agent) tab.branch = await repositoryBranch(tab.cwd);
                // The model the pane's agent is running, and what it is doing
                // right now, for cards and the lock screen.
                if (agents.length === 1 && provider.safeParse(agents[0].agent).success) {
                  const session = chatStates.get(agents[0])?.sessionId;
                  tab.runningChildren = 0; tab.childProviders = [];
                  if (typeof session === "string") {
                    const source = agents[0].agent as Provider;
                    const [model, children] = await Promise.all([
                      currentModel(source, session).catch(() => undefined), childActivity(source, session),
                    ]);
                    if (model) tab.model = model;
                    tab.runningChildren = children.runningChildren; tab.childProviders = children.childProviders;
                    if (agents[0].agent_status === "working") {
                      const step = await currentStep(source, session).catch(() => undefined);
                      if (step) tab.currentStep = step;
                    }
                  }
                }
              }
            }));
            result = { ...workspaces, phren: info }; break;
          }
          case "/v1/workspaces/panes": result = await panes(selectedServer(url), url.searchParams.get("groupId") || "", url.searchParams.get("childId") || ""); break;
          case "/v1/transcripts/blob": {
            const target = targetFromURL(url); await validateTarget(target);
            const inner = url.searchParams.get("inner");
            const bytes = await historicalImage(await transcriptPath(target.source, target.session), Number(url.searchParams.get("line")), Number(url.searchParams.get("block")), target.source, inner === null ? undefined : Number(inner));
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
            if (url.searchParams.get("remote") !== "0") {
              const peers = await hookPeers().catch(() => []);
              remote = await remoteChildren({ provider: target.source, session: target.session, computer: computerID },
                await dispatchStatus(), async receipt => {
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
            result = { computer: info.computer, agents: publicChildAgents([...local, ...remote]) }; break;
          }
          case "/v1/subagents/transcript": {
            const target = targetFromURL(url); await validateTarget(target);
            const { reader, source, session } = await childConversationReader(target, z.string().parse(url.searchParams.get("child")));
            const page = await reader.read();
            result = { ...page, type: "backlog", source, session }; break;
          }
          case "/v1/code/status": result = await codeRoutes!.status(url.searchParams.get("project")); break;
          case "/v1/code/search": result = await codeRoutes!.search(url.searchParams.get("project"), url.searchParams.get("q"), url.searchParams.get("kind"), url.searchParams.get("limit")); break;
          case "/v1/code/outline": result = await codeRoutes!.outline(url.searchParams.get("project"), url.searchParams.get("path")); break;
          case "/v1/code/definition": result = await codeRoutes!.definition(url.searchParams.get("project"), url.searchParams.get("symbol")); break;
          case "/v1/code/references": result = await codeRoutes!.references(url.searchParams.get("project"), url.searchParams.get("symbol"), url.searchParams.get("limit")); break;
          case "/v1/code/usage": result = await codeRoutes!.usage(url.searchParams.get("project"), url.searchParams.get("top")); break;
          default: throw new BridgeError(404, "Unknown Phren Hook route.");
        }
      } else if (request.method === "POST") {
        const data = await body(request);
        if (url.pathname === "/v1/code/note") {
          result = await saveCodeNote(scheduleStore, data, dispatches ? async (note, prompt) => {
            if (note.target && "session" in note.target) return handOff({ session: note.target.session, project: note.project, text: prompt });
            return dispatches.dispatch({ computer: "anywhere", project: note.project,
              harness: note.target && "harness" in note.target ? note.target.harness : "codex", prompt, label: `Code note: ${note.symbol}`.slice(0, 200) });
          } : undefined);
        } else if (url.pathname === "/v1/schedules") {
          result = await scheduler!.statuses();
        } else if (url.pathname === "/v1/schedules/run") {
          const input = z.object({ project: z.string().min(1).max(200), id: z.string().regex(/^[a-f0-9]{8}$/) }).parse(data);
          result = { ok: true, run: await scheduler!.launchNow(input.project, input.id) };
        } else if (url.pathname === "/v1/schedules/history") {
          const input = z.object({ project: z.string().min(1).max(200).optional(), id: z.string().regex(/^[a-f0-9]{8}$/).optional(),
            limit: z.number().int().min(1).max(500).optional() }).parse(data);
          result = { runs: await scheduler!.history(input) };
        } else if (url.pathname === "/v1/dispatch") {
          result = await dispatches!.dispatch(data);
        } else if (url.pathname === "/v1/conductor/grants") {
          result = { ok: true, grant: await addGrant(data) };
        } else if (url.pathname === "/v1/push/register") {
          await agentHooks.push.register(data); result = { ok: true };
        } else if (url.pathname === "/v1/push/answer") {
          await agentHooks.answerPush(z.string().uuid().parse(data.binding), data.decision); result = { ok: true };
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
            const cwd = data.project !== undefined ? await dispatchProjectDirectory(data.project)
              : await launchDirectory(data.cwd, await journal.recent(), locatedDirectories);
            return launchSession(selectedServer(url), { ...data, cwd });
          });
        } else if (url.pathname.startsWith("/v1/workspaces/")) {
          const operation = url.pathname.split("/").at(-1)!;
          result = operation === "create" ? await launches.run(async () => workspaceAction(selectedServer(url), operation,
            { ...data, cwd: await launchDirectory(data.cwd ?? homeDirectory(), await journal.recent(), locatedDirectories) }))
            : await workspaceAction(selectedServer(url), operation, data);
        } else {
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
            await rpc(target.server, "agent.prompt", { target: target.pane, text });
            // A first prompt may create its transcript immediately. Recheck the
            // terminal/process binding, not the absence of a session. Never retry.
            let confirmed = false;
            try {
              const current = objects((await snapshot(target.server)).panes).find(p => p.pane_id === target.pane && p.tab_id === target.tab && p.workspace_id === target.workspace && p.agent === target.source);
              confirmed = !!current && current.terminal_id === pane.terminal_id && (await paneChatState(target.server, current)).startingToken === target.startingToken;
            } catch { /* Already delivered; an uncertain reply must not resend. */ }
            result = { ok: true, ...(!confirmed ? { deliveryUncertain: true } : {}) };
          } else {
          const target = targetSchema.parse(data.target);
          // Uploads store bytes without answering or interrupting the agent.
          // They still require fresh identity, just like prompt mutations.
          const sendsInput = ["/v1/prompt", "/v1/keys", "/v1/secret"].includes(url.pathname);
          // A key press is how a prompt the agent draws in its terminal gets
          // answered, so keys are the one input allowed while the agent is
          // blocked or waiting; the status check below is theirs alone.
          const pane = await validateTarget(target, false, sendsInput || url.pathname === "/v1/upload");
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
                const current = objects((await snapshot(target.server)).panes).find(p => p.pane_id === target.pane && p.tab_id === target.tab && p.workspace_id === target.workspace && p.agent === target.source);
                confirmed = !!current && current.terminal_id === pane.terminal_id && await paneIdentity(target.server, current, true) === target.session;
              } catch { /* No reliable post-delivery identity. */ }
              result = { ok: true, ...(!confirmed ? { deliveryUncertain: true } : {}) };
            }
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
              // A digit chosen from a parsed terminal dialog also needs Enter to
              // submit the selection; the phone only sends the option's key.
              const answerKeys = agentHooks.dialogAnswerKeys(target, keys);
              await rpc(target.server, "agent.send_keys", { target: target.pane, keys: answerKeys.map(key => HERDR_KEYS[key] ?? key) });
              // A remembered prompt is answered by any key but a cursor move; the
              // menu window stays open through Enter because some choices (Codex
              // full access) open a second confirmation the Hook now walks itself.
              if (keys.some(key => key !== "Up" && key !== "Down" && key !== "Tab")) { agentHooks.clearTerminalPrompt(target); agentHooks.releaseChoice(target); }
              if (keys.includes("Escape")) agentHooks.menuClosed(target);
              // Enter on Codex's /permissions menu may open "Enable full access?".
              // Watch the pane's lines for it, answer with 1 then Enter, and only
              // then close the window; a prompt that never arrives is reported as
              // still waiting with the visible text for the phone's question card.
              if (keys.includes("Enter") && menu && target.source === "codex"
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
            if (child !== undefined) {
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
            const cwd = await gitRepository(pane, target, data.child);
            if (url.pathname === "/v1/git/status") result = await gitStatus(cwd);
            else if (url.pathname === "/v1/git/log") result = await gitLog(cwd, z.coerce.number().int().min(1).max(200).optional().parse(data.limit) ?? 60, z.string().min(1).max(512).optional().parse(data.ref));
            else if (url.pathname === "/v1/git/branches") result = await gitBranches(cwd);
            else if (url.pathname === "/v1/git/pulls") result = await gitPulls(cwd);
            else if (url.pathname === "/v1/git/tree") result = await gitTree(cwd, z.string().max(4096).optional().parse(data.path) ?? "");
            else if (url.pathname === "/v1/git/stage") result = await gitStage(cwd, data.paths);
            else if (url.pathname === "/v1/git/unstage") result = await gitUnstage(cwd, data.paths);
            else if (url.pathname === "/v1/git/discard") result = await gitDiscard(cwd, data.paths);
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
        }
      }
      } else if (request.method === "DELETE") {
        if (url.pathname !== "/v1/conductor/grants") throw new BridgeError(404, "Unknown Phren Hook route.");
        const data = await body(request);
        result = { ok: true, grant: await removeGrant(data) };
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
  });
  http.requestTimeout = 20_000; http.headersTimeout = 10_000; http.maxHeadersCount = 32;
  const ws = new WebSocketServer({ noServer: true, maxPayload: 65_536, perMessageDeflate: false });
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
  http.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url || "/", "http://phren.local");
      if (!["/v1/transcripts", "/v1/status"].includes(url.pathname) || url.origin !== "http://phren.local") { socket.destroy(); return; }
      requireRoute(modules, "WS", url.pathname);
      ws.handleUpgrade(request, socket, head, client => {
        while (ws.clients.size > 16) {
          const oldest = ws.clients.values().next().value!;
          oldest.close(1008, "Too many connections; reconnect"); oldest.terminate();
          ws.clients.delete(oldest);
        }
        void stream(client, url).catch(() => client.close(1011, "Conversation unavailable; refresh"));
      });
    } catch { socket.destroy(); }
  });
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
    // A child agent's transcript streams through the same socket, bound to
    // the parent conversation: the parent target is what gets revalidated
    // each tick, and the frames name the child by its parent-scoped id.
    const child = url.pathname === "/v1/transcripts" ? url.searchParams.get("child") : null;
    const cursor = url.pathname === "/v1/transcripts" ? url.searchParams.get("afterLine") : null;
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
          const pane = first ? initialPane : await validateTarget(target);
          if (awaitingTranscript) await findTranscript();
          if (awaitingTranscript) {
            if (first) send(client, { ...emptyPage, type: "backlog", ...conversation });
          } else if (reader) {
            await refreshTranscript(reader.file, conversation.source, conversation.session);
            const page = resumeAfterLine === undefined
              ? await reader.read(undefined, abort.signal)
              : await reader.readAfter(resumeAfterLine, abort.signal);
            resumeAfterLine = undefined;
            if (first || page.entries.length || page.reset) send(client, { ...page, type: first || page.reset ? "backlog" : "append", ...conversation });
          } else {
            const pendingApproval = agentHooks.approval(target);
            const pendingQuestions = target.source === "codex" ? await codexQuestions.pending(target).catch(() => undefined) : undefined;
            const cwd = await trustedDirectory(pane).catch(() => undefined);
            const branch = modules.has("git") && cwd ? await repositoryBranch(cwd) : undefined;
            const waiting = !pendingApproval && ["blocked", "waiting"].includes(String(pane.agent_status));
            // Claude Code's auto-mode fallback, opencode and Codex draw a
            // numbered dialog in the pane with no PermissionRequest hook
            // behind it: read the pane (at most once per three seconds) and
            // publish the dialog as the same terminal choice shape the phone
            // answers. Codex joins in when no held approval and no structured
            // question is already asking.
            if (["claude", "opencode", "codex"].includes(target.source)) {
              await agentHooks.syncTerminalDialog(target, waiting && !pendingQuestions?.length);
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
          first = false;
        }
        while (pending.length && reader && !abort.signal.aborted) {
          const before = pending.shift()!;
          await validateTarget(target);
          const page = await reader.read(before, abort.signal);
          send(client, { ...page, type: "older", ...conversation });
        }
      } catch { stop(); client.close(1011, "The conversation changed; refresh"); }
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
      timer = setInterval(() => { void tick(); }, reader || awaitingTranscript ? 500 : 1500);
      await tick();
    } catch (error) { stop(); throw error; }
  }
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(socketPath(), () => resolve()); });
  await chmod(socketPath(), 0o600);
  await agentHooks.start();
  void scheduler?.tick().catch(() => {});
  const scheduleTimer = scheduler ? setInterval(() => { void scheduler.tick().catch(() => {}); }, 30_000) : undefined;
  let recording = false;
  const activityTimer = setInterval(() => {
    if (recording) return;
    recording = true;
    void (async () => {
      const live = await servers();
      await tabActivity.pruneServers(live.map(server => String(server.session)));
      for (const server of live) {
        try {
          const name = String(server.session), current = await snapshot(name);
          await tabActivity.observe(name, current);
          await journal.record(name, objects(current.panes));
        }
        catch { /* A disconnected computer keeps its previous local activity. */ }
      }
    })().finally(() => { recording = false; }).catch(() => {});
  }, 5000);
  await new Promise<void>(resolve => {
    const stop = () => { stopRetention(); clearInterval(scheduleTimer); clearInterval(activityTimer); scheduler?.close(); codeReindexer?.close(); agentHooks.close(); ws.clients.forEach(c => c.terminate()); ws.close(); http.close(() => resolve()); http.closeAllConnections(); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
  });
  await unlink(socketPath()).catch(() => {});
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

const launchKinds = ["codex", "claude", "copilot", "opencode"] as const;
const plainText = (max: number) => z.string().min(1).max(max).refine(t => !/[\x00-\x1f\x7f]/.test(t));
declare const CONDUCTOR_SKILL_SOURCE: string | undefined;

async function conductorBrief(): Promise<string> {
  let source: string | undefined;
  if (typeof CONDUCTOR_SKILL_SOURCE === "string") source = CONDUCTOR_SKILL_SOURCE;
  else {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const candidate of [
      path.join(here, "..", "starter", "global", "skills", "conductor", "SKILL.md"),
      path.join(here, "..", "..", "starter", "global", "skills", "conductor", "SKILL.md"),
    ]) {
      source = await readFile(candidate, "utf8").catch(() => undefined);
      if (source !== undefined) break;
    }
  }
  if (source === undefined) throw new BridgeError(503, "The shipped conductor brief is unavailable. Reinstall Phren Hook.");
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(source);
  const brief = (match?.[1] ?? source).trim();
  if (!brief) throw new BridgeError(503, "The shipped conductor brief is empty. Reinstall Phren Hook.");
  return brief;
}

async function prepareConductor(kind: (typeof launchKinds)[number], effort: "low" | "medium" | "high", model?: string): Promise<string[]> {
  const brief = await conductorBrief();
  const briefDirectory = path.join(bridgeRoot(), "conductor");
  await mkdir(briefDirectory, { recursive: true, mode: 0o700 });
  const briefFile = path.join(briefDirectory, "brief.md");
  if (await readFile(briefFile, "utf8").catch(() => undefined) !== brief + "\n") await atomic(briefFile, brief + "\n");
  if (kind === "claude") return [...(model ? ["--model", model] : []), "--append-system-prompt", brief, "--effort", effort];
  if (kind === "codex") return [...(model ? ["--model", model] : []), "-c", `model_reasoning_effort=${effort}`, "-c", `developer_instructions=${JSON.stringify(brief)}`];
  if (kind === "opencode") {
    const directory = path.join(process.env.XDG_CONFIG_HOME || path.join(homeDirectory(), ".config"), "opencode", "agents");
    const file = path.join(directory, "conductor.md");
    const definition = `---\ndescription: Coordinate the owner's work across agent sessions.\nmode: primary\n---\n\n${brief}\n`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await readFile(file, "utf8").catch(() => undefined) !== definition) await atomic(file, definition, 0o644);
    return [...(model ? ["--model", model] : []), "--agent", "conductor", "--variant", effort];
  }
  throw new BridgeError(400, "The selected harness cannot run as a conductor.");
}

async function targetForPane(server: string, pane: Json): Promise<Json | undefined> {
  if (!provider.safeParse(pane.agent).success || !id.safeParse(pane.workspace_id).success || !id.safeParse(pane.tab_id).success || !id.safeParse(pane.pane_id).success) return undefined;
  const binding = { server, workspace: pane.workspace_id, tab: pane.tab_id, pane: pane.pane_id, source: pane.agent };
  const session = await paneIdentity(server, pane);
  if (session) return { ...binding, session };
  const chat = await paneChatState(server, pane).catch((): Json => ({}));
  return chat.starting === true ? { ...binding, starting: true, startingToken: chat.startingToken } : undefined;
}

/**
 * "Open on a computer": a new Herdr workspace (or a tab in an existing one)
 * in the project's directory, with the chosen agent started in its pane.
 * Herdr's create calls do not return identifiers, so the new tab is found
 * by diffing snapshots; `agent.start` returns once Herdr has detected the
 * agent and it is ready for input, which can take most of `timeoutMs`.
 */
/** The Herdr agent-name slug for a human label: "Conductor smoke 4" becomes "conductor-smoke-4". */
export function herdrAgentName(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 32).replace(/-+$/, "");
  return slug || "agent";
}

export async function launchSession(server: string, data: Json): Promise<Json> {
  const cwd = z.string().min(1).max(4096).refine(t => path.isAbsolute(t) && !/[\x00-\x1f\x7f]/.test(t)).parse(data.cwd);
  const label = plainText(200).parse(data.label);
  const kind = z.enum(launchKinds).parse(data.kind);
  const role = z.enum(["agent", "conductor"]).default("agent").parse(data.role);
  const effort = z.enum(["low", "medium", "high"]).default("medium").parse(data.effort);
  if (role === "conductor" && kind === "copilot") throw new BridgeError(400, "Copilot cannot run as a conductor.");
  // Herdr's agent name is a slug (lowercase, digits, - or _, 1 to 32 chars);
  // the label a person typed is not, so derive one from it.
  const baseName = herdrAgentName(data.name === undefined ? label : plainText(200).parse(data.name));
  const name = role === "conductor" ? herdrAgentName(`conductor-${baseName}`) : baseName;
  const model = typeof data.model === "string" && data.model.trim() ? plainText(200).parse(data.model.trim()) : undefined;
  const modelFlag: Partial<Record<(typeof launchKinds)[number], string>> = { codex: "--model", claude: "--model", opencode: "--model" };
  const workspace = data.workspaceId === undefined ? undefined : id.parse(data.workspaceId);
  const timeout = Math.min(120_000, Math.max(3_000, data.timeoutMs === undefined ? 45_000 : z.number().int().parse(data.timeoutMs)));
  const before = await snapshot(server);
  if (role === "conductor") {
    const otherServers = (await servers()).map(item => String(item.session)).filter(name => name !== server);
    const overviews = [{ name: server, value: before }, ...await Promise.all(otherServers.map(async name => ({ name, value: await snapshot(name) })))];
    for (const overview of overviews) {
      const existing = objects(overview.value.panes).find(pane => typeof pane.agent_name === "string" && pane.agent_name.startsWith("conductor-")
        && provider.safeParse(pane.agent).success && !["completed", "exited", "failed", "stopped"].includes(String(pane.agent_status)));
      if (existing) throw new BridgeError(409, "A conductor is already running for this store.", { target: await targetForPane(overview.name, existing) });
    }
  }
  const args = role === "conductor" ? await prepareConductor(kind, effort, model)
    : model && modelFlag[kind] ? [modelFlag[kind], model] : undefined;
  if (workspace && !objects(before.workspaces).some(w => w.workspace_id === workspace)) throw new BridgeError(409, "The workspace changed.");
  const knownWorkspaces = new Set(objects(before.workspaces).map(w => w.workspace_id));
  const knownTabs = new Set(objects(before.tabs).map(t => t.tab_id));
  await rpc(server, workspace ? "tab.create" : "workspace.create", { workspace_id: workspace, label, cwd, focus: false, env: {} });
  let created: { workspaceId: string; tabId: string; paneId: string } | undefined;
  for (let attempt = 0; attempt < 25 && !created; attempt++) {
    const s = await snapshot(server);
    const fresh = objects(s.tabs).filter(t => !knownTabs.has(t.tab_id)
      && (workspace ? t.workspace_id === workspace : !knownWorkspaces.has(t.workspace_id)));
    const tab = fresh.find(t => t.label === label)
      ?? fresh.find(t => objects(s.workspaces).some(w => w.workspace_id === t.workspace_id && w.label === label))
      ?? fresh[0];
    const pane = tab && objects(s.panes).find(p => p.tab_id === tab.tab_id && p.workspace_id === tab.workspace_id && !p.agent);
    if (tab && pane && id.safeParse(tab.workspace_id).success && id.safeParse(tab.tab_id).success && id.safeParse(pane.pane_id).success) {
      created = { workspaceId: String(tab.workspace_id), tabId: String(tab.tab_id), paneId: String(pane.pane_id) };
    } else await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!created) throw new BridgeError(409, `Herdr created "${label}" but its pane did not appear. Check Herdr on the computer.`);
  try {
    await rpc(server, "agent.start", { name, kind, pane_id: created.paneId, timeout_ms: timeout, ...(args ? { args } : {}) }, undefined, timeout + 5_000);
  } catch (error) {
    const reason = error instanceof BridgeError && error.status === 504 ? "it did not become ready in time" : "Herdr reported an error";
    throw new BridgeError(409, `Herdr couldn't start ${kind} in the new "${label}" pane (${reason}). The workspace was created and is still open on the computer — open it from Herdr workspaces.`);
  }
  const after = await snapshot(server);
  const pane = objects(after.panes).find(p => p.pane_id === created!.paneId && p.tab_id === created!.tabId && p.workspace_id === created!.workspaceId);
  const agentStatus = typeof pane?.agent_status === "string" ? pane.agent_status : undefined;
  const sessionId = pane && pane.agent === kind ? await paneIdentity(server, pane) : undefined;
  const chat = !sessionId && pane && pane.agent === kind ? await paneChatState(server, pane).catch((): Json => ({})) : {};
  const binding = { server, workspace: created.workspaceId, tab: created.tabId, pane: created.paneId, source: kind };
  const target = sessionId ? { ...binding, session: sessionId }
    : chat.starting === true ? { ...binding, starting: true, startingToken: chat.startingToken } : undefined;
  return { ok: true, ...created, agent: kind, agentStatus, role, sessionId, target };
}

async function workspaceAction(server: string, operation: string, data: Json): Promise<Json> {
  if (!["focus", "rename", "create", "close"].includes(operation)) throw new BridgeError(400, "Unsupported Herdr action.");
  const s = await snapshot(server);
  const workspace = typeof data.workspaceId === "string" ? data.workspaceId : undefined;
  const tab = typeof data.tabId === "string" ? data.tabId : undefined;
  const pane = typeof data.paneId === "string" ? data.paneId : undefined;
  if (workspace && !objects(s.workspaces).some(w => w.workspace_id === workspace)) throw new BridgeError(409, "The workspace changed.");
  if (tab && !objects(s.tabs).some(t => t.tab_id === tab && (!workspace || t.workspace_id === workspace))) throw new BridgeError(409, "The tab changed.");
  if (pane && !objects(s.panes).some(p => p.pane_id === pane && (!tab || p.tab_id === tab) && (!workspace || p.workspace_id === workspace))) throw new BridgeError(409, "The pane changed.");
  const label = data.label === undefined ? undefined : z.string().min(1).max(200).refine(t => !/[\x00-\x1f\x7f]/.test(t)).parse(data.label);
  const cwd = data.cwd === undefined ? undefined : z.string().max(4096).refine(t => path.isAbsolute(t) && !/[\x00-\x1f\x7f]/.test(t)).parse(data.cwd);
  if (operation === "create") await rpc(server, workspace ? "tab.create" : "workspace.create", { workspace_id: workspace, label, cwd, focus: false, env: {} });
  else if (!workspace && !tab && !pane) throw new BridgeError(400, "Choose a Herdr destination.");
  else if (pane && operation === "focus") await rpc(server, "pane.focus", { pane_id: pane });
  else if (pane) throw new BridgeError(400, "This pane action is not available.");
  else await rpc(server, `${tab ? "tab" : "workspace"}.${operation}`, { ...(tab ? { tab_id: tab } : { workspace_id: workspace }), ...(label ? { label } : {}) });
  return { ok: true };
}

import { continuationPlacement } from "./continuation-launch.js";
import { ConductorSuccessionService, preflightConductorWorkers } from "./conductor-succession.js";
import { StorePulls } from "./store-pull.js";
import { GitboyWebhooks } from "./gitboy-webhooks.js";
import { setChoiceReaders } from "./account-choice.js";
import { AccountFailover } from "./account-failover.js";
import { ownerInboxSources } from "./owner-inbox-sources.js";
import { OwnerInbox } from "./owner-inbox.js";
import { closeFinishedWorker } from "./worker-close.js";
import { isLocalComputer } from "./dispatch-hosts.js";
import { hookPeers, peerRequest } from "./peers.js";
import { handOff } from "./hand-off.js";
import { sessionStalls } from "./stalls.js";
import { HandOffQueue } from "./hand-off-queue.js";
import { paneRouteOnce, promptGuards } from "./server-pane-routes.js";
import { FanoutMessages } from "./fanout-messages.js";
import { activateModules as moduleSnapshot } from "../modules/runtime.js";
import { disabledHint } from "../modules/registry.js";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { cpus, hostname, loadavg } from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { relayLiveSpeech } from "./speech-live.js";
import { streamSimulator } from "./simulator-stream.js";
import { failRelay, relayTranscription } from "./speech-transcribe.js";
import { ActivityJournal } from "./activity.js";
import { countTick } from "./metrics.js";
import { AgentHooks } from "./agent-hooks.js";
import { approvalPushCapability } from "./push.js";
import { startChangeRetention } from "./changes.js";
import { CodeReindexer, CodeRoutes } from "./code-routes.js";
import { WorkspaceContextUsage } from "./context.js";
import { DispatchService } from "./dispatch.js";
import { DispatchReturns, hookWorkers } from "./dispatch-returns.js";
import { findPane, paneChatState, paneIdentity, recentServers, sharedSnapshot, snapshot, validateTarget } from "./herdr.js";
import { LaunchLimiter } from "./limits.js";
import { locateProject } from "./locate.js";
import { BridgeError, bridgeRoot, objects, PROTOCOL, provider, socketPath, targetSchema, type Target } from "./protocol.js";
import { CodexQuestions } from "./questions.js";
import { TabActivityStore } from "./tab-activity.js";
import { childAgentTree } from "./transcripts.js";
import { ModelCatalog } from "./models.js";
import { ModelSwitcher } from "./model-switch.js";
import { SettingsSwitcher } from "./settings-switch.js";
import { PermissionModeSwitcher } from "./permission-mode.js";
import { SideQuestions } from "./side-questions.js";
import { AccountUsageReader } from "./usage.js";
import { ResourceMonitor } from "./resources.js";
import { ALERT_CHECK_MS, HealthAlerts } from "./machine-health-alerts.js";
import { createScheduleLauncher, Scheduler, scheduleRunsFile } from "./schedules.js";
import { dailyCanaryDue, runCanary } from "./canary.js";
import { defaultPhrenPath } from "../shared.js";
import { capabilitiesForModules, createRouteHandler, type HookInfo, requireRoute, selectedServer, workspacesReader } from "./server-routes.js";
import { typedMuxRequest } from "./mux-wire.js";
import { overviewStream } from "./server-overview.js";
import { GitWatch } from "./git-watch.js";
import { transcriptStreams } from "./server-stream.js";
import { launchSession } from "./server-launch.js";
import { copyClaudeConversation, SessionMover, transcriptTail } from "./session-move.js";
import { harnessInventoryWithin, launchCheckOff } from "./harnesses.js";
import { paneAccount, paneAccountKey } from "./pane-accounts.js";
import { readTurn } from "./turn-records.js";
import { takesPrompt } from "./session-activity.js";
import { readLaunchBrief } from "./launch-brief.js";
import { conductorPane, readRoleState } from "./conductor-role.js";
import { terminalKind, terminalProvider } from "./terminal.js";
import { targetTranscriptPath } from "./transcripts.js";
import { codexAppServerEnabled, codexServers } from "./codex-servers.js";
import { CodexAuthKeeper, codexAuthRefreshEnabled } from "./codex-auth-refresh.js";
import { localNames } from "./computer-names.js";
import { startStoreSyncLoop } from "../sync/store-sync.js";
import { SocketBudget, socketIdentity, socketKind } from "./socket-budget.js";

export { capabilities, capabilitiesForModules, requireRoute } from "./server-routes.js";
export { streamCloseReason } from "./server-stream.js";
export { herdrAgentName, launchSession } from "./server-launch.js";

export async function serve(version: string, options: { modelCatalog?: ModelCatalog; accountUsage?: AccountUsageReader } = {}): Promise<void> {
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
    ? new DispatchService({ computerID, validateParentTarget: target => validateTarget(target, false, true),
      originAgent: async origin => {
        const state = (await readRoleState())?.succession;
        if (state?.side === "origin" && state.phase === "committed" && state.from.server === origin.server && state.from.pane === origin.pane && state.previous.terminal && state.previous.source) return { agent: state.previous.source, terminal: state.previous.terminal };
        const pane = findPane(await snapshot(origin.server), origin);
        const agent = provider.safeParse(pane?.agent);
        return agent.success && typeof pane?.terminal_id === "string" ? { agent: agent.data, terminal: pane.terminal_id } : undefined;
      } })
    : undefined;
  const locatedDirectories = new Set<string>();
  const journal = new ActivityJournal();
  const agentHooks = new AgentHooks(undefined, modules, path.join(bridgeRoot(), "deliveries.json"));
  // Follows what dispatched workers do and tells the dispatching agent.
  let succession: ConductorSuccessionService | undefined;
  const returns: DispatchReturns | undefined = dispatches ? new DispatchReturns({
    takesPrompt: (target, pane) => takesPrompt(target.server, pane, target.session, promptGuards(agentHooks, target)),
    localComputer: { id: computerID, name: hostname() },
    forward: (origin, text, deliveryId) => succession?.forward(origin, text, deliveryId) ?? Promise.resolve(undefined),
    // Continue on another signed-in account when a Claude worker stops at its usage limit: opt-in, `phren config account-failover on`.
    failover: new AccountFailover({ rooms: context => dispatches.claudeRooms(context), dispatch: (input, origin, continues) => succession ? succession.automatic("dispatch", { ...input, continues }, origin, () => dispatches.dispatch(input, origin, continues)) : dispatches.dispatch(input, origin, continues) }),
    localWorkers: hookWorkers(agentHooks),
    close: async (receipt, verifiedPeer) => {
      const data = { target: receipt.target, dispatch: receipt.moves?.slice().reverse().find(move => move.to.computer)?.id ?? receipt.id, turn: receipt.closePending!.turn };
      if (receipt.computerId === computerID) return closeFinishedWorker(data, handOffs);
      const peer = verifiedPeer ?? (await hookPeers().catch(() => [])).find(peer => peer.name === receipt.computer);
      if (peer) return peerRequest(peer, "/v1/dispatch/close", data);
      if (!receipt.moves?.some(move => move.to.computer) && isLocalComputer(receipt.computer)) return closeFinishedWorker(data, handOffs);
      throw new BridgeError(503, "The worker's verified computer is offline.");
    },
    localAnswer: (target, actionId, decision) => agentHooks.answer(target, actionId, decision),
    // A worker's request the worker's own Hook did not push reaches this Hook's phone.
    onApproval: (receipt, approval) => {
      if (approval.pushed || !agentHooks.push.available) return;
      agentHooks.pushForwarded({ provider: receipt.harness, computer: receipt.computer, project: receipt.project,
        request: approval.request ?? approval.title ?? approval.tool, ...(approval.requestKind ? { requestKind: approval.requestKind } : {}) },
      decision => returns!.answerApproval(receipt.id, decision, approval.actionId));
      return true;
    },
  }) : undefined;
  // Push is offered only once an APNs sender loaded; phones may still register.
  if ("approvalPush" in activeCapabilities) {
    Object.defineProperty(activeCapabilities, "approvalPush", { enumerable: true, get: () => approvalPushCapability(agentHooks.push.status) });
  }
  const inbox = dispatches ? new OwnerInbox(() => ownerInboxSources(agentHooks)) : undefined;
  const modelCatalog = options.modelCatalog ?? new ModelCatalog();
  const modelSwitcher = new ModelSwitcher(agentHooks, modelCatalog);
  const settingsSwitcher = new SettingsSwitcher(agentHooks);
  const permissionModeSwitcher = new PermissionModeSwitcher(agentHooks);
  const sideQuestions = new SideQuestions();
  const sendPrompt = async (target: Target, text: string, deliveryId: string, typing: () => Promise<void>) => await paneRouteOnce({ agentHooks, modelSwitcher, settingsSwitcher, permissionModeSwitcher, codexQuestions, sideQuestions },
    new URL("http://phren.local/v1/prompt"), { target, text, deliveryId, hookQueued: true }, {} as never, typing) as Record<string, unknown>;
  const handOffs = dispatches ? new HandOffQueue({
    forward: (target, text, deliveryId) => succession?.forward(target, text, deliveryId) ?? Promise.resolve(undefined),
    validate: target => validateTarget(target, false, true),
    current: async target => {
      const pane = findPane(await snapshot(target.server), target);
      const session = pane ? await paneIdentity(target.server, pane, true) : undefined;
      return pane && session ? { session, terminal: pane.terminal_id } : undefined;
    },
    notify: (target, text, deliveryId, computer) => handOff({ computer, target, text, deliveryId }, { notifySender: false, bypassConductor: true }),
    send: sendPrompt,
    delivery: (target, deliveryId) => agentHooks.deliveries.status(deliveryId, target),
    inFlight: target => agentHooks.deliveries.holding(target),
    held: (target, deliveryId) => agentHooks.deliveries.held(deliveryId, target),
    ready: (target, pane) => takesPrompt(target.server, pane, target.session, promptGuards(agentHooks, target)),
  }) : undefined;
  // Moving a session to another agent (session-move.ts): its hand-off request
  // takes the hand_off path, and the new agent starts through the launch path.
  succession = dispatches ? new ConductorSuccessionService({ root, computer: { id: computerID, name: hostname() }, snapshot, validate: target => validateTarget(target, false, true),
    isSuccessor: async (origin, id) => (await readTurn(origin.server, origin.pane))?.dispatch === id,
    deliver: (target, text, deliveryId) => handOffs!.enqueue({ target, text, deliveryId }),
    checkWorkers: from => preflightConductorWorkers(from, computerID),
  }) : undefined;
  const mover = new SessionMover({
    succession,
    snapshot: server => snapshot(server),
    identity: (server, pane) => paneIdentity(server, pane, true),
    terminal: terminalProvider(),
    deliver: (target, text, deliveryId) => handOffs ? handOffs.enqueue({ target, text, deliveryId }) : sendPrompt(target, text, deliveryId, async () => {}),
    withdraw: async (target, deliveryId, reason) => handOffs?.withdraw(deliveryId, target, reason),
    // The new agent starts in the folder an agent already ran in, so it is trusted for the new harness too.
    launch: (server, data, options) => launches.run(() => launchSession(server, data, { trustFolder: true, ...options })),
    inventory: () => launchCheckOff() ? Promise.resolve(undefined) : harnessInventoryWithin(2_500),
    transcript: async target => transcriptTail(await targetTranscriptPath(target)),
    copyConversation: async (target, home, check) => copyClaudeConversation(await targetTranscriptPath(target), home, process.env, check),
    paneAccount: (server, pane) => paneAccount(paneAccountKey(server, pane.pane_id), typeof pane.terminal_id === "string" ? pane.terminal_id : undefined)?.id,
    paneDispatch: async (server, pane) => {
      const dispatch = (await readTurn(server, String(pane.pane_id)))?.dispatch;
      if (!dispatch) return undefined;
      const continuation = await continuationPlacement(dispatch);
      if (continuation) return continuation.worker ? dispatch : undefined;
      const localMove = await (await import("./session-move.js")).readMove(dispatch);
      return localMove && !localMove.dispatch ? undefined : dispatch;
    },
    brief: readLaunchBrief,
    isConductor: async (server, pane) => (await conductorPane(server, await snapshot(server)))?.pane_id === pane.pane_id,
    envAtStart: server => terminalKind(server) === "tmux",
    afterExit: async (server, pane) => { const entry = codexServers.forPane(server, pane); if (entry) await codexServers.stop(entry); },
  });
  const contextUsage = new WorkspaceContextUsage();
  const accountUsage = options.accountUsage ?? new AccountUsageReader();
  // A Claude launch that names no account runs under the one with the most room (account-choice.ts).
  setChoiceReaders({ usage: () => accountUsage.limits(true) });
  const resources = new ResourceMonitor();
  const tabActivity = new TabActivityStore();
  const codexQuestions = new CodexQuestions(undefined, codexServers);
  const scheduleStore = defaultPhrenPath();
  const scheduler = modules.has("schedules") ? new Scheduler({ now: () => new Date(), store: scheduleStore, runsFile: scheduleRunsFile(),
    aliases: [computerID],
    // A schedule starts in its project's folder, which the Hook resolved itself.
    launch: createScheduleLauncher((server, data) => launchSession(server, data, { trustFolder: true }), scheduleStore,
      // `session: reuse` continues a session through the same queue a hand-off takes.
      (target, text, deliveryId) => handOffs ? handOffs.enqueue({ target, text, deliveryId }) : sendPrompt(target, text, deliveryId, async () => {})),
    push: { notify: value => agentHooks.push.notifySchedule(value) },
    locateProject: async project => (await locateProject(project, await journal.recent()))[0]?.directory }) : undefined;
  const fanoutMessages = new FanoutMessages({ ...process.env, PHREN_PATH: scheduleStore }, {
    validate: target => validateTarget(target, false, true),
    tree: target => childAgentTree(target.source, target.session, 0, new Set(), computerID),
  });
  fanoutMessages.start();
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
  const info: HookInfo = { product: "phren-hook", protocol: PROTOCOL, version, computer: { id: computerID, name: hostname(), aliases: localNames() }, capabilities: activeCapabilities,
    modules: Object.fromEntries(modules.modules.map(module => [module.name, module.version])),
    store: modules.store, profile: modules.profile, generation: modules.generation,
    get load() { return { average: Number(loadavg()[0].toFixed(2)), cpus: cpus().length }; },
    get gatewayMs() { return gatewayTiming(); } };
  // The canary launches through the same serialized launch path as the phone.
  const canary = (trigger: "manual" | "daily") => runCanary({ trigger, store: scheduleStore,
    launch: (server, data) => launches.run(() => launchSession(server, data, { canary: true })), scheduler });
  const old = await lstat(socketPath()).catch(() => null);
  if (old) {
    if (!old.isSocket() || (process.getuid && old.uid !== process.getuid())) throw new Error("Refusing to replace an unexpected hook socket.");
    // The service manager owns process lifetime. Only remove a stale socket.
    const { connect } = await import("node:net");
    const live = await new Promise<boolean>(resolve => { const s = connect(socketPath()); s.on("connect", () => { s.destroy(); resolve(true); }); s.on("error", () => resolve(false)); });
    if (live) throw new Error("Phren Hook is already running.");
    await unlink(socketPath());
  }

  const storePulls = new StorePulls(scheduleStore);
  const gitboyWebhooks = new GitboyWebhooks(root, storeId => storePulls.request(storeId));
  const stopRetention = modules.has("git") ? await startChangeRetention() : () => {};
  if (modules.has("git")) await rm(path.join(root, "changes-scratch"), { recursive: true, force: true });
  const streams = transcriptStreams({ modules, agentHooks, codexQuestions, sideQuestions, settingsSwitcher, info, activeCapabilities });
  const { stream } = streams;
  // The phone's overview, pushed over a WebSocket when it changes.
  const overview = overviewStream({
    read: workspacesReader({ modules, info, agentHooks, journal, tabActivity, contextUsage }),
    info: () => ({ ...info, capabilities: info.capabilities }),
    renew: server => agentHooks.overview.renew(server),
    resources: () => resources.read(),
    sudo: agentHooks.sudo,
  });
  const gitWatch = new GitWatch();
  // 256 KiB: gitboy's /memory/files asks about up to 500 paths in one query string.
  const http = createServer({ maxHeaderSize: 256 * 1024 }, createRouteHandler({ version, modules, info, computerID, scheduleStore, scheduler, dispatches, agentHooks,
    journal, tabActivity, contextUsage, modelCatalog, modelSwitcher, settingsSwitcher, permissionModeSwitcher, sideQuestions, accountUsage, resources, codexQuestions, launches, locatedDirectories,
    fanoutMessages, canary, streams, returns, handOffs, inbox, mover, succession, storePulls, gitboyWebhooks }));
  http.requestTimeout = 20_000; http.headersTimeout = 10_000; http.maxHeadersCount = 32;
  const ws = new WebSocketServer({ noServer: true, maxPayload: 65_536, perMessageDeflate: false });
  const socketPools = new SocketBudget<WebSocket>();
  http.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url || "/", "http://phren.local");
      if (!["/v1/transcripts", "/v1/status", "/v1/overview", "/v1/git/watch", "/v1/speech/transcribe", "/v1/speech/live", "/v1/simulators/stream"].includes(url.pathname) || url.origin !== "http://phren.local") { socket.destroy(); return; }
      requireRoute(modules, "WS", url.pathname);
      // Parsed before the upgrade: an invalid server name is refused as the other routes refuse it.
      const overviewServer = url.pathname === "/v1/overview" ? selectedServer(url) : undefined;
      // Sockets are budgeted per authenticated identity (socket-budget.ts); the
      // x-phren-client header only picks a sub-pool inside that budget.
      const identity = socketIdentity(request), kind = socketKind(request);
      ws.handleUpgrade(request, socket, head, client => {
        client.once("close", () => socketPools.remove(client));
        for (const oldest of socketPools.add(client, identity, kind)) {
          oldest.close(1008, "Too many connections; reconnect"); oldest.terminate();
          ws.clients.delete(oldest);
        }
        if (overviewServer !== undefined) { overview(client, overviewServer, url.searchParams.get("watchApprovals") === "1", url.searchParams.get("resources") === "1", typedMuxRequest(url), url.searchParams.get("sudo") === "1"); return; }
        if (url.pathname === "/v1/git/watch") { void gitWatch.stream(client, url); return; }
        if (url.pathname === "/v1/speech/transcribe") { void relayTranscription(client, url.searchParams).catch(() => failRelay(client)); return; }
        if (url.pathname === "/v1/simulators/stream") { void streamSimulator(client, url.searchParams).catch(() => client.close(1011, "Simulator stream unavailable")); return; }
        if (url.pathname === "/v1/speech/live") { void relayLiveSpeech(client, url.searchParams).catch(() => client.close(1011, "Spoken replies unavailable")); return; }
        void stream(client, url).catch(() => client.close(1011, "Conversation unavailable; refresh"));
      });
    } catch { socket.destroy(); }
  });
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(socketPath(), () => resolve()); });
  await chmod(socketPath(), 0o600);
  await gitboyWebhooks.start();
  await agentHooks.start();
  // Codex panes on the Hook's own app-servers: their requests become
  // approval cards, and servers a previous Hook started are rejoined.
  codexServers.setSink({ request: (target, request, answer) => agentHooks.codexRequest(target, request, answer),
    resolved: (target, requestId) => agentHooks.codexResolved(target, requestId),
    threadChanged: previous => agentHooks.deliveries.threadChanged(previous) });
  await codexServers.adopt().catch(() => {});
  void scheduler?.tick().catch(() => {});
  const scheduleTimer = scheduler ? setInterval(() => { countTick("schedules"); void scheduler.tick().catch(() => {}); }, 30_000) : undefined;
  // Off unless PHREN_CANARY_DAILY=1 or `phren canary --daily on`.
  // Refresh the shared Codex sign-in before its workers each try to at once.
  const codexAuth = codexAppServerEnabled() && codexAuthRefreshEnabled() ? new CodexAuthKeeper(codexServers) : undefined;
  const codexAuthTimer = codexAuth ? setInterval(() => { void codexAuth.tick().catch(() => {}); }, 60 * 60_000) : undefined;
  if (codexAuth) setTimeout(() => { void codexAuth.tick().catch(() => {}); }, 60_000).unref();
  // Every store converges with its remote even when no agent session runs here (store-sync.ts).
  const storeSync = startStoreSyncLoop(scheduleStore);
  const canaryTimer = setInterval(() => { countTick("canary"); void dailyCanaryDue().then(due => due ? canary("daily") : undefined).catch(() => {}); }, 10 * 60_000);
  // A new high machine health finding reaches the phone once (machine-health-alerts.ts).
  const healthAlerts = new HealthAlerts(finding => agentHooks.push.notifyMachineHealth({ computer: hostname(), ...finding }));
  const healthTimer = setInterval(() => { countTick("health"); void resources.read().then(value => healthAlerts.observe(value.health, Date.now())).catch(() => {}); }, ALERT_CHECK_MS);
  let recording = false;
  const activityTimer = setInterval(() => {
    countTick("activity");
    // Served OpenCode panes: follow new ones, drop those whose process is gone.
    agentHooks.paneServers.tick();
    if (recording) return;
    recording = true;
    void (async () => {
      // The server list is reused for SERVER_LIST_REUSE_MS instead of pinging
      // every Herdr directory each tick, and a snapshot an open chat or the
      // overview fetched in the last four seconds is reused; otherwise each
      // tick still takes its own, so activity keeps its 5 s resolution.
      const live = await recentServers();
      await tabActivity.pruneServers(live.map(server => String(server.session)));
      for (const server of live) {
        try {
          const name = String(server.session), current = await sharedSnapshot(name, 4000);
          await tabActivity.observe(name, current);
          await journal.record(name, objects(current.panes));
          // Phone messages a pane still holds: fail loudly when it closed,
          // restarted or finished without them.
          await agentHooks.deliveries.observe(name, objects(current.panes)).catch(() => {});
          // A Codex app-server whose pane closed is stopped; a dead one forgotten.
          await codexServers.reap(name, current).catch(() => {});
          // Approvals drawn in a terminal reach a phone with phren closed.
          await agentHooks.observeWaitingPanes(name, objects(current.panes), async pane => {
            const state = await paneChatState(name, pane, { tokenWhenIdentified: false });
            const parsed = targetSchema.safeParse({ server: name, workspace: pane.workspace_id, tab: pane.tab_id, pane: pane.pane_id,
              source: pane.agent, session: state.sessionId });
            if (parsed.success) await sessionStalls.observe(parsed.data, pane);
            return parsed.success ? parsed.data : undefined;
          });
        }
        catch { /* A disconnected computer keeps its previous local activity. */ }
      }
      await codexServers.sweep(live.map(server => String(server.session))).catch(() => {});
      // Dispatch returns ride this tick and its shared snapshots. The returns
      // loop throttles its own peer polls and never holds up activity.
      void handOffs?.tick().catch(() => {});
      void mover.reconcile().catch(() => {});
      void succession?.reconcile().catch(() => {});
      void returns?.tick();
      void inbox?.tick().catch(() => {});
    })().finally(() => { recording = false; }).catch(() => {});
  }, 5000);
  await new Promise<void>(resolve => {
    const stop = () => { gitboyWebhooks.stop(); storePulls.stop(); storeSync.stop(); fanoutMessages.close(); stopRetention(); clearInterval(scheduleTimer); clearInterval(canaryTimer); clearInterval(healthTimer); clearInterval(codexAuthTimer); clearInterval(activityTimer); scheduler?.close(); codeReindexer?.close(); codexServers.close(); gitWatch.close(); agentHooks.close(); ws.clients.forEach(c => c.terminate()); ws.close(); http.close(() => resolve()); http.closeAllConnections(); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
  });
  await unlink(socketPath()).catch(() => {});
}

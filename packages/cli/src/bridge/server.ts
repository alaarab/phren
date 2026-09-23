import { FanoutMessages } from "./fanout-messages.js";
import { activateModules as moduleSnapshot } from "../modules/runtime.js";
import { disabledHint } from "../modules/registry.js";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { cpus, hostname, loadavg } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { ActivityJournal } from "./activity.js";
import { countTick } from "./metrics.js";
import { AgentHooks } from "./agent-hooks.js";
import { startChangeRetention } from "./changes.js";
import { CodeReindexer, CodeRoutes } from "./code-routes.js";
import { WorkspaceContextUsage } from "./context.js";
import { DispatchService } from "./dispatch.js";
import { recentServers, sharedSnapshot, validateTarget } from "./herdr.js";
import { LaunchLimiter } from "./limits.js";
import { locateProject } from "./locate.js";
import { BridgeError, bridgeRoot, objects, PROTOCOL, socketPath } from "./protocol.js";
import { CodexQuestions } from "./questions.js";
import { TabActivityStore } from "./tab-activity.js";
import { childAgentTree } from "./transcripts.js";
import { ModelCatalog } from "./models.js";
import { ModelSwitcher } from "./model-switch.js";
import { SideQuestions } from "./side-questions.js";
import { AccountUsageReader } from "./usage.js";
import { createScheduleLauncher, Scheduler, scheduleRunsFile } from "./schedules.js";
import { dailyCanaryDue, runCanary } from "./canary.js";
import { defaultPhrenPath } from "../shared.js";
import { capabilitiesForModules, createRouteHandler, type HookInfo, requireRoute } from "./server-routes.js";
import { transcriptStreams } from "./server-stream.js";
import { launchSession } from "./server-launch.js";
import { localNames } from "./computer-names.js";

export { capabilities, capabilitiesForModules, requireRoute } from "./server-routes.js";
export { streamCloseReason } from "./server-stream.js";
export { herdrAgentName, launchSession } from "./server-launch.js";

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
  const modelSwitcher = new ModelSwitcher(agentHooks, modelCatalog);
  const sideQuestions = new SideQuestions();
  const contextUsage = new WorkspaceContextUsage();
  const accountUsage = new AccountUsageReader();
  const tabActivity = new TabActivityStore();
  const codexQuestions = new CodexQuestions();
  const scheduleStore = defaultPhrenPath();
  const scheduler = modules.has("schedules") ? new Scheduler({ now: () => new Date(), store: scheduleStore, runsFile: scheduleRunsFile(),
    launch: createScheduleLauncher((server, data) => launchSession(server, data), scheduleStore),
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

  const stopRetention = modules.has("git") ? await startChangeRetention() : () => {};
  if (modules.has("git")) await rm(path.join(root, "changes-scratch"), { recursive: true, force: true });
  const streams = transcriptStreams({ modules, agentHooks, codexQuestions, sideQuestions, info, activeCapabilities });
  const { stream } = streams;
  const http = createServer(createRouteHandler({ version, modules, info, computerID, scheduleStore, scheduler, dispatches, agentHooks,
    journal, tabActivity, contextUsage, modelCatalog, modelSwitcher, sideQuestions, accountUsage, codexQuestions, launches, locatedDirectories,
    fanoutMessages, canary, streams }));
  http.requestTimeout = 20_000; http.headersTimeout = 10_000; http.maxHeadersCount = 32;
  const ws = new WebSocketServer({ noServer: true, maxPayload: 65_536, perMessageDeflate: false });
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
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(socketPath(), () => resolve()); });
  await chmod(socketPath(), 0o600);
  await agentHooks.start();
  void scheduler?.tick().catch(() => {});
  const scheduleTimer = scheduler ? setInterval(() => { countTick("schedules"); void scheduler.tick().catch(() => {}); }, 30_000) : undefined;
  // Off unless PHREN_CANARY_DAILY=1 or `phren canary --daily on`.
  const canaryTimer = setInterval(() => { countTick("canary"); void dailyCanaryDue().then(due => due ? canary("daily") : undefined).catch(() => {}); }, 10 * 60_000);
  let recording = false;
  const activityTimer = setInterval(() => {
    countTick("activity");
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
        }
        catch { /* A disconnected computer keeps its previous local activity. */ }
      }
    })().finally(() => { recording = false; }).catch(() => {});
  }, 5000);
  await new Promise<void>(resolve => {
    const stop = () => { fanoutMessages.close(); stopRetention(); clearInterval(scheduleTimer); clearInterval(canaryTimer); clearInterval(activityTimer); scheduler?.close(); codeReindexer?.close(); agentHooks.close(); ws.clients.forEach(c => c.terminate()); ws.close(); http.close(() => resolve()); http.closeAllConnections(); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
  });
  await unlink(socketPath()).catch(() => {});
}

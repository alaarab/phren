import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { getProjectDirs } from "../phren-paths.js";
import { listLiveSessions } from "./hand-off.js";
import { canaryFile, type CanaryResult, type CanaryStep, readCanary } from "./health.js";
import { paneIdentity, rpc, servers, snapshot } from "./herdr.js";
import { atomic, BridgeError, bridgeRoot, id, type Json, objects, provider, type Provider } from "./protocol.js";
import { readScheduleDocument } from "./schedules.js";
import { TranscriptReader, transcriptPath } from "./transcripts.js";

/** The label every canary workspace carries, so cleanup finds only its own. */
export const CANARY_LABEL = "phren canary";
const DAY_MS = 24 * 60 * 60_000;

export interface CanaryOptions {
  trigger: "manual" | "daily";
  store: string;
  /** Starts an agent the way the phone's launch route does; the Hook passes launchSession. */
  launch: (server: string, data: Json) => Promise<Json>;
  /** The Hook's scheduler, when the schedules module runs it. */
  scheduler?: { lastTickAt?: Date };
  server?: string;
  root?: string;
}

function reason(error: unknown): string {
  const text = error instanceof Error ? error.message : "Unknown failure.";
  return text.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 300) || "Unknown failure.";
}

async function step(steps: CanaryStep[], name: string, run: () => Promise<Omit<CanaryStep, "name" | "durationMs">>): Promise<void> {
  const started = Date.now();
  try { steps.push({ name, durationMs: 0, ...await run() }); }
  catch (error) { steps.push({ name, durationMs: 0, status: "failed", reason: reason(error) }); }
  steps.at(-1)!.durationMs = Date.now() - started;
}

/** Close every workspace this canary created, by id and by label. Never
 * touches a workspace that existed before the canary started. */
async function closeCanaryWorkspaces(server: string, before: Set<string>, created?: string): Promise<string | undefined> {
  const failures: string[] = [];
  let current: Json;
  try { current = await snapshot(server); } catch (error) { return `could not list workspaces to clean up (${reason(error)})`; }
  const mine = objects(current.workspaces).filter(workspace => !before.has(String(workspace.workspace_id))
    && (workspace.workspace_id === created || workspace.label === CANARY_LABEL));
  for (const workspace of mine) {
    if (!id.safeParse(workspace.workspace_id).success) continue;
    try { await rpc(server, "workspace.close", { workspace_id: workspace.workspace_id }); }
    catch (error) { failures.push(`${String(workspace.workspace_id)}: ${reason(error)}`); }
  }
  return failures.length ? `cleanup failed for ${failures.join("; ")}` : undefined;
}

/** (1) A Claude conductor launched through launchSession in a temporary folder, then closed. */
async function conductorStep(options: CanaryOptions, server: string): Promise<Omit<CanaryStep, "name" | "durationMs">> {
  const before = new Set(objects((await snapshot(server)).workspaces).map(workspace => String(workspace.workspace_id)));
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), "phren-canary-")));
  let created: string | undefined, failure: string | undefined, detail: string | undefined;
  try {
    const launched = await options.launch(server, { role: "conductor", kind: "claude", label: CANARY_LABEL, cwd: folder, timeoutMs: 45_000 });
    created = typeof launched.workspaceId === "string" ? launched.workspaceId : undefined;
    detail = `claude started (${typeof launched.agentStatus === "string" ? launched.agentStatus : "status unknown"})`;
  } catch (error) { failure = reason(error); }
  finally {
    const cleanup = await closeCanaryWorkspaces(server, before, created);
    await rm(folder, { recursive: true, force: true }).catch(() => {});
    if (cleanup) failure = failure ? `${failure}; ${cleanup}` : cleanup;
  }
  return failure ? { status: "failed", reason: failure } : { status: "ok", detail };
}

/** (2) Every project's schedules.yaml parses and the Hook's scheduler ticked recently. Nothing runs. */
async function scheduleStep(options: CanaryOptions): Promise<Omit<CanaryStep, "name" | "durationMs">> {
  if (!options.scheduler) return { status: "skipped", reason: "The schedules module is off on this computer." };
  let count = 0;
  const broken: string[] = [];
  for (const directory of getProjectDirs(options.store)) {
    const present = await lstat(path.join(directory, "schedules.yaml")).catch(() => undefined);
    if (!present) continue;
    try { count += (await readScheduleDocument(directory)).schedules.length; }
    catch (error) { broken.push(`${path.basename(directory)}: ${reason(error)}`); }
  }
  const tick = options.scheduler.lastTickAt;
  if (broken.length) return { status: "failed", reason: `schedules.yaml does not parse in ${broken.join("; ")}` };
  if (!tick || Date.now() - tick.getTime() > 120_000) return { status: "failed", reason: tick ? `The scheduler last ticked at ${tick.toISOString()}.` : "The scheduler has not ticked since the Hook started." };
  return { status: "ok", detail: `${count} schedule${count === 1 ? "" : "s"} parse; the scheduler ticked at ${tick.toISOString()}` };
}

/** (3) One existing idle session's transcript, read only. No input reaches any pane. */
async function transcriptStep(): Promise<Omit<CanaryStep, "name" | "durationMs">> {
  for (const live of await servers()) {
    const server = String(live.session), current = await snapshot(server);
    const workspaceLabels = new Map(objects(current.workspaces).map(workspace => [workspace.workspace_id, workspace.label]));
    for (const pane of objects(current.panes)) {
      if (pane.agent_status !== "idle" || !provider.safeParse(pane.agent).success || workspaceLabels.get(pane.workspace_id) === CANARY_LABEL) continue;
      const session = await paneIdentity(server, pane).catch(() => undefined);
      if (!session) continue;
      const source = pane.agent as Provider;
      let file: string;
      try { file = await transcriptPath(source, session); } catch { continue; }
      const page = await new TranscriptReader(file, source).read();
      return { status: "ok", detail: `read ${page.entries.length} entries from an idle ${source} session` };
    }
  }
  return { status: "skipped", reason: "No idle agent session with a transcript to read." };
}

/** (4) Every live session here and on enrolled computers; an unreachable computer fails the step. */
async function sessionsStep(): Promise<Omit<CanaryStep, "name" | "durationMs">> {
  const live = await listLiveSessions();
  const detail = `${live.sessions.length} live session${live.sessions.length === 1 ? "" : "s"} across ${live.enrolled + 1} computer${live.enrolled ? "s" : ""}`;
  if (live.unreachable.length) return { status: "failed", detail, reason: `Unreachable: ${live.unreachable.map(item => `${item.computer} (${item.error})`).join("; ")}` };
  return { status: "ok", detail };
}

let running: Promise<CanaryResult> | undefined;

/** Exercise the real launch, schedule, transcript and session paths once and
 * save the outcome to canary.json. Everything it opens is closed again, even on
 * failure; it never sends input to an existing pane and never runs or edits the
 * owner's schedules or tasks. */
export function runCanary(options: CanaryOptions): Promise<CanaryResult> {
  if (running) throw new BridgeError(409, "A canary is already running on this computer.");
  running = (async () => {
    const started = new Date(), steps: CanaryStep[] = [], server = options.server ?? "default";
    await step(steps, "conductor", () => conductorStep(options, server));
    await step(steps, "schedules", () => scheduleStep(options));
    await step(steps, "transcript", () => transcriptStep());
    await step(steps, "sessions", () => sessionsStep());
    const finished = new Date();
    const result: CanaryResult = { version: 1, trigger: options.trigger, computer: hostname(), startedAt: started.toISOString(),
      finishedAt: finished.toISOString(), durationMs: finished.getTime() - started.getTime(),
      ok: steps.every(item => item.status !== "failed"), steps };
    await atomic(canaryFile(options.root ?? bridgeRoot()), JSON.stringify(result, null, 2) + "\n");
    return result;
  })().finally(() => { running = undefined; });
  return running;
}

/** Whether the daily canary is on: `PHREN_CANARY_DAILY=1`, or `phren canary --daily on`. */
export async function dailyCanaryEnabled(root = bridgeRoot()): Promise<boolean> {
  if (process.env.PHREN_CANARY_DAILY === "1") return true;
  return !!(await lstat(path.join(root, "canary-daily")).catch(() => undefined))?.isFile();
}

/** A daily canary is due when none has run in the last day. */
export async function dailyCanaryDue(root = bridgeRoot(), now = Date.now()): Promise<boolean> {
  if (running || !await dailyCanaryEnabled(root)) return false;
  const last = await readCanary(root);
  return !last || now - Date.parse(last.startedAt) >= DAY_MS;
}

/** `phren canary [--daily on|off]`: run the canary through this computer's Hook, or switch the daily run. */
export async function runCanaryCommand(args: string[]): Promise<number> {
  const { hookRequest } = await import("./client.js");
  const { mkdir, writeFile } = await import("node:fs/promises");
  if (args[0] === "--daily") {
    const flag = path.join(bridgeRoot(), "canary-daily");
    if (args[1] === "on") { await mkdir(bridgeRoot(), { recursive: true, mode: 0o700 }); await writeFile(flag, "", { mode: 0o600 }); }
    else if (args[1] === "off") await rm(flag, { force: true });
    else throw new Error("Usage: phren canary [--daily on|off]");
    console.log(`Daily canary ${args[1]}. The Hook checks every ten minutes and runs it once a day.`);
    return 0;
  }
  if (args.length) throw new Error("Usage: phren canary [--daily on|off]");
  const result = await hookRequest("/v1/canary", {}, undefined, 240_000);
  console.log(JSON.stringify(result, null, 2));
  return result.ok === true ? 0 : 1;
}

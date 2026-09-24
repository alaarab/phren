import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { codexHome } from "../home-paths.js";
import path from "node:path";
import { finished as streamFinished } from "node:stream/promises";
import { fanoutRoot } from "./fanouts.js";
import { findPane, paneIdentity, rpc, servers, snapshot } from "./herdr.js";
import { atomic, atomicInPrivateDir, BridgeError, type Json } from "./protocol.js";
import { logger } from "../logger.js";
import { defaultPhrenPath } from "../shared.js";
import type { Schedule, ScheduleLauncher, ScheduleLaunchContext, ScheduleLaunchRecord, ScheduleLaunchResult, ScheduleRunOutcome } from "./schedule-format.js";
import { watchHerdrRun } from "./schedule-watch.js";

/** Starting a scheduled run: in a Herdr pane when a server is live, otherwise
 * as a headless job under the fan-out root. */

const CLAUDE_SCHEDULE_SETTINGS = JSON.stringify({ enableAllProjectMcpServers: true });

type HerdrLauncher = (server: string, data: Json) => Promise<Json>;

export function createScheduleLauncher(launchHerdr: HerdrLauncher, store = defaultPhrenPath()): ScheduleLauncher {
  const abort = new AbortController(), children = new Set<ChildProcess>();
  const launcher: ScheduleLauncher = async context => {
    const live = await servers();
    if (live.length) return launchInHerdr(String(live[0].session), context, launchHerdr, abort.signal);
    return launchHeadless(context, store, child => { children.add(child); child.once("exit", () => children.delete(child)); });
  };
  launcher.close = () => { abort.abort(); for (const child of children) child.kill("SIGTERM"); children.clear(); };
  return launcher;
}

async function launchInHerdr(server: string, context: ScheduleLaunchContext, launchHerdr: HerdrLauncher, signal: AbortSignal): Promise<ScheduleLaunchResult> {
  const launched = await launchHerdr(server, { cwd: context.cwd, label: context.schedule.name, kind: context.schedule.harness, model: context.schedule.model });
  const workspaceId = String(launched.workspaceId), tabId = String(launched.tabId), paneId = String(launched.paneId);
  await promptWhenReady(server, paneId, context.schedule.prompt, signal);
  let sessionId = typeof launched.sessionId === "string" ? launched.sessionId : undefined;
  for (let attempt = 0; attempt < 10 && !sessionId; attempt++) {
    const pane = findPane(await snapshot(server), { workspace: workspaceId, tab: tabId, pane: paneId });
    if (pane) sessionId = await paneIdentity(server, pane).catch(() => undefined);
    if (!sessionId) await new Promise(resolve => setTimeout(resolve, 200));
  }
  const launch: ScheduleLaunchRecord = { mode: "herdr", server, workspaceId, tabId, paneId,
    ...(sessionId ? { sessionId } : {}) };
  return { launch, completion: watchHerdrRun(server, { workspaceId, tabId, paneId }, signal,
    { source: context.schedule.harness, startedAt: Date.now(), sessionId, onBlocked: context.blockedStartup }) };
}

/** Herdr refuses a prompt until the agent has finished starting; a run
 * launched a moment ago waits for it rather than failing on the first try. */
async function promptWhenReady(server: string, paneId: string, text: string, signal: AbortSignal, waitMs = 60_000): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { await rpc(server, "agent.prompt", { target: paneId, text }, signal); return; }
    catch (error) {
      const starting = error instanceof BridgeError && error.details?.herdrCode === "agent_not_ready";
      if (!starting || signal.aborted) throw error;
      if (Date.now() >= deadline) throw new BridgeError(409, `The agent in ${paneId} never became ready for the prompt; it may be waiting at a startup screen on the computer.`);
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
  }
}

async function launchHeadless(context: ScheduleLaunchContext, store: string, started: (child: ChildProcess) => void): Promise<ScheduleLaunchResult> {
  const root = fanoutRoot({ ...process.env, PHREN_PATH: store }), jobDir = path.join(root, context.runId);
  await mkdir(jobDir, { recursive: true, mode: 0o700 });
  const eventLog = "events.jsonl", now = new Date().toISOString();
  const manifest: Record<string, unknown> = { schemaVersion: 1, id: context.runId, provider: context.schedule.harness,
    taskLabel: context.schedule.name, cwd: context.cwd, worktree: context.cwd, ...(context.schedule.model ? { model: context.schedule.model } : {}),
    eventLog, createdAt: now, startedAt: now, updatedAt: now, status: "queued", schedule: { id: context.schedule.id, project: context.project } };
  await writeManifest(jobDir, manifest);
  const command = headlessCommand(context.schedule, context.cwd);
  // An untrusted directory only costs Codex a prompt; the run still starts, and the log says why.
  if (context.schedule.harness === "codex") await ensureCodexDirTrusted(context.cwd).catch(error =>
    logger.warn("schedule", `Could not mark ${path.basename(context.cwd)} trusted for Codex (run ${context.runId}): ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`));
  let child: ChildProcess;
  try { child = spawn(command.file, command.args, { cwd: command.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] }); }
  catch (error) { await writeManifest(jobDir, { ...manifest, status: "failed", updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }); throw error; }
  started(child);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const output = createWriteStream(path.join(jobDir, eventLog), { flags: "a", mode: 0o600 });
  const errors = createWriteStream(path.join(jobDir, "stderr.log"), { flags: "a", mode: 0o600 });
  const streamsFinished = Promise.all([streamFinished(output), streamFinished(errors)]).then(() => undefined).catch(() => undefined);
  child.stdin?.on("error", () => { /* A child that exits before reading is reported by close. */ });
  child.stdout?.pipe(output); child.stderr?.pipe(errors); child.stdin?.end(context.schedule.prompt);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  }).catch(async error => {
    output.end(); errors.end();
    await writeManifest(jobDir, { ...manifest, status: "failed", updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
    throw error;
  });
  await writeManifest(jobDir, { ...manifest, status: "running", updatedAt: new Date().toISOString() });
  const completion = closed.then(async ({ code, signal }): Promise<ScheduleRunOutcome> => {
    await streamsFinished;
    const finishedAt = new Date().toISOString(), ok = code === 0;
    await writeManifest(jobDir, { ...manifest, status: ok ? "completed" : "failed", updatedAt: finishedAt, finishedAt,
      ...(typeof code === "number" ? { exitCode: code } : {}) }).catch(() => {});
    return ok ? { status: "finished" } : { status: "failed", reason: signal ? `The scheduled agent exited after ${signal}.` : `The scheduled agent exited with code ${code ?? "unknown"}.` };
  });
  return { launch: { mode: "headless", jobDir }, completion };
}

export function headlessCommand(schedule: Schedule, cwd: string): { file: string; args: string[]; cwd: string } {
  const model = schedule.model ? ["--model", schedule.model] : [];
  if (schedule.harness === "codex") return { file: "codex", cwd, args: ["exec", ...model, "--sandbox", "workspace-write", "-C", cwd,
    "--skip-git-repo-check", "--json", "-"] };
  if (schedule.harness === "opencode") return { file: "opencode", cwd, args: ["run", "--format", "json", "--dir", cwd, ...model] };
  return { file: "claude", cwd, args: ["-p", "--output-format", "stream-json", "--settings", CLAUDE_SCHEDULE_SETTINGS, ...model] };
}

function tomlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export async function ensureCodexDirTrusted(cwd: string): Promise<void> {
  const directory = codexHome();
  const file = path.join(directory, "config.toml");
  let text = "";
  try { text = await readFile(file, "utf8"); }
  // An unreadable config is left untouched; the caller logs why.
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const header = `[projects.${tomlQuote(cwd)}]`;
  const trustLine = 'trust_level = "trusted"';
  let next: string;
  const at = text.indexOf(header);
  if (at >= 0) {
    const bodyStart = at + header.length;
    const rest = text.slice(bodyStart);
    const nextTable = rest.search(/^\s*\[/m);
    const section = nextTable >= 0 ? rest.slice(0, nextTable) : rest;
    if (new RegExp(`trust_level\\s*=\\s*"trusted"`).test(section)) return;
    const existing = /^[ \t]*trust_level\s*=.*$/m.exec(section);
    if (existing) {
      const replaced = section.replace(existing[0], existing[0].match(/^[ \t]*/)![0] + trustLine);
      next = text.slice(0, bodyStart) + replaced + rest.slice(section.length);
    } else {
      const newline = section.startsWith("\n") || section.startsWith("\r\n") ? "" : "\n";
      next = text.slice(0, bodyStart) + newline + trustLine + (section.startsWith("\n") || section.startsWith("\r\n") ? section : "\n" + section) + rest.slice(section.length);
    }
  } else {
    const separator = text && !text.endsWith("\n") ? "\n\n" : text ? "\n" : "";
    next = text + `${separator}${header}\n${trustLine}\n`;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await stat(file).catch(() => undefined);
  const mode = metadata ? metadata.mode & 0o777 : 0o600;
  await atomic(file, next, mode);
}

async function writeManifest(jobDir: string, manifest: Record<string, unknown>): Promise<void> {
  await atomicInPrivateDir(path.join(jobDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { finished as streamFinished } from "node:stream/promises";
import { claudeHome, claudeLaunchEnv } from "./claude-accounts.js";
import { fanoutRoot } from "./fanouts.js";
import { pretrustFolder } from "./folder-trust.js";
import { findPane, paneIdentity, servers, snapshot } from "./herdr.js";
import { agentNotReady, terminalProvider } from "./terminal.js";
import { atomicInPrivateDir, BridgeError } from "./protocol.js";
import { defaultPhrenPath } from "../shared.js";
import { watchHerdrRun } from "./schedule-watch.js";
/** Starting a scheduled run: in a Herdr pane when a server is live, otherwise
 * as a headless job under the fan-out root. */
const CLAUDE_SCHEDULE_SETTINGS = JSON.stringify({ enableAllProjectMcpServers: true });
export function createScheduleLauncher(launchHerdr, store = defaultPhrenPath()) {
    const abort = new AbortController(), children = new Set();
    const launcher = async (context) => {
        const live = await servers();
        if (live.length)
            return launchInHerdr(String(live[0].session), context, launchHerdr, abort.signal);
        return launchHeadless(context, store, child => { children.add(child); child.once("exit", () => children.delete(child)); });
    };
    launcher.close = () => { abort.abort(); for (const child of children)
        child.kill("SIGTERM"); children.clear(); };
    launcher.resume = (run, schedule) => resumeScheduleRun(run, schedule, abort.signal);
    return launcher;
}
/**
 * The outcome of a run a previous Hook process launched and never saw finish
 * (a restart or crash mid-run). A Herdr pane is followed again to its real
 * end; a headless job's manifest says how it ended, if it got that far. A run
 * whose end cannot be known fails with that reason rather than staying open,
 * since an open run blocks its schedule for good.
 */
export async function resumeScheduleRun(run, schedule, signal, watch = watchHerdrRun) {
    const launch = run.launch;
    if (run.status === "launched")
        return { status: "failed", reason: "Phren Hook restarted before this run finished launching." };
    if (launch.mode === "herdr" && launch.server && launch.workspaceId && launch.tabId && launch.paneId) {
        return watch(launch.server, { workspaceId: launch.workspaceId, tabId: launch.tabId, paneId: launch.paneId }, signal, { source: schedule.harness, startedAt: Date.parse(run.startedAt), sessionId: launch.sessionId });
    }
    if (launch.mode === "headless" && launch.jobDir) {
        const manifest = await readFile(path.join(launch.jobDir, "manifest.json"), "utf8").then(text => JSON.parse(text)).catch(() => undefined);
        if (manifest?.status === "completed")
            return { status: "finished" };
        if (manifest?.status === "failed") {
            return { status: "failed", reason: typeof manifest.exitCode === "number" ? `The scheduled agent exited with code ${manifest.exitCode}.` : "The scheduled agent failed." };
        }
    }
    return { status: "failed", reason: "Phren Hook restarted while this run was going, so its end was not observed." };
}
async function launchInHerdr(server, context, launchHerdr, signal) {
    // The prompt goes with the launch where the harness takes one (Claude,
    // Codex); otherwise it is typed once the agent is ready.
    const brief = context.schedule.prompt.trim() ? { brief: { id: context.runId, text: context.schedule.prompt } } : {};
    const launched = await launchHerdr(server, { cwd: context.cwd, label: context.schedule.name, kind: context.schedule.harness, model: context.schedule.model, ...(context.schedule.account ? { account: context.schedule.account } : {}), ...brief });
    const workspaceId = String(launched.workspaceId), tabId = String(launched.tabId), paneId = String(launched.paneId);
    if (launched.briefLaunched !== true)
        await promptWhenReady(server, paneId, context.schedule.prompt, signal);
    let sessionId = typeof launched.sessionId === "string" ? launched.sessionId : undefined;
    for (let attempt = 0; attempt < 10 && !sessionId; attempt++) {
        const pane = findPane(await snapshot(server), { workspace: workspaceId, tab: tabId, pane: paneId });
        if (pane)
            sessionId = await paneIdentity(server, pane).catch(() => undefined);
        if (!sessionId)
            await new Promise(resolve => setTimeout(resolve, 200));
    }
    const launch = { mode: "herdr", server, workspaceId, tabId, paneId,
        ...(sessionId ? { sessionId } : {}) };
    return { launch, completion: watchHerdrRun(server, { workspaceId, tabId, paneId }, signal, { source: context.schedule.harness, startedAt: Date.now(), sessionId, onBlocked: context.blockedStartup }) };
}
/** Herdr refuses a prompt until the agent has finished starting; a run
 * launched a moment ago waits for it rather than failing on the first try. */
async function promptWhenReady(server, paneId, text, signal, waitMs = 60_000) {
    const deadline = Date.now() + waitMs;
    for (;;) {
        try {
            await terminalProvider().prompt(server, paneId, text, signal);
            return;
        }
        catch (error) {
            const starting = agentNotReady(error);
            if (!starting || signal.aborted)
                throw error;
            if (Date.now() >= deadline)
                throw new BridgeError(409, `The agent in ${paneId} never became ready for the prompt; it may be waiting at a startup screen on the computer.`);
            await new Promise(resolve => setTimeout(resolve, 1_000));
        }
    }
}
/** The environment a headless run gets: this Hook's, plus the chosen Claude account's config directory. */
export function headlessEnv(schedule, env = process.env) {
    if (!schedule.account || schedule.harness !== "claude")
        return env;
    const home = claudeHome(schedule.account, env);
    if (!home)
        throw new Error(`Schedule "${schedule.name}" uses Claude account "${schedule.account}", which is not set up on this computer. Run \`phren bridge accounts\`.`);
    return { ...env, ...claudeLaunchEnv(home) };
}
async function launchHeadless(context, store, started) {
    const env = headlessEnv(context.schedule);
    const root = fanoutRoot({ ...process.env, PHREN_PATH: store }), jobDir = path.join(root, context.runId);
    await mkdir(jobDir, { recursive: true, mode: 0o700 });
    const eventLog = "events.jsonl", now = new Date().toISOString();
    const manifest = { schemaVersion: 1, id: context.runId, provider: context.schedule.harness,
        taskLabel: context.schedule.name, cwd: context.cwd, worktree: context.cwd, ...(context.schedule.model ? { model: context.schedule.model } : {}),
        eventLog, createdAt: now, startedAt: now, updatedAt: now, status: "queued", schedule: { id: context.schedule.id, project: context.project } };
    await writeManifest(jobDir, manifest);
    const command = headlessCommand(context.schedule, context.cwd);
    // An untrusted directory only costs Codex a prompt; the run still starts, and the log says why.
    // Headless Claude (`-p`) has no trust screen, so only Codex needs it here.
    if (context.schedule.harness === "codex")
        await pretrustFolder("codex", context.cwd, `scheduled run ${context.runId}`);
    let child;
    try {
        child = spawn(command.file, command.args, { cwd: command.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    }
    catch (error) {
        await writeManifest(jobDir, { ...manifest, status: "failed", updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
        throw error;
    }
    started(child);
    const closed = new Promise(resolve => {
        child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const output = createWriteStream(path.join(jobDir, eventLog), { flags: "a", mode: 0o600 });
    const errors = createWriteStream(path.join(jobDir, "stderr.log"), { flags: "a", mode: 0o600 });
    const streamsFinished = Promise.all([streamFinished(output), streamFinished(errors)]).then(() => undefined).catch(() => undefined);
    child.stdin?.on("error", () => { });
    child.stdout?.pipe(output);
    child.stderr?.pipe(errors);
    child.stdin?.end(context.schedule.prompt);
    await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
    }).catch(async (error) => {
        output.end();
        errors.end();
        await writeManifest(jobDir, { ...manifest, status: "failed", updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
        throw error;
    });
    await writeManifest(jobDir, { ...manifest, status: "running", updatedAt: new Date().toISOString() });
    const completion = closed.then(async ({ code, signal }) => {
        await streamsFinished;
        const finishedAt = new Date().toISOString(), ok = code === 0;
        await writeManifest(jobDir, { ...manifest, status: ok ? "completed" : "failed", updatedAt: finishedAt, finishedAt,
            ...(typeof code === "number" ? { exitCode: code } : {}) }).catch(() => { });
        return ok ? { status: "finished" } : { status: "failed", reason: signal ? `The scheduled agent exited after ${signal}.` : `The scheduled agent exited with code ${code ?? "unknown"}.` };
    });
    return { launch: { mode: "headless", jobDir }, completion };
}
export function headlessCommand(schedule, cwd) {
    const model = schedule.model ? ["--model", schedule.model] : [];
    if (schedule.harness === "codex")
        return { file: "codex", cwd, args: ["exec", ...model, "--sandbox", "workspace-write", "-C", cwd,
                "--skip-git-repo-check", "--json", "-"] };
    if (schedule.harness === "opencode")
        return { file: "opencode", cwd, args: ["run", "--format", "json", "--dir", cwd, ...model] };
    return { file: "claude", cwd, args: ["-p", "--output-format", "stream-json", "--settings", CLAUDE_SCHEDULE_SETTINGS, ...model] };
}
async function writeManifest(jobDir, manifest) {
    await atomicInPrivateDir(path.join(jobDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

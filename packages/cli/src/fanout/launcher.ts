import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteText } from "../phren-paths.js";
import { manifestSchema, type FanoutManifest } from "../bridge/fanouts.js";
import { codex } from "./adapters/codex.js";
import { opencode } from "./adapters/opencode.js";
import { claude } from "./adapters/claude.js";
import { uuid, type LaunchOptions, type Provider } from "./adapters/types.js";
import { LoopWatchdog, stderrRefusal } from "./watchdog.js";
export const adapters = { codex, opencode, claude };
export interface JobOptions extends Omit<LaunchOptions, "job"> { store: string; provider: Provider; label: string; reason: string; prompt: string }
export function jobsRoot(store: string): string { return path.join(store, ".runtime", "agent-fanouts"); }
export function readJob(store: string, id: string): FanoutManifest {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id)) throw new Error("Invalid job id.");
  const root = fs.realpathSync(jobsRoot(store)), job = path.join(root, id);
  if (!fs.lstatSync(job).isDirectory() || fs.realpathSync(job) !== job) throw new Error("Invalid job directory.");
  const file = path.join(job, "manifest.json"), info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536) throw new Error("Invalid job manifest.");
  const result = manifestSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (result.id !== id) throw new Error("Job id does not match its manifest.");
  return result;
}
export function listJobs(store: string): FanoutManifest[] {
  if (!fs.existsSync(jobsRoot(store))) return [];
  return fs.readdirSync(jobsRoot(store)).flatMap(id => { try { return [readJob(store, id)]; } catch { return []; } });
}
export function swiftBuildCount(): number {
  const output = execFileSync("ps", ["-axo", "comm="], { encoding: "utf8", timeout: 5_000 });
  return output.split("\n").filter(line => path.basename(line.trim()) === "xcodebuild").length;
}
export function writeManifest(job: string, manifest: FanoutManifest): void {
  atomicWriteText(path.join(job, "manifest.json"), JSON.stringify(manifestSchema.parse(manifest)) + "\n");
  fs.chmodSync(path.join(job, "manifest.json"), 0o600);
}
export function createJob(options: JobOptions, env: NodeJS.ProcessEnv = process.env): { job: string; manifest: FanoutManifest } {
  if (!options.label.trim() || options.label.length > 200) throw new Error("Choose a label of 1 to 200 characters.");
  const worktree = fs.realpathSync(options.worktree);
  if (!fs.statSync(worktree).isDirectory()) throw new Error("Choose a worktree directory.");
  const id = `${options.provider}-${randomBytes(12).toString("hex")}`;
  const root = jobsRoot(options.store), job = path.join(root, id);
  fs.mkdirSync(job, { recursive: true, mode: 0o700 }); fs.chmodSync(root, 0o700);
  const codexParent = uuid(env.CODEX_THREAD_ID || env.CODEX_SESSION_ID), claudeParent = uuid(env.CLAUDE_CODE_SESSION_ID);
  const now = new Date().toISOString();
  const manifest: FanoutManifest = { schemaVersion: 1, id, provider: options.provider, taskLabel: options.label,
    cwd: worktree, worktree, model: options.model, eventLog: "events.jsonl", createdAt: now, startedAt: now, updatedAt: now,
    status: "running", reason: options.reason, ...(options.resume ? { resumes: options.resume } : {}),
    ...(codexParent ? { parent: { provider: "codex", session: codexParent } } : claudeParent ? { parent: { provider: "claude", session: claudeParent } } : {}) };
  for (const [file, content] of Object.entries({ "prompt.txt": options.prompt, "events.jsonl": "", "stderr.log": "" })) fs.writeFileSync(path.join(job, file), content, { mode: 0o600 });
  writeManifest(job, manifest);
  return { job, manifest };
}
export async function launch(options: JobOptions, reservation = createJob(options)): Promise<number> {
  const { job, manifest } = reservation, adapter = adapters[options.provider];
  console.log(job);
  const out = fs.openSync(path.join(job, manifest.eventLog), "a"), err = fs.openSync(path.join(job, "stderr.log"), "a");
  const child = spawn("nice", ["-n", "15", adapter.command, ...adapter.argv({ ...options, job })], {
    cwd: manifest.worktree, env: { ...process.env, PHREN_FANOUT_JOB: manifest.id, PHREN_FANOUT_DIR: job },
    stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
  });
  let pending = "", stderr = "", cancelled = false;
  const watchdog = new LoopWatchdog();
  const kill = () => { try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch { /* Already exited. */ } };
  const cancel = () => { cancelled = true; kill(); };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, cancel);
  child.stdout?.on("data", (chunk: Buffer) => {
    fs.writeSync(out, chunk); pending += chunk.toString("utf8");
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      try { const event = JSON.parse(line); watchdog.observe(event); const session = adapter.session(event); if (session && !manifest.session) { manifest.session = session; writeManifest(job, manifest); } } catch { /* Partial or non-JSON provider output. */ }
    }
    if (pending.length > 1_048_576) pending = "";
  });
  child.stderr?.on("data", (chunk: Buffer) => { fs.writeSync(err, chunk); stderr = (stderr + chunk.toString("utf8")).slice(-16_384); });
  child.stdin?.on("error", () => {});
  child.stdin?.end(options.prompt);
  const timer = setInterval(() => {
    const reason = watchdog.reason();
    if (!reason) return;
    fs.writeFileSync(path.join(job, "looped.txt"), reason + "\n", { mode: 0o600 });
    atomicWriteText(path.join(job, "blocked.json"), JSON.stringify({ type: "tool_loop", pattern: "", message: reason, at: new Date().toISOString() }));
    kill();
  }, 30_000);
  const exitCode = await new Promise<number>(resolve => { child.once("error", error => { fs.writeSync(err, `${error.message}\n`); resolve(127); }); child.once("close", code => resolve(cancelled ? 130 : code ?? 1)); });
  clearInterval(timer);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, cancel);
  fs.closeSync(out); fs.closeSync(err);
  const blockedFile = path.join(job, "blocked.json"), refusal = stderrRefusal(stderr);
  if (refusal && !fs.existsSync(blockedFile)) atomicWriteText(blockedFile, JSON.stringify({ ...refusal, at: new Date().toISOString() }));
  const blocked = fs.existsSync(blockedFile);
  if (blocked) console.error(`blocked: ${fs.readFileSync(blockedFile, "utf8").slice(0, 4000)}`);
  fs.writeFileSync(path.join(job, "exit.txt"), `${exitCode}\n`, { mode: 0o600 });
  writeManifest(job, { ...manifest, status: blocked ? "failed" : cancelled ? "cancelled" : exitCode === 0 ? "completed" : "failed",
    exitCode, updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
  return blocked && exitCode === 0 ? 1 : exitCode;
}

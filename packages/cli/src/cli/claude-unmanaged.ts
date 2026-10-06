import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { jobsRoot, listJobs, readJob, writeManifest } from "../fanout/launcher.js";
import { uuid } from "../fanout/adapters/types.js";

export interface ClaudeHookPayload { session_id?: string; transcript_path?: string; cwd?: string }

export function readClaudeHookPayload(): ClaudeHookPayload | undefined {
  if (process.stdin.isTTY) return;
  try { return JSON.parse(fs.readFileSync(0, "utf8")) as ClaudeHookPayload; } catch { return; }
}

function claudeProcess(): { pid: number; headless: boolean } | undefined {
  let pid = process.ppid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    let row: string;
    try { row = execFileSync("ps", ["-o", "ppid=,comm=,tty=", "-p", String(pid)], { encoding: "utf8", timeout: 1_000 }).trim(); }
    catch { return; }
    const match = /^(\d+)\s+(\S+)\s+(\S+)$/.exec(row);
    if (!match) return;
    if (path.basename(match[2]) === "claude") return { pid, headless: match[3] === "?" || match[3] === "??" };
    pid = Number(match[1]);
  }
}

function nativePath(file: string, session: string): boolean {
  const root = path.join(homedir(), ".claude", "projects");
  if (!path.isAbsolute(file) || path.basename(file) !== `${session}.jsonl` || !file.startsWith(root + path.sep)) return false;
  try { return fs.realpathSync(path.dirname(file)).startsWith(fs.realpathSync(root) + path.sep); }
  catch { return false; }
}

/** Returns true for a recognized unmanaged headless worker, even when already registered. */
export function registerUnmanagedClaude(payload: ClaudeHookPayload | undefined, store: string, cwd: string,
  env: NodeJS.ProcessEnv = process.env, processInfo?: { pid: number; headless: boolean }): boolean {
  if (env.PHREN_FANOUT_JOB || env.PHREN_FANOUT_DIR) return false;
  const session = uuid(payload?.session_id);
  const transcript = payload?.transcript_path;
  const parentCodex = uuid(env.CODEX_THREAD_ID || env.CODEX_SESSION_ID);
  const parentClaude = uuid(env.CLAUDE_CODE_SESSION_ID);
  const parent = parentCodex ? { provider: "codex" as const, session: parentCodex }
    : parentClaude && parentClaude !== session ? { provider: "claude" as const, session: parentClaude } : undefined;
  if (!session || !parent || typeof transcript !== "string" || !nativePath(transcript, session)) return false;
  const running = processInfo ?? claudeProcess();
  if (!running?.pid || !(running.headless || env.CLAUDE_CODE_ENTRYPOINT?.startsWith("sdk-"))) return false;
  const root = jobsRoot(store), id = `claude-unmanaged-${session}`;
  if (fs.existsSync(root) && fs.realpathSync(root) !== path.join(fs.realpathSync(store), ".runtime", "agent-fanouts")) return false;
  if (fs.existsSync(root) && listJobs(store).some(job => job.provider === "claude" && job.session === session)) return true;
  const job = path.join(root, id);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 }); fs.chmodSync(root, 0o700);
  try { fs.mkdirSync(job, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return true;
    throw error;
  }
  const now = new Date().toISOString(), worktree = path.resolve(payload?.cwd || cwd);
  fs.writeFileSync(path.join(job, "events.jsonl"), "", { mode: 0o600 });
  writeManifest(job, { schemaVersion: 1, id, parent, provider: "claude", session,
    taskLabel: `Claude worker · ${path.basename(worktree)}`, cwd: worktree, worktree,
    eventLog: "events.jsonl", nativeTranscript: transcript, unmanagedPid: running.pid,
    createdAt: now, startedAt: now, updatedAt: now, status: "running" });
  return true;
}

export function finishUnmanagedClaude(payload: ClaudeHookPayload | undefined, store: string): boolean {
  const session = uuid(payload?.session_id);
  if (!session) return false;
  const id = `claude-unmanaged-${session}`, job = path.join(jobsRoot(store), id);
  let manifest;
  try { manifest = readJob(store, id); } catch { return false; }
  if (!manifest.nativeTranscript || (payload?.transcript_path && manifest.nativeTranscript !== payload.transcript_path)) return false;
  if (manifest.status === "running") {
    const now = new Date().toISOString();
    writeManifest(job, { ...manifest, status: "completed", updatedAt: now, finishedAt: now, exitCode: 0 });
    fs.writeFileSync(path.join(job, "exit.txt"), "0\n", { mode: 0o600 });
  }
  return true;
}

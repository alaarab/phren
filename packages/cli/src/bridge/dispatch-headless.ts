import { nonInteractiveGitEnv } from "../utils-helpers.js";
import { execFile, spawn as spawnProcess, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { visibleCodexExecEvent, visibleOpenCodeRunEvent } from "./fanouts.js";
import { BridgeError, bridgeRoot, provider, startingTargetSchema, targetSchema, type Json } from "./protocol.js";

const exec = promisify(execFile);
const timestamp = z.string().datetime({ offset: true });
const uuid = z.string().uuid();
const plain = (max: number) => z.string().min(1).max(max)
  .refine(value => !!value.trim() && !/[\x00-\x1f\x7f]/.test(value));
const optionValue = (max: number) => plain(max).refine(value => !value.startsWith("-"));
const headlessProvider = z.enum(["codex", "opencode"]);
const jobID = uuid;
const MAX_EVENT_LOG_BYTES = 1_048_576;

/** A remote parent is identity metadata, never a receiver-side transcript path. */
export const dispatchParentSchema = z.object({
  provider,
  session: z.union([z.string().uuid(), z.string().regex(/^ses_[0-9A-Za-z]{1,64}$/)]),
  computer: uuid.optional(),
}).strict();

export const targetDestinationSchema = z.object({
  kind: z.literal("target"),
  target: z.union([targetSchema, startingTargetSchema]),
}).strict();
export const headlessDestinationSchema = z.object({ kind: z.literal("headless"), jobId: jobID }).strict();
export const dispatchDestinationSchema = z.discriminatedUnion("kind", [targetDestinationSchema, headlessDestinationSchema]);
export type DispatchDestination = z.infer<typeof dispatchDestinationSchema>;

/** This is only accepted on the receiving Hook after its local project lookup. */
export const dispatchHeadlessLaunchSchema = z.object({
  dispatchId: uuid,
  parent: dispatchParentSchema.optional(),
  harness: headlessProvider,
  model: optionValue(200).optional(),
  mode: z.enum(["read-only", "workspace-write"]).optional(),
  prompt: z.string().min(1).max(32_768).refine(value => !/[\x00-\x08\x0b-\x1f\x7f]/.test(value)),
  label: optionValue(200),
}).strict();
export type DispatchHeadlessLaunch = z.infer<typeof dispatchHeadlessLaunchSchema>;

const manifestSchema = dispatchHeadlessLaunchSchema.omit({ prompt: true, harness: true }).extend({
  schemaVersion: z.literal(1),
  jobId: jobID,
  provider: headlessProvider,
  cwd: z.string().min(1).max(4096).refine(path.isAbsolute),
  worktree: z.string().min(1).max(4096).refine(path.isAbsolute),
  eventLog: z.literal("events.jsonl"),
  stderrLog: z.literal("stderr.log"),
  createdAt: timestamp,
  updatedAt: timestamp,
  finishedAt: timestamp.optional(),
  status: z.enum(["preparing", "spawning", "running", "completed", "failed", "uncertain"]),
  exitCode: z.number().int().min(0).max(255).optional(),
  error: z.string().max(500).optional(),
}).strict();
type HeadlessManifest = z.infer<typeof manifestSchema>;

export const MAX_HEADLESS_LEADS = 4;

type Spawn = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
type WorktreeCreator = (source: string, destination: string) => Promise<string>;

export interface DispatchHeadlessOptions {
  root?: string;
  wrapperPath?: string;
  maxLeads?: number;
  spawn?: Spawn;
  createWorktree?: WorktreeCreator;
  /** Test-only seam for the interval after the process exists but before the receipt confirms it. */
  afterSpawn?: (child: ChildProcess) => Promise<void> | void;
}

export function fanoutWrapperPath(home = homedir()): string {
  return path.join(home, ".phren", "global", "skills", "fanout", "scripts", "run.sh");
}

function headlessRoot(root: string): string { return path.join(root, "headless-dispatches"); }
function worktreeRoot(root: string): string { return path.join(root, "headless-worktrees"); }
function manifestPath(root: string, jobId: string): string { return path.join(headlessRoot(root), jobID.parse(jobId), "manifest.json"); }

async function atomicWrite(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  try { await rename(temporary, file); } finally { await unlink(temporary).catch(() => {}); }
}

async function regularManifest(file: string): Promise<HeadlessManifest | undefined> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536) return;
    return manifestSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch { return; }
}

async function verifiedWrapper(file: string): Promise<string> {
  const info = await lstat(file).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || !(info.mode & 0o111)) {
    throw new BridgeError(503, "Headless dispatch needs the installed fanout wrapper at ~/.phren/global/skills/fanout/scripts/run.sh.");
  }
  return realpath(file);
}

async function isolatedWorktree(source: string, destination: string): Promise<string> {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  try {
    await exec("git", ["-C", source, "worktree", "add", "--detach", destination, "HEAD"], { env: nonInteractiveGitEnv(), timeout: 20_000, maxBuffer: 65_536 });
    return await realpath(destination);
  } catch {
    throw new BridgeError(503, "Headless dispatch needs a Git checkout to create an isolated worktree.");
  }
}

function publicManifest(manifest: HeadlessManifest): Json {
  const status = manifest.status === "spawning" ? "uncertain" : manifest.status;
  return {
    destination: { kind: "headless", jobId: manifest.jobId }, dispatchId: manifest.dispatchId,
    provider: manifest.provider, label: manifest.label, status, createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt, ...(manifest.finishedAt ? { finishedAt: manifest.finishedAt } : {}),
    ...(manifest.exitCode === undefined ? {} : { exitCode: manifest.exitCode }),
    ...(manifest.error ? { error: manifest.error } : {}),
    answer: { available: false, reason: `${manifest.provider} headless workers do not expose an answer API.` },
  };
}

function asBridgeError(error: unknown, fallback: string): BridgeError {
  return error instanceof BridgeError ? error : new BridgeError(503, fallback);
}

/**
 * Receiver-local headless launcher. It deliberately knows nothing about peers:
 * the sender only receives its opaque job handle after this Hook has persisted it.
 */
export class DispatchHeadless {
  private readonly root: string;
  private readonly wrapper: string;
  private readonly maxLeads: number;
  private readonly spawn: Spawn;
  private readonly createWorktree: WorktreeCreator;
  private readonly afterSpawn?: (child: ChildProcess) => Promise<void> | void;
  private serial: Promise<void> = Promise.resolve();

  constructor(options: DispatchHeadlessOptions = {}) {
    this.root = options.root ?? bridgeRoot();
    this.wrapper = options.wrapperPath ?? fanoutWrapperPath();
    this.maxLeads = options.maxLeads ?? MAX_HEADLESS_LEADS;
    this.spawn = options.spawn ?? ((file, args, spawnOptions) => spawnProcess(file, args, spawnOptions));
    this.createWorktree = options.createWorktree ?? isolatedWorktree;
    this.afterSpawn = options.afterSpawn;
  }

  async available(): Promise<boolean> {
    try { await verifiedWrapper(this.wrapper); return true; } catch { return false; }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.serial;
    let release!: () => void;
    this.serial = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private async activeLeads(): Promise<number> {
    const names = (await readdir(headlessRoot(this.root)).catch(() => [])).filter(name => /^[a-f0-9-]{36}$/.test(name));
    let active = 0;
    for (const name of names.slice(0, 1024)) {
      const manifest = await regularManifest(manifestPath(this.root, name));
      if (manifest && ["preparing", "spawning", "running", "uncertain"].includes(manifest.status)) active++;
    }
    return active;
  }

  private async sourceDirectory(value: string): Promise<string> {
    const source = await realpath(value).catch(() => undefined);
    if (!source || !(await stat(source)).isDirectory()) throw new BridgeError(404, "Project is not on this computer.");
    return source;
  }

  /** `sourceDirectory` must come from the receiving Hook's registered project lookup. */
  async launch(value: unknown, sourceDirectory: string): Promise<Json> {
    return this.exclusive(async () => {
      const input = dispatchHeadlessLaunchSchema.parse(value);
      if (await this.activeLeads() >= this.maxLeads) throw new BridgeError(429, "The headless lead limit is reached. Wait for a running lead to finish.");
      const wrapper = await verifiedWrapper(this.wrapper);
      const source = await this.sourceDirectory(sourceDirectory);
      const jobId = randomUUID();
      const worktrees = worktreeRoot(this.root);
      await mkdir(worktrees, { recursive: true, mode: 0o700 });
      const root = await realpath(worktrees);
      const destination = path.join(root, jobId);
      const now = new Date().toISOString();
      let manifest: HeadlessManifest = {
        schemaVersion: 1, jobId, dispatchId: input.dispatchId, ...(input.parent ? { parent: input.parent } : {}),
        provider: input.harness, ...(input.model ? { model: input.model } : {}), ...(input.mode ? { mode: input.mode } : {}),
        label: input.label, cwd: source, worktree: destination, eventLog: "events.jsonl", stderrLog: "stderr.log",
        createdAt: now, updatedAt: now, status: "preparing",
      };
      await atomicWrite(manifestPath(this.root, jobId), manifest);
      try {
        const worktree = await this.createWorktree(source, destination);
        if (!worktree.startsWith(root + path.sep) || worktree === source) throw new BridgeError(503, "The fanout wrapper did not receive an isolated worktree.");
        manifest = { ...manifest, worktree, status: "spawning", updatedAt: new Date().toISOString() };
        await atomicWrite(manifestPath(this.root, jobId), manifest);
      } catch (error) {
        manifest = { ...manifest, status: "failed", updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), error: asBridgeError(error, "Could not create the isolated worktree.").message.slice(0, 500) };
        await atomicWrite(manifestPath(this.root, jobId), manifest);
        throw asBridgeError(error, "Could not create the isolated worktree.");
      }

      const args = ["--provider", input.harness, "--label", input.label, "--worktree", manifest.worktree,
        ...(input.model ? ["--model", input.model] : []), ...(input.mode ? ["--mode", input.mode] : [])];
      const events = await open(path.join(path.dirname(manifestPath(this.root, jobId)), manifest.eventLog), "a", 0o600);
      const errors = await open(path.join(path.dirname(manifestPath(this.root, jobId)), manifest.stderrLog), "a", 0o600);
      let child: ChildProcess, started: Promise<void>;
      let spawned = false;
      let receiptSaved = false, closed: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      try {
        // Separate argv values and a stdin brief keep labels, models and prompts out of a shell.
        child = this.spawn(wrapper, args, { cwd: manifest.worktree, detached: true, stdio: ["pipe", events.fd, errors.fd] });
        // Node reports spawn or error on the next tick, so these listeners must exist before anything is awaited.
        started = new Promise<void>((resolve, reject) => {
          child.once("spawn", () => { spawned = true; resolve(); });
          child.once("error", reject);
        });
        started.catch(() => {});
        child.once("close", (code, signal) => {
          if (receiptSaved) void this.finish(jobId, code, signal);
          else closed = { code, signal };
        });
      } catch (error) {
        await events.close(); await errors.close();
        manifest = { ...manifest, status: "failed", updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), error: "The fanout wrapper could not start." };
        await atomicWrite(manifestPath(this.root, jobId), manifest);
        throw asBridgeError(error, "The fanout wrapper could not start.");
      }
      await events.close(); await errors.close();
      try {
        await started;
        child.stdin?.end(input.prompt);
        child.unref();
        await this.afterSpawn?.(child);
        manifest = { ...manifest, status: "running", updatedAt: new Date().toISOString() };
        await atomicWrite(manifestPath(this.root, jobId), manifest);
        receiptSaved = true;
      } catch (error) {
        if (!spawned) {
          manifest = { ...manifest, status: "failed", updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), error: "The fanout wrapper could not start." };
          await atomicWrite(manifestPath(this.root, jobId), manifest);
          throw asBridgeError(error, "The fanout wrapper could not start.");
        }
        // The spawn happened. Leaving this receipt at spawning is the durable no-restart boundary.
        throw new BridgeError(503, "The headless wrapper may be running. Inspect this dispatch before retrying.");
      }
      if (closed) {
        await this.finish(jobId, closed.code, closed.signal);
        manifest = await regularManifest(manifestPath(this.root, jobId)) ?? manifest;
      }
      return { ok: true, ...publicManifest(manifest) };
    });
  }

  private async finish(jobId: string, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    const file = manifestPath(this.root, jobId), current = await regularManifest(file);
    if (!current || !["running", "spawning"].includes(current.status)) return;
    const at = new Date().toISOString();
    const ok = code === 0;
    await atomicWrite(file, { ...current, status: ok ? "completed" : "failed", updatedAt: at, finishedAt: at,
      ...(typeof code === "number" ? { exitCode: code } : {}), ...(ok ? {} : { error: signal ? `The headless wrapper exited after ${signal}.` : `The headless wrapper exited with code ${code ?? "unknown"}.` }) }).catch(() => {});
  }

  async read(value: unknown): Promise<Json> {
    const input = z.object({ destination: headlessDestinationSchema, after: z.number().int().min(0).max(1_000_000).optional() }).strict().parse(value);
    const manifest = await regularManifest(manifestPath(this.root, input.destination.jobId));
    if (!manifest) throw new BridgeError(404, "That headless dispatch is not available on this computer.");
    const log = path.join(path.dirname(manifestPath(this.root, manifest.jobId)), manifest.eventLog);
    const info = await lstat(log).catch(() => undefined);
    if (info && (!info.isFile() || info.isSymbolicLink() || info.size > MAX_EVENT_LOG_BYTES)) throw new BridgeError(413, "The headless event log is unavailable.");
    const lines = info ? (await readFile(log, "utf8")).split("\n") : [];
    const after = input.after ?? 0, events: Json[] = [];
    for (let index = after; index < lines.length && events.length < 200; index++) {
      if (!lines[index]) continue;
      try {
        const raw = JSON.parse(lines[index]) as Json;
        const event = manifest.provider === "codex" ? visibleCodexExecEvent(raw) : visibleOpenCodeRunEvent(raw);
        if (event) events.push(event);
      } catch { /* A partial or non-event wrapper line is not public transcript content. */ }
    }
    return { ...publicManifest(manifest), events, next: lines.length };
  }

  async answer(value: unknown): Promise<never> {
    const input = z.object({ destination: headlessDestinationSchema }).strict().parse(value);
    const manifest = await regularManifest(manifestPath(this.root, input.destination.jobId));
    if (!manifest) throw new BridgeError(404, "That headless dispatch is not available on this computer.");
    throw new BridgeError(409, `${manifest.provider} headless workers do not expose an answer API. Open a supported remote chat instead.`);
  }
}

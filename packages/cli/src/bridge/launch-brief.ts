import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomic, bridgeRoot, targetSchema, type Target } from "./protocol.js";

/**
 * A worker's first prompt carried by its launch instead of typed into a
 * starting pane. The brief is written to a private file on the computer that
 * starts the agent, and the harness gets one short argument pointing at it:
 * `claude "<prompt>"` and `codex "<prompt>"` both open the interactive TUI
 * and submit that prompt themselves, so there is no Enter to lose and no
 * starting pane to wait for. The same id is exported to the agent as
 * `PHREN_DISPATCH_ID`, and its SessionStart and UserPromptSubmit hooks echo
 * it back: the receipt is that echo, not a match on typed text.
 *
 * OpenCode takes its brief over the HTTP API its launched TUI serves
 * (opencode-panes.ts); the file is still written so the arrival is recorded
 * here. Copilot, with no such argument or API, keeps the typed path.
 */

/** A dispatch receipt id or a scheduled run id: what `PHREN_DISPATCH_ID` carries. */
export const briefId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const launchBriefSchema = z.object({
  id: briefId,
  text: z.string().min(1).max(32768).refine(value => !!value.trim() && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value)),
}).strict();
export type LaunchBrief = z.infer<typeof launchBriefSchema>;

/** The variable a launched agent's hooks read its brief id from. */
export const DISPATCH_ID_ENV = "PHREN_DISPATCH_ID";

/** Briefs older than this are removed when the next one is written; a worker
 * may re-read its brief after a compaction, so it is not removed on arrival. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BRIEFS = 256;

export function briefRoot(): string { return path.join(bridgeRoot(), "briefs"); }
function briefDirectory(id: string): string { return path.join(briefRoot(), briefId.parse(id)); }

/** The harnesses whose TUI takes a first prompt as an argument, and the
 * arguments that carry it. Claude reads outside its working directory only
 * with permission, so the brief's own folder is added to its tool access;
 * `--add-dir` takes several values, so it comes after the prompt. */
export function briefArgs(kind: string, file: string): string[] | undefined {
  if (!launchesWithBrief(kind)) return undefined;
  const prompt = `Read and follow the brief in ${file}`;
  if (kind === "claude") return [prompt, "--add-dir", path.dirname(file)];
  return [prompt];
}

export function launchesWithBrief(kind: string): boolean { return kind === "claude" || kind === "codex"; }

async function prune(now: number): Promise<void> {
  const root = briefRoot();
  const names = (await readdir(root).catch(() => [] as string[])).filter(name => briefId.safeParse(name).success);
  const entries = (await Promise.all(names.map(async name => {
    const info = await lstat(path.join(root, name)).catch(() => undefined);
    return info?.isDirectory() ? { name, at: info.mtimeMs } : undefined;
  }))).filter((entry): entry is { name: string; at: number } => !!entry).sort((a, b) => b.at - a.at);
  const stale = entries.filter((entry, index) => index >= MAX_BRIEFS - 1 || now - entry.at > KEEP_MS);
  await Promise.all(stale.map(entry => rm(path.join(root, entry.name), { recursive: true, force: true }).catch(() => undefined)));
}

/**
 * Writes the brief (0600, in a 0700 folder of its own) and returns its path.
 * The folder is filled beside `briefs/` and renamed into place, so a brief
 * folder never exists without its `brief.md`: anything that lists `briefs/`
 * (the arrival route, a test, the owner) sees a whole brief or none. Writing
 * it in place left a moment where the folder was there and the file was not.
 */
export async function writeLaunchBrief(brief: LaunchBrief, now = Date.now()): Promise<string> {
  await mkdir(briefRoot(), { recursive: true, mode: 0o700 });
  await prune(now);
  const directory = briefDirectory(brief.id);
  const file = path.join(directory, "brief.md");
  const text = brief.text.endsWith("\n") ? brief.text : `${brief.text}\n`;
  // The same id again (a retried launch) replaces the text in the existing folder.
  if (await stat(directory).catch(() => undefined)) { await atomic(file, text); return file; }
  const staging = path.join(bridgeRoot(), "briefs-staging");
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const draft = path.join(staging, `${brief.id}.${randomUUID()}`);
  try {
    await mkdir(draft, { mode: 0o700 });
    await atomic(path.join(draft, "brief.md"), text);
    await rename(draft, directory);
  } catch (error) {
    await rm(draft, { recursive: true, force: true }).catch(() => undefined);
    // Another writer published the same id first: write into its folder.
    if (!(await stat(path.join(directory, "brief.md")).catch(() => undefined))) throw error;
    await atomic(file, text);
  }
  return file;
}

const arrivalEvent = z.object({ at: z.string().datetime(), target: targetSchema }).strict();
export const arrivalSchema = z.object({ started: arrivalEvent.optional(), accepted: arrivalEvent.optional() }).strict();
export type BriefArrival = z.infer<typeof arrivalSchema>;

/** What the worker's own hooks have said about its brief: `started` at its
 * SessionStart, `accepted` when the brief prompt was submitted. Empty while
 * neither has arrived; undefined when this computer wrote no such brief. */
export async function briefArrival(id: string): Promise<BriefArrival | undefined> {
  const directory = briefDirectory(id);
  if (!(await stat(directory).catch(() => undefined))?.isDirectory()) return undefined;
  const text = await readFile(path.join(directory, "arrival.json"), "utf8").catch(() => undefined);
  const parsed = text === undefined ? undefined : arrivalSchema.safeParse((() => { try { return JSON.parse(text); } catch { return undefined; } })());
  return parsed?.success ? parsed.data : {};
}

/** The brief id in a prompt that points at a brief file, for callbacks that
 * cannot trust their own environment (Codex's shared hook daemon). */
export function briefIdInPrompt(prompt: string): string | undefined {
  const escaped = briefRoot().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}[\\\\/]([A-Za-z0-9_-]{8,64})[\\\\/]brief\\.md`).exec(prompt);
  return match?.[1];
}

let arrivals: Promise<unknown> = Promise.resolve();

/** Records a worker hook's report about its brief. Only the first of each
 * event counts, and only for a brief this computer wrote. */
export function recordBriefArrival(id: string, event: string, target: Target, now = new Date()): Promise<void> {
  const kind = event === "UserPromptSubmit" ? "accepted" : event === "SessionStart" ? "started" : undefined;
  if (!kind || !briefId.safeParse(id).success) return Promise.resolve();
  const run = arrivals.then(async () => {
    const current = await briefArrival(id);
    if (!current || current[kind]) return;
    await atomic(path.join(briefDirectory(id), "arrival.json"), arrivalSchema.parse({ ...current, [kind]: { at: now.toISOString(), target } }));
  });
  arrivals = run.catch(() => undefined);
  return run;
}

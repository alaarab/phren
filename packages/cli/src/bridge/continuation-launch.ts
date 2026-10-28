import { createHash } from "node:crypto";
import { lstat, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicInPrivateDir, BridgeError, bridgeRoot, type Json } from "./protocol.js";
import type { PeerIdentity } from "./request-origin.js";
import { terminalProvider } from "./terminal.js";
import { briefArrival, briefId, assertUnusedLaunchId } from "./launch-brief.js";
import { moveToSchema, projectName } from "./dispatch.js";

export const continuationLaunchSchema = z.object({
  workerDispatch: briefId.optional(), worker: z.boolean().default(false), computerId: z.string().uuid(), project: projectName, to: moveToSchema.refine(to => to.computer === undefined, "A receiving launch is local only."), label: z.string().max(200),
  brief: z.object({ id: z.string().uuid(), text: z.string().min(1).max(32768) }).strict(),
}).strict();
type Placement = { hash: string; worker?: boolean; workerDispatch?: string; state: "uncertain" | "placed" | "not-placed"; createdAt?: number; server?: string; caller?: PeerIdentity; paneTarget?: Json; result?: Json };
const queues = new Map<string, Promise<Json>>();
const creating = new Map<string, Placement>();
const fileFor = (id: string) => path.join(bridgeRoot(), "move-launches", `${z.string().uuid().parse(id)}.json`);

/** A durable intent precedes creation. An interrupted intent is reconciled by
 * its brief arrival, never by creating another pane. */
export async function continuationPlacement(id: string, includeCreating = true): Promise<Placement | undefined> {
  let saved: Placement;
  try { saved = JSON.parse(await readFile(fileFor(id), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return includeCreating ? creating.get(fileFor(id)) : undefined; throw error; }
  if (!saved.result) {
    const arrived = (await briefArrival(id))?.accepted?.target;
    if (arrived) {
      saved = { ...saved, state: "placed", result: { target: arrived, briefLaunched: true } };
      await atomicInPrivateDir(fileFor(id), JSON.stringify(saved));
    }
  }
  if (!saved.result && !queues.has(fileFor(id)) && saved.createdAt && Date.now() - saved.createdAt >= 10 * 60_000 && saved.server) {
    // A unique creation label covers a crash between create() and onPlaced().
    // Failure to inspect the terminal keeps the placement uncertain.
    const panes = await terminalProvider().listPanes(saved.server);
    if (!panes.some(pane => pane.label === `move-${id}` || saved.paneTarget && pane.pane === saved.paneTarget.pane)) {
      saved = { ...saved, state: "not-placed" }; await atomicInPrivateDir(fileFor(id), JSON.stringify(saved));
    }
  }
  return saved;
}

export async function launchContinuation(input: unknown, launch: (data: z.infer<typeof continuationLaunchSchema>, placed: (paneTarget: Json) => Promise<void>) => Promise<Json>, authorization?: { caller?: PeerIdentity; server: string }): Promise<Json> {
  const data = continuationLaunchSchema.parse(input);
  const file = fileFor(data.brief.id);
  const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  const pending = queues.get(file);
  if (pending) { await pending.catch(() => undefined); return launchContinuation(data, launch, authorization); }
  const metadata = { hash, worker: data.worker, ...(data.workerDispatch ? { workerDispatch: data.workerDispatch } : {}), createdAt: Date.now(), ...authorization };
  creating.set(file, { ...metadata, state: "uncertain" });
  const work = (async () => {
    const saved = await continuationPlacement(data.brief.id, false);
    if (saved) {
      if (JSON.stringify(saved.caller) !== JSON.stringify(authorization?.caller)) throw new BridgeError(403, "This peer is not the launch's recorded counterpart.");
      if (saved.hash !== hash) throw new BridgeError(409, "This move id already names a different launch.");
      if (saved.result) return saved.result;
      throw new BridgeError(409, "This move's launch is uncertain; inspect its existing pane or wait for its arrival. It will not be launched twice.");
    }
    await assertUnusedLaunchId(data.brief.id);
    await atomicInPrivateDir(file, JSON.stringify({ ...metadata, state: "uncertain" }));
    let paneTarget: Json | undefined;
    const result = await launch(data, async pane => {
      paneTarget = pane;
      await atomicInPrivateDir(file, JSON.stringify({ ...metadata, state: "uncertain", paneTarget }));
    });
    await atomicInPrivateDir(file, JSON.stringify({ ...metadata, state: "placed", paneTarget, result }));
    return result;
  })();
  queues.set(file, work);
  try { return await work; } finally { queues.delete(file); creating.delete(file); }
}

/** An owner-admitted source move publishes one canonical intent privately.
 * The receiving Hook pulls it back over its own verified reverse enrollment. */
const intentFile = (id: string) => path.join(bridgeRoot(), "move-intents", `${z.string().uuid().parse(id)}.json`);
export async function saveContinuationIntent(input: Json): Promise<void> {
  const id = z.string().uuid().parse((input.brief as Json).id);
  const previous = await readFile(intentFile(id), "utf8").catch(error => { if (error.code !== "ENOENT") throw error; return undefined; });
  const encoded = JSON.stringify(input);
  if (previous && previous !== encoded) throw new BridgeError(409, "This move id already has a different launch intent.");
  await atomicInPrivateDir(intentFile(id), encoded);
}
export async function continuationIntent(id: string): Promise<Json> {
  try { return JSON.parse(await readFile(intentFile(id), "utf8")); }
  catch { throw new BridgeError(404, "No owner-admitted continuation intent is recorded."); }
}

/**
 * The whole conversation a summary-by-target move copies to the receiving Hook, beside its intent: the source's
 * prompts and replies, already redacted the way a peer hand-off is. The brief only has room for its newest turns;
 * the receiving launch pulls this through the same intent route, in pages, and puts it in the new agent's brief
 * folder. A Hook that predates it ignores the page parameter and answers with the intent, which has no
 * `conversation`, so either side being older leaves the excerpt alone.
 */
export const CONVERSATION_LIMIT = 2_000_000;
const CONVERSATION_PAGE = 262_144;
/** Under the 1 MiB a Hook reads of one peer answer (client.ts), escaped as JSON. */
const PAGE_BYTES = 900_000;
const conversationFile = (id: string) => path.join(bridgeRoot(), "move-intents", `${z.string().uuid().parse(id)}.conversation.md`);
export const CONVERSATION_FILE = "conversation.md";

/** In a summary-by-target brief's opening line, so the receiving launch asks for a copy only for those moves. */
export const CONVERSATION_MARKER = "Phren copied its conversation instead";

/**
 * Removes the saved conversations no move needs any more, as `done` decides from the move id and the copy's age
 * (the move moved or failed, or it has no record at all), and any older than `maxAgeMs` whatever `done` says.
 * A destination reads a copy only while its launch runs, which is over once the move is moved or failed. A write
 * a crash left behind (`<copy>.<uuid>.tmp`) goes after an hour. Returns the move ids whose copy was removed.
 */
export async function pruneContinuationConversations(done: (id: string, ageMs: number) => boolean | Promise<boolean>, now = Date.now(), maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<string[]> {
  const root = path.join(bridgeRoot(), "move-intents");
  const names = await readdir(root).catch(() => [] as string[]);
  const removed: string[] = [];
  for (const name of names) {
    const match = /^([0-9a-f-]{36})\.conversation\.md(\.[0-9a-f-]{36}\.tmp)?$/i.exec(name);
    if (!match) continue;
    const file = path.join(root, name);
    const info = await lstat(file).catch(() => undefined);
    if (!info?.isFile()) continue;
    const age = now - info.mtimeMs;
    const remove = match[2] ? age > ORPHAN_GRACE_MS : age > maxAgeMs || await done(match[1], age);
    if (remove) await rm(file, { force: true }).then(() => { if (!match[2]) removed.push(match[1]); }, () => undefined);
  }
  return removed;
}
/** How long a copy with no move record (or a write a crash left) is kept: a move in another process records itself first. */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;

/** Saved once per move: a run of the move that starts again keeps the first copy, which a destination may be part way through reading. */
export async function saveContinuationConversation(id: string, text: string): Promise<void> {
  if (text.length > CONVERSATION_LIMIT) throw new BridgeError(413, "The conversation is too long to copy.");
  if (await stat(conversationFile(id)).catch(() => undefined)) return;
  await atomicInPrivateDir(conversationFile(id), text);
}

/** One page of the saved conversation from character `offset`, with its whole length and hash to check against. */
export async function continuationConversationPage(id: string, offset: number): Promise<Json> {
  let text: string;
  try { text = await readFile(conversationFile(id), "utf8"); }
  catch { throw new BridgeError(404, "No conversation is recorded for this move."); }
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) throw new BridgeError(400, "Invalid conversation offset.");
  let size = Math.min(CONVERSATION_PAGE, text.length - offset);
  // Escaping can grow text several times; a page always fits one answer and always moves forward.
  while (size > 1 && Buffer.byteLength(JSON.stringify(text.slice(offset, offset + size))) > PAGE_BYTES) size = Math.floor(size / 2);
  const end = offset + size;
  return { conversation: { text: text.slice(offset, end), offset, next: end < text.length ? end : null, total: text.length,
    sha256: createHash("sha256").update(text).digest("hex") } };
}

const pageSchema = z.object({ text: z.string(), offset: z.number().int().nonnegative(), next: z.number().int().positive().nullable(),
  total: z.number().int().nonnegative().max(CONVERSATION_LIMIT), sha256: z.string().regex(/^[0-9a-f]{64}$/) });

/**
 * The receiving side: every page of the source's conversation through `page(offset)`, checked against its length
 * and hash and redacted again here, or undefined when the source has none (an older Hook, a move that never
 * built one) or it does not arrive whole. Never fails the launch: the brief's excerpt stands on its own.
 */
export async function fetchContinuationConversation(page: (offset: number) => Promise<Json>, redact: (text: string) => string): Promise<string | undefined> {
  const parts: string[] = [];
  let offset = 0, total: number | undefined, hash: string | undefined;
  for (let pages = 0; pages < 64; pages++) {
    let answer: Json;
    try { answer = await page(offset); } catch { return undefined; }
    const parsed = pageSchema.safeParse(answer.conversation);
    if (!parsed.success || parsed.data.offset !== offset) return undefined;
    if ((total ??= parsed.data.total) !== parsed.data.total || (hash ??= parsed.data.sha256) !== parsed.data.sha256) return undefined;
    parts.push(parsed.data.text);
    offset += parsed.data.text.length;
    if (parsed.data.next === null) {
      const text = parts.join("");
      if (text.length !== total || createHash("sha256").update(text).digest("hex") !== hash) return undefined;
      return redact(text);
    }
    if (parsed.data.next !== offset || offset > total) return undefined;
  }
  return undefined;
}

/** Where the copied conversation is, to tell the new agent; appended only when the brief has room for it. */
export function withConversationPointer(text: string, file: string, limit = 32768): string {
  const pointer = `\n\nThe previous agent's conversation, more of it than the excerpt above, is in ${file}. Read what you need of it, from the end back, before you write your hand-off.`;
  return text.length + pointer.length <= limit ? `${text}${pointer}` : text;
}

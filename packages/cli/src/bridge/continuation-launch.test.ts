import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { continuationConversationPage, continuationIntent, fetchContinuationConversation, ORPHAN_GRACE_MS, pruneContinuationFiles, saveContinuationConversation, saveContinuationIntent, withConversationPointer } from "./continuation-launch.js";
import { redactPeerHandoff } from "./peer-handoff.js";
import type { Json } from "./protocol.js";

const ID = "a0000000-0000-4000-8000-0000000000c1";
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-continuation-")); vi.stubEnv("PHREN_BRIDGE_HOME", root); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it("serves a saved conversation in pages that each fit one peer answer, and reassembles it whole", async () => {
  // A control character is six bytes escaped as JSON: a plain-size page of them would be 1.5 MB, so it is halved.
  const text = `start ${"\u0001".repeat(600_000)} middle ${"x".repeat(400_000)} end`;
  await saveContinuationConversation(ID, text);
  const pages: Array<{ offset: number; chars: number; bytes: number }> = [];
  const copied = await fetchContinuationConversation(async offset => {
    const page = await continuationConversationPage(ID, offset) as { conversation: { text: string } };
    pages.push({ offset, chars: page.conversation.text.length, bytes: Buffer.byteLength(JSON.stringify(page)) });
    return page;
  }, value => value);
  expect(copied).toBe(text);
  expect(Math.max(...pages.map(page => page.bytes))).toBeLessThan(900_000 + 1_000);
  expect(pages[0].chars).toBeLessThan(262_144);
  expect(pages.length).toBeGreaterThan(Math.ceil(text.length / 262_144));
});

it("prunes a copy and an intent its move is done with, and any older than seven days, and leaves a crash's half-written file an hour", async () => {
  const running = "a0000000-0000-4000-8000-0000000000d1", done = "a0000000-0000-4000-8000-0000000000d2", old = "a0000000-0000-4000-8000-0000000000d3";
  const orphan = "a0000000-0000-4000-8000-0000000000d4", orphanOld = "a0000000-0000-4000-8000-0000000000d5";
  for (const id of [running, done, old]) await saveContinuationConversation(id, `conversation of ${id}`);
  for (const id of [running, done, old, orphan, orphanOld]) await saveContinuationIntent({ brief: { id } });
  const intents = path.join(root, "move-intents");
  const week = 7 * 24 * 60 * 60 * 1000, now = Date.now();
  const aged = new Date(now - week - 60_000), twoHours = new Date(now - 2 * 60 * 60 * 1000);
  // `old` is still running but past the backstop, whatever its record says.
  for (const name of [`${old}.conversation.md`, `${old}.json`]) await utimes(path.join(intents, name), aged, aged);
  // A move in another process records itself first: neither orphan has a record at all.
  await utimes(path.join(intents, `${orphanOld}.json`), twoHours, twoHours);
  // Writes a crash left: one fresh, one two hours old, for a copy and for an intent.
  const fresh = `${running}.conversation.md.b0000000-0000-4000-8000-000000000001.tmp`;
  const stale = `${running}.json.b0000000-0000-4000-8000-000000000002.tmp`;
  await writeFile(path.join(intents, fresh), "partial"); await writeFile(path.join(intents, stale), "partial");
  await utimes(path.join(intents, stale), twoHours, twoHours);
  // Other files in the folder are not continuation files and are never touched.
  const unrelated = ["notes.txt", "extra.json", `${running}.json.bak`];
  for (const name of unrelated) await writeFile(path.join(intents, name), "keep");
  // A 36-character name that is not a UUID sits before a removable file and must not stop the sweep.
  const stray = `${"0".repeat(36)}.json`;
  await writeFile(path.join(intents, stray), "keep");
  // The rule listMoves applies: a finished move is done with its files, one with no record file gets an hour,
  // and nothing outlives seven days.
  const written = new Set([running, done, old]), finished = new Set([done]);
  const removed = await pruneContinuationFiles((id, age) => {
    // `done` is handed a move id, which recordFile parses as a UUID.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error(`not a move id: ${id}`);
    return finished.has(id) || (age > ORPHAN_GRACE_MS && !written.has(id));
  }, now);
  // `done` lost its copy and its intent and is still named once.
  expect(removed.sort()).toEqual([done, old, orphanOld].sort());
  expect((await readdir(intents)).sort()).toEqual([`${running}.conversation.md`, `${running}.json`, `${orphan}.json`, fresh, stray, ...unrelated].sort());
  expect(await fetchContinuationConversation(offset => continuationConversationPage(running, offset), value => value)).toBe(`conversation of ${running}`);
  expect(await continuationIntent(running)).toMatchObject({ brief: { id: running } });
  expect(await continuationIntent(orphan)).toMatchObject({ brief: { id: orphan } });
  await expect(continuationConversationPage(done, 0)).rejects.toMatchObject({ status: 404 });
  await expect(continuationIntent(done)).rejects.toMatchObject({ status: 404 });
  // Nothing to prune, or no folder at all: no error.
  expect(await pruneContinuationFiles(() => false, now)).toEqual([]);
  await rm(intents, { recursive: true });
  expect(await pruneContinuationFiles(() => true, now)).toEqual([]);
});

it("keeps the first copy of a move when its run starts again, so a reader part way through is not cut off", async () => {
  await saveContinuationConversation(ID, "first copy");
  await saveContinuationConversation(ID, "second copy, with a new turn");
  expect(await fetchContinuationConversation(offset => continuationConversationPage(ID, offset), value => value)).toBe("first copy");
});

it("takes nothing from an older Hook, a missing copy, or pages that do not add up", async () => {
  const text = "Prompt: finish the parser.\n".repeat(20_000);
  await saveContinuationConversation(ID, text);
  // An older source answers the page request with the intent itself.
  expect(await fetchContinuationConversation(async () => ({ computerId: ID, brief: { id: ID, text: "excerpt" } }), value => value)).toBeUndefined();
  await expect(continuationConversationPage("a0000000-0000-4000-8000-0000000000c2", 0)).rejects.toMatchObject({ status: 404 });
  expect(await fetchContinuationConversation(async () => { throw new Error("offline"); }, value => value)).toBeUndefined();
  // A page whose text was changed in transit fails the hash.
  const tampered = async (offset: number) => {
    const page = await continuationConversationPage(ID, offset) as { conversation: Json };
    return offset === 0 ? { conversation: { ...page.conversation, text: `X${String(page.conversation.text).slice(1)}` } } : page;
  };
  expect(await fetchContinuationConversation(tampered, value => value)).toBeUndefined();
  await expect(saveContinuationConversation(ID, "x".repeat(2_000_001))).rejects.toMatchObject({ status: 413 });
});

it("redacts the copy again on arrival and points the brief at it only when the line fits", async () => {
  await saveContinuationConversation(ID, "It ran deploy --token sk-live-1234567890abcdef");
  const copied = await fetchContinuationConversation(offset => continuationConversationPage(ID, offset), redactPeerHandoff);
  expect(copied).not.toContain("sk-live");
  expect(copied).toContain("[redacted]");
  expect(withConversationPointer("Brief.", "/b/conversation.md")).toContain("is in /b/conversation.md");
  const full = "x".repeat(32_700);
  expect(withConversationPointer(full, "/b/conversation.md")).toBe(full);
});

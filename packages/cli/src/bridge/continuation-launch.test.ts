import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { continuationConversationPage, fetchContinuationConversation, saveContinuationConversation, withConversationPointer } from "./continuation-launch.js";
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

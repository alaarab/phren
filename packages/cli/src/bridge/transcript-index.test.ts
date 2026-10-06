import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TranscriptReader } from "./transcripts.js";

const row = (text: string) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: text } });

describe("indexed transcript pages", () => {
  let root: string, file: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-index-")); file = path.join(root, "transcript.jsonl"); });
  afterEach(async () => { await rm(root, { recursive: true }); });

  it("walks all pages across byte checkpoints without missing or duplicating lines", async () => {
    const text = "Unicode 👩🏽‍💻 世界 " + "x".repeat(1400);
    await writeFile(file, Array.from({ length: 1201 }, (_, i) => i % 7 === 0 ? '{"type":"session_meta"}' : row(`${i} ${text}`)).join("\n") + "\n");
    let page = await new TranscriptReader(file, "codex").read();
    const lines = page.entries.map(e => e.line);
    while (page.hasMore) {
      const before = page.startLine;
      page = await new TranscriptReader(file, "codex").read(before);
      expect(page.startLine).toBeLessThan(before);
      expect(page.entries.every(e => e.line < before)).toBe(true);
      lines.unshift(...page.entries.map(e => e.line));
    }
    expect(lines).toEqual(Array.from({ length: 1201 }, (_, i) => i).filter(i => i % 7 !== 0));
    expect(page.totalLines).toBe(1201);
    expect(page.startLine).toBe(0);
  });

  it("returns a terminal empty page when only hidden rows precede the cursor", async () => {
    await writeFile(file, '{"type":"session_meta"}\n{"type":"response_item","payload":{"type":"reasoning"}}\n' + row("Visible") + "\n");
    const page = await new TranscriptReader(file, "codex").read(2);
    expect(page).toMatchObject({ entries: [], startLine: 0, hasMore: false, totalLines: 3 });
  });

  it("shares incremental indexing without replaying partial rows or resetting a live reader after paging", async () => {
    await writeFile(file, row("First") + "\n");
    const live = new TranscriptReader(file, "codex");
    await live.read();
    const next = row("Arrives in pieces " + "a".repeat(70_000));
    await appendFile(file, next.slice(0, 66_000));
    expect((await live.read()).entries).toEqual([]);
    await appendFile(file, next.slice(66_000) + "\n");
    expect((await new TranscriptReader(file, "codex").read(1)).entries.map(e => e.line)).toEqual([0]);
    expect((await live.read()).entries.map(e => e.line)).toEqual([1]);
    expect((await live.read()).entries).toEqual([]);
  });

  it("replaces a long resume window so history can recover every skipped line", async () => {
    await writeFile(file, Array.from({ length: 2709 }, (_, i) => row(`Turn ${i}`)).join("\n") + "\n");
    // The phone last read the turn at line 1020 before the Hook restarted.
    // A new reader can return only its bounded newest page in one frame.
    const resumed = await new TranscriptReader(file, "codex").readAfter(1020);
    expect(resumed.reset).toBe(true);
    expect(resumed.startLine).toBeGreaterThan(1021);
    expect(resumed.entries.at(-1)?.line).toBe(2708);

    const lines = resumed.entries.map(entry => entry.line);
    let before = resumed.startLine;
    while (before > 0) {
      const page = await new TranscriptReader(file, "codex").read(before);
      expect(page.startLine).toBeLessThan(before);
      lines.unshift(...page.entries.map(entry => entry.line));
      before = page.startLine;
    }
    expect(lines).toEqual(Array.from({ length: 2709 }, (_, i) => i));

    // A short reconnect still merges with the phone's existing window.
    const short = await new TranscriptReader(file, "codex").readAfter(2700);
    expect(short.reset).toBe(false);
    expect(short.entries.map(entry => entry.line)).toEqual([2701, 2702, 2703, 2704, 2705, 2706, 2707, 2708]);

    // The same bound can be hit by a running reader during a busy poll.
    const live = new TranscriptReader(file, "codex");
    await live.read();
    await appendFile(file, Array.from({ length: 300 }, (_, i) => row(`Later ${i}`)).join("\n") + "\n");
    const burst = await live.read();
    expect(burst.reset).toBe(true);
    expect(burst.startLine).toBeGreaterThan(2709);
  });

  it("invalidates cached indexes on replacement, truncation, and same-size rewrite", async () => {
    await writeFile(file, row("Before") + "\n");
    const reader = new TranscriptReader(file, "codex");
    await reader.read();
    await new Promise(resolve => setTimeout(resolve, 5));
    await writeFile(file, row("Edited") + "\n");
    expect(JSON.stringify((await reader.read()).entries)).toContain("Edited");
    await writeFile(file + ".new", row("New inode") + "\n");
    await rename(file + ".new", file);
    const replacement = await reader.read();
    expect(replacement.reset).toBe(true);
    expect(replacement.entries[0].line).toBe(0);
    await writeFile(file, "\n");
    expect(await reader.read()).toMatchObject({ entries: [], reset: true, totalLines: 1, hasMore: false });
  });

  it("does not lose the message that would exceed the page byte budget", async () => {
    await writeFile(file, Array.from({ length: 9 }, (_, i) => row(`${i} ` + "a".repeat(700_000))).join("\n") + "\n");
    const first = await new TranscriptReader(file, "codex").read();
    const entries = [...first.entries];
    let page = first;
    while (page.hasMore) {
      const before = page.startLine;
      page = await new TranscriptReader(file, "codex").read(before);
      expect(page.startLine).toBeLessThan(before);
      entries.unshift(...page.entries);
    }
    expect(entries.map(e => e.line)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("cancels an indexed read without poisoning later requests", async () => {
    await writeFile(file, row("Still usable") + "\n");
    const abort = new AbortController(); abort.abort();
    await expect(new TranscriptReader(file, "codex").read(undefined, abort.signal)).rejects.toThrow();
    expect((await new TranscriptReader(file, "codex").read()).entries).toHaveLength(1);
  });
});

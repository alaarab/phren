import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { completionEntry, TranscriptReader } from "./transcripts.js";

const prompt = "2026-10-31T10:00:00.000Z", stop = "2026-10-31T10:00:02.000Z";
let root: string, file: string;
beforeEach(async () => {
  const scratch = path.join(process.cwd(), ".scratch");
  await mkdir(scratch, { recursive: true });
  root = await mkdtemp(path.join(scratch, "completion-entry-"));
  file = path.join(root, "transcript.jsonl");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("completion transcript entry keys", () => {
  it.each(["codex", "opencode"] as const)("uses %s's last public row before Stop, including line zero", async source => {
    const row = (at: string, text: string) => source === "codex"
      ? { timestamp: at, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } }
      : { time: at, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text }] } } };
    await writeFile(file, JSON.stringify(row("2026-10-31T10:00:01.000Z", "Finished")) + "\n");
    expect(await completionEntry(file, source, prompt, stop)).toBe("0");
    await appendFile(file, JSON.stringify(row("2026-10-31T10:00:03.000Z", "Next turn")) + "\n");
    expect(await completionEntry(file, source, prompt, stop)).toBe("0");
    const page = await new TranscriptReader(file, source).read();
    expect(page.entries.map(entry => entry.line)).toEqual([0, 1]);
  });

  it.each([
    { type: "tool_use", id: "call-1", name: "Read", input: { file_path: "file.ts" } },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
  ])("resolves a terminal Claude assistant row containing only $type after commentary", async block => {
    const rows = [
      { type: "assistant", timestamp: "2026-10-31T10:00:00.500Z", message: { role: "assistant", content: "Commentary" } },
      { type: "assistant", timestamp: "2026-10-31T10:00:01.000Z", message: { role: "assistant", content: [block], stop_reason: "end_turn" } },
    ];
    await writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    expect(await completionEntry(file, "claude", prompt, stop, { reply: "Commentary" })).toBe("1");
    const page = await new TranscriptReader(file, "claude").read();
    expect(page.entries.map(entry => entry.line)).toEqual([0, 1]);
  });

  it("invalidates a resolved entry on transcript rewrite and resolves a delayed final row", async () => {
    const answer = JSON.stringify({ type: "assistant", timestamp: "2026-10-31T10:00:01.000Z",
      message: { role: "assistant", content: "Finished", stop_reason: "end_turn" } }) + "\n";
    await writeFile(file, answer);
    expect(await completionEntry(file, "claude", prompt, stop)).toBe("0");
    await writeFile(file, JSON.stringify({ type: "progress" }) + "\n");
    const later = new Date(Date.now() + 5_000);
    await utimes(file, later, later);
    expect(await completionEntry(file, "claude", prompt, stop)).toBeUndefined();
    await appendFile(file, answer);
    expect(await completionEntry(file, "claude", prompt, stop)).toBe("1");
  });
});

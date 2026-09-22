import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { claudePanePreview, CodexRolloutPreview, TranscriptPreviewStream } from "./transcript-preview.js";
import { TranscriptReader } from "./transcripts.js";
import type { Target } from "./protocol.js";

const target: Target = { source: "claude", session: "preview-session", server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1" };
const start = "2026-09-22T10:00:00.000Z";
const user = { line: 0, raw: { type: "user", timestamp: start, message: { content: "Explain this" } } };
const roots: string[] = [];
async function scratch() {
  const base = path.resolve(".scratch"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "preview-")); roots.push(root); return root;
}
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("live reply previews", () => {
  it("streams growing Claude pane text at most twice a second, and stops at the real entry", async () => {
    let words = "The first";
    const pane = vi.fn(async () => `╭────╮\n❯ Explain this\n⏺ ${words}\n✻ Working… (esc to interrupt)\n❯ composer\n╰────╯`);
    const stream = new TranscriptPreviewStream(target, pane);
    stream.observe([user]);
    expect(await stream.update("working", undefined, 0)).toEqual({ preview: { turnStartedAt: start, text: "The first" } });
    expect(stream.verb).toBe("Working");
    words = "The first words grow";
    expect(await stream.update("working", undefined, 100)).toBeUndefined();
    expect(pane).toHaveBeenCalledTimes(1);
    expect(await stream.update("working", undefined, 500)).toEqual({ preview: { turnStartedAt: start, text: words } });
    expect(await stream.update("working", undefined, 1000)).toBeUndefined();
    stream.observe([{ line: 1, raw: { type: "assistant", timestamp: "2026-09-22T10:00:01Z", message: { content: words, stop_reason: "end_turn" } } }]);
    // The text stops at the real entry; Claude's spinner verb carries on.
    expect(await stream.update("working", undefined, 1600)).toEqual({ preview: null });
    expect(stream.verb).toBe("Working");
    await stream.update("idle", undefined, 2600);
    expect(stream.verb).toBeUndefined();
  });

  it("clears at stop and does not resurrect a preview from unchanged terminal content", async () => {
    const pane = vi.fn(async () => "❯ Explain this\n⏺ Partial reply\n❯");
    const stream = new TranscriptPreviewStream(target, pane); stream.observe([user]);
    await stream.update("working", undefined, 0);
    expect(await stream.update("idle", undefined, 10)).toEqual({ preview: null });
    expect(await stream.update("working", undefined, 1000)).toBeUndefined();
    expect(pane).toHaveBeenCalledTimes(1);
    stream.observe([{ ...user, line: 2, raw: { ...user.raw, timestamp: "2026-09-22T10:01:00Z" } }]);
    expect((await stream.update("working", undefined, 1500))?.preview?.turnStartedAt).toBe("2026-09-22T10:01:00Z");
  });

  it("reads Claude's own spinner verb and never previews a tool call line", async () => {
    const { claudeSpinnerVerb } = await import("./transcript-preview.js");
    expect(claudeSpinnerVerb("⏺ Reply\n✢ Pondering… (12s · ↑ 1.2k tokens · esc to interrupt)\n❯")).toBe("Pondering");
    expect(claudeSpinnerVerb("⏺ Reply\n❯")).toBeUndefined();
    expect(claudePanePreview("❯ Explain this\n⏺ Let me look.\n⏺ Bash(ls -la)\n  ⎿ file\n⏺ phren - search_knowledge (MCP)(query: \"x\")\n✻ Pondering… (3s)\n❯", "Explain this"))
      .toBe("Let me look.");
    // Collapsed tool groups and the titled rule above the input box are chrome.
    expect(claudePanePreview("❯ Explain this\n⏺ Reading now.\n⏺ Calling phren, running 1 shell command…\n  ⎿  $ ls\n✽ Precipitating… (49s)\n───── Claude sesh in herdr ─\n❯\n─────", "Explain this"))
      .toBe("Reading now.");
  });

  it("strips chrome, prompts and spinners without showing old replies or tool output", () => {
    expect(claudePanePreview("❯ Previous\n⏺ Old reply\n❯ Explain this\n✻ Thinking…\n❯", "Explain this")).toBe("");
    expect(claudePanePreview("⏺ Old reply\n❯", "Explain this")).toBe("");
    expect(claudePanePreview("❯ Explain this\n│⏺ New reply⠋│\n│  with another line│\n⎿ Tool result\n✻ Thinking…\n❯ typed draft\nfooter", "Explain this"))
      .toBe("New reply\nwith another line");
  });

  it("prefers Codex deltas and never reads the pane, including an empty delta stream", async () => {
    const pane = vi.fn(async () => "terminal text");
    const delta = vi.fn().mockResolvedValueOnce({ turnStartedAt: start, text: "Delta one" })
      .mockResolvedValueOnce({ turnStartedAt: start, text: "Delta one two" }).mockResolvedValue(null);
    const stream = new TranscriptPreviewStream({ ...target, source: "codex" }, pane, delta);
    expect((await stream.update("working", undefined, 0))?.preview?.text).toBe("Delta one");
    expect((await stream.update("working", undefined, 500))?.preview?.text).toBe("Delta one two");
    expect(await stream.update("working", undefined, 1000)).toEqual({ preview: null });
    expect(pane).not.toHaveBeenCalled();
  });

  it("keeps an anchored reply growing after wrapping and scrolling", () => {
    expect(claudePanePreview("❯ Explain this long\n  prompt that wraps\n⏺ First line\n  Second line\n❯", "Explain this long prompt that wraps"))
      .toBe("First line\nSecond line");
    expect(claudePanePreview("  Second line\n  Third line\n✻ Working (esc to interrupt)", "Explain this", "First line\nSecond line"))
      .toBe("First line\nSecond line\nThird line");
    expect(claudePanePreview("unrelated pane chrome\n❯", "Explain this", "First line\nSecond line"))
      .toBe("First line\nSecond line");
  });

  it("reads public Codex rollout deltas without putting them in history", async () => {
    const file = path.join(await scratch(), "rollout.jsonl");
    const rows = [
      { type: "event_msg", timestamp: start, payload: { type: "task_started" } },
      { type: "event_msg", payload: { type: "agent_message_delta", delta: "Hello" } },
      { type: "event_msg", payload: { type: "agent_reasoning_delta", delta: "Private" } },
    ];
    await writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const delta = new CodexRolloutPreview();
    expect(await delta.read(file)).toEqual({ turnStartedAt: start, text: "Hello" });
    await appendFile(file, JSON.stringify({ type: "event_msg", payload: { type: "agent_message_delta", delta: " world" } }) + "\n");
    expect((await delta.read(file))?.text).toBe("Hello world");
    const history = new TranscriptReader(file, "codex");
    expect(JSON.stringify(await history.read())).not.toContain("Hello");
    await appendFile(file, JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: "Hello world" } }) + "\n");
    expect(await delta.read(file)).toBeNull();
    expect((await history.read()).entries).toHaveLength(1);
  });

  it("OpenCode text deltas stay ephemeral until the message completes", async () => {
    const root = await scratch(); vi.stubEnv("PHREN_PATH", root); vi.useFakeTimers();
    const pluginPath = new URL("../../plugins/opencode/phren-transcript.js", import.meta.url).href;
    const { PhrenTranscriptPlugin } = await import(/* @vite-ignore */ pluginPath);
    const plugin = await PhrenTranscriptPlugin();
    const sessionID = "ses_preview";
    const event = (type: string, properties: Record<string, unknown>) => plugin.event({ event: { type, properties: { sessionID, ...properties } } });
    await event("message.updated", { info: { id: "u1", role: "user", time: { created: Date.parse(start) } } });
    await event("message.part.updated", { part: { id: "up", messageID: "u1", type: "text", text: "Explain this" } });
    await event("message.updated", { info: { id: "a1", role: "assistant", time: { created: Date.parse(start) + 1 } } });
    await event("message.part.updated", { part: { id: "ap", messageID: "a1", type: "text", text: "Hello" } });
    await vi.advanceTimersByTimeAsync(250);
    const file = path.join(root, ".runtime", "sessions", `${"opencode-" + sessionID}.events.jsonl`);
    expect(JSON.parse(await readFile(file + ".preview.json", "utf8"))).toEqual({ turnStartedAt: start, text: "Hello" });
    expect(await readFile(file, "utf8")).not.toContain("Hello");
    await event("message.part.delta", { messageID: "a1", partID: "ap", field: "text", delta: " world" });
    await vi.advanceTimersByTimeAsync(250);
    expect(JSON.parse(await readFile(file + ".preview.json", "utf8")).text).toBe("Hello world");
    await event("message.updated", { info: { id: "a1", role: "assistant", finish: "stop", time: { created: Date.parse(start) + 1, completed: Date.parse(start) + 2000 } } });
    await vi.advanceTimersByTimeAsync(250);
    await expect(readFile(file + ".preview.json")).rejects.toThrow();
    expect((await new TranscriptReader(file, "opencode").read()).entries).toHaveLength(2);
    expect(await readFile(file, "utf8")).toContain("Hello world");
  });
});

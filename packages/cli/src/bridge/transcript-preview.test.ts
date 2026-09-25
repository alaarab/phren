import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "../logger.js";
import { claudeBoldMarkdown, claudeChrome, claudePanePreview, CodexRolloutPreview, readDeltaPreview, readPreviewPane, TranscriptPreviewStream, unwrapTerminalLines } from "./transcript-preview.js";
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
  it("returns no pane text when Herdr fails, logging the reason once per pane", async () => {
    vi.stubEnv("PHREN_HERDR_HOME", await scratch());
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const failing = { ...target, pane: "w1:p-missing" };
      expect(await readPreviewPane(failing)).toBe("");
      expect(await readPreviewPane(failing)).toBe("");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][1]).toBe("Preview pane read for default/w1:p-missing failed: Herdr is not reachable on this computer (ENOENT: Herdr is not running).");
    } finally { warn.mockRestore(); }
  });

  it("bounds OpenCode sidecar bytes while accepting the full escaped text limit", async () => {
    const file = path.join(await scratch(), "opencode.events.jsonl");
    const source = { ...target, source: "opencode" as const };
    const preview = { turnStartedAt: start, text: "\u0000".repeat(32_768) };
    await writeFile(file + ".preview.json", JSON.stringify(preview));
    expect(await readDeltaPreview(source, file)).toEqual(preview);
    await writeFile(file + ".preview.json", JSON.stringify({ turnStartedAt: start, text: "Small text" }) + " ".repeat(1_000_000));
    expect(await readDeltaPreview(source, file)).toBeNull();
  });

  // O_NOFOLLOW does not exist on Windows, and the Hook supports macOS and Linux only.
  it.skipIf(process.platform === "win32")("does not follow an OpenCode preview sidecar symlink", async () => {
    const root = await scratch(), file = path.join(root, "opencode.events.jsonl");
    const other = path.join(root, "other.json");
    await writeFile(other, JSON.stringify({ turnStartedAt: start, text: "Other file" }));
    await symlink(other, file + ".preview.json");
    expect(await readDeltaPreview({ ...target, source: "opencode" }, file)).toBeNull();
  });

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
    stream.observe([{ line: 1, raw: { type: "assistant", timestamp: "2026-09-22T10:00:01Z", message: { content: words, stop_reason: "tool_use" } } }]);
    // The text stops at the real entry; Claude's spinner verb carries on.
    expect(await stream.update("working", undefined, 1600)).toEqual({ preview: null });
    expect(stream.verb).toBe("Working");
    await stream.update("idle", undefined, 2600);
    expect(stream.verb).toBeUndefined();
  });

  it("stops reading the pane when the transcript ends the turn, though the snapshot still says working", async () => {
    const pane = vi.fn(async () => "❯ Explain this\n⏺ Partial reply\n✻ Working… (esc to interrupt)\n❯");
    for (const end of [
      { type: "assistant", timestamp: "2026-09-22T10:00:02Z", message: { content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" } },
      { type: "system", subtype: "turn_duration", durationMs: 2000, timestamp: "2026-09-22T10:00:02Z" },
    ]) {
      pane.mockClear();
      const stream = new TranscriptPreviewStream(target, pane);
      stream.observe([user]);
      expect(await stream.update("working", undefined, 0)).toEqual({ preview: { turnStartedAt: start, text: "Partial reply" } });
      stream.observe([{ line: 1, raw: end }]);
      expect(stream.verb).toBeUndefined();
      // A stale shared snapshot keeps reporting "working" for up to 2.5 s.
      expect(await stream.update("working", undefined, 600)).toEqual({ preview: null });
      for (const at of [1200, 1800, 2400]) expect(await stream.update("working", undefined, at)).toBeUndefined();
      expect(pane).toHaveBeenCalledTimes(1);
      // The next prompt resumes reads.
      stream.observe([{ line: 2, raw: { ...user.raw, timestamp: "2026-09-22T10:01:00Z" } }]);
      expect((await stream.update("working", undefined, 3000))?.preview?.turnStartedAt).toBe("2026-09-22T10:01:00Z");
      expect(pane).toHaveBeenCalledTimes(2);
    }
  });

  it("stops reading a Codex delta source after task_complete until the next turn starts", async () => {
    const codex: Target = { ...target, source: "codex" };
    const delta = vi.fn(async () => ({ turnStartedAt: start, text: "Streaming" }));
    const stream = new TranscriptPreviewStream(codex, async () => "", delta);
    stream.observe([{ line: 0, raw: { type: "event_msg", timestamp: start, payload: { type: "task_started" } } }]);
    expect(await stream.update("working", undefined, 0)).toEqual({ preview: { turnStartedAt: start, text: "Streaming" } });
    stream.observe([{ line: 1, raw: { type: "event_msg", timestamp: start, payload: { type: "task_complete" } } }]);
    expect(await stream.update("working", undefined, 600)).toEqual({ preview: null });
    expect(delta).toHaveBeenCalledTimes(1);
    stream.observe([{ line: 2, raw: { type: "event_msg", timestamp: start, payload: { type: "task_started" } } }]);
    await stream.update("working", undefined, 1200);
    expect(delta).toHaveBeenCalledTimes(2);
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

  it("keeps Claude's unbulleted tool summaries out of the reply (Claude Code 2.1.x)", () => {
    // Recorded shape, 2026-09-24: the group summary sits indented under the
    // reply's own block, with no ⏺, and a running one carries its command.
    const running = "❯ Is it compatible\n⏺ Checking the app's minimum Hook version against what npm has:\n\n"
      + "  Running 1 shell command… \"minimumHook|minHook|requiredHook\" apps/\n  ios/Phren apps/ios/PhrenLive/Sources…\n\n✻ Nesting… (12s · ↓ 640 tokens)\n❯";
    expect(claudePanePreview(running, "Is it compatible")).toBe("Checking the app's minimum Hook version against what npm has:");
    const finished = "❯ Is it compatible\n⏺ Looked it up.\n\n  Called phren, ran 1 shell command\n\n⏺ Yes, npm has it.\n❯";
    expect(claudePanePreview(finished, "Is it compatible")).toBe("Yes, npm has it.");
    // Prose that merely starts with such a verb stays reply text.
    const prose = "❯ Is it compatible\n⏺ I checked:\n\n  Ran 3 tests and all passed on the Mini.\n❯";
    expect(claudePanePreview(prose, "Is it compatible")).toContain("Ran 3 tests and all passed");
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
    // Claude's sub-agent group: a running line and its tree never reach the preview.
    expect(claudePanePreview("❯ Explain this\n⏺ Starting the first wave.\n⏺ Running 2 agents…\n   ├─ Plan 1.4: failures · 0 tool uses\n   └─ Plan 1.5: tests · 0 tool uses\n✻ Spinning… (54s)\n❯", "Explain this"))
      .toBe("Starting the first wave.");
    // A narrow pane: the titled rule keeps one dash, and a running call carries a suffix.
    expect(claudePanePreview("❯ Explain this\n⏺ Filing it:\n⏺ Calling phren… (ctrl+o to expand)\n✢ Crunching… (26s)\n Claude sesh in herdr on pjren js not in co… ─\n❯\n─────", "Explain this"))
      .toBe("Filing it:");
    // A narrow pane wraps the next call's description; its command under
    // "⎿" wraps too. Neither is reply text (seen on the phone, 2026-09-24).
    const pane = [
      "❯ And I didn't use the words retire",
      "⏺ Agreed. \"Retirement\" claims Power Portal is going away, which",
      "  hasn't been decided. First, checking where the word shows up:",
      "",
      "⏺ Finding retire wording around Power",
      "  Portal reports",
      "  ⎿  $ grep -rn -i \"retire\" src docs --include=*.ts",
      "     --include=*.tsx --include=*.md | command",
      "     grep -v -i \"retired_\\|RETIRED_DELTEK\"",
      "✶ Fiddle-faddling… (14s · ↓ 663 tokens)",
      "❯",
    ].join("\n");
    expect(claudePanePreview(pane, "And I didn't use the words retire"))
      .toBe("Agreed. \"Retirement\" claims Power Portal is going away, which hasn't been decided. First, checking where the word shows up:");
  });

  it("parses Claude's whole spinner line into its verb, time, tokens and thinking state", async () => {
    const { parseClaudeSpinnerLine, claudeSpinner } = await import("./transcript-preview.js");
    expect(parseClaudeSpinnerLine("✢ Pondering… (12s · ↑ 1.2k tokens · esc to interrupt)"))
      .toEqual({ verb: "Pondering", elapsed: 12, tokens: { count: 1200, direction: "up" }, thinking: false });
    expect(parseClaudeSpinnerLine("✽ Precipitating… (49s · thought for 4s)"))
      .toEqual({ verb: "Precipitating", elapsed: 49, thinking: false, thoughtFor: 4 });
    expect(parseClaudeSpinnerLine("✢ Crunching… (26s · ↓ 864 tokens)"))
      .toEqual({ verb: "Crunching", elapsed: 26, tokens: { count: 864, direction: "down" }, thinking: false });
    expect(parseClaudeSpinnerLine("* Whirlpooling… (27s · ↓ 2.3k tokens · thinking)"))
      .toEqual({ verb: "Whirlpooling", elapsed: 27, tokens: { count: 2300, direction: "down" }, thinking: true });
    expect(parseClaudeSpinnerLine("✻ Brewing… (1h 2m 3s · ↓ 12.4k tokens)")?.elapsed).toBe(3723);
    expect(parseClaudeSpinnerLine("✻ Working… (esc to interrupt)")).toEqual({ verb: "Working", thinking: false });
    // Reply text that merely looks like a bullet is not a spinner.
    expect(parseClaudeSpinnerLine("* Update the docs (see below)")).toBeUndefined();
    expect(parseClaudeSpinnerLine("* Reading… (the file)")).toBeUndefined();
    expect(claudeSpinner("⏺ Reply\n✻ Old… (3s)\n* Whirlpooling… (34s · ↓ 3.1k tokens · thinking)\n❯")?.verb).toBe("Whirlpooling");
  });

  it("sends a frame when the spinner's tokens or thinking change, never for the clock alone", async () => {
    let spinner = "✢ Crunching… (26s · ↓ 864 tokens)";
    const pane = vi.fn(async () => `❯ Explain this\n⏺ Reading\n${spinner}\n❯`);
    const stream = new TranscriptPreviewStream(target, pane);
    stream.observe([user]);
    expect(await stream.update("working", undefined, 0)).toEqual({ preview: { turnStartedAt: start, text: "Reading" } });
    expect(stream.activity).toEqual({ verb: "Crunching", elapsed: 26, tokens: { count: 864, direction: "down" }, thinking: false });
    spinner = "✢ Crunching… (27s · ↓ 864 tokens)";
    expect(await stream.update("working", undefined, 600)).toBeUndefined();
    spinner = "✢ Crunching… (28s · ↓ 1.1k tokens · thinking)";
    expect(await stream.update("working", undefined, 1200)).toEqual({ preview: { turnStartedAt: start, text: "Reading" } });
    expect(stream.activity).toMatchObject({ tokens: { count: 1100 }, thinking: true });
    await stream.update("idle", undefined, 2000);
    expect(stream.activity).toBeUndefined();
  });

  it("never previews a spinner line whatever its glyph", () => {
    expect(claudePanePreview("❯ Explain this\n⏺ Checking.\n* Whirlpooling… (27s · ↓ 2.3k tokens · thinking)\n❯", "Explain this"))
      .toBe("Checking.");
    expect(claudePanePreview("❯ Explain this\n⏺ Checking.\n✦ Pondering… (12s · ↑ 1.2k tokens)\n❯", "Explain this"))
      .toBe("Checking.");
    // A reply's own bullet stays.
    expect(claudePanePreview("❯ Explain this\n⏺ Two things:\n  * first (a)\n  * second\n❯", "Explain this"))
      .toBe("Two things:\n* first (a)\n* second");
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

describe("unwrapTerminalLines", () => {
  it("joins a paragraph the terminal wrapped at the pane width", () => {
    const pane = [
      "You mean the project's Code section. Right now it",
      "lists indexed files and symbols, but you can't open",
      "a file and read it.",
      "",
      "Starting a worker on it:",
    ];
    expect(unwrapTerminalLines(pane)).toBe(
      "You mean the project's Code section. Right now it lists indexed files and symbols, but you can't open a file and read it.\n\nStarting a worker on it:");
  });

  it("keeps list items, their wrapped continuations, short lines and fenced code apart", () => {
    const pane = [
      "Three things changed in the chat screen today:",
      "- the header keeps the branch beside a very long",
      "  project name",
      "- taps land",
      "```",
      "const answer = computeTheAnswerForTheWholeScreen(42)",
      "return answer",
      "```",
      "Done.",
    ];
    expect(unwrapTerminalLines(pane).split("\n")).toEqual([
      "Three things changed in the chat screen today:",
      "- the header keeps the branch beside a very long project name",
      "- taps land",
      "```",
      "const answer = computeTheAnswerForTheWholeScreen(42)",
      "return answer",
      "```",
      "Done.",
    ]);
  });
});

describe("Claude's bold in the pane preview", () => {
  const E = "\x1b";
  it("turns SGR bold into Markdown with whitespace outside the markers", () => {
    expect(claudeBoldMarkdown(`  - ${E}[0m${E}[1mHere: ${E}[0madded to ${E}[0m${E}[38;2;177;185;249m~/.ssh${E}[0m\r`))
      .toBe("  - **Here:** added to ~/.ssh");
    // A color change inside a bold run keeps one run; 38;5;1 is a color, not bold.
    expect(claudeBoldMarkdown(`${E}[1mone ${E}[38;5;1mtwo${E}[0m ${E}[38;5;1mred${E}[0m`)).toBe("**one two** red");
    expect(claudeBoldMarkdown(`${E}[1m   ${E}[22mplain`)).toBe("   plain");
  });

  it("keeps a wrapped bold list item's Markdown and still drops tool lines", () => {
    const pane = [
      `❯ Solve all of those above`,
      `${E}[0m⏺ Understood. That means three more pieces:`,
      ``,
      `  1. ${E}[0m${E}[1mMake the missing numbers real${E}[0m instead of leaving them out: people new`,
      `  and left this week.`,
      `  2. ${E}[0m${E}[1mScreenshot the healthy, live and empty overview cards on the page by${E}[0m`,
      `  ${E}[0m${E}[1mloading${E}[0m realistic connected sample data, which stays here.`,
      `${E}[0m${E}[38;2;78;186;101m⏺ ${E}[0m${E}[1mAgent${E}[0m(Record the missing numbers)`,
      `  ⎿  Backgrounded agent`,
      `✻ Shimmying… (14s · ↓ 841 tokens)`,
      `❯`,
    ].join("\r\n");
    expect(claudePanePreview(pane, "Solve all of those above")).toBe([
      "Understood. That means three more pieces:",
      "",
      "1. **Make the missing numbers real** instead of leaving them out: people new and left this week.",
      "2. **Screenshot the healthy, live and empty overview cards on the page by** **loading** realistic connected sample data, which stays here.",
    ].join("\n"));
  });
});

describe("Claude Code screen text", () => {
  it("keeps the update notice out of a streaming reply", () => {
    const pane = [
      "❯ Why is it stuck",
      "⏺ That message did reach me. The phone is still showing its own copy because",
      "  it only clears that copy when the transcript has the same text, so the copy",
      "  never",
      "",
      "                                                    ✔ Update installed · Restart to update",
      "✻ Spelunking… (6s · thought for 2s)",
      "❯",
    ].join("\n");
    const text = claudePanePreview(pane, "Why is it stuck");
    expect(text).not.toMatch(/Update installed|Restart to update/);
    expect(text.endsWith("so the copy never")).toBe(true);
  });

  it("recognizes status, tip and hint lines but not reply text that mentions them", () => {
    for (const line of ["✔ Update installed · Restart to update", "✗ Auto-update failed", "Tip: Use /memory to edit", "⏵⏵ auto-accept edits on (shift+tab to cycle)", "※ Run /doctor for details"]) {
      expect(claudeChrome(line)).toBe(true);
    }
    for (const line of ["The update check passed.", "I will restart the server next.", "Tips are in the README."]) {
      expect(claudeChrome(line)).toBe(false);
    }
  });
});

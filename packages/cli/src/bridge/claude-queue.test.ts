import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claudeQueueAction, claudeQueued, type ClaudeQueueDeps } from "./claude-queue.js";

const recorded = (file: string) => readFileSync(new URL(`./fixtures/claude/2.1.284/${file}`, import.meta.url), "utf8");
const empty = recorded("working-tmux.ansi"), typing = recorded("owner-typing-tmux.ansi");
const row = (operation: string, content?: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "queue-operation", operation, timestamp: "t", ...(content === undefined ? {} : { content }), ...extra });

/** A Claude pane whose keys write the queue rows Claude Code 2.1.314 wrote:
 * send-now removes each queued message as absorbed, `up` pops each back. */
function pane(queued: string[], options: { held?: boolean; screens?: string[]; obeys?: boolean } = {}) {
  const sent: string[][] = [], rows = queued.map(text => row("enqueue", text)), screens = [...(options.screens ?? [empty])];
  const deps: ClaudeQueueDeps = {
    transcript: async () => rows.join("\n"),
    screen: async () => screens.length > 1 ? screens.shift()! : screens[0],
    held: () => options.held ?? false,
    sleep: async () => {},
    sendKeys: async keys => {
      sent.push(keys);
      if (options.obeys === false) return;
      if (keys.join() === "ctrl+x,ctrl+s") for (const text of queued) rows.push(row("remove", text, { reason: "absorbed_mid_turn" }));
      if (keys.join() === "up") for (const text of queued) rows.push(row("popAll", text));
    },
  };
  return { deps, sent };
}

describe("Claude's queued messages", () => {
  it("reads the queue from its rows, without the harness's own envelopes", () => {
    const rows = [row("enqueue", "first"), row("enqueue", "second"), row("enqueue", "third"), row("dequeue"),
      row("remove", "second", { reason: "absorbed_mid_turn" }), row("enqueue", "<task-notification>x</task-notification>"),
      row("enqueue", '<pasted_content id="1">\nfourth\n</pasted_content id="1">'), "not json"];
    expect(claudeQueued(rows.join("\n"))).toEqual(["third", "fourth"]);
    expect(claudeQueued([row("enqueue", "back"), row("popAll", "back")].join("\n"))).toEqual([]);
  });

  it("keeps identical occurrences separate and matches a wrapped enqueue to its plain removal", () => {
    const rows = [row("enqueue", "same"), row("enqueue", '<pasted_content id="1">\nsame\n</pasted_content id="1">'),
      row("remove", "same", { reason: "absorbed_mid_turn" })];
    // One removal takes one of two identical messages, not both.
    expect(claudeQueued(rows.join("\n"))).toEqual(["same"]);
    const popped = [row("enqueue", "a"), row("enqueue", "a"), row("popAll", "a")];
    expect(claudeQueued(popped.join("\n"))).toEqual(["a"]);
  });

  it("sends the queue to the running turn with Claude's send-now chord", async () => {
    const { deps, sent } = pane(["check the build", "then open the PR"]);
    await expect(claudeQueueAction("send-now", "working", deps)).resolves.toEqual({ ok: true, messages: ["check the build", "then open the PR"] });
    expect(sent).toEqual([["ctrl+x", "ctrl+s"]]);
  });

  it("withdraws the queue by pulling it into the input, then clearing it", async () => {
    const { deps, sent } = pane(["check the build"]);
    await expect(claudeQueueAction("withdraw", "working", deps)).resolves.toEqual({ ok: true, messages: ["check the build"] });
    expect(sent).toEqual([["up"], ["ctrl+l"]]);
  });

  it("presses nothing when nothing is queued: up would recall the last prompt", async () => {
    const { deps, sent } = pane([]);
    await expect(claudeQueueAction("withdraw", "working", deps)).rejects.toMatchObject({ status: 409, details: { code: "queue-empty" } });
    expect(sent).toEqual([]);
  });

  it("reports keys Claude did not act on", async () => {
    const sendNow = pane(["x"], { obeys: false });
    await expect(claudeQueueAction("send-now", "working", sendNow.deps)).rejects.toMatchObject({ details: { code: "queue-not-sent" } });
    // An `up` that recalled something else into the empty input is cleared again.
    const withdraw = pane(["x"], { obeys: false });
    await expect(claudeQueueAction("withdraw", "working", withdraw.deps)).rejects.toMatchObject({ details: { code: "queue-not-withdrawn" } });
    expect(withdraw.sent).toEqual([["up"], ["ctrl+l"]]);
    const uncleared = pane(["x"], { screens: [empty, typing] });
    await expect(claudeQueueAction("withdraw", "working", uncleared.deps)).rejects.toMatchObject({ details: { code: "queue-not-cleared" } });
  });

  it("presses nothing over the owner's draft, a held prompt or an idle agent", async () => {
    for (const [options, status, code] of [[{ screens: [typing] }, "working", "queue-input-busy"], [{ held: true }, "working", "queue-held"],
      [{}, "idle", "queue-idle"]] as const) {
      const { deps, sent } = pane(["x"], options);
      await expect(claudeQueueAction("send-now", status, deps)).rejects.toMatchObject({ status: 409, details: { code } });
      expect(sent).toEqual([]);
    }
  });
});

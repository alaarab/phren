import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claudeQueueAction, type ClaudeQueueDeps } from "./claude-queue.js";

const recorded = (file: string) => readFileSync(new URL(`./fixtures/claude/2.1.284/${file}`, import.meta.url), "utf8");
const empty = recorded("working-tmux.ansi"), typing = recorded("owner-typing-tmux.ansi");

function pane(screens: string[], held = false) {
  const sent: string[][] = [];
  const deps: ClaudeQueueDeps = {
    screen: async () => screens.length > 1 ? screens.shift()! : screens[0],
    sendKeys: async keys => { sent.push(keys); },
    held: () => held,
    sleep: async () => {},
  };
  return { deps, sent };
}

describe("Claude's queued messages", () => {
  it("sends the queue to the running turn with Claude's send-now chord", async () => {
    const { deps, sent } = pane([empty]);
    await expect(claudeQueueAction("send-now", "working", deps)).resolves.toEqual({ ok: true });
    expect(sent).toEqual([["ctrl+x", "ctrl+s"]]);
  });

  it("withdraws the queue by pulling it into the input and clearing it", async () => {
    const { deps, sent } = pane([empty]);
    await expect(claudeQueueAction("withdraw", "working", deps)).resolves.toEqual({ ok: true });
    expect(sent).toEqual([["up"], ["ctrl+l"]]);
  });

  it("reports a withdrawal whose text stayed in the input", async () => {
    const { deps } = pane([empty, typing]);
    await expect(claudeQueueAction("withdraw", "working", deps)).rejects.toMatchObject({ status: 409, details: { code: "queue-not-cleared" } });
  });

  it("presses nothing over the owner's draft, a held prompt or an idle agent", async () => {
    for (const [screen, held, status, code] of [[typing, false, "working", "queue-input-busy"], [empty, true, "working", "queue-held"],
      [empty, false, "idle", "queue-idle"]] as const) {
      const { deps, sent } = pane([screen], held);
      await expect(claudeQueueAction("send-now", status, deps)).rejects.toMatchObject({ status: 409, details: { code } });
      expect(sent).toEqual([]);
    }
  });
});

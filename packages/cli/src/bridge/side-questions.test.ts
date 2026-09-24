import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rpc, validateTarget } from "./herdr.js";
import { MODEL_BUSY, refuseWorkingSlash } from "./model-switch.js";
import type { Target } from "./protocol.js";
import { answerText, panelAsks, scrolledLines, SideQuestions, sidePanel, sideQuestionText } from "./side-questions.js";

vi.mock("./herdr.js", async original => ({ ...await original<typeof import("./herdr.js")>(), rpc: vi.fn(), validateTarget: vi.fn() }));

// Claude Code 2.1.280's /btw panel as recorded in a 46-column Herdr pane.
const recorded = (file: string) => readFileSync(new URL(`./fixtures/claude/2.1.280/${file}`, import.meta.url), "utf8");
const answering = recorded("btw-panel-answering.txt");
const settled = recorded("btw-panel.txt");
const scrolled = recorded("btw-panel-scrolled.txt");
const QUESTION = "in ten short numbered points, why is the sky blue?";
const target: Target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "claude", session: "aaaaaaaa-1111-4111-8111-111111111111" };
const composer = "✻ Worked for 14s\n──────\n❯\n──────\n  ⏵⏵ auto mode on (shift+tab to cycle)\n";

describe("the recorded /btw panel", () => {
  it("reads the question history and the answering state", () => {
    const panel = sidePanel(answering)!;
    expect(panel).toMatchObject({ answering: true, settled: false, body: [] });
    expect(panel.questions).toEqual(["what is 2+2", "what is 2+2? answer in one short s…", "in ten short numbered points, why …"]);
    expect(panelAsks(panel, QUESTION)).toBe(true);
    expect(panelAsks(panel, "in ten long points")).toBe(false);
  });

  it("reads a settled answer and stitches the scrolled windows by their overlap", () => {
    const top = sidePanel(settled)!, end = sidePanel(scrolled)!;
    expect(top).toMatchObject({ answering: false, settled: true });
    expect(top.body[0].trim()).toBe("1. Sunlight looks white, but it");
    const added = scrolledLines(top.body, end.body)!;
    expect(added.map(line => line.trim())).toEqual(["sunlight contains less of it, some", "is absorbed high in the atmosphere,",
      "and our eyes are less sensitive to", "it.", "10. At sunrise and sunset, light", "passes through much more air,",
      "which scatters most of the blue", "away and leaves reds and oranges."]);
    expect(scrolledLines(end.body, end.body)).toBeUndefined();
    const text = answerText([...top.body, ...added]);
    expect(text.startsWith("1. Sunlight looks white, but it\n   contains every color")).toBe(true);
    expect(text.endsWith("    away and leaves reds and oranges.")).toBe(true);
  });

  it("finds no panel in a composer or in ordinary output", () => {
    expect(sidePanel(composer)).toBeUndefined();
    expect(sidePanel("Press Esc to close the dialog\n")).toBeUndefined();
    expect(sidePanel("")).toBeUndefined();
  });

  it("takes /btw only for Claude, on one line", () => {
    expect(sideQuestionText("claude", " /btw what is\n2+2 ")).toBe("what is 2+2");
    expect(sideQuestionText("claude", "/btw")).toBeUndefined();
    expect(sideQuestionText("claude", "/btwx hello")).toBeUndefined();
    expect(sideQuestionText("codex", "/btw hello")).toBeUndefined();
  });

  it("lets only Claude's /btw into a working pane", () => {
    expect(() => refuseWorkingSlash({ agent_status: "working" }, "/btw what is 2+2", "claude")).not.toThrow();
    expect(() => refuseWorkingSlash({ agent_status: "working" }, "/btw what is 2+2", "codex")).toThrow(MODEL_BUSY);
    expect(() => refuseWorkingSlash({ agent_status: "working" }, "/compact", "claude")).toThrow(MODEL_BUSY);
    expect(() => refuseWorkingSlash({ agent_status: "working" }, "/btw", "claude")).toThrow(MODEL_BUSY);
  });
});

describe("side question transaction", () => {
  let screen: string, stage: "none" | "answering" | "settled" | "scrolled", sideQuestions: SideQuestions;
  const sent = () => vi.mocked(rpc).mock.calls.filter(call => call[1] !== "agent.read").map(call => [call[1], call[2]]);
  const settle = async (id: string) => {
    for (let i = 0; i < 200 && sideQuestions.list(target).find(side => side.id === id)?.state === "pending"; i++) await new Promise(resolve => setTimeout(resolve, 5));
    return sideQuestions.list(target).find(side => side.id === id);
  };
  beforeEach(() => {
    sideQuestions = new SideQuestions({ intervalMs: 1, openMs: 50, timeoutMs: 200 });
    stage = "none"; screen = composer;
    vi.mocked(validateTarget).mockReset().mockImplementation(async () => ({ terminal_id: "t1", agent_status: "working" }));
    vi.mocked(rpc).mockReset().mockImplementation(async (_server, method, params) => {
      if (method === "agent.prompt") { stage = "answering"; return {}; }
      if (method === "agent.send_keys") {
        for (const key of params?.keys as string[]) {
          if (key === "esc") stage = "none";
          if (key === "down" && stage === "settled") stage = "scrolled";
        }
        return {};
      }
      if (method === "agent.read") {
        const text = stage === "answering" ? answering : stage === "settled" ? settled : stage === "scrolled" ? scrolled : screen;
        return { read: { text } };
      }
      throw Error(`Unexpected ${method}`);
    });
  });

  it("asks, reads the whole answer, closes the panel and holds other input meanwhile", async () => {
    const { id } = await sideQuestions.ask(target, { terminal_id: "t1" }, `/btw ${QUESTION}`);
    expect(() => sideQuestions.assertAvailable(target)).toThrow("side question is open");
    expect(sideQuestions.list(target)).toEqual([{ id, question: QUESTION, state: "pending", revision: 1 }]);
    await new Promise(resolve => setTimeout(resolve, 20));
    stage = "settled";
    const side = await settle(id);
    expect(side?.state).toBe("answer");
    expect(side?.answer).toMatch(/^1\. Sunlight looks white/);
    expect(side?.answer).toMatch(/10\. At sunrise and sunset, light\n {4}passes through much more air,/);
    expect(sent()).toEqual([
      ["agent.prompt", { target: target.pane, text: `/btw ${QUESTION}` }],
      ["agent.send_keys", { target: target.pane, keys: ["down"] }],
      ["agent.send_keys", { target: target.pane, keys: ["down", "down"] }],
      ["agent.send_keys", { target: target.pane, keys: ["esc"] }],
    ]);
    expect(stage).toBe("none");
    expect(() => sideQuestions.assertAvailable(target)).not.toThrow();
    // Dismissing on the phone forgets it; nothing more is typed.
    expect(sideQuestions.dismiss(target, id)).toEqual({ ok: true });
    expect(sideQuestions.list(target)).toEqual([]);
    expect(sent()).toHaveLength(4);
  });

  it("refuses when the terminal already shows a panel, without typing", async () => {
    screen = settled;
    await expect(sideQuestions.ask(target, { terminal_id: "t1" }, `/btw ${QUESTION}`)).rejects.toMatchObject({ status: 409 });
    expect(sent()).toEqual([]);
    expect(() => sideQuestions.assertAvailable(target)).not.toThrow();
  });

  it("cancels a pending question from the phone by closing its panel", async () => {
    const { id } = await sideQuestions.ask(target, { terminal_id: "t1" }, `/btw ${QUESTION}`);
    sideQuestions.dismiss(target, id);
    await settle(id);
    for (let i = 0; i < 100 && stage !== "none"; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(sent().at(-1)).toEqual(["agent.send_keys", { target: target.pane, keys: ["esc"] }]);
    expect(sideQuestions.list(target)).toEqual([]);
  });

  it("reports a panel closed in the terminal as cancelled and never presses Escape outside it", async () => {
    const { id } = await sideQuestions.ask(target, { terminal_id: "t1" }, `/btw ${QUESTION}`);
    await new Promise(resolve => setTimeout(resolve, 20));
    stage = "none";
    expect((await settle(id))?.state).toBe("cancelled");
    expect(sent()).toEqual([["agent.prompt", { target: target.pane, text: `/btw ${QUESTION}` }]]);
  });

  it("gives up after the timeout and closes the still-answering panel", async () => {
    const { id } = await sideQuestions.ask(target, { terminal_id: "t1" }, `/btw ${QUESTION}`);
    const side = await settle(id);
    expect(side).toMatchObject({ state: "error", answer: "No answer after 0 seconds." });
    expect(sent().at(-1)).toEqual(["agent.send_keys", { target: target.pane, keys: ["esc"] }]);
  });

  it("stops when the pane's conversation changes", async () => {
    const { id } = await sideQuestions.ask(target, { terminal_id: "t1" }, `/btw ${QUESTION}`);
    vi.mocked(validateTarget).mockImplementation(async () => ({ terminal_id: "t2", agent_status: "working" }));
    expect(await settle(id)).toMatchObject({ state: "error", answer: "The conversation in this pane changed." });
    expect(sent()).toHaveLength(1);
  });
});

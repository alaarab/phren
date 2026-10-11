import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { answerClaudeQuestionDialog, claudeQuestionDialog, type DialogQuestion } from "./claude-question-dialog.js";
import { FakeClaude } from "./__fixtures__/claude-questions/fake-claude.js";

// Panes captured from Claude Code 2.1 drawing AskUserQuestion in Herdr.
const pane = (name: string) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "claude-questions", `${name}.txt`), "utf8");

describe("reading Claude's question dialog", () => {
  it("reads the first of three questions under its tab bar, not the prompt above it", () => {
    expect(claudeQuestionDialog(pane("q1"))).toEqual({
      kind: "question", tabs: ["Color", "Tools", "Size"], multiSelect: false, cursor: 1,
      title: "Which color should the new onboarding banner use for the dark theme?",
      options: [
        { number: 1, label: "Red", answered: false, cursor: true },
        { number: 2, label: "Green", answered: false, cursor: false },
        { number: 3, label: "Blue", answered: false, cursor: false },
      ],
      other: { number: 4, label: "Type something.", answered: false, cursor: false },
    });
  });

  it("reads multi-select boxes, a typed answer and the Next row", () => {
    const checked = claudeQuestionDialog(pane("q2-checked"));
    expect(checked).toMatchObject({ kind: "question", title: "Which tools do you use?", multiSelect: true, cursor: 1 });
    expect(checked?.kind === "question" && checked.options.map(row => [row.label, row.checked])).toEqual([["Vim", true], ["Emacs", false], ["VSCode", true]]);
    expect(checked?.kind === "question" && checked.other).toMatchObject({ number: 4, label: "Type something", checked: false });
    expect(claudeQuestionDialog(pane("q2-other"))).toMatchObject({ cursor: 4, other: { label: "Nano", checked: true } });
    expect(claudeQuestionDialog(pane("q2-next"))).toMatchObject({ cursor: "next" });
    expect(claudeQuestionDialog(pane("q3"))).toMatchObject({ title: "Which size?", options: [{ label: "Small" }, { label: "Large" }] });
  });

  it("reads the review tab and a lone question", () => {
    expect(claudeQuestionDialog(pane("review"))).toEqual({ kind: "review", tabs: ["Color", "Tools", "Size"], answers: [
      { question: "Which color should the new onboarding banner use for the dark theme?", answer: "Green" },
      { question: "Which tools do you use?", answer: "Vim, VSCode, Nano" },
      { question: "Which size?", answer: "Large" },
    ] });
    expect(claudeQuestionDialog(pane("single"))).toMatchObject({ tabs: ["Choice"], title: "Pick one?", multiSelect: false });
    expect(claudeQuestionDialog(pane("single-multi"))).toMatchObject({ tabs: ["Tools"], title: "Which tools?", multiSelect: true });
    expect(claudeQuestionDialog(pane("answered"))).toBeUndefined();
  });

  it("reads a long question's title and review rows out of Claude's left border", () => {
    // Claude Code 2.1.284 boxes a question wider than 80 columns or with a
    // line break; the border is not part of the question the phone sends.
    expect(claudeQuestionDialog(pane("long-single"))).toMatchObject({ tabs: ["Prod deploy"], multiSelect: false,
      title: "Staging is green: migrations applied, smoke tests passed, and the build is tagged v2.3.1 (the \"release candidate\") — it's ready for production. Confirm prod deploy?",
      options: [{ label: "Yes, deploy prod now" }, { label: "Not yet" }] });
    expect(claudeQuestionDialog(pane("long-set-review"))).toEqual({ kind: "review", tabs: ["Prod deploy", "Notify"], answers: [
      { question: "Staging is green: migrations applied, smoke tests passed, and the build is tagged v2.3.1 (the \"release candidate\") — it's ready for production. Confirm prod deploy?", answer: "Yes, deploy prod now" },
      { question: "Who should hear about the deploy once it finishes, given that the on-call rotation changed this week and the release channel is muted?", answer: "On-call" },
    ] });
  });
});

const set: DialogQuestion[] = [
  { question: "Which color?", options: [{ label: "Red" }, { label: "Green" }, { label: "Blue" }] },
  { question: "Which tools?", multiSelect: true, options: [{ label: "Vim" }, { label: "Emacs" }, { label: "VSCode" }] },
  { question: "Which size?", options: [{ label: "Small" }, { label: "Large" }] },
];

describe("answering Claude's question dialog", () => {
  it("the old blind digits-then-Tab walk skips the next question and never submits", async () => {
    const claude = new FakeClaude(set);
    for (const keys of [["2", "tab"], ["1", "3", "tab"], ["2", "enter"]]) await claude.io().keys(keys);
    expect(claude.result).toBeUndefined();
    expect(claude.value(1)).toEqual([]);
  });

  it("answers every question, with a typed Other on a multi-select, and submits from the review", async () => {
    const claude = new FakeClaude(set);
    await answerClaudeQuestionDialog(claude.io(), set, [{ options: [1] }, { options: [0, 2], text: "Nano editor" }, { options: [1] }]);
    expect(claude.result).toEqual({ "Which color?": "Green", "Which tools?": ["Vim", "VSCode", "Nano editor"], "Which size?": "Large" });
    expect(claude.sent.at(-1)).toEqual(["1"]);
  });

  it("types a single-select Other answer and walks back from another tab", async () => {
    const claude = new FakeClaude(set);
    claude.tab = 2;
    await answerClaudeQuestionDialog(claude.io(), set, [{ options: [], text: "Teal" }, { options: [1] }, { options: [0] }]);
    expect(claude.sent[0]).toEqual(["left", "left"]);
    expect(claude.result).toEqual({ "Which color?": "Teal", "Which tools?": ["Emacs"], "Which size?": "Small" });
  });

  it("waits for a slow redraw instead of calling a taken answer refused", async () => {
    // A busy computer: Claude took the digit but redraws 3 s later. The walk
    // used to give up after 2 s and the phone said the answer wasn't confirmed.
    const one = [set[0]], claude = new FakeClaude(one);
    await answerClaudeQuestionDialog(claude.io({ redrawMs: 3_000 }), one, [{ options: [1] }]);
    expect(claude.sent).toEqual([["2"]]);
    expect(claude.result).toEqual({ "Which color?": "Green" });
  });

  it("answers and submits long questions drawn inside Claude's border", async () => {
    const long: DialogQuestion[] = [
      { question: "Staging is green and the build is tagged.\n\nConfirm prod deploy?", options: [{ label: "Yes, deploy prod now" }, { label: "Not yet" }] },
      { question: "Who should hear about the deploy once it finishes, given that the on-call rotation changed this week?", multiSelect: true, options: [{ label: "On-call" }, { label: "Release channel" }] },
    ];
    const claude = new FakeClaude(long);
    await answerClaudeQuestionDialog(claude.io(), long, [{ options: [0] }, { options: [1] }]);
    expect(claude.result).toEqual({ [long[0].question]: "Yes, deploy prod now", [long[1].question]: ["Release channel"] });
  });

  it("answers a lone single-select question with its digit alone", async () => {
    const one = [set[0]], claude = new FakeClaude(one);
    await answerClaudeQuestionDialog(claude.io(), one, [{ options: [2] }]);
    expect(claude.sent).toEqual([["3"]]);
    expect(claude.result).toEqual({ "Which color?": "Blue" });
  });

  it("confirms a lone multi-select question through its review", async () => {
    const one = [set[1]], claude = new FakeClaude(one);
    await answerClaudeQuestionDialog(claude.io(), one, [{ options: [0, 1] }]);
    expect(claude.sent).toEqual([["1"], ["2"], ["tab"], ["1"]]);
    expect(claude.result).toEqual({ "Which tools?": ["Vim", "Emacs"] });
  });

  it("answers an older phone's single question without submitting early", async () => {
    const claude = new FakeClaude(set);
    await answerClaudeQuestionDialog(claude.io(), set, [{ options: [0] }], { from: 0, submit: false });
    await answerClaudeQuestionDialog(claude.io(), set, [{ options: [1] }], { from: 1, submit: false });
    expect(claude.result).toBeUndefined();
    await answerClaudeQuestionDialog(claude.io(), set, [{ options: [0] }], { from: 2, submit: true });
    expect(claude.result).toEqual({ "Which color?": "Red", "Which tools?": ["Emacs"], "Which size?": "Small" });
  });

  it("sends nothing to a pane asking a different set of questions", async () => {
    const claude = new FakeClaude(set);
    await expect(answerClaudeQuestionDialog(claude.io(), set.slice(0, 2), [{ options: [0] }, { options: [0] }])).rejects.toMatchObject({ status: 409 });
    await expect(answerClaudeQuestionDialog(claude.io(), [{ ...set[0], question: "Which colour?" }, set[1], set[2]], [{ options: [0] }, { options: [0] }, { options: [0] }]))
      .rejects.toMatchObject({ status: 409 });
    expect(claude.sent).toEqual([]);
    expect(claude.gone).toBe(false);
  });
});

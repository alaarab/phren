import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { answerClaudeQuestionDialog, sameTitle, claudeQuestionDialog, type DialogQuestion } from "./claude-question-dialog.js";
import { FakeClaude } from "./__fixtures__/claude-questions/fake-claude.js";

// Panes captured from Claude Code 2.1 drawing AskUserQuestion in Herdr.
const pane = (name: string) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "claude-questions", `${name}.txt`), "utf8");

describe("reading Claude's question dialog", () => {
  const shortDialog = (bar: string) => [bar, "", "Pick?", "", "❯ 1. A", "  2. B", "  3. Type something.",
    "  4. Chat about this", "", "Enter to select", "Esc to cancel"].join("\n");

  it.each([
    ["Submit", "← ☐ Color ☐ Tools ✔ Sub\nmit →", ["Color", "Tools"]],
    ["a tab label", "← ☐ Color theme ☐ Too\nls ✔ Submit →", ["Color theme", "Tools"]],
    ["Submit after combining-mark output", "e\u0301".repeat(22) + "\n\n← ☐ Color ☐ Tools ✔ Sub\nmit →", ["Color", "Tools"]],
    ["Submit with a wide tab label", "─".repeat(24) + "\n← ☐ 色彩🎨 ☐ Tools ✔ Sub\nmit →", ["色彩🎨", "Tools"]],
    ["Submit after VS16 emoji output", "☕️".repeat(8) + "\n\n← ☐ Color ☐ Tools ✔ Sub\nmit →", ["Color", "Tools"]],
    ["Submit after ZWJ emoji output", "👨‍👩‍👧‍👦".repeat(3) + "\n\n← ☐ Color ☐ Tools ✔ Sub\nmit →", ["Color", "Tools"]],
    ["a label before a spaced Submit suffix", "← ☐ Color ☐ Too\nls ✔\nSubmit →", ["Color", "Tools"]],
    ["a tab whose separating space the capture trimmed", "← ☐ Color theme ☐ Size ☐\nTools ✔ Submit →", ["Color theme", "Size", "Tools"]],
    ["three rows with a trimmed space", "← ☐ Color ☐\nSize ☐ Too\nls ✔ Submit →", ["Color", "Size", "Tools"]],
  ] as const)("preserves characters when a tab bar wraps inside %s", (_name, bar, tabs) => {
    expect(claudeQuestionDialog(shortDialog(bar))).toMatchObject({ kind: "question", title: "Pick?", tabs });
  });

  it("starts the tab bar at its leading arrow, excluding a preceding checkbox row", () => {
    expect(claudeQuestionDialog(shortDialog("☐ Previous task\n← ☐ Color ☐ Tools ✔ Submit →")))
      .toMatchObject({ kind: "question", title: "Pick?", tabs: ["Color", "Tools"] });
  });

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

  it.each(["q1", "review", "long-single"])("rejects a stale or quoted %s dialog", name => {
    expect(claudeQuestionDialog(pane(name).replace(/❯/g, " "))).toBeUndefined();
    expect(claudeQuestionDialog(pane(name) + "\n❯ Continue\nWorking…")).toBeUndefined();
    expect(claudeQuestionDialog("```text\n" + pane(name) + "\n```")).toBeUndefined();
    expect(claudeQuestionDialog(pane(name).split("\n").map(line => "> " + line).join("\n"))).toBeUndefined();
  });

  it("reads and answers a question whose footer wraps before Esc to cancel", async () => {
    expect(claudeQuestionDialog(pane("single").replace(" · Esc to cancel", " ·\nEsc to cancel"))).toMatchObject({ kind: "question", title: "Pick one?", cursor: 1 });
    const claude = new FakeClaude([{ question: "Pick one?", options: [{ label: "A" }, { label: "B" }] }]);
    const io = claude.io();
    await answerClaudeQuestionDialog({ ...io, read: async () => (await io.read()).replace(" · Esc to cancel", " ·\nEsc to cancel") },
      [{ question: "Pick one?", options: [{ label: "A" }, { label: "B" }] }], [{ options: [1] }]);
    expect(claude.result).toEqual({ "Pick one?": "B" });
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
  it.each([false, true])("submits four questions with a wrapped tab bar and a final multi-select (Other: %s)", async typed => {
    const questions: DialogQuestion[] = [set[0], set[2],
      { question: "Which environment?", options: [{ label: "Staging" }, { label: "Production" }] }, set[1]];
    const claude = new FakeClaude(questions), io = claude.io();
    // The owner may already be on question four in the terminal. Reflow the
    // real dialog layout at two tab boundaries, including Submit on its own
    // physical row; the existing fake always draws a single wide tab bar.
    claude.tab = 3;
    await answerClaudeQuestionDialog({ ...io, read: async () => (await io.read())
      .replace(/(←[^\n]*?[☐☒] \S+  [☐☒] \S+)  /, "$1\n")
      .replace(/  ✔ Submit  →/, "\n✔ Submit  →") }, questions,
    [{ options: [1] }, { options: [0] }, { options: [0] }, { options: [0, 1, 2], ...(typed ? { text: "Nano editor" } : {}) }]);
    expect(claude.result).toEqual({ "Which color?": "Green", "Which size?": "Small", "Which environment?": "Staging",
      "Which tools?": ["Vim", "Emacs", "VSCode", ...(typed ? ["Nano editor"] : [])] });
  });

  it.each([false, true])("reuses identical focused Other text without appending (multiSelect: %s)", async multiSelect => {
    const questions = [{ ...set[0], multiSelect }], claude = new FakeClaude(questions);
    claude.cursor = 4; claude.typed[0] = "Teal 123"; claude.typedOn[0] = multiSelect;
    await answerClaudeQuestionDialog(claude.io(), questions, [{ options: [], text: "Teal 123" }]);
    expect(claude.result).toEqual({ "Which color?": multiSelect ? ["Teal 123"] : "Teal 123" });
    expect(claude.typed[0]).toBe("Teal 123");
  });

  it.each([false, true])("refuses differing existing Other text without editing it (multiSelect: %s)", async multiSelect => {
    const questions = [{ ...set[0], multiSelect }], claude = new FakeClaude(questions);
    claude.cursor = 4; claude.typed[0] = "Old draft";
    await expect(answerClaudeQuestionDialog(claude.io(), questions, [{ options: [], text: "New answer" }]))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("existing typed answer") });
    expect(claude.typed[0]).toBe("Old draft");
    expect(claude.result).toBeUndefined();
  });

  it.each([false, true])("leaves focused Other before selecting options (multiSelect: %s)", async multiSelect => {
    const questions = [{ ...set[0], multiSelect }], claude = new FakeClaude(questions);
    claude.cursor = 4; claude.typed[0] = "Draft"; claude.typedOn[0] = multiSelect;
    await answerClaudeQuestionDialog(claude.io(), questions, [{ options: [1] }]);
    expect(claude.result).toEqual({ "Which color?": multiSelect ? ["Green"] : "Green" });
    expect(claude.typed[0]).toBe("Draft");
  });

  it("stops if leaving the text field does not move the cursor", async () => {
    const questions = [set[0]], claude = new FakeClaude(questions), io = claude.io();
    claude.cursor = 4; claude.typed[0] = "Draft";
    await expect(answerClaudeQuestionDialog({ ...io, keys: async keys => {
      if (keys.includes("up")) { claude.sent.push(keys); return; }
      await io.keys(keys);
    } }, questions, [{ options: [0] }])).rejects.toMatchObject({ status: 409, details: { code: "question-unconfirmed" } });
    expect(claude.typed[0]).toBe("Draft");
    expect(claude.sent.flat()).not.toContain("1");
  });

  it("moves from Next to Other on a multi-select without guessing row one", async () => {
    const questions = [set[1]], claude = new FakeClaude(questions);
    claude.cursor = "next";
    await answerClaudeQuestionDialog(claude.io(), questions, [{ options: [], text: "Nano" }]);
    expect(claude.result).toEqual({ "Which tools?": ["Nano"] });
  });

  it("waits through unreadable redraws between questions and after review submission", async () => {
    const claude = new FakeClaude(set), io = claude.io();
    let unreadable = 0;
    await answerClaudeQuestionDialog({ ...io,
      keys: async keys => { const tab = claude.tab; await io.keys(keys); unreadable = claude.tab !== tab || claude.gone ? 22 : 4; },
      read: async () => unreadable-- > 0 ? "\n← ☒ color  ✔ Sub" : io.read(),
    }, set, [{ options: [1] }, { options: [0, 2], text: "Nano" }, { options: [1] }]);
    expect(unreadable).toBeLessThan(0);
    expect(claude.result).toEqual({ "Which color?": "Green", "Which tools?": ["Vim", "VSCode", "Nano"], "Which size?": "Large" });
  });

  it.each([[false, "redrawing…"], [true, "redrawing…"], [false, "❯"], [true, "❯"]])("never treats an unreadable redraw as completion (review: %s, frame: %s)", async (review, frame) => {
    const questions = [review ? set[1] : set[0]], claude = new FakeClaude(questions), io = claude.io();
    await expect(answerClaudeQuestionDialog({ ...io, read: async () => claude.gone ? String(frame) : io.read() }, questions, [{ options: [0] }]))
      .rejects.toMatchObject({ status: 409, details: { code: "question-unconfirmed" } });
  });

  it("refuses a typed answer whose suffix was lost, even when its first 20 characters match", async () => {
    const questions = [set[0]], claude = new FakeClaude(questions), io = claude.io();
    const text = "A long answer with the correct suffix";
    await expect(answerClaudeQuestionDialog({ ...io, keys: async keys => {
      await io.keys(keys);
      if (claude.typed[0]) claude.typed[0] = text.slice(0, 25);
    } }, questions, [{ options: [], text }])).rejects.toMatchObject({ status: 409 });
    expect(claude.result).toBeUndefined();
  });

  it.each(["wrong option", "missing selection", "extra selection", "wrong text suffix"])("refuses review with %s before submitting", async mismatch => {
    const claude = new FakeClaude(set), io = claude.io();
    const text = "A long answer with the correct suffix";
    await expect(answerClaudeQuestionDialog({ ...io, read: async () => {
      const frame = await io.read();
      if (claude.tab !== set.length) return frame;
      if (mismatch === "wrong option") return frame.replace("→ Green", "→ Red");
      if (mismatch === "missing selection") return frame.replace("→ Vim, VSCode,", "→ Vim,");
      if (mismatch === "extra selection") return frame.replace("→ Vim, VSCode,", "→ Vim, Emacs, VSCode,");
      return frame.replace(text, text.slice(0, -6) + "WRONG");
    } }, set, [{ options: [1] }, { options: [0, 2], text }, { options: [1] }]))
      .rejects.toMatchObject({ status: 409, details: { code: "question-unconfirmed" }, message: expect.stringContaining("review") });
    expect(claude.result).toBeUndefined();
    expect(claude.tab).toBe(set.length);
  });

  it("refuses a wrapped Other field whose first line equals the phone answer", async () => {
    const questions = [set[0]], claude = new FakeClaude(questions), io = claude.io();
    claude.cursor = 4; claude.typed[0] = "Teal";
    await expect(answerClaudeQuestionDialog({ ...io, read: async () => (await io.read()).replace("4. Teal", "4. Teal\n     extra text") },
      questions, [{ options: [], text: "Teal" }])).rejects.toMatchObject({ status: 409 });
    expect(claude.sent).toEqual([]);
  });

  it("refuses ambiguous wrapped answer text on review", async () => {
    const questions = [set[1]], claude = new FakeClaude(questions), io = claude.io();
    await expect(answerClaudeQuestionDialog({ ...io, read: async () => (await io.read()).replace("→ Vim, VSCode", "→ Vim,\n     VSCode") },
      questions, [{ options: [0, 2] }])).rejects.toMatchObject({ status: 409, message: expect.stringContaining("review") });
    expect(claude.result).toBeUndefined();
  });

  it("refuses a label with an unverified suffix before sending a single-select shortcut", async () => {
    const label = "A very long label shared by two different choices";
    const questions = [{ question: "Pick?", options: [{ label: label + " WRONG" }, { label: "B" }] }];
    const claude = new FakeClaude(questions), io = claude.io();
    await expect(answerClaudeQuestionDialog({ ...io, read: async () => (await io.read()).replaceAll(label + " WRONG", label) },
      questions, [{ options: [0] }])).rejects.toMatchObject({ status: 409, details: { code: "question-not-shown" } });
    expect(claude.sent).toEqual([]);
  });

  it("refuses a leading digit in an empty Other field before it can select an option", async () => {
    const questions = [set[0]], claude = new FakeClaude(questions);
    await expect(answerClaudeQuestionDialog(claude.io(), questions, [{ options: [], text: "123 teal" }]))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("starting with a digit") });
    expect(claude.result).toBeUndefined();
    expect(claude.sent.flat()).not.toContain("1");
  });

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

  it("lets an older phone advance individual questions but refuses to submit an unverifiable partial review", async () => {
    const claude = new FakeClaude(set);
    await answerClaudeQuestionDialog(claude.io(), set, [{ options: [0] }], { from: 0, submit: false });
    await answerClaudeQuestionDialog(claude.io(), set, [{ options: [1] }], { from: 1, submit: false });
    expect(claude.result).toBeUndefined();
    await expect(answerClaudeQuestionDialog(claude.io(), set, [{ options: [0] }], { from: 2, submit: true }))
      .rejects.toMatchObject({ status: 409, details: { code: "question-not-shown" }, message: expect.stringContaining("partial answer set") });
    expect(claude.result).toBeUndefined();
  });

  it("sends nothing to a pane asking a different set of questions", async () => {
    const claude = new FakeClaude(set);
    await expect(answerClaudeQuestionDialog(claude.io(), set.slice(0, 2), [{ options: [0] }, { options: [0] }])).rejects.toMatchObject({ status: 409 });
    await expect(answerClaudeQuestionDialog(claude.io(), [{ ...set[0], question: "Which colour?" }, set[1], set[2]], [{ options: [0] }, { options: [0] }, { options: [0] }]))
      .rejects.toMatchObject({ status: 409 });
    expect(claude.sent).toEqual([]);
    expect(claude.gone).toBe(false);
  });

  it("tells a refusal before any key from one after keys were sent", async () => {
    const before = new FakeClaude(set);
    await expect(answerClaudeQuestionDialog(before.io(), set.slice(0, 2), [{ options: [0] }, { options: [0] }]))
      .rejects.toMatchObject({ status: 409, details: { code: "question-not-shown" }, message: expect.stringContaining("Nothing was sent") });
    const after = new FakeClaude(set);
    await expect(answerClaudeQuestionDialog(after.io(), [set[0], { ...set[1], question: "Which tool?" }, set[2]], [{ options: [0] }, { options: [0] }, { options: [0] }]))
      .rejects.toMatchObject({ status: 409, details: { code: "question-unconfirmed" }, message: expect.stringContaining("already sent") });
    expect(after.sent.length).toBeGreaterThan(0);
  });

  it("matches a question Claude cut at 2000 characters or collapsed whitespace", () => {
    const long = "word ".repeat(600).trim();
    expect(sameTitle(long.slice(0, 1999).trimEnd() + "…", long)).toBe(true);
    expect(sameTitle("Short?…", "Short? Yes")).toBe(false);
    expect(sameTitle("Which color?", "Which   color?")).toBe(true);
  });
});

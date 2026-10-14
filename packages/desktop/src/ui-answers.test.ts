import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Plain ESM UI module.
import { answerApproval, answerQuestion, answerSudo, buildClaudeUpdatedInput, buildQuestionAnswers, approvalDecision, dismissSideAnswer, questionValue, sendSecret } from "../ui/chat/answers.js";

const COMPUTER = "box";
const TARGET = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "claude", session: "s1" };

/** Stub global fetch: return an ok JSON body and record the call. */
function stubFetch(body: unknown = { ok: true }) {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function lastCall(): { url: string; body: any; headers: Record<string, string> } {
  const fetchMock = globalThis.fetch as unknown as { mock: { calls: any[][] } };
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url, body: JSON.parse(init.body), headers: init.headers };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("approvalDecision", () => {
  it("maps the two-axis answer to the Hook's decision", () => {
    expect(approvalDecision("approve", "once")).toBe("approve");
    expect(approvalDecision("approve", "project")).toBe("allow-project");
    expect(approvalDecision("approve", "everywhere")).toBe("allow-everywhere");
    expect(approvalDecision("deny", "everywhere")).toBe("deny");
    expect(approvalDecision("approve")).toBe("approve");
  });
});

describe("answerApproval", () => {
  it("POSTs an approval answer with the plain approve", async () => {
    const mock = stubFetch();
    await answerApproval(COMPUTER, TARGET, { actionId: "a1", decision: "approve" });
    const call = lastCall();
    expect(mock).toHaveBeenCalledTimes(1);
    expect(call.url).toBe("/hosts/box/v1/approvals/answer");
    expect(call.body).toEqual({ target: TARGET, actionId: "a1", decision: "approve" });
    expect(call.headers["X-Phren-Desktop"]).toBe("1");
  });

  it("maps the project and everywhere scopes", async () => {
    stubFetch();
    await answerApproval(COMPUTER, TARGET, { actionId: "a1", decision: "approve", scope: "project" });
    expect(lastCall().body.decision).toBe("allow-project");
    await answerApproval(COMPUTER, TARGET, { actionId: "a1", decision: "approve", scope: "everywhere" });
    expect(lastCall().body.decision).toBe("allow-everywhere");
    await answerApproval(COMPUTER, TARGET, { actionId: "a1", decision: "deny", scope: "project" });
    expect(lastCall().body.decision).toBe("deny");
  });

  it("carries updatedInput for a Claude question", async () => {
    stubFetch();
    await answerApproval(COMPUTER, TARGET, { actionId: "a1", decision: "approve", updatedInput: { answers: { Q: "A" } } });
    expect(lastCall().body.updatedInput).toEqual({ answers: { Q: "A" } });
  });
});

describe("answerQuestion", () => {
  // server-pane-routes.ts requires question text, boolean multiSelect and
  // string option labels for Claude/OpenCode; Codex resolves its own prompt.
  const questions = [
    { id: "q1", header: "Route", question: "Which?", multiSelect: false, options: [{ label: "A", description: "First" }, { label: "B" }] },
    { id: "q2", question: "Anything else?", multiSelect: false, options: [{ label: "No" }] },
  ];
  const answers = buildQuestionAnswers(questions, [{ selections: [1] }, { text: "  Something else  " }]);

  it("answers a Codex prompt by toolUseId even when given questions", async () => {
    stubFetch();
    const target = { ...TARGET, source: "codex" };
    await answerQuestion(COMPUTER, target, { id: "tu1", questions, answers });
    const call = lastCall();
    expect(call.url).toBe("/hosts/box/v1/questions/answer");
    expect(call.body).toEqual({ target, toolUseId: "tu1", answers: [{ optionIndexes: [1] }, { optionIndexes: [], text: "Something else" }] });
  });

  it.each(["claude", "opencode"])("answers a pending %s dialog with the Hook's question schema", async (source) => {
    stubFetch();
    const target = { ...TARGET, source };
    const multi = { question: "Which extras?", multiSelect: true, options: [{ label: "C" }, { label: "D" }] };
    const allQuestions = [...questions, multi];
    await answerQuestion(COMPUTER, target, {
      id: "dialog1", questions: allQuestions,
      answers: buildQuestionAnswers(allQuestions, [{ selections: [1] }, { text: "Something else" }, { selections: [1, 0], text: "  E  " }]),
    });
    const call = lastCall();
    expect(call.url).toBe("/hosts/box/v1/questions/answer");
    expect(call.body).toEqual({
      target,
      questions: [
        { question: "Which?", multiSelect: false, options: ["A", "B"] },
        { question: "Anything else?", multiSelect: false, options: ["No"] },
        { question: "Which extras?", multiSelect: true, options: ["C", "D"] },
      ],
      answers: [{ optionIndexes: [1] }, { optionIndexes: [], text: "Something else" }, { optionIndexes: [0, 1], text: "E" }],
    });
  });
});

describe("sendSecret", () => {
  it("POSTs the secret as text", async () => {
    stubFetch();
    await sendSecret(COMPUTER, TARGET, { value: "hunter2" });
    const call = lastCall();
    expect(call.url).toBe("/hosts/box/v1/secret");
    expect(call.body).toEqual({ target: TARGET, text: "hunter2" });
  });
});

describe("answerSudo", () => {
  it("sends a password once", async () => {
    stubFetch();
    await answerSudo(COMPUTER, { id: "u1", password: "pw" });
    expect(lastCall().url).toBe("/hosts/box/v1/sudo/answer");
    expect(lastCall().body).toEqual({ id: "u1", password: "pw" });
  });

  it("asks for the outcome when remembering for the session", async () => {
    stubFetch();
    await answerSudo(COMPUTER, { id: "u1", password: "pw", remember: true });
    expect(lastCall().body).toEqual({ id: "u1", password: "pw", outcome: true });
  });

  it("denies when no password is given", async () => {
    stubFetch();
    await answerSudo(COMPUTER, { id: "u1" });
    expect(lastCall().body).toEqual({ id: "u1", deny: true });
  });
});

describe("dismissSideAnswer", () => {
  it("POSTs the dismiss with the target", async () => {
    stubFetch();
    await dismissSideAnswer(COMPUTER, TARGET, "side-1");
    const call = lastCall();
    expect(call.url).toBe("/hosts/box/v1/side-question/dismiss");
    expect(call.body).toEqual({ target: TARGET, id: "side-1" });
  });
});

describe("question value helpers", () => {
  const single = { question: "Q", options: [{ label: "A" }, { label: "B" }] };
  const multi = { question: "Q", multiSelect: true, options: [{ label: "A" }, { label: "B" }] };
  const free = { question: "Q", kind: "text", options: [] };

  it("reads a single choice, a multi choice and a typed answer", () => {
    expect(questionValue(single, { selections: [1] })).toBe("B");
    expect(questionValue(multi, { selections: [0, 1] })).toEqual(["A", "B"]);
    expect(questionValue(free, { text: "  hi " })).toBe("hi");
    expect(questionValue(single, { text: "Other" })).toBe("Other");
  });

  it("throws on an unanswered question", () => {
    expect(() => questionValue(single, {})).toThrow();
  });

  it("builds Claude updatedInput keyed by question text", () => {
    const input = { questions: [single] };
    expect(buildClaudeUpdatedInput(input, [single], [{ selections: [0] }])).toEqual({
      questions: [single], answers: { Q: "A" },
    });
  });

  it("builds Codex answer rows from selections", () => {
    expect(buildQuestionAnswers([single, free], [{ selections: [1] }, { text: "yo" }]))
      .toEqual([{ optionIndexes: [1] }, { optionIndexes: [], text: "yo" }]);
  });
});

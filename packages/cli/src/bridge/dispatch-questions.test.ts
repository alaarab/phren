import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DispatchQuestionRelay, questionAnswerRequest } from "./dispatch-questions.js";
import { BridgeError } from "./protocol.js";

const dispatchId = "aaaaaaaa-1111-4111-8111-111111111111";
const computer = { id: "bbbbbbbb-2222-4222-8222-222222222222", name: "Desk" };
const target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "codex", session: "cccccccc-3333-4333-8333-333333333333" };
const context = { dispatchId, computer, brief: "Parser checks", destination: { kind: "target" as const, target } };

describe("dispatch question relay", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-dispatch-questions-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("dedupes stale status frames and forwards the original Codex call id", async () => {
    const forward = vi.fn(async () => ({ ok: true })), relay = new DispatchQuestionRelay({ root, forward });
    const frame = { agentStatus: { source: "codex", pendingQuestions: [{ toolUseId: "call-1", isAsync: true,
      questions: [{ question: "Pick checks", options: [{ label: "Unit" }, { label: "Type" }] }] }] } };
    const [question] = await relay.consume(context, frame);
    expect(await relay.consume(context, frame)).toEqual([]);
    await expect(relay.consume(context, { agentStatus: { source: "codex", pendingQuestions: [{ ...frame.agentStatus.pendingQuestions[0], submitted: true }] } })).resolves.toEqual([]);
    await relay.answer({ notificationId: question.id, answer: [{ optionIndexes: [0, 1] }] });
    expect(forward).toHaveBeenCalledWith("/v1/questions/answer", { target, toolUseId: "call-1", answers: [{ optionIndexes: [0, 1] }] });
  });

  it("keeps Claude question input intact while forwarding choice, text, and multiSelect answers", async () => {
    const claudeTarget = { ...target, source: "claude", session: "dddddddd-4444-4444-8444-444444444444" };
    const relay = new DispatchQuestionRelay({ root });
    const input = { questions: [{ question: "Pick reviewers", options: ["Review A", "Review B"], multiSelect: true }, { question: "Why?" }] };
    const [question] = await relay.consume({ ...context, destination: { kind: "target", target: claudeTarget } }, { agentStatus: {
      source: "claude", pendingApproval: { toolName: "AskUserQuestion", actionId: "eeeeeeee-5555-4555-8555-555555555555", input },
    } });
    expect(questionAnswerRequest(question, { answers: { "Pick reviewers": ["Review A", "Review B"], "Why?": "Both know this subsystem" } }))
      .toEqual({ route: "/v1/approvals/answer", data: { target: claudeTarget, actionId: "eeeeeeee-5555-4555-8555-555555555555", decision: "approve",
        updatedInput: { ...input, answers: { "Pick reviewers": ["Review A", "Review B"], "Why?": "Both know this subsystem" } } } });
  });

  it("forwards only the existing bounded terminal keys, including starting bindings", async () => {
    const { session: _session, ...location } = target;
    const starting = { ...location, starting: true as const, startingToken: "a".repeat(64) };
    const relay = new DispatchQuestionRelay({ root });
    const [question] = await relay.consume({ ...context, destination: { kind: "target", target: starting } }, { agentStatus: {
      source: "codex", terminalPrompt: { callId: "trust-1", toolName: "Trust folder", message: "Trust this checkout?" },
    } });
    expect(questionAnswerRequest(question, { keys: ["Down", "Enter"] })).toEqual({ route: "/v1/keys", data: { target: starting, keys: ["Down", "Enter"] } });
    expect(() => questionAnswerRequest(question, { keys: ["x"] })).toThrow();
  });

  it("retains an uncertain answer receipt and never forwards it a second time", async () => {
    const forward = vi.fn(async () => { throw new BridgeError(504, "lost acknowledgement"); });
    const relay = new DispatchQuestionRelay({ root, forward });
    const [question] = await relay.consume(context, { agentStatus: { source: "codex", pendingQuestions: [{ toolUseId: "call-2", isAsync: true,
      questions: [{ question: "Continue?", options: [{ label: "Yes" }] }] }] } });
    await expect(relay.answer({ notificationId: question.id, answer: [{ optionIndexes: [0] }] })).rejects.toMatchObject({ status: 409 });
    await expect(relay.answer({ notificationId: question.id, answer: [{ optionIndexes: [0] }] })).rejects.toMatchObject({ status: 409 });
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("reports the headless limitation instead of substituting a terminal or provider", async () => {
    const relay = new DispatchQuestionRelay({ root });
    const headless = { kind: "headless" as const, jobId: "ffffffff-6666-4666-8666-666666666666" };
    const [question] = await relay.consume({ ...context, destination: headless }, { agentStatus: { source: "codex", pendingQuestions: [{ toolUseId: "call-3", isAsync: true,
      questions: [{ question: "Continue?", options: [{ label: "Yes" }] }] }] } });
    expect(question).toMatchObject({ kind: "headless", destination: headless, limitation: "Headless workers do not expose an answer API." });
    expect(() => questionAnswerRequest(question, [{ optionIndexes: [0] }])).toThrow("do not expose an answer API");
  });
});

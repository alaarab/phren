import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexQuestions, pendingAsyncQuestion, pendingAsyncQuestions, questionReply } from "./questions.js";

const state = vi.hoisted(() => ({ file: "", root: "", session: "aaaaaaaa-1111-4111-8111-111111111111" }));
vi.mock("./herdr.js", () => ({ validateTarget: vi.fn(async () => ({})), paneIdentity: vi.fn(async () => state.session) }));
vi.mock("./transcripts.js", () => ({ transcriptPath: vi.fn(async () => state.file) }));
vi.mock("./protocol.js", async importOriginal => ({ ...await importOriginal<typeof import("./protocol.js")>(), bridgeRoot: () => state.root }));
const target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "codex" as const, session: "aaaaaaaa-1111-4111-8111-111111111111" };
const questions = [{ title: "Which screens?", options: ["Both", "Lock screen"] }];
const call = { type: "response_item", payload: { type: "function_call", name: "request_user_input_async", call_id: "call-1", arguments: JSON.stringify({ questions }) } };
const accepted = { type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: '{"accepted":true}' } };
const message = (text: string) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
let directory = "", executable = "";
async function transcript(rows: unknown[]) { await writeFile(state.file, rows.map(v => JSON.stringify(v)).join("\n") + "\n"); }
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "phren-questions-"));
  state.root = directory; state.file = path.join(directory, "rollout.jsonl"); state.session = target.session;
  executable = path.join(directory, "codex");
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--help')) console.log('--thread --message');
else fs.appendFileSync(${JSON.stringify(path.join(directory, "sent.jsonl"))}, JSON.stringify(process.argv.slice(2))+'\\n');
`, { mode: 0o700 });
  await transcript([call, accepted]);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("Codex async question replies", () => {
  it("keeps accepted questions pending but rejects already answered, failed and unknown calls", async () => {
    expect(await pendingAsyncQuestion(state.file, "call-1")).toEqual(questions);
    await expect(pendingAsyncQuestion(state.file, "other")).rejects.toThrow("no longer pending");
    await transcript([call, accepted, message("> Which screens?\n\nBoth")]);
    await expect(pendingAsyncQuestion(state.file, "call-1")).rejects.toThrow("no longer pending");
    await transcript([call, { ...accepted, payload: { ...accepted.payload, output: '{"accepted":false}' } }]);
    await expect(pendingAsyncQuestion(state.file, "call-1")).rejects.toThrow("no longer pending");
    await transcript([call]);
    await expect(pendingAsyncQuestion(state.file, "call-1")).rejects.toThrow("no longer pending");
  });
  it("discovers pending questions beyond the opening transcript page and keeps unrelated questions", async () => {
    const other = { ...call, payload: { ...call.payload, call_id: "call-2", arguments: JSON.stringify({ questions: [{ title: "Which provider?", options: ["Codex"] }] }) } };
    await transcript([call, accepted, ...Array.from({ length: 100 }, (_, i) => message(`More context ${i}`)), other,
      { ...accepted, payload: { ...accepted.payload, call_id: "call-2" } }, message("> Which screens?\n\nBoth")]);
    expect((await pendingAsyncQuestions(state.file)).map(p => p.id)).toEqual(["call-2"]);
    const snapshot = await new CodexQuestions(executable).pending(target);
    expect(snapshot).toMatchObject([{ toolUseId: "call-2", isAsync: true, questions: [{ question: "Which provider?", options: [{ label: "Codex" }] }] }]);
  });
  it("does not report an incomplete history scan as an empty pending set", async () => {
    const large = { type: "response_item", payload: { type: "function_call_output", call_id: "large", output: "x".repeat(8_388_608) } };
    await transcript([call, accepted, large]);
    await expect(pendingAsyncQuestions(state.file)).rejects.toThrow("too large to verify");
    // A newer exact call can still be answered without scanning older output.
    await transcript([large, call, accepted]);
    expect(await pendingAsyncQuestion(state.file, "call-1")).toEqual(questions);
  });
  it("reconstructs answers from trusted questions and validates choices and typed answers", () => {
    expect(questionReply(questions, [{ optionIndexes: [0] }])).toBe("> Which screens?\n\nBoth");
    expect(questionReply(questions, [{ optionIndexes: [], text: "In chat only" }])).toBe("> Which screens?\n\nIn chat only");
    for (const answers of [[], [{ optionIndexes: [5] }], [{ optionIndexes: [0], text: "Other" }], [{ optionIndexes: [] }]]) {
      expect(() => questionReply(questions, answers)).toThrow();
    }
    expect(() => questionReply(questions, [{ optionIndexes: [], text: "bad\u001binput" }])).toThrow();
  });
  it("delivers one quoted reply to the exact UUID without terminal input and prevents concurrent/restarted retries", async () => {
    const bridge = new CodexQuestions(executable);
    const body = { toolUseId: "call-1", answers: [{ optionIndexes: [0] }] };
    const results = await Promise.allSettled([bridge.answer(target, body), bridge.answer(target, body)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(JSON.parse((await readFile(path.join(directory, "sent.jsonl"), "utf8")).trim())).toEqual(["queue", "--thread", target.session, "--message", "> Which screens?\n\nBoth"]);
    await expect(new CodexQuestions(executable).answer(target, body)).rejects.toThrow("already submitted");
    expect(await new CodexQuestions(executable).pending(target)).toEqual([]);
  });
  it("keeps an unconfirmed question visible and never retries an ambiguous provider failure", async () => {
    await writeFile(executable, "#!/usr/bin/env node\nif (process.argv.includes('--help')) console.log('--thread --message'); else process.exit(1);\n", { mode: 0o700 });
    const bridge = new CodexQuestions(executable), body = { toolUseId: "call-1", answers: [{ optionIndexes: [0] }] };
    await expect(bridge.answer(target, body)).rejects.toThrow("did not confirm");
    expect(await bridge.pending(target)).toHaveLength(1);
    await expect(bridge.answer(target, body)).rejects.toThrow("already submitted");
  });
  it("does not send when fresh conversation identity changes or provider lacks the inbox command", async () => {
    state.session = "bbbbbbbb-1111-4111-8111-111111111111";
    await expect(new CodexQuestions(executable).answer(target, { toolUseId: "call-1", answers: [{ optionIndexes: [0] }] })).rejects.toThrow("conversation changed");
    await expect(readFile(path.join(directory, "sent.jsonl"))).rejects.toThrow();
    expect(await new CodexQuestions(path.join(directory, "missing-codex")).supported()).toBe(false);
  });

  it("finds a question Codex 0.155 delivers on an async agent message, until a quoting reply answers it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "phren-questions-"));
    const file = path.join(dir, "rollout.jsonl");
    const asked = { type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", id: "call_q1", content: [{ type: "Text", text: "Deploy as-is?" }],
      phase: "final_answer", delivery: "async", questions: [{ title: "Deploy as-is?", options: null }] } } };
    const shown = { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Deploy as-is?" }] } };
    await writeFile(file, [shown, asked].map(JSON.stringify).join("\n") + "\n");
    try {
      const pending = await pendingAsyncQuestions(file);
      expect(pending).toEqual([{ id: "call_q1", questions: [{ title: "Deploy as-is?" }] }]);
      expect(await pendingAsyncQuestion(file, "call_q1")).toEqual([{ title: "Deploy as-is?" }]);
      const reply = questionReply(pending[0].questions, [{ optionIndexes: [], text: "Yes, deploy" }]);
      expect(reply).toBe("> Deploy as-is?\n\nYes, deploy");
      await appendFile(file, JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: reply }] } }) + "\n");
      expect(await pendingAsyncQuestions(file)).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

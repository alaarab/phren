import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { appendFile, copyFile, mkdir, mkdtemp, realpath, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexQuestions, pendingAsyncQuestion, pendingAsyncQuestions, questionReply, serverQuestion, type ServedCodex } from "./questions.js";
import { formatQuestionReply, readableQuestionReply } from "./codex-question-reply.js";
import type { PendingServerRequest } from "./codex-app-server.js";
import type { CodexServerEntry } from "./codex-servers.js";

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
  // The fake codex is an extensionless shebang script, which Windows cannot execute.
  // Codex replies go through the Hook, which supports macOS and Linux only.
  it.skipIf(process.platform === "win32")("delivers one quoted reply to the exact UUID without terminal input and prevents concurrent/restarted retries", async () => {
    const bridge = new CodexQuestions(executable);
    const body = { toolUseId: "call-1", answers: [{ optionIndexes: [0] }] };
    const results = await Promise.allSettled([bridge.answer(target, body), bridge.answer(target, body)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(JSON.parse((await readFile(path.join(directory, "sent.jsonl"), "utf8")).trim())).toEqual(["queue", "--thread", target.session, "--message", "> Which screens?\n\nBoth"]);
    await expect(new CodexQuestions(executable).answer(target, body)).rejects.toThrow("already submitted");
    expect(await new CodexQuestions(executable).pending(target)).toEqual([]);
  });
  // The fake codex is an extensionless shebang script, which Windows cannot execute.
  // Codex replies go through the Hook, which supports macOS and Linux only.
  it.skipIf(process.platform === "win32")("keeps an unconfirmed question visible and never retries an ambiguous provider failure", async () => {
    await writeFile(executable, "#!/usr/bin/env node\nif (process.argv.includes('--help')) console.log('--thread --message'); else process.exit(1);\n", { mode: 0o700 });
    const bridge = new CodexQuestions(executable), body = { toolUseId: "call-1", answers: [{ optionIndexes: [0] }] };
    await expect(bridge.answer(target, body)).rejects.toThrow("did not confirm");
    expect(await bridge.pending(target)).toHaveLength(1);
    await expect(bridge.answer(target, body)).rejects.toThrow("already submitted");
  });
  // The fake codex is an extensionless shebang script, which Windows cannot execute.
  // Codex replies go through the Hook, which supports macOS and Linux only.
  it.skipIf(process.platform === "win32")("does not send when fresh conversation identity changes or provider lacks the inbox command", async () => {
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
  // Codex 0.155.1 as the Linux box wrote it: the request_user_input_async call,
  // the AgentMessage delivered async under the same id, then {accepted:true}.
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "codex", "0.155.1", "async-question.rollout.jsonl");
  const fixtureTitle = "For the report inventory, what does \u201cXYZ data\u201d mean, and which sources beyond A and B should I include?";
  it("counts a question Codex records as both a call and a delivered message once", async () => {
    await copyFile(fixture, state.file);
    expect(await pendingAsyncQuestions(state.file)).toEqual([{ id: "call_neutralQuestion0001", questions: [{ title: fixtureTitle }] }]);
    expect(await new CodexQuestions(executable).pending(target)).toEqual([{ toolUseId: "call_neutralQuestion0001", isAsync: true, submitted: false,
      questions: [{ question: fixtureTitle, options: [], kind: "text" }] }]);
  });
  // The fake codex is an extensionless shebang script, which Windows cannot execute.
  it.skipIf(process.platform === "win32")("answers the recorded free-text question with one quoted codex queue message", async () => {
    await copyFile(fixture, state.file);
    await new CodexQuestions(executable).answer(target, { toolUseId: "call_neutralQuestion0001", answers: [{ optionIndexes: [], text: "Only the two named sources" }] });
    expect(JSON.parse((await readFile(path.join(directory, "sent.jsonl"), "utf8")).trim())).toEqual(["queue", "--thread", target.session, "--message",
      `> ${fixtureTitle}\n\nOnly the two named sources`]);
    expect(await new CodexQuestions(executable).pending(target)).toEqual([]);
  });
  // phren's session wrapper at ~/.local/bin/codex runs phren's session-start
  // hook first, which outlasted the 5 s probe: the phone was told to answer
  // in the terminal. The Hook runs the binary the wrapper names instead.
  it.skipIf(process.platform === "win32")("probes and answers with the real codex behind phren's slow session wrapper", async () => {
    const bin = path.join(directory, "bin"), real = path.join(directory, "real");
    await mkdir(bin); await mkdir(real);
    await copyFile(executable, path.join(real, "codex"));
    await writeFile(path.join(bin, "codex"), `#!/bin/sh
set -u

REAL_BIN='${path.join(real, "codex")}'
if [ ! -x "$REAL_BIN" ]; then
  echo "phren wrapper error: real codex binary not executable: $REAL_BIN" >&2
  exit 127
fi
sleep 30
"$REAL_BIN" "$@"
`, { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("PHREN_CODEX_BINARY", "on");
    try {
      const started = Date.now(), bridge = new CodexQuestions();
      expect(await bridge.supported()).toBe(true);
      expect(Date.now() - started).toBeLessThan(4000);
      await copyFile(fixture, state.file);
      await bridge.answer(target, { toolUseId: "call_neutralQuestion0001", answers: [{ optionIndexes: [], text: "Yes" }] });
      expect(JSON.parse((await readFile(path.join(directory, "sent.jsonl"), "utf8")).trim())[0]).toBe("queue");
    } finally { vi.unstubAllEnvs(); }
  });
});

describe("Codex questions on the Hook's own app-server", () => {
  const entry = { id: "0123456789ab", threadId: target.session } as CodexServerEntry;
  function served(parked: PendingServerRequest[] = []) {
    const steered: string[] = [], extras: unknown[][] = [], answered: { requestId: unknown; result: unknown }[] = [];
    const codex: ServedCodex = {
      forTarget: where => where.pane === target.pane ? entry : undefined,
      steer: async (_entry, text, extra = []) => { steered.push(text); extras.push(extra); return { turnId: "turn-1" }; },
      questions: () => parked,
      answerQuestion: (_entry, requestId, result) => {
        const index = parked.findIndex(request => request.requestId === requestId);
        if (index < 0) return false;
        parked.splice(index, 1); answered.push({ requestId, result }); return true;
      },
    };
    return { codex, steered, extras, answered };
  }

  it("clears a question Codex's own reply answers and shows that reply as the question and answer", async () => {
    const reply = formatQuestionReply("call-1", [{ question: "Which screens?", answer: "Both" }]);
    expect(reply).toBe('<send_user_message_question_reply>\n[{"answer":"Both","question":"Which screens?","questionItemId":"[\\"request_user_input_async\\",\\"call-1\\",0]"}]\n</send_user_message_question_reply>');
    await transcript([call, accepted, message(reply)]);
    expect(await pendingAsyncQuestions(state.file)).toEqual([]);
    expect(readableQuestionReply(reply)).toBe("> Which screens?\n\nBoth");
    expect(readableQuestionReply("Both")).toBeUndefined();
    // Codex joins an answer's attached files into the same message.
    const attached = `${reply}\nAttached files on this computer:\n/u/shot.png\n<image name=[Image #1] path="/u/shot.png">\n</image>`;
    await transcript([call, accepted, message(attached)]);
    expect(await pendingAsyncQuestions(state.file)).toEqual([]);
  });

  it("answers an async question in the running turn, as Codex's TUI does, never through codex queue", async () => {
    const { codex, steered } = served();
    const bridge = new CodexQuestions(path.join(directory, "missing-codex"), codex);
    expect(bridge.availableFor(target)).toBe(true);
    await bridge.answer(target, { toolUseId: "call-1", answers: [{ optionIndexes: [], text: "Only the lock screen" }] });
    expect(steered).toEqual([formatQuestionReply("call-1", [{ question: "Which screens?", answer: "Only the lock screen" }])]);
    await expect(readFile(path.join(directory, "sent.jsonl"))).rejects.toThrow();
    await expect(bridge.answer(target, { toolUseId: "call-1", answers: [{ optionIndexes: [0] }] })).rejects.toThrow("already submitted");
    expect(steered).toHaveLength(1);
    expect(await bridge.pending(target)).toEqual([]);
  });

  it("shows a parked request_user_input as a card and answers the request itself", async () => {
    const asked: PendingServerRequest = { requestId: 7, method: "item/tool/requestUserInput", threadId: target.session, params: { threadId: target.session, turnId: "t", itemId: "i", isBlocking: true,
      questions: [{ id: "screens", header: "Screens", question: "Which screens?", options: [{ label: "Both", description: "" }, { label: "Lock screen", description: "" }] },
        { id: "note", header: "Note", question: "Anything else?", isOther: true, options: null }] } };
    const { codex, answered, steered } = served([asked]);
    const bridge = new CodexQuestions(path.join(directory, "missing-codex"), codex);
    const [card] = await bridge.pending(target);
    expect(card).toEqual({ toolUseId: "request:7", isAsync: true, submitted: false, questions: [
      { question: "Which screens?", options: [{ label: "Both" }, { label: "Lock screen" }] }, { question: "Anything else?", options: [], kind: "text" }] });
    await expect(bridge.answer(target, { toolUseId: "request:7", answers: [{ optionIndexes: [], text: "Neither" }, { optionIndexes: [], text: "No" }] })).rejects.toThrow("offered answers");
    await bridge.answer(target, { toolUseId: "request:7", answers: [{ optionIndexes: [1] }, { optionIndexes: [], text: "Ship it" }] });
    expect(answered).toEqual([{ requestId: 7, result: { answers: { screens: { answers: ["Lock screen"] }, note: { answers: ["Ship it"] } } } }]);
    expect(steered).toEqual([]);
    await expect(bridge.answer(target, { toolUseId: "request:7", answers: [{ optionIndexes: [0] }, { optionIndexes: [], text: "x" }] })).rejects.toThrow("no longer pending");
  });

  it("turns a form elicitation into questions and accepts it with typed values", () => {
    const shown = serverQuestion({ requestId: "e1", method: "mcpServer/elicitation/request", params: { serverName: "deploy", threadId: target.session, mode: "form", message: "Deploy settings",
      requestedSchema: { type: "object", properties: {
        confirm: { type: "boolean", title: "Deploy now?" },
        region: { type: "string", title: "Region", oneOf: [{ const: "us-east-1", title: "US East" }, { const: "eu-west-1", title: "EU West" }] },
        replicas: { type: "integer", title: "Replicas" },
        label: { type: "string" } } } } });
    expect(shown?.questions).toEqual([{ title: "Deploy settings\n\nDeploy now?", options: ["Yes", "No"] }, { title: "Region", options: ["US East", "EU West"] },
      { title: "Replicas" }, { title: "label" }]);
    expect(shown?.result(["Yes", "EU West", "3", "blue"])).toEqual({ action: "accept", content: { confirm: true, region: "eu-west-1", replicas: 3, label: "blue" } });
    expect(() => shown?.result(["Yes", "EU West", "2.5", "blue"])).toThrow("number");
  });

  it("leaves secret inputs, URL elicitations and multi-select fields in the pane", () => {
    expect(serverQuestion({ requestId: 1, method: "item/tool/requestUserInput", params: { questions: [{ id: "k", header: "Key", question: "API key?", isSecret: true }] } })).toBeUndefined();
    expect(serverQuestion({ requestId: 2, method: "mcpServer/elicitation/request", params: { mode: "url", message: "Sign in", url: "https://example.com", elicitationId: "x" } })).toBeUndefined();
    expect(serverQuestion({ requestId: 3, method: "mcpServer/elicitation/request", params: { mode: "form", message: "Pick", requestedSchema: { properties: { tags: { type: "array", items: { enum: ["a"] } } } } } })).toBeUndefined();
  });

  async function uploads(...names: string[]): Promise<string[]> {
    const folder = path.join(directory, "uploads", target.session);
    await mkdir(folder, { recursive: true });
    return Promise.all(names.map(async name => { const file = path.join(folder, name); await writeFile(file, "x"); return realpath(file); }));
  }

  it("sends an async answer's attached pictures as images and names every file", async () => {
    const [picture, notes] = await uploads("1-shot.png", "2-notes.txt");
    const { codex, steered, extras } = served();
    await new CodexQuestions(path.join(directory, "missing-codex"), codex).answer(target, { toolUseId: "call-1", answers: [{ optionIndexes: [0] }], attachments: [picture, notes] });
    expect(steered).toEqual([formatQuestionReply("call-1", [{ question: "Which screens?", answer: "Both" }])]);
    expect(extras[0]).toEqual([{ type: "text", text: `Attached files on this computer:\n${picture}\n${notes}`, text_elements: [] }, { type: "localImage", path: picture }]);
  });

  it("adds attachments to a blocking answer and to a codex queue reply, and refuses others", async () => {
    const [picture] = await uploads("1-shot.png");
    const asked: PendingServerRequest = { requestId: 9, method: "item/tool/requestUserInput", threadId: target.session, params: { questions: [{ id: "why", header: "Why", question: "What went wrong?", isOther: true, options: null }] } };
    const { codex, answered } = served([asked]);
    await new CodexQuestions(path.join(directory, "missing-codex"), codex).answer(target, { toolUseId: "request:9", answers: [{ optionIndexes: [], text: "See the screenshot" }], attachments: [picture] });
    expect(answered[0].result).toEqual({ answers: { why: { answers: [`See the screenshot\n\nAttached files on this computer:\n${picture}`] } } });

    const outside = path.join(directory, "elsewhere.png"); await writeFile(outside, "x");
    await expect(new CodexQuestions(path.join(directory, "missing-codex"), served().codex).answer(target, { toolUseId: "call-1", answers: [{ optionIndexes: [0] }], attachments: [outside] })).rejects.toThrow("not one of this conversation's uploads");
    const form: PendingServerRequest = { requestId: "e", method: "mcpServer/elicitation/request", params: { mode: "form", message: "Pick", requestedSchema: { properties: { name: { type: "string" } } } } };
    await expect(new CodexQuestions(path.join(directory, "missing-codex"), served([form]).codex).answer(target, { toolUseId: 'request:"e"', answers: [{ optionIndexes: [], text: "x" }], attachments: [picture] })).rejects.toThrow("takes no attachments");
  });

  it.skipIf(process.platform === "win32")("names attached files under a codex queue reply for a pane not on the Hook's server", async () => {
    const [picture] = await uploads("1-shot.png");
    await new CodexQuestions(executable).answer(target, { toolUseId: "call-1", answers: [{ optionIndexes: [0] }], attachments: [picture] });
    expect(JSON.parse((await readFile(path.join(directory, "sent.jsonl"), "utf8")).trim()).at(-1)).toBe(`> Which screens?\n\nBoth\n\nAttached files on this computer:\n${picture}`);
  });
});

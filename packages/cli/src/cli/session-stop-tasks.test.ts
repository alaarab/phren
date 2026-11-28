import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initTestPhrenRoot, makeTempDir } from "../test-helpers.js";
import { recordSessionTask, sessionLedgerPath } from "../task/session-tasks.js";
import { taskStopDecision, writeTaskStopDecision } from "./session-stop-tasks.js";

const SESSION = "session-1";
const BID = "1234abcd";

let tmp: ReturnType<typeof makeTempDir>;

function writeTasks(active = "", queue = "", done = ""): void {
  const projectDir = path.join(tmp.path, "demo");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "tasks.md"),
    `# demo tasks\n\n## Active\n\n${active}\n## Queue\n\n${queue}\n## Done\n\n${done}\n`);
}

function record(bid = BID): void {
  recordSessionTask(tmp.path, SESSION, { store: tmp.path, project: "demo", stableId: bid });
}

function decide(overrides: Partial<Parameters<typeof taskStopDecision>[0]> = {}) {
  return taskStopDecision({ phrenPath: tmp.path, payload: { session_id: SESSION }, tool: "claude", env: {}, ...overrides });
}

beforeEach(() => {
  tmp = makeTempDir("session-stop-tasks-");
  initTestPhrenRoot(tmp.path);
});
afterEach(() => tmp.cleanup());

describe("taskStopDecision", () => {
  it("no longer blocks on an Active task the session recorded", () => {
    writeTasks(`- [ ] Implement parser <!-- bid:${BID} -->`);
    record();
    expect(decide()).toBeUndefined();
  });

  it.each([
    { name: "Done", active: "", queue: "", done: `- [x] Implement parser <!-- bid:${BID} -->` },
    { name: "Queue", active: "", queue: `- [ ] Implement parser <!-- bid:${BID} -->`, done: "" },
    { name: "parked", active: `- [ ] Implement parser <!-- bid:${BID} -->\n  Context: Blocker: upstream API; Next: retry once it ships`, queue: "", done: "" },
  ])("does not block a $name task", ({ active, queue, done }) => {
    writeTasks(active, queue, done);
    record();
    expect(decide()).toBeUndefined();
  });

  it("does not block while the agent is already continuing from a Stop hook", () => {
    writeTasks(`- [ ] Implement parser <!-- bid:${BID} -->`);
    record();
    expect(decide({ payload: { session_id: SESSION, stop_hook_active: true } })).toBeUndefined();
  });

  it("does not block harnesses that cannot block a stop", () => {
    writeTasks(`- [ ] Implement parser <!-- bid:${BID} -->`);
    record();
    expect(decide({ tool: "copilot" })).toBeUndefined();
  });

  it("can be turned off", () => {
    writeTasks(`- [ ] Implement parser <!-- bid:${BID} -->`);
    record();
    expect(decide({ env: { PHREN_TASK_STOP_CHECK: "off" } })).toBeUndefined();
  });

  it("does not block without a session id", () => {
    writeTasks(`- [ ] Implement parser <!-- bid:${BID} -->`);
    record();
    expect(decide({ payload: {}, env: {} })).toBeUndefined();
  });

  it("treats a corrupt ledger as nothing to settle", () => {
    writeTasks(`- [ ] Implement parser <!-- bid:${BID} -->`);
    record();
    fs.writeFileSync(sessionLedgerPath(tmp.path, SESSION)!, "{not json");
    expect(() => decide()).not.toThrow();
    expect(decide()).toBeUndefined();
  });
});

describe("writeTaskStopDecision", () => {
  it("writes one JSON block decision", () => {
    const writes: string[] = [];
    writeTaskStopDecision({ decision: "block", reason: "settle the task" }, {
      write: (chunk: string) => { writes.push(chunk); return true; },
    });
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!)).toEqual({ decision: "block", reason: "settle the task" });
  });
});

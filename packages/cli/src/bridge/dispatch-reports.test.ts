import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DispatchConnections, type DispatchStream } from "./dispatch-connections.js";
import { ClaudeBackgroundInbox } from "./dispatch-outbox.js";
import { DispatchReports, allowlistedReportEnvelope, reportBackgroundEvent, reportEnvelope, type DispatchWatch, type FinalDispatchReport } from "./dispatch-reports.js";

const localComputer = { id: "aaaaaaaa-1111-4111-8111-111111111111", name: "Desk" };
const remoteComputer = { id: "bbbbbbbb-2222-4222-8222-222222222222", name: "Linuxbox" };
const parent = { server: "default", workspace: "pw", tab: "pt", pane: "pp", source: "claude" as const,
  session: "cccccccc-3333-4333-8333-333333333333" };
const remote = { server: "default", workspace: "rw", tab: "rt", pane: "rp", source: "claude" as const,
  session: "dddddddd-4444-4444-8444-444444444444" };

function state(): DispatchWatch {
  const stamp = new Date().toISOString();
  return { version: 1, dispatchId: "eeeeeeee-5555-4555-8555-555555555555", computer: "Linuxbox", label: "Parser checks",
    harness: "claude", remoteComputer, parent: { provider: "claude", session: parent.session, computer: localComputer.id },
    parentTarget: parent, target: remote, cursor: -1, lastAssistant: "", reportState: "watching",
    createdAt: stamp, updatedAt: stamp, attempts: 0 };
}

describe("dispatch reports", () => {
  let root: string, parentLive: boolean, reports: DispatchReports, delivered: string[];
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "phren-reports-")); parentLive = true; delivered = [];
    reports = new DispatchReports({ root, computer: localComputer, validateParent: async () => parentLive,
      peers: async () => [], inboxes: { claude: new ClaudeBackgroundInbox(async (_target, envelope) => { delivered.push(envelope); return "delivered"; }) } });
  });
  afterEach(async () => { await reports.close(); await rm(root, { recursive: true, force: true }); });

  it("completes only on provider terminal turns, not tools, questions, or idle", async () => {
    const watch = state();
    const nonterminal = [
      { type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "Still working" }] } },
      { type: "assistant", message: { role: "assistant", stop_reason: "pause_turn", content: [{ type: "tool_use", name: "AskUserQuestion" }] } },
      { type: "system", subtype: "idle" },
    ];
    expect(await reports.transcriptFrame(watch, remote, { totalLines: 3,
      entries: nonterminal.map((raw, line) => ({ line, raw })) })).toBe(false);
    expect(watch.reportState).toBe("watching"); expect(delivered).toEqual([]);
    expect(await reports.transcriptFrame(watch, remote, { totalLines: 4, entries: [{ line: 3,
      raw: { type: "assistant", uuid: "turn-final", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done" }] } } }] })).toBe(true);
    expect(watch.reportState).toBe("completed"); expect(delivered).toHaveLength(1);
  });

  it("recognizes Codex completed turns and OpenCode end_turn without treating nearby steps as final", async () => {
    const codex = state(), codexTarget = { ...remote, source: "codex" as const };
    codex.harness = "codex"; codex.target = codexTarget;
    await reports.transcriptFrame(codex, codexTarget, { totalLines: 3, entries: [
      { line: 0, raw: { type: "response_item", payload: { type: "message", role: "assistant", channel: "final",
        content: [{ type: "output_text", text: "Codex result" }] } } },
      { line: 1, raw: { type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", questions: [{}] } } } },
      { line: 2, raw: { type: "event_msg", payload: { type: "task_complete" } } },
    ] });
    expect(codex.report?.text).toBe("Codex result");

    const opencode = state(), opencodeTarget = { ...remote, source: "opencode" as const, session: "ses_fixture" };
    opencode.dispatchId = "ffffffff-6666-4666-8666-666666666666"; opencode.harness = "opencode"; opencode.target = opencodeTarget;
    await reports.transcriptFrame(opencode, opencodeTarget, { totalLines: 2, entries: [
      { line: 0, raw: { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "OpenCode result" }] } } } },
      { line: 1, raw: { type: "system", data: { message: { role: "assistant", content: [{ type: "text", text: "Step finished: end_turn" }] } } } },
    ] });
    expect(opencode.report?.text).toBe("OpenCode result");
    expect(opencode.reportState).toBe("completed");
  });

  it("bounds UTF-8 bytes, excludes reasoning, and XML-escapes the Background envelope", async () => {
    const watch = state(), text = "<script>&public\0 " + "🙂".repeat(1001);
    await reports.transcriptFrame(watch, remote, { totalLines: 1, entries: [{ line: 0, raw: { type: "assistant", uuid: "final",
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "SECRET" }, { type: "text", text }] } } }] });
    expect(Buffer.byteLength(watch.report!.text)).toBeLessThanOrEqual(4000);
    expect(watch.report!.truncated).toBe(true); expect(watch.report!.text).not.toContain("SECRET");
    expect(delivered[0]).not.toContain("<script>"); expect(delivered[0]).not.toContain("\0"); expect(delivered[0]).not.toContain("SECRET");
    expect(allowlistedReportEnvelope(delivered[0])).toBe(delivered[0]);
    expect(reportBackgroundEvent(delivered[0], "now")).toMatchObject({ type: "system", phrenBackground: true,
      message: { role: "user", content: delivered[0] } });
  });

  it("deduplicates repeated backlogs and recovers from a truncated stream", async () => {
    const watch = state(); watch.cursor = 50; watch.lastAssistant = "stale";
    const frame = { type: "backlog", reset: true, totalLines: 2, entries: [
      { line: 0, raw: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Fresh result" }] } } },
      { line: 1, raw: { type: "assistant", uuid: "fresh", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Fresh result" }] } } },
    ] };
    expect(await reports.transcriptFrame(watch, remote, frame)).toBe(true);
    expect(watch.report?.text).toBe("Fresh result");
    await reports.transcriptFrame(watch, remote, { ...frame, totalLines: 3,
      entries: [{ ...frame.entries[1], line: 2 }] });
    expect(delivered).toHaveLength(1);
  });

  it("retains a report when its parent conversation was replaced", async () => {
    const watch = state(); parentLive = false;
    await reports.transcriptFrame(watch, remote, { totalLines: 1, entries: [{ line: 0, raw: { type: "assistant", uuid: "final",
      message: { role: "assistant", stop_reason: "end_turn", content: "Review ready" } } }] });
    expect(watch.reportState).toBe("reportPending"); expect(watch.report?.text).toBe("Review ready"); expect(delivered).toEqual([]);
  });

  it("reports reportPending when the harness has no exact-session inbox", async () => {
    await reports.close();
    reports = new DispatchReports({ root, computer: localComputer, validateParent: async () => true, peers: async () => [] });
    const watch = state();
    await reports.transcriptFrame(watch, remote, { totalLines: 1, entries: [{ line: 0, raw: { type: "assistant", uuid: "final",
      message: { role: "assistant", stop_reason: "end_turn", content: "Review ready" } } }] });
    expect(watch.reportState).toBe("reportPending"); expect(watch.error).toContain("no safe background inbox");
  });

  it("projects inert Claude and Codex inbox fixtures as the same Background row", () => {
    const report: FinalDispatchReport = { dispatchId: state().dispatchId, turnId: "f".repeat(32), text: "Checks returned; verification pending.", truncated: false,
      createdAt: new Date().toISOString(), transcript: { computer: remoteComputer, target: remote, line: 9, turnId: "f".repeat(32) },
      claims: { tests: "unknown", merge: "unknown", integration: "unknown" } };
    const envelope = reportEnvelope(report, "Linuxbox");
    const claude = reportBackgroundEvent(envelope, "claude-time"), codex = reportBackgroundEvent(envelope, "codex-time");
    expect(claude).toMatchObject({ type: "system", phrenBackground: true });
    expect(codex).toMatchObject({ type: "system", phrenBackground: true });
    expect((claude!.message as { content: string }).content).toBe((codex!.message as { content: string }).content);
  });

  it("extends dispatch status from its persisted report record", async () => {
    const watch = state();
    await reports.transcriptFrame(watch, remote, { totalLines: 1, entries: [{ line: 0, raw: { type: "assistant", uuid: "final",
      message: { role: "assistant", stop_reason: "end_turn", content: "Status result" } } }] });
    const [status] = await reports.status([{ id: watch.dispatchId, state: "accepted" }]);
    expect(status).toMatchObject({ reportState: "completed", report: { text: "Status result",
      claims: { tests: "unknown", merge: "unknown", integration: "unknown" } } });
  });

  it("restores and closes a persisted watch without relaunching its worker", async () => {
    const receipt = { id: state().dispatchId, computer: "Linuxbox", label: "Parser checks", harness: "claude", state: "accepted",
      target: remote, remoteComputer, parent: { provider: "claude", session: parent.session, computer: localComputer.id } };
    await reports.watch(receipt, parent);
    expect((await reports.status([{ id: receipt.id }]))[0]).toMatchObject({ reportState: "watching" });
    await reports.close();
    reports = new DispatchReports({ root, computer: localComputer, validateParent: async () => false, peers: async () => [] });
    await reports.restore();
    expect((await reports.status([{ id: receipt.id }]))[0]).toMatchObject({ reportState: "watching" });
  });

  it("reconnects a renamed peer by immutable computer identity", async () => {
    await reports.close();
    const opened: Array<{ peer: string; route: string }> = [];
    const connections = new DispatchConnections(async (peer, route): Promise<DispatchStream> => {
      let finish!: () => void;
      const closed = new Promise<Error | undefined>(resolve => { finish = () => resolve(undefined); });
      opened.push({ peer: peer.name, route }); return { closed, close: finish };
    });
    reports = new DispatchReports({ root, computer: localComputer, validateParent: async () => true,
      peers: async () => [{ name: "Desk", address: "desk.example", username: "sam", port: 22, hostKey: "fixture", server: "default" }],
      request: async (_peer, route) => route === "/v1/health" ? { computer: remoteComputer } : {}, connections });
    const receipt = { id: state().dispatchId, computer: "Linuxbox", label: "Parser checks", harness: "claude", state: "accepted",
      target: remote, remoteComputer, parent: { provider: "claude", session: parent.session, computer: localComputer.id } };
    await reports.watch(receipt, parent);
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    expect(opened.every(value => value.peer === "Desk")).toBe(true);
    expect(opened.map(value => value.route).sort()).toEqual(expect.arrayContaining([expect.stringContaining("/v1/status?"), expect.stringContaining("/v1/transcripts?")]));
  });

  it("recovers a receipt when restart happened before its watch was persisted", async () => {
    await reports.close();
    const receipt = { id: state().dispatchId, computer: "Linuxbox", label: "Parser checks", harness: "claude", state: "sending",
      target: remote, remoteComputer, parent: { provider: "claude", session: parent.session, computer: localComputer.id }, parentTarget: parent };
    await mkdir(path.join(root, "dispatches"), { recursive: true });
    await writeFile(path.join(root, `dispatches/${receipt.id}.json`), JSON.stringify(receipt));
    reports = new DispatchReports({ root, computer: localComputer, validateParent: async () => false, peers: async () => [] });
    await reports.restore();
    expect((await reports.status([{ id: receipt.id }]))[0]).toMatchObject({ reportState: "watching" });
  });
});

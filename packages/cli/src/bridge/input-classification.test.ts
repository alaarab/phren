import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TranscriptReader } from "./transcripts.js";

const monitor = `<task-notification>
<task-id>bru2vhgmb</task-id>
<summary>Monitor event: "Worker exits (fixes, reviews, spike)"</summary>
<event>review-bug-loginlink exited: 0</event>
</task-notification>`;

describe("notification rows through the real transcript reader", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

  async function read(rows: unknown[]) {
    const root = await mkdtemp(path.join(tmpdir(), "phren-classify-"));
    roots.push(root);
    const file = path.join(root, "session.jsonl");
    await writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const page = await new TranscriptReader(file, "claude").read();
    return page.entries.map(entry => entry.raw);
  }

  // The spec's reconstructed rows: owner prompt, tool call, Monitor notification.
  const owner = { type: "user", uuid: "u1", timestamp: "2026-11-01T15:00:00.000Z", message: { role: "user", content: "Review the login link" } };
  const call = { type: "assistant", uuid: "a1", timestamp: "2026-11-01T15:00:01.000Z",
    message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "read reviews" } }], stop_reason: "tool_use" } };
  const notice = { type: "user", uuid: "n1", timestamp: "2026-11-01T15:00:02.000Z", origin: { kind: "task-notification" },
    message: { role: "user", content: monitor } };

  it("keeps the owner prompt and never exports the notification's text", async () => {
    const rows = await read([owner, call, notice]);
    expect(rows).toContainEqual({ type: "user", uuid: "u1", timestamp: owner.timestamp, message: { role: "user", content: "Review the login link" } });
    expect(JSON.stringify(rows)).not.toContain("Monitor event");
  });

  it("exports a completed task notification only as its public envelope", async () => {
    const completed = { ...notice, message: { role: "user", content: `<task-notification>
<task-id>bhook189</task-id>
<tool-use-id>toolu_011jM1</tool-use-id>
<status>completed</status>
<summary>Background command "Run the suite" completed (exit code 0)</summary>
<result>PRIVATE OUTPUT</result>
</task-notification>` } };
    const rows = await read([owner, completed]);
    expect(rows).toContainEqual({ type: "system", phrenBackground: true, timestamp: completed.timestamp, uuid: completed.uuid,
      message: { role: "user", content: `<task-notification>
<task-id>bhook189</task-id>
<tool-use-id>toolu_011jM1</tool-use-id>
<status>completed</status>
<summary>Background command "Run the suite" completed (exit code 0)</summary>
</task-notification>` } });
    expect(JSON.stringify(rows)).not.toContain("PRIVATE OUTPUT");
  });

  it("hides the supplied system-notification preamble and a system-reminder wrapper stays a notice", async () => {
    const system = { ...notice, uuid: "n2", origin: undefined,
      message: { role: "user", content: "[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event" } };
    const wrappedNotice = `<task-notification>
<task-id>bhook189</task-id>
<tool-use-id>toolu_1</tool-use-id>
<status>completed</status>
</task-notification>`;
    const wrapped = { ...notice, uuid: "n3", origin: undefined,
      message: { role: "user", content: `<system-reminder>\n${wrappedNotice}\n</system-reminder>` } };
    const rows = await read([owner, system, wrapped]);
    expect(rows.some(row => row.uuid === "n2")).toBe(false);
    expect(rows.find(row => row.uuid === "n3")).toMatchObject({ type: "system", phrenBackground: true });
  });
  it.each([
    { origin: { kind: "teammate-message" } }, { origin: { kind: "auto-continuation" } },
    { origin: { kind: "scheduled" } }, { isMeta: true },
  ])("does not export automatic user input as an owner prompt: %j", async facts => {
    const rows = await read([owner, { type: "user", uuid: "automatic", timestamp: "2026-11-01T15:00:02.000Z", ...facts,
      message: { role: "user", content: "PRIVATE automatic instructions" } }]);
    expect(rows.filter(row => row.type === "user")).toEqual([owner]);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE");
  });
  it.each([
    "How does the <task-notification> envelope work?", "Monitor event: explain this phrase",
    "<command-message>review</command-message>\n<command-name>/review</command-name>", "Do a pull",
  ])("keeps genuine owner text: %s", async text => {
    const rows = await read([{ ...owner, origin: { kind: "human" }, commandMode: "queued", message: { role: "user", content: text } }]);
    expect(rows[0]).toMatchObject({ type: "user", timestamp: owner.timestamp, message: { content: text } });
  });

});

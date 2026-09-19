import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fanoutChildren, visibleOpenCodeRunEvent } from "./fanouts.js";

const parent = "aaaaaaaa-1111-4111-8111-111111111111";
let roots: string[] = [];

async function fixture(id: string, overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "phren-fanouts-")); roots.push(root);
  const directory = path.join(root, ".runtime/agent-fanouts", id); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "events.jsonl"), '{"type":"text"}\n');
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id, parent: { provider: "codex", session: parent }, provider: "opencode",
    taskLabel: "Review bridge", cwd: "/repo", worktree: "/repo-wt", model: "openrouter/deepseek/deepseek-v4.1-flash",
    eventLog: "events.jsonl", createdAt: "2026-09-19T19:00:00.000Z", startedAt: "2026-09-19T19:00:01.000Z",
    updatedAt: "2026-09-19T19:00:02.000Z", status: "running", ...overrides,
  }));
  return { root, directory, env: { PHREN_PATH: root } };
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("fan-out manifests", () => {
  it("returns only jobs bound to the validated parent and hides local metadata", async () => {
    const { env } = await fixture("job-1");
    const found = await fanoutChildren("codex", parent, env);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ provider: "opencode", path: "Review bridge", state: "running", children: [] });
    expect(found[0].id).toMatch(/^[a-f0-9]{32}$/);
    expect(JSON.stringify({ ...found[0], transcript: undefined, session: undefined })).not.toContain("/repo");
    expect(await fanoutChildren("codex", "bbbbbbbb-2222-4222-8222-222222222222", env)).toEqual([]);
  });

  it("rejects event-log symlinks and mismatched directory IDs", async () => {
    const first = await fixture("job-link");
    const outside = path.join(first.root, "outside.jsonl"); await writeFile(outside, "secret");
    await rm(path.join(first.directory, "events.jsonl")); await symlink(outside, path.join(first.directory, "events.jsonl"));
    expect(await fanoutChildren("codex", parent, first.env)).toEqual([]);
    const second = await fixture("job-name", { id: "different" });
    expect(await fanoutChildren("codex", parent, second.env)).toEqual([]);
  });

  it("redacts OpenCode reasoning, arguments, outputs, costs, and snapshots", () => {
    const secret = "sk-secret";
    expect(visibleOpenCodeRunEvent({ type: "text", timestamp: 1_789_845_268_396, part: { type: "text", text: "Visible", reasoning: secret } }))
      .toMatchObject({ type: "assistant/message", data: { message: { content: [{ text: "Visible" }] } } });
    const tool = visibleOpenCodeRunEvent({ type: "tool_use", part: { type: "tool", tool: "bash", callID: "call-1",
      state: { status: "completed", input: { token: secret }, output: secret }, snapshot: secret } });
    expect(tool).toMatchObject({ data: { message: { content: [{ name: "bash", input: {}, phrenStatus: "completed" }] } } });
    expect(JSON.stringify(tool)).not.toContain(secret);
    expect(visibleOpenCodeRunEvent({ type: "step_start", part: { reasoning: secret } })).toBeUndefined();
  });
});

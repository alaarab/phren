import { mkdtempSync, rmSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { directChildAgents } from "./transcript-codex.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const started = (child: string) => JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: {
  type: "SubAgentActivity", id: "spawn-1", kind: "started", agent_thread_id: child, agent_path: "/root/reviewer" } } });
const filler = (text: string) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });

describe("codex child relations", () => {
  it("rescans a rollout rewritten in place that grew past its cached size", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "phren-codex-children-")); dirs.push(dir);
    const file = path.join(dir, "rollout.jsonl");
    const child = "cccccccc-2222-4222-8222-222222222222";
    // A first conversation, read and cached.
    await writeFile(file, [filler("an earlier, much longer conversation ".repeat(8)), filler("second row")].join("\n") + "\n");
    expect(await directChildAgents(file)).toEqual([]);
    // Rewritten in place (same inode) with shorter rows, then appended past
    // the old size: not an append of the cached content.
    await writeFile(file, filler("First message") + "\n");
    await appendFile(file, started(child) + "\n" + filler("padding ".repeat(60)) + "\n");
    expect(await directChildAgents(file)).toMatchObject([{ session: child, callId: "spawn-1", state: "running" }]);
  });

  it("still reads only the new rows of a true append", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "phren-codex-children-")); dirs.push(dir);
    const file = path.join(dir, "rollout.jsonl");
    const child = "dddddddd-3333-4333-8333-333333333333";
    await writeFile(file, filler("First message") + "\n");
    expect(await directChildAgents(file)).toEqual([]);
    await appendFile(file, started(child) + "\n");
    expect(await directChildAgents(file)).toMatchObject([{ session: child, state: "running" }]);
  });
});

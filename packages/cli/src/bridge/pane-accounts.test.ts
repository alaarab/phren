import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nativeClaudeTranscript } from "./fanouts.js";
import { notePaneTranscript, paneAccount, paneAccountKey, recordPaneAccount } from "./pane-accounts.js";
import { transcriptAccount, transcriptPath } from "./transcripts.js";

const session = "bbbbbbbb-1111-4111-8111-111111111111";
const shared = "cccccccc-1111-4111-8111-111111111111";
let home: string;
const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };

async function transcript(dir: string, id: string) {
  const folder = path.join(home, dir, "projects", "-repo"); await mkdir(folder, { recursive: true });
  const file = path.join(folder, `${id}.jsonl`); await writeFile(file, "{}\n");
  return file;
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "phren-accounts-"));
  home = await (await import("node:fs/promises")).realpath(home);
  process.env.HOME = home; delete process.env.CLAUDE_CONFIG_DIR;
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await mkdir(path.join(home, ".claude-work"), { recursive: true });
  await writeFile(path.join(home, ".claude-work", ".claude.json"), "{}");
});
afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  await rm(home, { recursive: true, force: true });
});

describe("Claude transcripts across accounts", () => {
  it("finds a session in a second home and names its account", async () => {
    const file = await transcript(".claude-work", session);
    expect(await transcriptPath("claude", session)).toBe(file);
    expect(transcriptAccount(file)).toMatchObject({ id: "work", label: "Work" });
    expect(await nativeClaudeTranscript(file, session)).toBe(file);
  });

  it("treats a session id in two homes as ambiguous unless the pane's account is known", async () => {
    await transcript(".claude", shared);
    const work = await transcript(".claude-work", shared);
    await expect(transcriptPath("claude", shared)).rejects.toThrow("not available");
    expect(await transcriptPath("claude", shared, "work")).toBe(work);
  });
});

describe("a pane's account", () => {
  it("comes from the transcript path, else the recorded launch", async () => {
    const key = paneAccountKey("default", "w1:p1");
    expect(paneAccount(key, "t1")).toBeUndefined();
    recordPaneAccount(key, "work", "t1");
    expect(paneAccount(key, "t1")).toMatchObject({ id: "work" });
    notePaneTranscript(key, path.join(home, ".claude", "projects", "-repo", `${session}.jsonl`), "t1");
    expect(paneAccount(key, "t1")).toMatchObject({ id: "default", label: "Claude" });
    // A new terminal in the same pane id forgets it.
    expect(paneAccount(key, "t2")).toBeUndefined();
  });
});

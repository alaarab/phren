import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fanoutChildren } from "../bridge/fanouts.js";
import { publicChildAgents } from "../bridge/transcripts.js";
import { visibleClaudeEvent } from "../bridge/transcript-claude.js";
import { createJob, readJob, writeManifest } from "../fanout/launcher.js";
import { finishUnmanagedClaude, registerUnmanagedClaude } from "./claude-unmanaged.js";

const parent = "aaaaaaaa-1111-4111-8111-111111111111";
const worker = "bbbbbbbb-2222-4222-8222-222222222222";
let temp: { path: string; cleanup: () => void };
let store: string, transcript: string;

beforeEach(() => {
  const scratch = path.join(process.cwd(), ".scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "claude-unmanaged-"));
  temp = { path: root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  vi.stubEnv("HOME", temp.path);
  // os.homedir reads USERPROFILE on Windows; keep the native transcript
  // boundary in the same isolated fixture on every CI platform.
  vi.stubEnv("USERPROFILE", temp.path);
  store = path.join(temp.path, ".phren");
  fs.mkdirSync(store);
  const project = path.join(temp.path, ".claude", "projects", "-repo");
  fs.mkdirSync(project, { recursive: true });
  transcript = path.join(project, `${worker}.jsonl`);
  fs.writeFileSync(transcript, JSON.stringify({ type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "Native reply" }] } }) + "\n");
});
afterEach(() => { vi.unstubAllEnvs(); temp.cleanup(); });

const payload = () => ({ session_id: worker, transcript_path: transcript, cwd: path.dirname(store) });
const env = () => ({ CODEX_THREAD_ID: parent, CLAUDE_CODE_ENTRYPOINT: "sdk-cli" });

describe("unmanaged Claude print workers", () => {
  it("registers a headless hook session under its Codex launcher and reads Claude's native transcript", async () => {
    expect(registerUnmanagedClaude(payload(), store, temp.path, env(), { pid: process.pid, headless: false })).toBe(true);
    const manifest = readJob(store, `claude-unmanaged-${worker}`);
    expect(manifest).toMatchObject({ provider: "claude", session: worker, parent: { provider: "codex", session: parent },
      nativeTranscript: transcript, unmanagedPid: process.pid, status: "running" });
    const [child] = await fanoutChildren("codex", parent, { PHREN_PATH: store });
    expect(child).toMatchObject({ provider: "claude", state: "running", transcript, session: worker });
    const [line] = fs.readFileSync(child.transcript, "utf8").trim().split("\n");
    expect(visibleClaudeEvent(JSON.parse(line))).toMatchObject({ message: { content: [{ text: "Native reply" }] } });
  });

  it("does not duplicate a wrapper job, even when its environment marker is missing", async () => {
    expect(registerUnmanagedClaude(payload(), store, temp.path, { ...env(), PHREN_FANOUT_JOB: "wrapped" }, { pid: process.pid, headless: true })).toBe(false);
    expect(fs.existsSync(path.join(store, ".runtime", "agent-fanouts"))).toBe(false);
    const wrapped = createJob({ store, provider: "claude", model: "haiku", label: "wrapped", worktree: temp.path,
      prompt: "review", reason: "explicit" }, { CODEX_THREAD_ID: parent }, () => "codex");
    writeManifest(wrapped.job, { ...wrapped.manifest, session: worker });
    expect(registerUnmanagedClaude(payload(), store, temp.path, env(), { pid: process.pid, headless: true })).toBe(true);
    expect(fs.readdirSync(path.join(store, ".runtime", "agent-fanouts"))).toEqual([wrapped.manifest.id]);
  });

  it("marks Stop as finished and reads a stale live status as gone", async () => {
    registerUnmanagedClaude(payload(), store, temp.path, env(), { pid: 99_999_999, headless: true });
    const gone = (await fanoutChildren("codex", parent, { PHREN_PATH: store }))[0];
    expect(gone).toMatchObject({ state: "gone", reason: "gone: worker process exited" });
    expect(publicChildAgents([gone])[0]).toMatchObject({ state: "completed", failed: true, reason: "gone: worker process exited" });
    expect(finishUnmanagedClaude(payload(), store)).toBe(true);
    expect(readJob(store, `claude-unmanaged-${worker}`)).toMatchObject({ status: "completed", exitCode: 0 });
    expect(fs.readFileSync(path.join(store, ".runtime", "agent-fanouts", `claude-unmanaged-${worker}`, "exit.txt"), "utf8")).toBe("0\n");
    expect((await fanoutChildren("codex", parent, { PHREN_PATH: store }))[0].state).toBe("completed");
  });

  it("binds a bare Claude child to an inherited Claude parent session", async () => {
    expect(registerUnmanagedClaude(payload(), store, temp.path,
      { CLAUDE_CODE_SESSION_ID: parent, CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, { pid: process.pid, headless: false })).toBe(true);
    expect((await fanoutChildren("claude", parent, { PHREN_PATH: store }))[0]).toMatchObject({ session: worker, state: "running" });
    expect(await fanoutChildren("codex", parent, { PHREN_PATH: store })).toEqual([]);
  });

  it("ignores interactive or parentless sessions but accepts a headless session without an SDK marker", () => {
    expect(registerUnmanagedClaude(payload(), store, temp.path, { CODEX_THREAD_ID: parent, CLAUDE_CODE_ENTRYPOINT: "cli" },
      { pid: process.pid, headless: false })).toBe(false);
    expect(registerUnmanagedClaude(payload(), store, temp.path, { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" },
      { pid: process.pid, headless: true })).toBe(false);
    expect(registerUnmanagedClaude(payload(), store, temp.path, { CODEX_THREAD_ID: parent, CLAUDE_CODE_ENTRYPOINT: "cli" },
      { pid: process.pid, headless: true })).toBe(true);
  });
});

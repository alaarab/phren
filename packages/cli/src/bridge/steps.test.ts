import { mkdir, mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { currentStep, describe as describeStep, stepOf } from "./steps.js";

describe("current step", () => {
  let root: string | undefined;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

  it("describes tool calls the way the lock screen reads them", () => {
    expect(describeStep("Bash", { command: "swift test --filter ChatTimelineTests\necho done" })).toBe("Bash: swift test --filter ChatTimelineT…");
    expect(describeStep("shell", '{"command":["bash","-lc","ls -la"]}')).toBe("shell: ls -la");
    expect(describeStep("shell", { command: "/bin/zsh -lc 'swift build'" })).toBe("shell: swift build");
    expect(describeStep("Bash", { command: `cd ${homedir()}/app && git status` })).toBe("Bash: git status");
    expect(describeStep("Bash", { command: `ls ${homedir()}/app` })).toBe("Bash: ls ~/app");
    expect(describeStep("Edit", { file_path: "/home/sam/app/Sources/View.swift" })).toBe("Editing View.swift");
    expect(describeStep("apply_patch", { input: "*** Begin Patch\n*** Update File: apps/ios/A.swift\n" })).toBe("Editing A.swift");
    expect(describeStep("Read", { file_path: "/home/sam/notes.md" })).toBe("Reading notes.md");
    expect(describeStep("Grep", { pattern: "needsAnswer" })).toBe("Searching needsAnswer");
    expect(describeStep("WebFetch", { url: "https://example.org/docs/page" })).toBe("Fetching example.org");
    expect(describeStep("Agent", { description: "Fix the stale tests", prompt: "secret" })).toBe("Delegating Fix the stale tests");
    expect(describeStep("mcp__phren__get_tasks", { project: "phren" })).toBe("mcp__phren__get_tasks");
  });

  it("reads each provider's rows newest first", () => {
    expect(stepOf({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Now" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } }, "claude")).toBe("Bash: ls");
    expect(stepOf({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }, "claude")).toBe("Writing a reply");
    expect(stepOf({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "x" }] } }, "claude")).toBeUndefined();
    expect(stepOf({ type: "user", message: { role: "user", content: "hi" } }, "claude")).toBe("Reading your message");
    expect(stepOf({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: '{"cmd":"pwd"}' } }, "codex")).toBe("shell: pwd");
    expect(stepOf({ type: "response_item", payload: { type: "message", role: "assistant", content: [] } }, "codex")).toBe("Writing a reply");
    expect(stepOf({ type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "tool_use", name: "webfetch", input: { url: "https://openrouter.ai/x" } }] } } }, "opencode")).toBe("Fetching openrouter.ai");
    expect(stepOf({ type: "tool.execution_start", data: { toolName: "bash", arguments: { command: "make" } } }, "copilot")).toBe("bash: make");
  });

  it("finds the newest decisive row in a Claude transcript and follows appends", async () => {
    root = await mkdtemp(path.join(tmpdir(), "phren-steps-"));
    const old = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = root;
    const session = "eeeeeeee-5555-4555-8555-555555555555";
    const project = path.join(root, "projects/-home-sam-app"); await mkdir(project, { recursive: true });
    const file = path.join(project, `${session}.jsonl`);
    await writeFile(file, [
      { type: "user", message: { role: "user", content: "Fix the build" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "swift build" } }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
    ].map(JSON.stringify).join("\n") + "\n");
    try {
      expect(await currentStep("claude", session)).toBe("Bash: swift build");
      await appendFile(file, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Built." }] } }) + "\n");
      expect(await currentStep("claude", session)).toBe("Writing a reply");
      expect(await currentStep("claude", "ffffffff-5555-4555-8555-555555555555")).toBeUndefined();
    } finally { process.env.CLAUDE_CONFIG_DIR = old; }
  });
});

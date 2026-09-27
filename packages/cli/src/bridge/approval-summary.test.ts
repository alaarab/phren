import { describe, expect, it } from "vitest";
import { approvalSummary, approvalTitle, shortApproval } from "./approval-summary.js";

describe("approval summaries", () => {
  it.each([
    [{ tool: "Bash", input: { command: "pnpm  test\n --filter cli" } }, "Run: pnpm test --filter cli", "command"],
    [{ tool: "Shell", input: { command: ["/bin/sh", "-lc", "echo first\necho second"] } }, "Run: echo first echo second", "command"],
    [{ tool: "exec_command", input: { command: ["bash", "-c", "npm run build"] } }, "Run: npm run build", "command"],
    [{ tool: "Bash", input: { command: "bash -lc 'pnpm lint'" } }, "Run: pnpm lint", "command"],
    [{ tool: "mcp__phren__get_tasks", input: { project: "phren" } }, "phren MCP: get_tasks", "tool"],
    [{ tool: "mcp__my_server__lookup", input: {} }, "my_server MCP: lookup", "tool"],
    [{ tool: "phren_admin", input: { server: "phren", tool: "get_tasks" } }, "phren MCP: get_tasks", "tool"],
    [{ tool: "action", input: { server_name: "phren", tool_name: "get_tasks" } }, "phren MCP: get_tasks", "tool"],
    [{ tool: "action", message: "Allow the phren MCP server to run tool get_tasks?" }, "phren MCP: get_tasks", "tool"],
    [{ tool: "bash", message: "bash: echo ready" }, "Run: echo ready", "command"],
    [{ tool: "Edit", input: { file_path: "/home/me/phren/src/app.ts" }, cwd: "/home/me/phren" }, "Edit: src/app.ts", "edit"],
    [{ tool: "Write", input: { file_path: "/home/me/phren/src/new.ts" }, cwd: "/home/me/phren" }, "Write: src/new.ts", "edit"],
    [{ tool: "Edit", input: { path: "/home/me/elsewhere/file.ts" }, cwd: "/home/me/phren" }, "Edit: /home/me/elsewhere/file.ts", "edit"],
    [{ tool: "apply_patch", input: { patch: "*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: src/b.ts\n*** End Patch" } }, "Apply patch: 2 files", "edit"],
    [{ tool: "apply_patch", input: { patch: "*** Begin Patch\n*** Update File: src/a.ts\n*** Update File: src/a.ts\n*** Add File: src/b.ts\n*** End Patch" } }, "Apply patch: 2 files", "edit"],
    [{ tool: "AskUserQuestion", input: { questions: [{ question: "Ship this now?" }] } }, "Ship this now?", "question"],
    [{ tool: "Question", message: "Allow the phren MCP server to run tool get_tasks?" }, "phren MCP: get_tasks", "tool"],
    [{ tool: "Question", message: "Ship this now?" }, "Ship this now?", "question"],
    [{ tool: "Read", input: { file_path: "src/app.ts" } }, "Read: src/app.ts", "tool"],
    [{}, "Open Phren to review the request.", "other"],
  ] as const)("formats %#", (input, request, requestKind) => {
    expect(approvalSummary(input)).toEqual({ request, requestKind });
  });

  it.each([
    ["Run: TOKEN=abc123 pnpm build", "Run: TOKEN=… pnpm build"],
    ["Run: PASSWORD='secret words' build", "Run: PASSWORD=… build"],
    ["Run: curl -H 'Authorization: Bearer abcdef'", "Run: curl -H 'Authorization: Bearer …'"],
    ["Run: tool --token abc --password=def -p xyz", "Run: tool --token … --password … -p …"],
    ["Run: ghp_1234567890 gho_1234567890 github_pat_1234567890", "Run: … … …"],
    ["Run: sk-abcdefghijklmnopqrstuvwxyz xoxb-123-abc AKIAABCDEFGHIJKLMNOP", "Run: … … …"],
    ["Run: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature", "Run: …"],
    [`Run: ${"a".repeat(32)} ${"B".repeat(36)}`, "Run: … …"],
    ["Run: curl https://alice:password@example.com/api/items?token=secret", "Run: curl https://example.com/api/items"],
  ])("redacts %# before delivery", (raw, expected) => {
    expect(shortApproval(raw)).toBe(expected);
  });

  it("redacts before truncating and ends at a word boundary", () => {
    expect(shortApproval(`Run: echo ${"a".repeat(150)} done`)).toBe("Run: echo … done");
    const result = approvalSummary({ tool: "Bash", input: { command: `echo ${"safe ".repeat(30)}--token secretvalue` } }).request;
    expect(result.length).toBeLessThanOrEqual(110);
    expect(result).toMatch(/safe…$/);
    expect(result).not.toContain("secretvalue");
  });

  it.each([
    ["codex", "phren", "Omarchy", "Codex · phren on Omarchy"],
    ["claude", "phren", undefined, "Claude · phren"],
    ["opencode", undefined, "Desk", "opencode on Desk"],
    ["copilot", undefined, undefined, "Copilot"],
    ["unknown", undefined, undefined, "Your agent"],
  ])("titles %#", (agent, project, computer, expected) => {
    expect(approvalTitle(agent, project, computer)).toBe(expected);
  });
});

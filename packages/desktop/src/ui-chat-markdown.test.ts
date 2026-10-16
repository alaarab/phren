import { describe, expect, it } from "vitest";
// @ts-expect-error Plain browser ESM.
import { chatToMarkdown, escapeTitle, exportFilename } from "../ui/chat/markdown-export.js";

const row = (over: Record<string, unknown>) => ({
  id: String(over.line), line: 0, role: "assistant", title: null, text: "", imageBlocks: [], resultImages: [], uploadImages: [],
  toolCallID: null, isToolError: false, isHookContext: false, isQueued: false, ...over,
});
const meta = { title: "Fix login", project: "phren", computer: "This computer", harness: "Claude", agent: "Claude", date: new Date(2026, 9, 16) };

describe("chatToMarkdown", () => {
  const messages = [
    row({ line: 1, role: "user", text: "Fix the login flow" }),
    row({ line: 2, text: "Here:\n\n```ts\nconst a = 1;\n```" }),
    row({ line: 3, role: "tool", title: "Bash", text: JSON.stringify({ command: "pnpm test" }), toolCallID: "t1" }),
    row({ line: 4, role: "tool", title: "Tool result", text: "ok", toolCallID: "t1" }),
    row({ line: 5, role: "tool", title: "Edit", text: JSON.stringify({ file_path: "src/app.ts", old_string: "a", new_string: "b" }), toolCallID: "t2" }),
    row({ line: 6, role: "user", text: "see this", uploadImages: ["/tmp/a.png"] }),
  ];
  const { markdown, messages: count } = chatToMarkdown(messages, meta);

  it("writes the title and a metadata line", () => {
    const lines = markdown.split("\n");
    expect(lines[0]).toBe("# Fix login");
    expect(lines[2]).toBe("phren · This computer · Claude · 2026-10-16");
  });
  it("writes turn headings and counts messages, not tool rows", () => {
    expect(markdown).toContain("**You**\n\nFix the login flow");
    expect(markdown).toContain("**Claude**\n\nHere:");
    expect(count).toBe(3);
  });
  it("keeps fenced code with its language", () => {
    expect(markdown).toContain("```ts\nconst a = 1;\n```");
  });
  it("writes tool calls as one-line bullets without output", () => {
    expect(markdown).toContain("- Ran `pnpm test` — passed\n- Edited `src/app.ts`");
    expect(markdown).not.toContain("\nok\n");
  });
  it("marks failed commands and images", () => {
    const failed = chatToMarkdown([
      row({ line: 1, role: "tool", title: "Bash", text: JSON.stringify({ command: "make" }), toolCallID: "x" }),
      row({ line: 2, role: "tool", title: "Tool result", toolCallID: "x", isToolError: true }),
    ], meta).markdown;
    expect(failed).toContain("- Ran `make` — failed");
    expect(markdown).toContain("[image]");
  });
  it("removes credentials from messages, tool commands and the title", () => {
    const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4";
    const out = chatToMarkdown([
      row({ line: 1, role: "user", text: `use ${token} and password: hunter2` }),
      row({ line: 2, role: "tool", title: "Bash", text: JSON.stringify({ command: `curl -H "Authorization: Bearer abcdef123456" x` }) }),
    ], { ...meta, title: `key ${token}` }).markdown;
    expect(out).not.toContain(token);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("abcdef123456");
    expect(out).toContain("[redacted]");
  });
  it("says when earlier messages are not included", () => {
    expect(chatToMarkdown([], { ...meta, earlierMissing: true }).markdown).toContain("_Earlier messages not included_");
    expect(markdown).not.toContain("Earlier messages");
  });
});

describe("titles and filenames", () => {
  it("escapes markdown characters and newlines in a title", () => {
    expect(escapeTitle("a *b* `c`\n[d] #e")).toBe("a \\*b\\* \\`c\\` \\[d\\] \\#e");
    expect(chatToMarkdown([], { title: "x_y <z>" }).markdown.split("\n")[0]).toBe("# x\\_y \\<z\\>");
  });
  it("slugifies the filename with the date", () => {
    expect(exportFilename("Fix: login / Ünïcode flow!", new Date(2026, 0, 5))).toBe("fix-login-unicode-flow-2026-01-05.md");
    expect(exportFilename("???", new Date(2026, 0, 5))).toBe("chat-2026-01-05.md");
  });
});

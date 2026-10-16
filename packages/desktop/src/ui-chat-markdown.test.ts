import { describe, expect, it } from "vitest";
// @ts-expect-error Plain browser ESM.
import { balanceFences, chatToMarkdown, escapeTitle, exportFilename } from "../ui/chat/markdown-export.js";
// @ts-expect-error Plain browser ESM.
import { redactExport, redactNotice } from "../ui/redact.js";

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

describe("redactExport", () => {
  const cases: Array<[string, string, string]> = [
    ["mysql -p", "mysql -u root -phunter2 db", "hunter2"],
    ["curl -u", "curl -u admin:s3cret https://x.test", "s3cret"],
    ["curl --user", "curl --user admin:s3cret https://x.test", "s3cret"],
    ["--password", "deploy --password hunter2 now", "hunter2"],
    ["--token", "run --token abc123xyz", "abc123xyz"],
    ["--api-key", "run --api-key zzz999", "zzz999"],
    ["--auth", "run --auth qqq888", "qqq888"],
    ["Cookie header", "Cookie: session=abc999; theme=dark", "abc999"],
    ["Set-Cookie header", "Set-Cookie: id=zzz777; Path=/", "zzz777"],
    ["X-API-Key header", "X-API-Key: k-12345", "k-12345"],
    ["other *-Token header", "X-Auth-Token: tok4567", "tok4567"],
    ["Slack webhook", "post https://hooks.slack.com/services/T123ABC/B456DEF/abcDEF789xyz", "abcDEF789xyz"],
    ["any JWT", "jwt eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2lnbmF0dXJl end", "cGF5bG9hZA"],
  ];
  for (const [name, input, secret] of cases) {
    it(`removes ${name}`, () => {
      const out = redactExport(input);
      expect(out).not.toContain(secret);
      expect(out).toContain("[redacted]");
    });
  }
  it("keeps ordinary command lines and runs in linear time", () => {
    expect(redactExport("pnpm test -- auth")).toBe("pnpm test -- auth");
    const start = Date.now();
    redactExport(`${"a-".repeat(50_000)}\n${"-p".repeat(50_000)}`);
    expect(Date.now() - start).toBeLessThan(2000);
  });
  it("leaves redactNotice output unchanged", () => {
    expect(redactNotice("token: abc123 see ghp_" + "a".repeat(36) + " ok")).toBe("token: [redacted] see [redacted] ok");
    expect(redactNotice("plain words here")).toBe("plain words here");
    const long = redactNotice("x ".repeat(300));
    expect(long.length).toBe(401);
    expect(long.endsWith("x …")).toBe(true);
  });
});

describe("redaction order and fences", () => {
  it("redacts a title token before escaping, and the filename follows the redacted title", () => {
    const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const out = chatToMarkdown([], { title: `fix ${token}` });
    expect(out.markdown).not.toContain("ghp");
    expect(exportFilename(out.title, new Date(2026, 0, 5))).toBe("fix-redacted-2026-01-05.md");
  });
  it("redacts a long command before clipping it", () => {
    const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const command = `${"x".repeat(100)} ${token}`;
    const out = chatToMarkdown([row({ line: 1, role: "tool", title: "Bash", text: JSON.stringify({ command }) })], meta).markdown;
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain("a1B2c3D4");
  });
  it("closes a fence a message leaves open so later headings survive", () => {
    const out = chatToMarkdown([row({ line: 1, text: "```js\nopen" }), row({ line: 2, role: "user", text: "next" })], meta).markdown;
    expect(out).toContain("```js\nopen\n```\n\n**You**");
    expect(balanceFences("```\na\n```")).toBe("```\na\n```");
    expect(balanceFences("````\n```\nx")).toBe("````\n```\nx\n````");
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

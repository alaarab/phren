import { describe, expect, it } from "vitest";
import {
  PROJECT_NAME, findingWriteSchema, isRepoPath, isSearchText, taskCompleteSchema,
} from "./gitboy-contract.js";

const findingIssues = (body: unknown) => {
  const result = findingWriteSchema.safeParse(body);
  return result.success ? [] : result.error.issues;
};
const taskIssues = (body: unknown) => {
  const result = taskCompleteSchema.safeParse(body);
  return result.success ? [] : result.error.issues;
};
type Issue = ReturnType<typeof findingIssues>[number];
const atPath = (issues: Issue[], path: string) => issues.find(issue => issue.path.join(".") === path);

describe("the project segment gitboy routes accept", () => {
  it("admits lowercase names with digits, underscores and hyphens", () => {
    for (const name of ["app", "my-app", "a", "0", "a_b", "a-b-c", "9lives", "a".repeat(100)]) {
      expect(PROJECT_NAME.test(name), name).toBe(true);
    }
  });

  it("refuses names that could step out of the route or change its case", () => {
    const cases: Array<[string, string]> = [
      ["an empty name", ""],
      ["a leading hyphen", "-app"],
      ["a leading underscore", "_app"],
      ["uppercase letters", "App"],
      ["a dot", "my.app"],
      ["a space", "my app"],
      ["a slash", "my/app"],
      ["a parent segment", "../app"],
      ["an encoded parent segment", "%2e%2e"],
      ["an encoded slash", "app%2f.."],
      ["more than 100 characters", "a".repeat(101)],
      ["a newline", "app\n"],
      ["a trailing space", "app "],
    ];
    for (const [label, name] of cases) expect(PROJECT_NAME.test(name), label).toBe(false);
  });
});

describe("repository-relative paths on gitboy-read routes", () => {
  it("admits ordinary repository paths, including hidden directories and punctuation in names", () => {
    const cases: Array<[string, string]> = [
      ["a single segment", "src/a.ts"],
      ["a nested path", "packages/cli/src/bridge/gitboy-contract.ts"],
      ["a hidden directory", ".github/workflows/ci.yml"],
      ["an internal space", "docs/read me.md"],
      ["parentheses", "src/app(1).test.ts"],
      ["brackets", "src/file[1].ts"],
      ["an apostrophe", "docs/it's.md"],
      ["an ampersand and dollar", "src/a&b$c.ts"],
      ["a hash", "src/up.ts#L12"],
      ["three dots in a segment", "src/a...b"],
    ];
    for (const [label, value] of cases) expect(isRepoPath(value), label).toBe(true);
  });

  it("refuses parent and single-dot segments anywhere in the path", () => {
    const cases: Array<[string, string]> = [
      ["a parent segment", "../etc/passwd"],
      ["a nested parent segment", "src/../etc/passwd"],
      ["a single-dot segment", "src/./a.ts"],
      ["a parent segment after a valid prefix", "a/../b"],
      ["only a parent segment", ".."],
      ["only a single dot", "."],
      ["a trailing parent segment", "a/.."],
      ["a leading single-dot segment", "./a"],
    ];
    for (const [label, value] of cases) expect(isRepoPath(value), label).toBe(false);
  });

  it("refuses absolute paths, encoded separators and characters the path grammar does not name", () => {
    const cases: Array<[string, string]> = [
      ["an absolute path", "/etc/passwd"],
      ["a Windows drive", "C:/Windows"],
      ["a backslash separator", "src\\a.ts"],
      ["a percent-encoded separator", "src%2Fa.ts"],
      ["an encoded parent segment", "src/%2e%2e/a.ts"],
      ["a percent-encoded NUL", "src/a%00b.ts"],
      ["a query separator", "src/a.ts?x=1"],
      ["a wildcard", "src/*.ts"],
      ["a colon", "src/a:b.ts"],
    ];
    for (const [label, value] of cases) expect(isRepoPath(value), label).toBe(false);
  });

  it("refuses empty segments and segments with surrounding whitespace", () => {
    const cases: Array<[string, string]> = [
      ["a trailing slash", "src/a/"],
      ["an empty segment", "src//a.ts"],
      ["a leading space", " src/a.ts"],
      ["a trailing space", "src/a.ts "],
      ["a space before a segment", "src/ a.ts"],
      ["a space after a segment", "src /a.ts"],
    ];
    for (const [label, value] of cases) expect(isRepoPath(value), label).toBe(false);
  });

  it("refuses control characters in a segment", () => {
    const cases: Array<[string, string]> = [
      ["a tab", "src/a\tb.ts"],
      ["a newline", "src/a\nb.ts"],
      ["a carriage return", "src/a\rb.ts"],
      ["a NUL", "src/a\u0000b.ts"],
      ["a DEL", "src/a\u007fb.ts"],
    ];
    for (const [label, value] of cases) expect(isRepoPath(value), label).toBe(false);
  });

  it("bounds a path at 1024 characters", () => {
    expect(isRepoPath("a".repeat(1024))).toBe(true);
    expect(isRepoPath("a".repeat(1025))).toBe(false);
    expect(isRepoPath("")).toBe(false);
  });
});



describe("search text on the gitboy-read search route", () => {
  it("admits text with tabs and newlines, as an error excerpt has", () => {
    for (const value of ["boom", "TypeError: x\n\tat foo", "C:\\src\\a.ts:12", " leading and trailing spaces "]) {
      expect(isSearchText(value), value).toBe(true);
    }
  });

  it("refuses text that is empty or only whitespace", () => {
    for (const [label, value] of [["an empty query", ""], ["only spaces", "   "], ["only a tab and a newline", "\t\n"]] as Array<[string, string]>) {
      expect(isSearchText(value), label).toBe(false);
    }
  });

  it("refuses control characters other than tabs and newlines", () => {
    const cases: Array<[string, string]> = [
      ["a NUL", "a\u0000b"],
      ["a backspace", "a\u0008b"],
      ["a vertical tab", "a\u000bb"],
      ["a form feed", "a\u000cb"],
      ["a carriage return", "a\rb"],
      ["a unit separator", "a\u001fb"],
      ["a DEL", "a\u007fb"],
    ];
    for (const [label, value] of cases) expect(isSearchText(value), label).toBe(false);
  });

  it("bounds a search query at 1000 characters", () => {
    expect(isSearchText("a".repeat(1000))).toBe(true);
    expect(isSearchText("a".repeat(1001))).toBe(false);
  });
});

describe("the finding body gitboy-write may save", () => {
  it("admits a finding with a known type and a well-formed citation", () => {
    for (const type of ["decision", "pitfall", "pattern", "bug"]) {
      expect(findingWriteSchema.safeParse({ text: "x", type }).success, type).toBe(true);
    }
    const cases: Array<[string, unknown]> = [
      ["plain text", { text: "Retry the upload on 502" }],
      ["text with a tab and a newline", { text: "Retry\tthe\nupload" }],
      ["a full citation", { text: "x", citation: { file: "src/up.ts", line: 12, commit: "abc1234", name: "upload()" } }],
      ["an empty citation", { text: "x", citation: {} }],
      ["a hidden-directory citation file", { text: "x", citation: { file: ".github/workflows/ci.yml" } }],
      ["a seven-character commit", { text: "x", citation: { commit: "abc1234" } }],
      ["a 64-character commit", { text: "x", citation: { commit: "a".repeat(64) } }],
      ["a 200-character symbol", { text: "x", citation: { name: "a".repeat(200) } }],
    ];
    for (const [label, body] of cases) expect(findingWriteSchema.safeParse(body).success, label).toBe(true);
  });

  it("collapses whitespace and trims the text before the Hook stores it", () => {
    expect(findingWriteSchema.parse({ text: "  Retry \t the\n\nupload  " }).text).toBe("Retry the upload");
  });

  it("refuses text that is empty after whitespace is collapsed", () => {
    const cases: Array<[string, string]> = [["an empty string", ""], ["only spaces", "   "], ["only a tab and a newline", "\t\n"]];
    for (const [label, text] of cases) {
      const issue = atPath(findingIssues({ text }), "text");
      expect(issue, label).toBeDefined();
      expect(issue?.message, label).toBe("Text is empty.");
    }
  });

  it("refuses control characters other than tabs and newlines in the text", () => {
    const cases: Array<[string, string]> = [
      ["a NUL", "a\u0000b"],
      ["a backspace", "a\u0008b"],
      ["a vertical tab", "a\u000bb"],
      ["a form feed", "a\u000cb"],
      ["a carriage return", "a\rb"],
      ["a DEL", "a\u007fb"],
    ];
    for (const [label, text] of cases) {
      const issue = atPath(findingIssues({ text }), "text");
      expect(issue, label).toBeDefined();
      expect(issue?.message, label).toContain("no other control characters");
    }
  });

  it("bounds the finding text at 5000 characters", () => {
    expect(findingWriteSchema.safeParse({ text: "a".repeat(5000) }).success).toBe(true);
    expect(atPath(findingIssues({ text: "a".repeat(5001) }), "text")).toBeDefined();
  });

  it("refuses a missing or non-string text", () => {
    expect(atPath(findingIssues({}), "text")).toBeDefined();
    expect(atPath(findingIssues({ text: 1 }), "text")).toBeDefined();
  });

  it("refuses finding types outside the contract", () => {
    for (const [label, type] of [["a workaround", "workaround"], ["null", null], ["a number", 1]] as Array<[string, unknown]>) {
      expect(atPath(findingIssues({ text: "x", type }), "type"), label).toBeDefined();
    }
  });

  it("refuses citations that are not an object", () => {
    for (const [label, citation] of [["null", null], ["a string", "src/a.ts"], ["an array", []]] as Array<[string, unknown]>) {
      expect(atPath(findingIssues({ text: "x", citation }), "citation"), label).toBeDefined();
    }
  });

  it("refuses fields the finding contract does not name", () => {
    expect(atPath(findingIssues({ text: "x", extra: true }), "")).toBeDefined();
    expect(atPath(findingIssues({ text: "x", citation: { file: "src/a.ts", repo: "/home/me" } }), "citation")).toBeDefined();
  });

  it("refuses citation files that are absolute, traverse upward or use another separator", () => {
    const cases: Array<[string, string]> = [
      ["an absolute file", "/etc/passwd"],
      ["a parent segment", "../etc/passwd"],
      ["a nested parent segment", "src/../etc/passwd"],
      ["an empty file", ""],
      ["a backslash", "src\\a.ts"],
    ];
    for (const [label, file] of cases) {
      const issue = atPath(findingIssues({ text: "x", citation: { file } }), "citation.file");
      expect(issue, label).toBeDefined();
      expect(issue?.message, label).toContain("repository-relative");
    }
  });

  it("bounds citation lines to integers from 1 to 10,000,000", () => {
    for (const [label, line] of [["zero", 0], ["a negative line", -1], ["a fractional line", 1.5], ["a string line", "12"], ["above ten million", 10_000_001]] as Array<[string, unknown]>) {
      expect(atPath(findingIssues({ text: "x", citation: { line } }), "citation.line"), label).toBeDefined();
    }
    expect(findingWriteSchema.safeParse({ text: "x", citation: { line: 1 } }).success).toBe(true);
    expect(findingWriteSchema.safeParse({ text: "x", citation: { line: 10_000_000 } }).success).toBe(true);
  });

  it("refuses commits that are not 7 to 64 hex digits", () => {
    const cases: Array<[string, string]> = [
      ["six hex digits", "abc123"],
      ["non-hex characters", "zzz1234"],
      ["a space", "abc 1234"],
      ["65 hex digits", "a".repeat(65)],
    ];
    for (const [label, commit] of cases) expect(atPath(findingIssues({ text: "x", citation: { commit } }), "citation.commit"), label).toBeDefined();
  });

  it("bounds citation names to 1 to 200 characters without control characters", () => {
    const cases: Array<[string, string]> = [
      ["an empty name", ""],
      ["more than 200 characters", "a".repeat(201)],
      ["a tab", "a\tb"],
      ["a newline", "a\nb"],
    ];
    for (const [label, name] of cases) expect(atPath(findingIssues({ text: "x", citation: { name } }), "citation.name"), label).toBeDefined();
  });

  it("refuses finding bodies that are not an object", () => {
    for (const [label, body] of [["null", null], ["an array", ["x"]], ["a string", "x"]] as Array<[string, unknown]>) {
      expect(findingWriteSchema.safeParse(body).success, label).toBe(false);
    }
  });
});

import { describe, expect, it, beforeEach } from "vitest";
import {
  extractPattern,
  isAllowed,
  addAllow,
  clearAllowlist,
} from "../permissions/allowlist.js";

// Reset the module-level allowlist before each test
beforeEach(() => {
  clearAllowlist();
});

describe("extractPattern", () => {
  // ── Shell tool ──────────────────────────────────────────────────────

  it("extracts binary name from shell command", () => {
    expect(extractPattern("shell", { command: "git status" })).toBe("git");
  });

  it("extracts binary from multi-arg command", () => {
    expect(extractPattern("shell", { command: "npm install --save foo" })).toBe(
      "npm",
    );
  });

  it("handles leading whitespace in command", () => {
    expect(extractPattern("shell", { command: "  ls -la" })).toBe("ls");
  });

  it("returns * for empty shell command", () => {
    expect(extractPattern("shell", { command: "" })).toBe("*");
  });

  it("returns * when command is missing", () => {
    expect(extractPattern("shell", {})).toBe("*");
  });

  // ── File tools ──────────────────────────────────────────────────────

  it("extracts path from input.path", () => {
    expect(extractPattern("read_file", { path: "/src/index.ts" })).toBe(
      "/src/index.ts",
    );
  });

  it("extracts file_path from input.file_path", () => {
    expect(
      extractPattern("write_file", { file_path: "/src/main.ts" }),
    ).toBe("/src/main.ts");
  });

  it("prefers path over file_path", () => {
    expect(
      extractPattern("read_file", {
        path: "/a.ts",
        file_path: "/b.ts",
      }),
    ).toBe("/a.ts");
  });

  // ── Other tools ─────────────────────────────────────────────────────

  it("returns * for tools with no path or command", () => {
    expect(extractPattern("phren_search", { query: "foo" })).toBe("*");
  });

  it("returns * for empty input", () => {
    expect(extractPattern("some_tool", {})).toBe("*");
  });
});

describe("isAllowed", () => {
  it("returns false when allowlist is empty", () => {
    expect(isAllowed("shell", { command: "git status" })).toBe(false);
  });

  it("returns true for exact tool+pattern match", () => {
    addAllow("shell", { command: "git status" }, "session");
    expect(isAllowed("shell", { command: "git diff" })).toBe(true); // same binary "git"
  });

  it("returns false for different tool name", () => {
    addAllow("shell", { command: "git status" }, "session");
    expect(isAllowed("read_file", { path: "git" })).toBe(false);
  });

  it("returns false for different binary", () => {
    addAllow("shell", { command: "git status" }, "session");
    expect(isAllowed("shell", { command: "npm install" })).toBe(false);
  });

  // ── Wildcard matching ───────────────────────────────────────────────

  it("wildcard pattern matches any input for that tool", () => {
    addAllow("phren_search", { query: "test" }, "tool");
    expect(isAllowed("phren_search", { query: "anything" })).toBe(true);
    expect(isAllowed("phren_search", { query: "different" })).toBe(true);
  });

  it("wildcard does not match different tool", () => {
    addAllow("phren_search", { query: "test" }, "tool");
    expect(isAllowed("shell", { command: "echo hi" })).toBe(false);
  });

  // ── File path matching ──────────────────────────────────────────────

  it("matches exact file path", () => {
    addAllow("read_file", { path: "/src/index.ts" }, "session");
    expect(isAllowed("read_file", { path: "/src/index.ts" })).toBe(true);
  });

  it("matches child path (startsWith)", () => {
    addAllow("read_file", { path: "/src/" }, "session");
    expect(isAllowed("read_file", { path: "/src/deep/file.ts" })).toBe(true);
  });

  it("does not match unrelated path", () => {
    addAllow("read_file", { path: "/src/index.ts" }, "session");
    expect(isAllowed("read_file", { path: "/lib/other.ts" })).toBe(false);
  });
});

describe("addAllow", () => {
  // ── Scope: once ─────────────────────────────────────────────────────

  it("does not persist 'once' scope", () => {
    addAllow("shell", { command: "git status" }, "once");
    expect(isAllowed("shell", { command: "git status" })).toBe(false);
  });

  // ── Scope: session ──────────────────────────────────────────────────

  it("persists 'session' scope with extracted pattern", () => {
    addAllow("shell", { command: "git status" }, "session");
    expect(isAllowed("shell", { command: "git diff" })).toBe(true);
  });

  // ── Scope: tool ─────────────────────────────────────────────────────

  it("tool scope on non-shell allows any input for that tool", () => {
    addAllow("read_file", { path: "/src/a.ts" }, "tool");
    expect(isAllowed("read_file", { path: "/completely/different.ts" })).toBe(true);
  });

  it("shell tool scope still scopes to binary, not wildcard", () => {
    addAllow("shell", { command: "git status" }, "tool");
    expect(isAllowed("shell", { command: "git diff" })).toBe(true);
  });

  it("shell tool scope does not allow different binaries", () => {
    addAllow("shell", { command: "git status" }, "tool");
    expect(isAllowed("shell", { command: "git diff" })).toBe(true);
    expect(isAllowed("shell", { command: "npm install" })).toBe(false);
  });

  // ── Deduplication ───────────────────────────────────────────────────

  it("does not add duplicate entries", () => {
    addAllow("shell", { command: "git status" }, "session");
    addAllow("shell", { command: "git diff" }, "session"); // same binary "git"
    // Still just one pattern match — adding twice doesn't break anything
    expect(isAllowed("shell", { command: "git log" })).toBe(true);
  });
});

describe("clearAllowlist", () => {
  it("empties the allowlist", () => {
    addAllow("shell", { command: "git status" }, "session");
    addAllow("read_file", { path: "/src/a.ts" }, "session");
    expect(isAllowed("shell", { command: "git status" })).toBe(true);

    clearAllowlist();
    expect(isAllowed("shell", { command: "git status" })).toBe(false);
  });

  it("causes isAllowed to return false after clear", () => {
    addAllow("shell", { command: "git status" }, "session");
    expect(isAllowed("shell", { command: "git status" })).toBe(true);

    clearAllowlist();
    expect(isAllowed("shell", { command: "git status" })).toBe(false);
  });
});

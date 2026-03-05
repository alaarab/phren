import { describe, it, expect } from "vitest";
import { sanitizeFts5Query, isValidProjectName, safeProjectPath } from "./utils.js";
import * as path from "path";

describe("sanitizeFts5Query", () => {
  it("passes through a normal query", () => {
    expect(sanitizeFts5Query("authentication")).toBe("authentication");
  });

  it("handles multi-word queries", () => {
    const result = sanitizeFts5Query("user login");
    expect(result).toBe("user login");
  });

  it("passes through SQL-like strings (SQL injection prevented by parameterized queries, not here)", () => {
    const result = sanitizeFts5Query("'; DROP TABLE docs--");
    // sanitizeFts5Query only strips FTS5 syntax, not SQL.
    // SQL injection is prevented by bind parameters at the query layer.
    expect(result).toBe("'; DROP TABLE docs--");
  });

  it("removes FTS5 column filter prefixes", () => {
    const result = sanitizeFts5Query("content:secret");
    expect(result).toBe("secret");
  });

  it("removes all known column filters", () => {
    expect(sanitizeFts5Query("type:backlog")).toBe("backlog");
    expect(sanitizeFts5Query("project:foo")).toBe("foo");
    expect(sanitizeFts5Query("filename:bar")).toBe("bar");
    expect(sanitizeFts5Query("path:/etc/passwd")).toBe("/etc/passwd");
  });

  it("preserves URLs (non-column-name prefixes)", () => {
    const result = sanitizeFts5Query("https://example.com");
    expect(result).toContain("https");
    expect(result).toContain("example.com");
  });

  it("removes null bytes", () => {
    const result = sanitizeFts5Query("hello\0world");
    expect(result).toBe("helloworld");
  });

  it("removes FTS5 ^ anchors", () => {
    const result = sanitizeFts5Query("^start of phrase");
    expect(result).toBe("start of phrase");
  });

  it("strips double quotes", () => {
    const result = sanitizeFts5Query('"exact phrase"');
    expect(result).toBe("exact phrase");
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeFts5Query("")).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(sanitizeFts5Query("   ")).toBe("");
  });

  it("handles combined injection attempts", () => {
    const result = sanitizeFts5Query('^content:"secret" OR filename:hack\0');
    expect(result).not.toContain("^");
    expect(result).not.toContain("\0");
    expect(result).not.toContain("content:");
    expect(result).not.toContain("filename:");
    expect(result).not.toContain('"');
  });
});

describe("isValidProjectName", () => {
  it("accepts a valid name", () => {
    expect(isValidProjectName("my-project")).toBe(true);
  });

  it("accepts names with dots (single dot is fine)", () => {
    expect(isValidProjectName(".hidden")).toBe(true);
  });

  it("accepts alphanumeric names", () => {
    expect(isValidProjectName("project123")).toBe(true);
  });

  it("rejects path traversal with ..", () => {
    expect(isValidProjectName("../etc")).toBe(false);
  });

  it("rejects forward slash", () => {
    expect(isValidProjectName("foo/bar")).toBe(false);
  });

  it("rejects backslash", () => {
    expect(isValidProjectName("foo\\bar")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidProjectName("")).toBe(false);
  });

  it("rejects null byte", () => {
    expect(isValidProjectName("foo\0bar")).toBe(false);
  });

  it("rejects bare double dots", () => {
    expect(isValidProjectName("..")).toBe(false);
  });

  it("rejects triple dots containing ..", () => {
    expect(isValidProjectName("...")).toBe(false);
  });
});

describe("safeProjectPath", () => {
  const base = "/tmp/test-cortex";

  it("returns resolved path for a valid subdirectory", () => {
    const result = safeProjectPath(base, "my-project");
    expect(result).toBe(path.resolve(base, "my-project"));
  });

  it("rejects traversal that escapes the base", () => {
    const result = safeProjectPath(base, "..", "etc", "passwd");
    expect(result).toBeNull();
  });

  it("rejects simple parent traversal", () => {
    const result = safeProjectPath(base, "..");
    expect(result).toBeNull();
  });

  it("allows the base directory itself", () => {
    const result = safeProjectPath(base);
    expect(result).toBe(path.resolve(base));
  });

  it("allows nested paths within base", () => {
    const result = safeProjectPath(base, "project", "subdir");
    expect(result).toBe(path.resolve(base, "project", "subdir"));
  });

  it("rejects prefix attacks (base name as substring)", () => {
    // e.g. base is /tmp/test-cortex, attacker tries /tmp/test-cortex-evil
    const result = safeProjectPath(base, "..", "test-cortex-evil");
    expect(result).toBeNull();
  });
});

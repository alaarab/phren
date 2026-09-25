import { describe, it, expect } from "vitest";
import * as yaml from "js-yaml";
import { UNIVERSAL_TECH_TERMS_RE, EXTRA_FRAGMENT_PATTERNS, phrenOk, phrenErr, forwardErr, parsePhrenErrorCode, isRecord, withDefaults, capCache, PhrenError, loadYamlDocument } from "./phren-core.js";

// ── UNIVERSAL_TECH_TERMS_RE ─────────────────────────────────────────────────

describe("UNIVERSAL_TECH_TERMS_RE", () => {
  it("matches known tech terms case-insensitively", () => {
    const text = "We use Python and typescript with Docker on AWS";
    const matches = text.match(new RegExp(UNIVERSAL_TECH_TERMS_RE.source, UNIVERSAL_TECH_TERMS_RE.flags));
    expect(matches).not.toBeNull();
    const lower = matches!.map((m) => m.toLowerCase());
    expect(lower).toContain("python");
    expect(lower).toContain("typescript");
    expect(lower).toContain("docker");
    expect(lower).toContain("aws");
  });

  it("does not match partial words", () => {
    const text = "Gopher is not Go, and Javalin is not Java";
    const re = new RegExp(UNIVERSAL_TECH_TERMS_RE.source, UNIVERSAL_TECH_TERMS_RE.flags);
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) matches.push(m[0]);
    // Should match "Go" and "Java" as standalone words; regex uses \b so substrings in
    // "Gopher" or "Javalin" should NOT match.
    for (const match of matches) {
      expect(["Go", "Java", "go", "java"]).toContain(match);
    }
  });

  it.each(["The quick brown fox jumps over the lazy dog", ""])("matches nothing in %j", (text) => {
    expect(text.match(new RegExp(UNIVERSAL_TECH_TERMS_RE.source, UNIVERSAL_TECH_TERMS_RE.flags))).toBeNull();
  });
});

// ── EXTRA_FRAGMENT_PATTERNS ───────────────────────────────────────────────────

describe("EXTRA_FRAGMENT_PATTERNS", () => {
  function matchPattern(label: string, text: string): string[] {
    const pat = EXTRA_FRAGMENT_PATTERNS.find((p) => p.label === label);
    if (!pat) throw new Error(`No pattern with label: ${label}`);
    const re = new RegExp(pat.re.source, pat.re.flags);
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) matches.push(m[0]);
    return matches;
  }

  it.each([
    ["version", "Upgrade to v1.2.3", ["v1.2.3"]],
    ["version", "Version 2.0.0", ["2.0.0"]],
    ["version", "Use 3.0.0-beta.1 for testing", ["3.0.0-beta.1"]],
    ["version", "port 8080 is open", []],
    ["env_key", "Set PHREN_LLM_ENDPOINT to your URL", ["PHREN_LLM_ENDPOINT"]],
    ["env_key", "NODE_ENV=production", ["NODE_ENV"]],
    // A single uppercase word with no underscore segment is not an env key.
    ["env_key", "The API is down", []],
    ["env_key", "PHREN_DEBUG=1 and AWS_REGION=us-east-1", ["PHREN_DEBUG", "AWS_REGION"]],
    ["file_path", "Edit /home/user/config.json", ["/home/user/config.json"]],
    ["file_path", "Check ./src/index.ts", ["./src/index.ts"]],
    ["file_path", "Stored in ~/phren/FINDINGS.md", ["~/phren/FINDINGS.md"]],
    ["file_path", "no paths here", []],
    ["error_code", "Fix TS2345 in the handler", ["TS2345"]],
    ["error_code", "ERR_MODULE_NOT_FOUND when importing", ["ERR_MODULE_NOT_FOUND"]],
    ["error_code", "Everything works fine", []],
    ["date", "Fixed on 2025-03-11", ["2025-03-11"]],
    ["date", "Deployed 2025/01/15", ["2025/01/15"]],
    ["date", "value is 42", []],
  ])("%s pattern finds the right matches in %j", (label, text, expected) => {
    expect(matchPattern(label, text)).toEqual(expected);
  });

  it("handles empty input for all patterns", () => {
    for (const { re, label } of EXTRA_FRAGMENT_PATTERNS) {
      const matches = "".match(new RegExp(re.source, re.flags));
      expect(matches, `${label} should return null on empty input`).toBeNull();
    }
  });

  it("handles very long strings without hanging", () => {
    const longText = "PHREN_DEBUG ".repeat(10000) + "v1.0.0";
    for (const { re } of EXTRA_FRAGMENT_PATTERNS) {
      const regex = new RegExp(re.source, re.flags);
      // Should complete without hanging
      const matches: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = regex.exec(longText)) !== null) matches.push(m[0]);
      expect(matches.length).toBeGreaterThanOrEqual(0);
    }
  });

  it("handles Unicode text without false positives", () => {
    const text = "使用 Python 和 日本語テスト";
    for (const { re, label } of EXTRA_FRAGMENT_PATTERNS) {
      const matches = text.match(new RegExp(re.source, re.flags));
      // None of the extra patterns should match CJK characters
      if (matches) {
        for (const match of matches) {
          expect(match, `${label} matched unexpected Unicode: ${match}`).toMatch(/^[a-zA-Z0-9_./-~]+$/);
        }
      }
    }
  });
});

// ── PhrenResult helpers ────────────────────────────────────────────────────

describe("phrenOk / phrenErr / forwardErr", () => {
  it("phrenOk wraps data", () => {
    const r = phrenOk(42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBe(42);
  });

  it("phrenErr wraps error", () => {
    const r = phrenErr("bad", PhrenError.FILE_NOT_FOUND);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("bad");
      expect(r.code).toBe("FILE_NOT_FOUND");
    }
  });

  it("forwardErr re-types a failed result", () => {
    const original = phrenErr<number>("oops", PhrenError.PERMISSION_DENIED);
    const forwarded = forwardErr<string>(original);
    expect(forwarded.ok).toBe(false);
    if (!forwarded.ok) {
      expect(forwarded.error).toBe("oops");
      expect(forwarded.code).toBe("PERMISSION_DENIED");
    }
  });

  it("forwardErr on ok result returns generic error", () => {
    const original = phrenOk("data");
    const forwarded = forwardErr<number>(original);
    expect(forwarded.ok).toBe(false);
  });
});

// ── parsePhrenErrorCode ────────────────────────────────────────────────────

describe("parsePhrenErrorCode", () => {
  it.each([
    ["PROJECT_NOT_FOUND: myproject", "PROJECT_NOT_FOUND"],
    ["RANDOM_ERROR: something", undefined],
    ["", undefined],
  ])("parses %j as %s", (message, code) => {
    expect(parsePhrenErrorCode(message)).toBe(code);
  });
});

// ── isRecord ────────────────────────────────────────────────────────────────

describe("isRecord", () => {
  it("is true only for plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    for (const value of [[], null, "string", 42, undefined]) expect(isRecord(value), String(value)).toBe(false);
  });
});

// ── withDefaults ────────────────────────────────────────────────────────────

describe("withDefaults", () => {
  it("fills missing keys from defaults", () => {
    const result = withDefaults({ a: 1 }, { a: 0, b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("ignores undefined/null in data", () => {
    const result = withDefaults({ a: undefined, b: null } as any, { a: 10, b: 20 });
    expect(result).toEqual({ a: 10, b: 20 });
  });

  it("shallow-merges nested objects", () => {
    const result = withDefaults(
      { opts: { x: 1 } } as any,
      { opts: { x: 0, y: 2 } } as any,
    );
    expect(result).toEqual({ opts: { x: 1, y: 2 } });
  });
});

// ── capCache ────────────────────────────────────────────────────────────────

describe("capCache", () => {
  it("does nothing when under limit", () => {
    const cache = new Map<string, number>();
    for (let i = 0; i < 100; i++) cache.set(`k${i}`, i);
    capCache(cache);
    expect(cache.size).toBe(100);
  });

  it("evicts oldest entries when over 1000", () => {
    const cache = new Map<string, number>();
    for (let i = 0; i < 1050; i++) cache.set(`k${i}`, i);
    capCache(cache);
    expect(cache.size).toBe(950);
    // First 100 keys should be evicted
    expect(cache.has("k0")).toBe(false);
    expect(cache.has("k99")).toBe(false);
    expect(cache.has("k100")).toBe(true);
  });
});

describe("loadYamlDocument", () => {
  const load = (text: string) => yaml.load(text, { schema: yaml.CORE_SCHEMA });

  // js-yaml 5 throws YAMLException on these; js-yaml 4 returned undefined, and
  // every caller in the CLI reads undefined as "nothing configured yet". A
  // scaffolded machines.yaml really is one header comment.
  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["blank lines", "\n\n"],
    ["one comment", "# machine-name: profile-name\n"],
    ["several comments", "# a\n# b\n"],
    ["indented comment", "  # x\n\n"],
  ])("returns undefined for %s", (_label, source) => {
    expect(loadYamlDocument(source, load)).toBeUndefined();
  });

  it("parses real documents, including ones with leading comments", () => {
    expect(loadYamlDocument("a: 1\n", load)).toEqual({ a: 1 });
    expect(loadYamlDocument("# lead\na: 1\n", load)).toEqual({ a: 1 });
    expect(loadYamlDocument("[]\n", load)).toEqual([]);
  });

  it("does not absorb an explicit null document or a syntax error", () => {
    expect(loadYamlDocument("---\n", load)).toBeNull();
    expect(loadYamlDocument("null\n", load)).toBeNull();
    expect(() => loadYamlDocument("a: [\n", load)).toThrow();
  });
});

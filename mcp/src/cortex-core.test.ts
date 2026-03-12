import { describe, it, expect } from "vitest";
import {
  UNIVERSAL_TECH_TERMS_RE,
  EXTRA_ENTITY_PATTERNS,
  cortexOk,
  cortexErr,
  forwardErr,
  parseCortexErrorCode,
  isRecord,
  withDefaults,
  capCache,
  CortexError,
} from "./cortex-core.js";

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

  it("returns empty for text with no tech terms", () => {
    const text = "The quick brown fox jumps over the lazy dog";
    const matches = text.match(new RegExp(UNIVERSAL_TECH_TERMS_RE.source, UNIVERSAL_TECH_TERMS_RE.flags));
    expect(matches).toBeNull();
  });

  it("handles empty string", () => {
    const matches = "".match(new RegExp(UNIVERSAL_TECH_TERMS_RE.source, UNIVERSAL_TECH_TERMS_RE.flags));
    expect(matches).toBeNull();
  });
});

// ── EXTRA_ENTITY_PATTERNS ───────────────────────────────────────────────────

describe("EXTRA_ENTITY_PATTERNS", () => {
  function matchPattern(label: string, text: string): string[] {
    const pat = EXTRA_ENTITY_PATTERNS.find((p) => p.label === label);
    if (!pat) throw new Error(`No pattern with label: ${label}`);
    const re = new RegExp(pat.re.source, pat.re.flags);
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) matches.push(m[0]);
    return matches;
  }

  describe("version pattern", () => {
    it("matches semver versions", () => {
      expect(matchPattern("version", "Upgrade to v1.2.3")).toEqual(["v1.2.3"]);
    });

    it("matches versions without v prefix", () => {
      expect(matchPattern("version", "Version 2.0.0")).toEqual(["2.0.0"]);
    });

    it("matches prerelease versions", () => {
      expect(matchPattern("version", "Use 3.0.0-beta.1 for testing")).toEqual(["3.0.0-beta.1"]);
    });

    it("returns empty for non-version numbers", () => {
      expect(matchPattern("version", "port 8080 is open")).toEqual([]);
    });
  });

  describe("env_key pattern", () => {
    it("matches CORTEX_ prefixed env vars", () => {
      expect(matchPattern("env_key", "Set CORTEX_LLM_ENDPOINT to your URL")).toEqual(["CORTEX_LLM_ENDPOINT"]);
    });

    it("matches NODE_ENV style vars", () => {
      expect(matchPattern("env_key", "NODE_ENV=production")).toEqual(["NODE_ENV"]);
    });

    it("does not match single-segment uppercase words", () => {
      // "API" alone has no underscore segment, should not match
      expect(matchPattern("env_key", "The API is down")).toEqual([]);
    });

    it("matches multiple env vars in one string", () => {
      const matches = matchPattern("env_key", "CORTEX_DEBUG=1 and AWS_REGION=us-east-1");
      expect(matches).toContain("CORTEX_DEBUG");
      expect(matches).toContain("AWS_REGION");
    });
  });

  describe("file_path pattern", () => {
    it("matches absolute paths", () => {
      const matches = matchPattern("file_path", "Edit /home/user/config.json");
      expect(matches).toEqual(["/home/user/config.json"]);
    });

    it("matches relative paths", () => {
      const matches = matchPattern("file_path", "Check ./src/index.ts");
      expect(matches).toEqual(["./src/index.ts"]);
    });

    it("matches tilde paths", () => {
      const matches = matchPattern("file_path", "Stored in ~/cortex/FINDINGS.md");
      expect(matches).toEqual(["~/cortex/FINDINGS.md"]);
    });

    it("returns empty for plain text", () => {
      expect(matchPattern("file_path", "no paths here")).toEqual([]);
    });
  });

  describe("error_code pattern", () => {
    it("matches TypeScript error codes", () => {
      expect(matchPattern("error_code", "Fix TS2345 in the handler")).toEqual(["TS2345"]);
    });

    it("matches ERR_ style codes", () => {
      expect(matchPattern("error_code", "ERR_MODULE_NOT_FOUND when importing")).toEqual(["ERR_MODULE_NOT_FOUND"]);
    });

    it("returns empty for normal words", () => {
      expect(matchPattern("error_code", "Everything works fine")).toEqual([]);
    });
  });

  describe("date pattern", () => {
    it("matches ISO dates", () => {
      expect(matchPattern("date", "Fixed on 2025-03-11")).toEqual(["2025-03-11"]);
    });

    it("matches slash dates", () => {
      expect(matchPattern("date", "Deployed 2025/01/15")).toEqual(["2025/01/15"]);
    });

    it("returns empty for non-date numbers", () => {
      expect(matchPattern("date", "value is 42")).toEqual([]);
    });
  });

  it("handles empty input for all patterns", () => {
    for (const { re, label } of EXTRA_ENTITY_PATTERNS) {
      const matches = "".match(new RegExp(re.source, re.flags));
      expect(matches, `${label} should return null on empty input`).toBeNull();
    }
  });

  it("handles very long strings without hanging", () => {
    const longText = "CORTEX_DEBUG ".repeat(10000) + "v1.0.0";
    for (const { re } of EXTRA_ENTITY_PATTERNS) {
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
    for (const { re, label } of EXTRA_ENTITY_PATTERNS) {
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

// ── CortexResult helpers ────────────────────────────────────────────────────

describe("cortexOk / cortexErr / forwardErr", () => {
  it("cortexOk wraps data", () => {
    const r = cortexOk(42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBe(42);
  });

  it("cortexErr wraps error", () => {
    const r = cortexErr("bad", CortexError.FILE_NOT_FOUND);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("bad");
      expect(r.code).toBe("FILE_NOT_FOUND");
    }
  });

  it("forwardErr re-types a failed result", () => {
    const original = cortexErr<number>("oops", CortexError.PERMISSION_DENIED);
    const forwarded = forwardErr<string>(original);
    expect(forwarded.ok).toBe(false);
    if (!forwarded.ok) {
      expect(forwarded.error).toBe("oops");
      expect(forwarded.code).toBe("PERMISSION_DENIED");
    }
  });

  it("forwardErr on ok result returns generic error", () => {
    const original = cortexOk("data");
    const forwarded = forwardErr<number>(original);
    expect(forwarded.ok).toBe(false);
  });
});

// ── parseCortexErrorCode ────────────────────────────────────────────────────

describe("parseCortexErrorCode", () => {
  it("extracts known error code from prefix", () => {
    expect(parseCortexErrorCode("PROJECT_NOT_FOUND: myproject")).toBe("PROJECT_NOT_FOUND");
  });

  it("returns undefined for unknown prefix", () => {
    expect(parseCortexErrorCode("RANDOM_ERROR: something")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseCortexErrorCode("")).toBeUndefined();
  });
});

// ── isRecord ────────────────────────────────────────────────────────────────

describe("isRecord", () => {
  it("returns true for plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it("returns false for arrays", () => {
    expect(isRecord([])).toBe(false);
  });

  it("returns false for null", () => {
    expect(isRecord(null)).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isRecord("string")).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
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

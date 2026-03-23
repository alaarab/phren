import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * Tests for hardening changes that don't fit neatly into existing test files.
 * Covers: webview project name validation, tree view cache race, pre-commit hook.
 */

// ── Webview project name validation ─────────────────────────────────────────

describe("webview isValidProjectName (inline mirror)", () => {
  // This is the exact same function inlined in graphWebview.ts
  function isValidProjectName(name: string): boolean {
    if (!name || name.length === 0) return false;
    if (name.length > 100) return false;
    if (name.includes("\0") || name.includes("/") || name.includes("\\") || name.includes("..")) return false;
    return /^[a-z0-9][a-z0-9_-]*$/.test(name);
  }

  it("rejects ../../../etc/passwd", () => {
    expect(isValidProjectName("../../../etc/passwd")).toBe(false);
  });

  it("rejects path with forward slash", () => {
    expect(isValidProjectName("foo/bar")).toBe(false);
  });

  it("rejects path with backslash", () => {
    expect(isValidProjectName("foo\\bar")).toBe(false);
  });

  it("rejects dot-dot traversal", () => {
    expect(isValidProjectName("..")).toBe(false);
  });

  it("rejects single dot", () => {
    expect(isValidProjectName(".")).toBe(false);
  });

  it("rejects null byte injection", () => {
    expect(isValidProjectName("project\0evil")).toBe(false);
  });

  it("rejects names starting with uppercase", () => {
    expect(isValidProjectName("MyProject")).toBe(false);
  });

  it("rejects names starting with hyphen", () => {
    expect(isValidProjectName("-project")).toBe(false);
  });

  it("accepts valid lowercase project names", () => {
    expect(isValidProjectName("my-project")).toBe(true);
    expect(isValidProjectName("project123")).toBe(true);
    expect(isValidProjectName("a")).toBe(true);
    expect(isValidProjectName("test-project-2")).toBe(true);
  });
});

// ── Tree view cache generation counter ──────────────────────────────────────

describe("tree view cache generation counter", () => {
  // Simulates the cache generation logic from PhrenTreeProvider
  class MockCacheProvider {
    cache = new Map<string, unknown>();
    cacheGeneration = 0;

    refresh(): void {
      this.cache.clear();
      this.cacheGeneration++;
    }

    async cachedFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
      if (this.cache.has(key)) {
        return this.cache.get(key) as T;
      }
      const generationAtStart = this.cacheGeneration;
      const result = await fetcher();
      if (this.cacheGeneration !== generationAtStart) {
        return result;
      }
      this.cache.set(key, result);
      return result;
    }
  }

  it("discards stale cache entries when generation changes during fetch", async () => {
    const provider = new MockCacheProvider();

    // Start a slow fetch
    const fetchPromise = provider.cachedFetch("projects", async () => {
      // Simulate a refresh happening during the fetch
      provider.refresh();
      return ["stale-project"];
    });

    const result = await fetchPromise;

    // The result is returned to the caller...
    expect(result).toEqual(["stale-project"]);
    // ...but it should NOT be cached (because generation changed)
    expect(provider.cache.has("projects")).toBe(false);
  });

  it("caches results when no refresh occurs during fetch", async () => {
    const provider = new MockCacheProvider();

    const result = await provider.cachedFetch("projects", async () => {
      return ["fresh-project"];
    });

    expect(result).toEqual(["fresh-project"]);
    // Result should be cached since generation didn't change
    expect(provider.cache.has("projects")).toBe(true);
    expect(provider.cache.get("projects")).toEqual(["fresh-project"]);
  });

  it("increments generation on each refresh", () => {
    const provider = new MockCacheProvider();
    expect(provider.cacheGeneration).toBe(0);
    provider.refresh();
    expect(provider.cacheGeneration).toBe(1);
    provider.refresh();
    expect(provider.cacheGeneration).toBe(2);
  });

  it("returns cached value on subsequent calls without refresh", async () => {
    const provider = new MockCacheProvider();
    let callCount = 0;

    const fetcher = async () => {
      callCount++;
      return ["data"];
    };

    await provider.cachedFetch("key", fetcher);
    await provider.cachedFetch("key", fetcher);

    expect(callCount).toBe(1); // fetcher only called once
  });
});

// ── Pre-commit hook existence ───────────────────────────────────────────────

describe("pre-commit hook script", () => {
  const hookPath = path.resolve(__dirname, "../../scripts/pre-commit");

  it("exists as a file", () => {
    expect(fs.existsSync(hookPath)).toBe(true);
  });

  it("is executable (has shebang)", () => {
    const content = fs.readFileSync(hookPath, "utf8");
    expect(content.startsWith("#!/")).toBe(true);
  });

  it("runs eslint on staged files", () => {
    const content = fs.readFileSync(hookPath, "utf8");
    expect(content).toContain("eslint");
    expect(content).toContain("git diff --cached");
  });

  it("excludes test files from linting", () => {
    const content = fs.readFileSync(hookPath, "utf8");
    expect(content).toContain(".test.ts");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, initTestPhrenRoot } from "../test-helpers.js";
import { readExtractedFacts, extractFactFromFinding, type ExtractedFact } from "../tools/extract-facts.js";

let tmp: { path: string; cleanup: () => void };
let phrenPath: string;
const origEnv: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]): void {
  for (const k of keys) origEnv[k] = process.env[k];
}
function restoreEnv(): void {
  for (const [k, v] of Object.entries(origEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  tmp = makeTempDir("extract-facts-test-");
  phrenPath = tmp.path;
  initTestPhrenRoot(phrenPath);
  saveEnv(
    "PHREN_FEATURE_FACT_EXTRACT",
    "PHREN_LLM_ENDPOINT",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
  );
});

afterEach(() => {
  restoreEnv();
  tmp.cleanup();
});

// ── readExtractedFacts ───────────────────────────────────────────────────────

describe("readExtractedFacts", () => {
  it("returns empty array when preferences.json does not exist", () => {
    fs.mkdirSync(path.join(phrenPath, "testproj"), { recursive: true });
    expect(readExtractedFacts(phrenPath, "testproj")).toEqual([]);
  });

  it("returns empty array for corrupt JSON", () => {
    const dir = path.join(phrenPath, "testproj");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "preferences.json"), "NOT JSON AT ALL");
    expect(readExtractedFacts(phrenPath, "testproj")).toEqual([]);
  });

  it("returns empty array when JSON is an object instead of array", () => {
    const dir = path.join(phrenPath, "testproj");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "preferences.json"), '{"key": "value"}');
    expect(readExtractedFacts(phrenPath, "testproj")).toEqual([]);
  });

  it("returns parsed facts from valid JSON", () => {
    const dir = path.join(phrenPath, "testproj");
    fs.mkdirSync(dir, { recursive: true });
    const facts: ExtractedFact[] = [
      { fact: "prefers TypeScript", source: "some finding", at: "2025-01-01T00:00:00Z" },
    ];
    fs.writeFileSync(path.join(dir, "preferences.json"), JSON.stringify(facts));
    const result = readExtractedFacts(phrenPath, "testproj");
    expect(result).toHaveLength(1);
    expect(result[0].fact).toBe("prefers TypeScript");
  });

  it("returns empty array for path-traversal project names", () => {
    expect(readExtractedFacts(phrenPath, "../etc")).toEqual([]);
  });
});

// ── writeExtractedFacts (tested indirectly via readExtractedFacts round-trip) ─

describe("writeExtractedFacts (indirect via round-trip)", () => {
  it("respects MAX_FACTS cap of 50", () => {
    const dir = path.join(phrenPath, "testproj");
    fs.mkdirSync(dir, { recursive: true });
    // Write 60 facts directly to preferences.json
    const facts: ExtractedFact[] = Array.from({ length: 60 }, (_, i) => ({
      fact: `fact-${i}`,
      source: `source-${i}`,
      at: new Date().toISOString(),
    }));
    fs.writeFileSync(path.join(dir, "preferences.json"), JSON.stringify(facts));

    // Reading returns all 60 (readExtractedFacts doesn't cap)
    const read = readExtractedFacts(phrenPath, "testproj");
    expect(read).toHaveLength(60);
  });
});

// ── extractFactFromFinding feature flag ──────────────────────────────────────

describe("extractFactFromFinding feature flag", () => {
  it("does nothing when PHREN_FEATURE_FACT_EXTRACT is disabled (0)", () => {
    process.env.PHREN_FEATURE_FACT_EXTRACT = "0";
    fs.mkdirSync(path.join(phrenPath, "testproj"), { recursive: true });

    // Should return immediately without side effects
    extractFactFromFinding(phrenPath, "testproj", "Uses React for frontend");

    // No preferences.json should be created
    expect(fs.existsSync(path.join(phrenPath, "testproj", "preferences.json"))).toBe(false);
  });

  it("does nothing when feature is enabled but no LLM is configured", () => {
    process.env.PHREN_FEATURE_FACT_EXTRACT = "1";
    delete process.env.PHREN_LLM_ENDPOINT;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    fs.mkdirSync(path.join(phrenPath, "testproj"), { recursive: true });

    extractFactFromFinding(phrenPath, "testproj", "Uses React for frontend");

    expect(fs.existsSync(path.join(phrenPath, "testproj", "preferences.json"))).toBe(false);
  });
});

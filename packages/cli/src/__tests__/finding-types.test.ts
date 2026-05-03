import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { FINDING_TYPES, FINDING_TAGS, DOC_TYPES } from "../shared.js";
import { entryScoreKey } from "../shared/governance.js";
import {
  FINDING_TYPE_DECAY,
  extractFindingType,
} from "../finding/lifecycle.js";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { addFindingToFile } from "../content/learning.js";

// ── Taxonomy consistency ────────────────────────────────────────────────────

describe("taxonomy consistency", () => {
  it("FINDING_TYPES is a subset of FINDING_TAGS", () => {
    for (const t of FINDING_TYPES) {
      expect(FINDING_TAGS).toContain(t);
    }
  });

  it("DOC_TYPES includes findings and canonical", () => {
    expect(DOC_TYPES).toContain("findings");
    expect(DOC_TYPES).toContain("canonical");
  });

  it("FINDING_TYPES has all 6 unified tags", () => {
    expect(FINDING_TYPES).toHaveLength(6);
    expect(FINDING_TYPES).toContain("decision");
    expect(FINDING_TYPES).toContain("pitfall");
    expect(FINDING_TYPES).toContain("pattern");
    expect(FINDING_TYPES).toContain("tradeoff");
    expect(FINDING_TYPES).toContain("architecture");
    expect(FINDING_TYPES).toContain("bug");
  });
});

// ── entryScoreKey stability ─────────────────────────────────────────────────

describe("entryScoreKey stability", () => {
  it("produces the same key for content with trailing text beyond 200 chars", () => {
    const base = "Redis connections need explicit close in finally blocks. ".repeat(5);
    const keyA = entryScoreKey("proj", "FINDINGS.md", base);
    const keyB = entryScoreKey("proj", "FINDINGS.md", base + " extra content that would differ if not sliced ".repeat(10));
    expect(keyA).toBe(keyB);
  });

  it("produces different keys for different projects", () => {
    const content = "Some finding text for testing";
    const keyA = entryScoreKey("proj-a", "FINDINGS.md", content);
    const keyB = entryScoreKey("proj-b", "FINDINGS.md", content);
    expect(keyA).not.toBe(keyB);
  });

  it("produces different keys for different filenames", () => {
    const content = "Some finding text";
    const keyA = entryScoreKey("proj", "FINDINGS.md", content);
    const keyB = entryScoreKey("proj", "CLAUDE.md", content);
    expect(keyA).not.toBe(keyB);
  });
});

// ── Finding type decay ──────────────────────────────────────────────────────

describe("finding type decay", () => {
  it("observations decay faster than patterns", () => {
    const observation = '- [observation] Login page shows error <!-- phren:created "2025-01-01" -->';
    const pattern = '- [pattern] Always clear dist before tsconfig change <!-- phren:created "2025-01-01" -->';

    const obsType = extractFindingType(observation);
    const patType = extractFindingType(pattern);

    expect(obsType).toBe("observation");
    expect(patType).toBe("pattern");
    expect(FINDING_TYPE_DECAY["observation"].maxAgeDays).toBe(14);
    expect(FINDING_TYPE_DECAY["pattern"].maxAgeDays).toBe(365);
  });

  it("decisions never decay", () => {
    expect(FINDING_TYPE_DECAY["decision"].maxAgeDays).toBe(Infinity);
    expect(FINDING_TYPE_DECAY["anti-pattern"].maxAgeDays).toBe(Infinity);
  });

  it("extractFindingType returns null for untagged findings", () => {
    expect(extractFindingType("- Some random finding")).toBeNull();
  });

  it("extractFindingType handles context tag", () => {
    expect(extractFindingType("- [context] Deployed v2.3.1 to staging")).toBe("context");
  });

  it("extractFindingType returns null for unknown tags", () => {
    expect(extractFindingType("- [foobar] Some finding")).toBeNull();
  });

  it("extractFindingType is case-insensitive", () => {
    expect(extractFindingType("- [PATTERN] Upper case tag")).toBe("pattern");
    expect(extractFindingType("- [Decision] Mixed case tag")).toBe("decision");
  });

  it("all defined types have valid config", () => {
    for (const [type, config] of Object.entries(FINDING_TYPE_DECAY)) {
      expect(config.maxAgeDays).toBeGreaterThan(0);
      expect(config.decayMultiplier).toBeGreaterThan(0);
      expect(config.decayMultiplier).toBeLessThanOrEqual(1);
      expect(typeof type).toBe("string");
    }
  });
});

// ── Typed findings persistence (decision|pitfall|pattern) ───────────────────

describe("typed findings (decision|pitfall|pattern)", () => {
  let tmp: { path: string; cleanup: () => void };

  function seedProject(phrenPath: string, project = "myapp") {
    const dir = path.join(phrenPath, project);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "summary.md"), `# ${project}\n`);
  }

  beforeEach(() => {
    tmp = makeTempDir("mcp-finding-types-");
    grantAdmin(tmp.path);
    seedProject(tmp.path);
  });
  afterEach(() => {
    delete process.env.PHREN_ACTOR;
    tmp.cleanup();
  });

  function findingsPath(project = "myapp") {
    return path.join(tmp.path, project, "FINDINGS.md");
  }

  it("stores a [decision] tag inline", () => {
    const r = addFindingToFile(tmp.path, "myapp", "[decision] Use PostgreSQL over MySQL for full-text search");
    expect(r.ok).toBe(true);
    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toContain("[decision] Use PostgreSQL over MySQL");
  });

  it("stores a [pitfall] tag inline", () => {
    const r = addFindingToFile(tmp.path, "myapp", "[pitfall] Redis connections must be closed in finally blocks");
    expect(r.ok).toBe(true);
    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toContain("[pitfall] Redis connections");
  });

  it("stores a [pattern] tag inline", () => {
    const r = addFindingToFile(tmp.path, "myapp", "[pattern] Use repository pattern to separate data access from business logic");
    expect(r.ok).toBe(true);
    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toContain("[pattern] Use repository pattern");
  });

  it("stores untagged findings without modification", () => {
    const r = addFindingToFile(tmp.path, "myapp", "Always restart the service after env changes");
    expect(r.ok).toBe(true);
    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toContain("Always restart the service after env changes");
    expect(content).not.toMatch(/- \[(decision|pitfall|pattern)\]/);
  });

  it("normalizes tag casing to lowercase", () => {
    addFindingToFile(tmp.path, "myapp", "[DECISION] Use monorepo");
    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toContain("[decision] Use monorepo");
  });

  it("all three types can coexist in the same FINDINGS.md", () => {
    addFindingToFile(tmp.path, "myapp", "[decision] Use Redis for caching");
    addFindingToFile(tmp.path, "myapp", "[pitfall] Avoid N+1 queries");
    addFindingToFile(tmp.path, "myapp", "[pattern] Use optimistic locking for concurrent writes");
    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toContain("[decision]");
    expect(content).toContain("[pitfall]");
    expect(content).toContain("[pattern]");
  });
});

// ── findingType prefix application ──────────────────────────────────────────
// Regression guard for the "doubled tag" bug where add_finding(finding="[pattern] X",
// findingType="pattern") used to store "[pattern] [pattern] X". Same shape produced
// "[bug] [critical bug]" and "[pitfall] [pitfall]" rows in the wild.

describe("applyFindingTypePrefix", () => {
  it("prepends findingType when text has no tag", async () => {
    const { applyFindingTypePrefix } = await import("../core/finding.js");
    expect(applyFindingTypePrefix("plain text", "pattern")).toBe("[pattern] plain text");
  });

  it("does not double-prepend when text already starts with the same tag", async () => {
    const { applyFindingTypePrefix } = await import("../core/finding.js");
    expect(applyFindingTypePrefix("[pattern] foo", "pattern")).toBe("[pattern] foo");
  });

  it("preserves a user-supplied refinement tag instead of replacing it", async () => {
    const { applyFindingTypePrefix } = await import("../core/finding.js");
    expect(applyFindingTypePrefix("[critical bug] X", "bug")).toBe("[critical bug] X");
  });

  it("returns text unchanged when findingType is undefined", async () => {
    const { applyFindingTypePrefix } = await import("../core/finding.js");
    expect(applyFindingTypePrefix("plain text", undefined)).toBe("plain text");
  });

  it("handles leading whitespace before existing tag", async () => {
    const { applyFindingTypePrefix } = await import("../core/finding.js");
    expect(applyFindingTypePrefix("  [pattern] foo", "pattern")).toBe("  [pattern] foo");
  });
});

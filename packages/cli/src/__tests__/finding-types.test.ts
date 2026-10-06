import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { FINDING_TYPES, FINDING_TAGS, DOC_TYPES } from "../shared.js";
import {
  FINDING_TYPE_DECAY,
  extractFindingType,
} from "../finding/lifecycle.js";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { addFindingToFile, autoDetectFindingType } from "../content/learning.js";

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
    expect(DOC_TYPES).toContain("notes");
  });

  it("FINDING_TYPES has the 4 offered tags (the intersection of what used to be 3 disjoint lists)", () => {
    expect(FINDING_TYPES).toHaveLength(4);
    expect(FINDING_TYPES).toContain("decision");
    expect(FINDING_TYPES).toContain("pitfall");
    expect(FINDING_TYPES).toContain("pattern");
    expect(FINDING_TYPES).toContain("bug");
    // tradeoff/architecture used to be offered here with no decay rule and no
    // max-age (see "decisions never decay" below) — dropped from the offered
    // set. Existing [tradeoff]/[architecture] bullets still read/search fine
    // as plain text; they just aren't offered or decay-tracked anymore.
    expect(FINDING_TYPES).not.toContain("tradeoff");
    expect(FINDING_TYPES).not.toContain("architecture");
  });

  it("FINDING_TAGS adds phren's auto-write-only tags on top of FINDING_TYPES", () => {
    expect(FINDING_TAGS).toHaveLength(6);
    expect(FINDING_TAGS).toContain("workaround");
    expect(FINDING_TAGS).toContain("context");
  });

  it("FINDING_TYPE_DECAY has exactly one row per FINDING_TAGS entry — no more, no less", () => {
    const decayKeys = Object.keys(FINDING_TYPE_DECAY).sort();
    const tagKeys = [...FINDING_TAGS].sort();
    expect(decayKeys).toEqual(tagKeys);
  });

  it("autoDetectFindingType can only produce tags that are in FINDING_TAGS", () => {
    const samples = [
      "we decided to use postgres",
      "found a bug in the retry loop",
      "applied a temporary fix for the daemon crash",
      "always clear dist before a tsconfig change",
      "watch out for the stale cache pitfall",
      "currently deployed v2.3.1 to staging",
    ];
    for (const text of samples) {
      const detected = autoDetectFindingType(text);
      expect(detected).not.toBeNull();
      expect(FINDING_TAGS).toContain(detected);
    }
  });
});

// ── entryScoreKey stability ─────────────────────────────────────────────────

// ── Finding type decay ──────────────────────────────────────────────────────

describe("finding type decay", () => {
  it("context decays faster than patterns", () => {
    // "observation" used to have a decay row here (maxAgeDays: 14) but was
    // never an offered or auto-detected tag — nothing could ever produce it,
    // so it was dead weight. "context" is the tag phren's own auto-detector
    // actually writes for this kind of fast-decaying, short-lived note.
    const context = '- [context] Deployed v2.3.1 to staging <!-- phren:created "2025-01-01" -->';
    const pattern = '- [pattern] Always clear dist before tsconfig change <!-- phren:created "2025-01-01" -->';

    const ctxType = extractFindingType(context);
    const patType = extractFindingType(pattern);

    expect(ctxType).toBe("context");
    expect(patType).toBe("pattern");
    expect(FINDING_TYPE_DECAY["context"].maxAgeDays).toBeLessThan(FINDING_TYPE_DECAY["pattern"].maxAgeDays);
  });

  it("decisions never decay", () => {
    // "anti-pattern" used to have a row here (also Infinity) but, like
    // "observation" above, nothing could ever produce it — dropped as dead
    // weight along with the rest of the unproducible rows.
    expect(FINDING_TYPE_DECAY["decision"].maxAgeDays).toBe(Infinity);
  });

  it("extractFindingType returns null for untagged findings", () => {
    expect(extractFindingType("- Some random finding")).toBeNull();
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

  it.each([
    ["[decision] Use PostgreSQL over MySQL for full-text search", "[decision] Use PostgreSQL over MySQL"],
    ["[pitfall] Redis connections must be closed in finally blocks", "[pitfall] Redis connections"],
    ["[pattern] Use repository pattern to separate data access from business logic", "[pattern] Use repository pattern"],
  ])("stores a type tag inline: %s", (finding, stored) => {
    const r = addFindingToFile(tmp.path, "myapp", finding);
    expect(r.ok).toBe(true);
    const content = fs.readFileSync(findingsPath(), "utf-8");
    expect(content).toContain(stored);
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

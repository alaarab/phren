import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, initTestPhrenRoot } from "../test-helpers.js";
import {
  getRetentionPolicy,
  updateRetentionPolicy,
  getWorkflowPolicy,
  updateWorkflowPolicy,
  getIndexPolicy,
  updateIndexPolicy,
  getRuntimeHealth,
  updateRuntimeHealth,
  validateGovernanceJson,
  appendReviewQueue,
  normalizeQueueEntryText,
  MAX_QUEUE_ENTRY_LENGTH,
  GOVERNANCE_SCHEMA_VERSION,
  type RetentionPolicy,
  type WorkflowPolicy,
  type IndexPolicy,
  VALID_TASK_MODES,
  VALID_FINDING_SENSITIVITY,
} from "../governance/governance-policy.js";

function writeGovJson(phrenPath: string, filename: string, data: Record<string, unknown>): void {
  const dir = path.join(phrenPath, ".config");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2) + "\n");
}

let tmp: { path: string; cleanup: () => void };
let phrenPath: string;

beforeEach(() => {
  tmp = makeTempDir("gov-policy-test-");
  phrenPath = tmp.path;
  initTestPhrenRoot(phrenPath);
});

afterEach(() => {
  tmp.cleanup();
});

// ── Retention Policy ───────────────────────────────────────────────────────

describe("getRetentionPolicy", () => {
  it("returns defaults when no file exists", () => {
    const policy = getRetentionPolicy(phrenPath);
    expect(policy.ttlDays).toBe(120);
    expect(policy.retentionDays).toBe(365);
    expect(policy.autoAcceptThreshold).toBe(0.75);
    expect(policy.minInjectConfidence).toBe(0.35);
    expect(policy.decay.d30).toBe(1.0);
    expect(policy.decay.d60).toBe(0.85);
    expect(policy.decay.d90).toBe(0.65);
    expect(policy.decay.d120).toBe(0.45);
  });

  it("reads custom values from file", () => {
    writeGovJson(phrenPath, "retention-policy.json", {
      ttlDays: 60,
      retentionDays: 180,
      autoAcceptThreshold: 0.5,
      minInjectConfidence: 0.2,
      decay: { d30: 0.9, d60: 0.7, d90: 0.5, d120: 0.3 },
    });
    const policy = getRetentionPolicy(phrenPath);
    expect(policy.ttlDays).toBe(60);
    expect(policy.retentionDays).toBe(180);
    expect(policy.decay.d30).toBe(0.9);
  });

  it("falls back to defaults for invalid JSON", () => {
    const dir = path.join(phrenPath, ".config");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "retention-policy.json"), "not-json");
    const policy = getRetentionPolicy(phrenPath);
    expect(policy.ttlDays).toBe(120);
  });

  it("fills missing fields with defaults (partial file)", () => {
    writeGovJson(phrenPath, "retention-policy.json", { ttlDays: 30 });
    const policy = getRetentionPolicy(phrenPath);
    expect(policy.ttlDays).toBe(30);
    expect(policy.retentionDays).toBe(365); // default
    expect(policy.decay.d30).toBe(1.0); // default
  });
});

describe("updateRetentionPolicy", () => {
  it("patches and persists retention policy", () => {
    const result = updateRetentionPolicy(phrenPath, { ttlDays: 60 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.ttlDays).toBe(60);
    expect(result.data.retentionDays).toBe(365); // unchanged default

    // Verify persisted
    const reread = getRetentionPolicy(phrenPath);
    expect(reread.ttlDays).toBe(60);
  });

  it("patches decay sub-object independently", () => {
    const result = updateRetentionPolicy(phrenPath, { decay: { d30: 0.5 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.decay.d30).toBe(0.5);
    expect(result.data.decay.d60).toBe(0.85); // unchanged
  });

  it("writes audit log entry", () => {
    updateRetentionPolicy(phrenPath, { ttlDays: 30 });
    const auditPath = path.join(phrenPath, ".runtime", "audit.log");
    expect(fs.existsSync(auditPath)).toBe(true);
    const log = fs.readFileSync(auditPath, "utf8");
    expect(log).toContain("update_policy");
  });
});

// ── Workflow Policy ────────────────────────────────────────────────────────

describe("getWorkflowPolicy", () => {
  it("returns defaults when no file exists", () => {
    const policy = getWorkflowPolicy(phrenPath);
    expect(policy.taskMode).toBe("auto");
    expect(policy.findingSensitivity).toBe("balanced");
    expect(policy.lowConfidenceThreshold).toBe(0.7);
    expect(policy.riskySections).toContain("Stale");
    expect(policy.riskySections).toContain("Conflicts");
  });

  it("normalizes invalid taskMode to default", () => {
    writeGovJson(phrenPath, "workflow-policy.json", { taskMode: "bogus" });
    const policy = getWorkflowPolicy(phrenPath);
    expect(policy.taskMode).toBe("auto");
  });

  it("normalizes invalid findingSensitivity to default", () => {
    writeGovJson(phrenPath, "workflow-policy.json", { findingSensitivity: "extreme" });
    const policy = getWorkflowPolicy(phrenPath);
    expect(policy.findingSensitivity).toBe("balanced");
  });

  it("filters invalid riskySections entries", () => {
    writeGovJson(phrenPath, "workflow-policy.json", { riskySections: ["Review", "Bogus", "Stale"] });
    const policy = getWorkflowPolicy(phrenPath);
    expect(policy.riskySections).toEqual(["Review", "Stale"]);
  });

  it("falls back to default riskySections when all entries are invalid", () => {
    writeGovJson(phrenPath, "workflow-policy.json", { riskySections: ["Bogus"] });
    const policy = getWorkflowPolicy(phrenPath);
    expect(policy.riskySections).toContain("Stale");
    expect(policy.riskySections).toContain("Conflicts");
  });
});

describe("updateWorkflowPolicy", () => {
  it("patches and persists workflow policy", () => {
    const result = updateWorkflowPolicy(phrenPath, { taskMode: "manual" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.taskMode).toBe("manual");
    expect(result.data.findingSensitivity).toBe("balanced"); // unchanged

    const reread = getWorkflowPolicy(phrenPath);
    expect(reread.taskMode).toBe("manual");
  });

  it("rejects invalid taskMode in patch", () => {
    const result = updateWorkflowPolicy(phrenPath, { taskMode: "invalid" as any });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Should keep the current/default value
    expect(VALID_TASK_MODES).toContain(result.data.taskMode);
  });

  it("updates findingSensitivity", () => {
    const result = updateWorkflowPolicy(phrenPath, { findingSensitivity: "aggressive" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.findingSensitivity).toBe("aggressive");
  });

  it("rejects invalid findingSensitivity in patch", () => {
    const result = updateWorkflowPolicy(phrenPath, { findingSensitivity: "extreme" as any });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(VALID_FINDING_SENSITIVITY).toContain(result.data.findingSensitivity);
  });

  it("filters invalid riskySections in patch", () => {
    const result = updateWorkflowPolicy(phrenPath, {
      riskySections: ["Review", "Bogus" as any, "Conflicts"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.riskySections).toEqual(["Review", "Conflicts"]);
  });

  it("updates lowConfidenceThreshold", () => {
    const result = updateWorkflowPolicy(phrenPath, { lowConfidenceThreshold: 0.3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.lowConfidenceThreshold).toBe(0.3);
  });
});

// ── Index Policy ───────────────────────────────────────────────────────────

describe("getIndexPolicy", () => {
  it("returns defaults when no file exists", () => {
    const policy = getIndexPolicy(phrenPath);
    expect(policy.includeGlobs).toContain("**/*.md");
    expect(policy.excludeGlobs).toContain("**/.git/**");
    expect(policy.includeHidden).toBe(false);
  });

  it("reads custom values from file", () => {
    writeGovJson(phrenPath, "index-policy.json", {
      includeGlobs: ["**/*.txt"],
      excludeGlobs: ["**/tmp/**"],
      includeHidden: true,
    });
    const policy = getIndexPolicy(phrenPath);
    expect(policy.includeGlobs).toEqual(["**/*.txt"]);
    expect(policy.excludeGlobs).toEqual(["**/tmp/**"]);
    expect(policy.includeHidden).toBe(true);
  });

  it("falls back to defaults for empty glob arrays", () => {
    writeGovJson(phrenPath, "index-policy.json", { includeGlobs: [], excludeGlobs: [] });
    const policy = getIndexPolicy(phrenPath);
    expect(policy.includeGlobs.length).toBeGreaterThan(0);
    expect(policy.excludeGlobs.length).toBeGreaterThan(0);
  });

  it("filters out empty strings from globs", () => {
    writeGovJson(phrenPath, "index-policy.json", {
      includeGlobs: ["**/*.md", "", "  "],
      excludeGlobs: ["**/.git/**"],
    });
    const policy = getIndexPolicy(phrenPath);
    expect(policy.includeGlobs).toEqual(["**/*.md"]);
  });
});

describe("updateIndexPolicy", () => {
  it("patches and persists index policy", () => {
    const result = updateIndexPolicy(phrenPath, { includeHidden: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.includeHidden).toBe(true);

    const reread = getIndexPolicy(phrenPath);
    expect(reread.includeHidden).toBe(true);
  });

  it("filters empty strings from patched globs", () => {
    const result = updateIndexPolicy(phrenPath, { includeGlobs: ["**/*.rs", "", "  "] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.includeGlobs).toEqual(["**/*.rs"]);
  });

  it("keeps current globs when patch has no glob field", () => {
    updateIndexPolicy(phrenPath, { includeGlobs: ["**/*.py"] });
    const result = updateIndexPolicy(phrenPath, { includeHidden: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.includeGlobs).toEqual(["**/*.py"]);
  });
});

// ── Validation ─────────────────────────────────────────────────────────────

describe("validateGovernanceJson", () => {
  it("returns true for nonexistent file", () => {
    expect(validateGovernanceJson("/no/such/file.json", "retention-policy")).toBe(true);
  });

  it("returns true for valid retention policy", () => {
    const filePath = path.join(phrenPath, ".config", "retention-policy.json");
    writeGovJson(phrenPath, "retention-policy.json", {
      ttlDays: 60,
      retentionDays: 180,
      autoAcceptThreshold: 0.5,
    });
    expect(validateGovernanceJson(filePath, "retention-policy")).toBe(true);
  });

  it("returns false for non-object JSON", () => {
    const dir = path.join(phrenPath, ".config");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "retention-policy.json");
    fs.writeFileSync(filePath, '"just a string"');
    expect(validateGovernanceJson(filePath, "retention-policy")).toBe(false);
  });

  it("returns false for invalid numeric fields", () => {
    const filePath = path.join(phrenPath, ".config", "retention-policy.json");
    writeGovJson(phrenPath, "retention-policy.json", { ttlDays: "not-a-number" });
    expect(validateGovernanceJson(filePath, "retention-policy")).toBe(false);
  });

  it("returns true for valid workflow policy", () => {
    const filePath = path.join(phrenPath, ".config", "workflow-policy.json");
    writeGovJson(phrenPath, "workflow-policy.json", {
      taskMode: "auto",
      findingSensitivity: "balanced",
    });
    expect(validateGovernanceJson(filePath, "workflow-policy")).toBe(true);
  });

  it("returns true for valid index policy", () => {
    const filePath = path.join(phrenPath, ".config", "index-policy.json");
    writeGovJson(phrenPath, "index-policy.json", {
      includeGlobs: ["**/*.md"],
      excludeGlobs: ["**/.git/**"],
      includeHidden: false,
    });
    expect(validateGovernanceJson(filePath, "index-policy")).toBe(true);
  });

  it("returns false for broken JSON", () => {
    const dir = path.join(phrenPath, ".config");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "workflow-policy.json");
    fs.writeFileSync(filePath, "{{{{");
    expect(validateGovernanceJson(filePath, "workflow-policy")).toBe(false);
  });
});

// ── Runtime Health ─────────────────────────────────────────────────────────

describe("getRuntimeHealth", () => {
  it("returns defaults when no file exists", () => {
    const health = getRuntimeHealth(phrenPath);
    expect(health.schemaVersion).toBe(GOVERNANCE_SCHEMA_VERSION);
    expect(health.lastSessionStartAt).toBeUndefined();
    expect(health.lastPromptAt).toBeUndefined();
  });
});

describe("updateRuntimeHealth", () => {
  it("patches and persists health data", () => {
    const now = new Date().toISOString();
    const updated = updateRuntimeHealth(phrenPath, { lastSessionStartAt: now });
    expect(updated.lastSessionStartAt).toBe(now);

    const reread = getRuntimeHealth(phrenPath);
    expect(reread.lastSessionStartAt).toBe(now);
  });

  it("merges lastSync fields incrementally", () => {
    updateRuntimeHealth(phrenPath, { lastSync: { lastPullAt: "2026-01-01T00:00:00Z" } });
    updateRuntimeHealth(phrenPath, { lastSync: { lastPushAt: "2026-01-02T00:00:00Z" } });

    const health = getRuntimeHealth(phrenPath);
    expect(health.lastSync?.lastPullAt).toBe("2026-01-01T00:00:00Z");
    expect(health.lastSync?.lastPushAt).toBe("2026-01-02T00:00:00Z");
  });

  it("preserves lastAutoSave across updates", () => {
    updateRuntimeHealth(phrenPath, {
      lastAutoSave: { at: "2026-01-01T00:00:00Z", status: "saved-local" },
    });
    updateRuntimeHealth(phrenPath, { lastPromptAt: "2026-01-02T00:00:00Z" });

    const health = getRuntimeHealth(phrenPath);
    expect(health.lastAutoSave?.status).toBe("saved-local");
    expect(health.lastPromptAt).toBe("2026-01-02T00:00:00Z");
  });
});

// ── Queue Entry Normalization ──────────────────────────────────────────────

describe("normalizeQueueEntryText", () => {
  it("cleans whitespace and special chars", () => {
    const result = normalizeQueueEntryText("  hello   world  ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.text).toBe("hello world");
  });

  it("rejects empty text", () => {
    const result = normalizeQueueEntryText("   ");
    expect(result.ok).toBe(false);
  });

  it("rejects text exceeding max length when truncate is false", () => {
    const longText = "a".repeat(MAX_QUEUE_ENTRY_LENGTH + 100);
    const result = normalizeQueueEntryText(longText);
    expect(result.ok).toBe(false);
  });

  it("truncates text when truncate option is set", () => {
    const longText = "a".repeat(MAX_QUEUE_ENTRY_LENGTH + 100);
    const result = normalizeQueueEntryText(longText, { truncate: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.truncated).toBe(true);
    expect(result.data.text.length).toBeLessThanOrEqual(MAX_QUEUE_ENTRY_LENGTH);
  });

  it("strips HTML comments", () => {
    const result = normalizeQueueEntryText("before <!-- comment --> after");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.text).toBe("before after");
  });

  it("strips escape sequences", () => {
    const result = normalizeQueueEntryText("line\\none");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.text).toBe("line one");
  });
});

// ── Review Queue ───────────────────────────────────────────────────────────

describe("appendReviewQueue", () => {
  const PROJECT = "review-test";

  beforeEach(() => {
    fs.mkdirSync(path.join(phrenPath, PROJECT), { recursive: true });
  });

  it("creates review.md when it does not exist", () => {
    const result = appendReviewQueue(phrenPath, PROJECT, "Review", ["Item one"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBe(1);

    const content = fs.readFileSync(path.join(phrenPath, PROJECT, "review.md"), "utf8");
    expect(content).toContain("Item one");
  });

  it("appends to existing review.md", () => {
    appendReviewQueue(phrenPath, PROJECT, "Review", ["First"]);
    const result = appendReviewQueue(phrenPath, PROJECT, "Review", ["Second"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBe(1);

    const content = fs.readFileSync(path.join(phrenPath, PROJECT, "review.md"), "utf8");
    expect(content).toContain("First");
    expect(content).toContain("Second");
  });

  it("deduplicates identical entries", () => {
    appendReviewQueue(phrenPath, PROJECT, "Review", ["Unique item"]);
    const result = appendReviewQueue(phrenPath, PROJECT, "Review", ["Unique item"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBe(0); // no new items added
  });

  it("writes to correct section (Stale)", () => {
    const result = appendReviewQueue(phrenPath, PROJECT, "Stale", ["Stale entry"]);
    expect(result.ok).toBe(true);

    const content = fs.readFileSync(path.join(phrenPath, PROJECT, "review.md"), "utf8");
    expect(content).toContain("## Stale");
    expect(content).toContain("Stale entry");
  });

  it("writes to correct section (Conflicts)", () => {
    const result = appendReviewQueue(phrenPath, PROJECT, "Conflicts", ["Conflict entry"]);
    expect(result.ok).toBe(true);

    const content = fs.readFileSync(path.join(phrenPath, PROJECT, "review.md"), "utf8");
    expect(content).toContain("## Conflicts");
    expect(content).toContain("Conflict entry");
  });

  it("returns 0 for empty entries array", () => {
    const result = appendReviewQueue(phrenPath, PROJECT, "Review", []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBe(0);
  });

  it("rejects invalid project name", () => {
    const result = appendReviewQueue(phrenPath, "../escape", "Review", ["test"]);
    expect(result.ok).toBe(false);
  });

  it("rejects nonexistent project", () => {
    const result = appendReviewQueue(phrenPath, "no-such-project", "Review", ["test"]);
    expect(result.ok).toBe(false);
  });

  it("truncates oversized entries instead of rejecting", () => {
    const longEntry = "x".repeat(MAX_QUEUE_ENTRY_LENGTH + 50);
    const result = appendReviewQueue(phrenPath, PROJECT, "Review", [longEntry]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBe(1);
  });
});

// ── Schema version handling ────────────────────────────────────────────────

describe("schema version handling", () => {
  it("writes schemaVersion on policy update", () => {
    updateRetentionPolicy(phrenPath, { ttlDays: 30 });
    const filePath = path.join(phrenPath, ".config", "retention-policy.json");
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.schemaVersion).toBe(GOVERNANCE_SCHEMA_VERSION);
  });

  it("reads files with future schemaVersion (forward-compat)", () => {
    writeGovJson(phrenPath, "retention-policy.json", {
      schemaVersion: 999,
      ttlDays: 42,
    });
    // Should still read without error
    const policy = getRetentionPolicy(phrenPath);
    expect(policy.ttlDays).toBe(42);
  });
});

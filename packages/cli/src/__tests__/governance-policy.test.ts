import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
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
  pruneDeadMemories,
  normalizeQueueEntryText,
  MAX_QUEUE_ENTRY_LENGTH,
  GOVERNANCE_SCHEMA_VERSION,
} from "../governance/policy.js";

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
    expect(policy.findingSensitivity).toBe("balanced");
    expect(policy.lowConfidenceThreshold).toBe(0.7);
    expect(policy.riskySections).toContain("Stale");
    expect(policy.riskySections).toContain("Conflicts");
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
    expect(result.data.findingSensitivity).toBe("balanced");
  });

  it("filters invalid riskySections in patch", () => {
    const result = updateWorkflowPolicy(phrenPath, {
      riskySections: ["Review", "Bogus" as any, "Conflicts"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.riskySections).toEqual(["Review", "Conflicts"]);
  });

  it("reads the policy under the write lock, so a concurrent writer's change survives", async () => {
    const file = path.join(phrenPath, ".config", "workflow-policy.json");
    const lock = `${file}.lock`;
    // Another process holds the lock, writes the confidence threshold, then releases it.
    const writer = spawn(process.execPath, ["-e", `
      const fs = require("fs");
      fs.writeFileSync(process.argv[1] + ".lock", process.pid + "\\n" + Date.now(), { flag: "wx" });
      setTimeout(() => {
        fs.writeFileSync(process.argv[1], JSON.stringify({ lowConfidenceThreshold: 0.75 }));
        fs.unlinkSync(process.argv[1] + ".lock");
      }, 300);
    `, file], { stdio: "ignore" });
    const exited = new Promise((resolve) => writer.on("exit", resolve));
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(lock) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(fs.existsSync(lock)).toBe(true);

    const result = updateWorkflowPolicy(phrenPath, { findingSensitivity: "aggressive" });
    await exited;

    const reread = getWorkflowPolicy(phrenPath);
    expect(reread.findingSensitivity).toBe("aggressive");
    expect(reread.lowConfidenceThreshold).toBe(0.75);
  });
});

// ── Index Policy ───────────────────────────────────────────────────────────

describe("getIndexPolicy", () => {
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

  it("ignores stored include globs that would leave the project folder", () => {
    writeGovJson(phrenPath, "index-policy.json", {
      includeGlobs: ["**/*.md", "../**/*.md", "notes/../../*.md", "/etc/*.conf", "~/notes/*.md", "C:/Users/**", "a\\b/*.md", "{..,x}/*.md"],
    });
    expect(getIndexPolicy(phrenPath).includeGlobs).toEqual(["**/*.md"]);
  });
});

describe("updateIndexPolicy", () => {
  it("refuses include globs that would leave the project folder, and keeps the stored policy", () => {
    updateIndexPolicy(phrenPath, { includeGlobs: ["**/*.py"] });
    const result = updateIndexPolicy(phrenPath, { includeGlobs: ["**/*.md", "../../other/**/*.md"] });
    expect(result.ok).toBe(false);
    expect(getIndexPolicy(phrenPath).includeGlobs).toEqual(["**/*.py"]);
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
});

// ── Review Queue ───────────────────────────────────────────────────────────

describe("appendReviewQueue", () => {
  const PROJECT = "review-test";

  beforeEach(() => {
    fs.mkdirSync(path.join(phrenPath, PROJECT), { recursive: true });
  });

  it("creates review.md when it does not exist", () => {
    const result = appendReviewQueue(phrenPath, PROJECT, "Review", ["Item one"], { origin: "explicit" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBe(1);

    const content = fs.readFileSync(path.join(phrenPath, PROJECT, "review.md"), "utf8");
    expect(content).toContain("Item one");
  });

  it("appends to existing review.md", () => {
    appendReviewQueue(phrenPath, PROJECT, "Review", ["First"], { origin: "explicit" });
    const result = appendReviewQueue(phrenPath, PROJECT, "Review", ["Second"], { origin: "explicit" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBe(1);

    const content = fs.readFileSync(path.join(phrenPath, PROJECT, "review.md"), "utf8");
    expect(content).toContain("First");
    expect(content).toContain("Second");
  });

  it("deduplicates identical entries", () => {
    appendReviewQueue(phrenPath, PROJECT, "Review", ["Unique item"], { origin: "explicit" });
    const result = appendReviewQueue(phrenPath, PROJECT, "Review", ["Unique item"], { origin: "explicit" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBe(0); // no new items added
  });

  const fullQueue = (entries: number) => fs.writeFileSync(path.join(phrenPath, PROJECT, "review.md"),
    `# ${PROJECT} Review Queue\n\n## Review\n\n${Array.from({ length: entries }, (_, i) => `- [2026-11-01] Held item ${i}`).join("\n")}\n\n## Stale\n\n## Conflicts\n`);

  it("holds back machine-generated appends over budget with their own result, while explicit appends still go in", () => {
    writeGovJson(phrenPath, "retention-policy.json", { schemaVersion: 1, budgets: { reviewEntries: 2 } });
    expect(appendReviewQueue(phrenPath, PROJECT, "Review", ["Machine one", "Machine two"], { origin: "machine" })).toEqual({ ok: true, data: 2 });
    expect(appendReviewQueue(phrenPath, PROJECT, "Stale", ["Machine three"], { origin: "machine" })).toEqual({ ok: true, data: 1 });
    const queuePath = path.join(phrenPath, PROJECT, "review.md");
    const full = fs.readFileSync(queuePath, "utf8");
    expect(appendReviewQueue(phrenPath, PROJECT, "Conflicts", ["Machine four"], { origin: "machine" })).toMatchObject({ ok: false, code: "OVER_BUDGET" });
    expect(appendReviewQueue(phrenPath, PROJECT, "Review", ["Machine one"], { origin: "explicit" })).toEqual({ ok: true, data: 0 });
    expect(fs.readFileSync(queuePath, "utf8")).toBe(full);
    expect(appendReviewQueue(phrenPath, PROJECT, "Review", ["Owner asked for this one"], { origin: "explicit" })).toEqual({ ok: true, data: 1 });
    expect(fs.readFileSync(queuePath, "utf8")).toContain("Owner asked for this one");
  });

  it("takes an explicit 0 as off even past the default budget", () => {
    fullQueue(160);
    expect(appendReviewQueue(phrenPath, PROJECT, "Stale", ["Machine past the default"], { origin: "machine" })).toMatchObject({ ok: false, code: "OVER_BUDGET" });
    writeGovJson(phrenPath, "retention-policy.json", { schemaVersion: 1, budgets: { reviewEntries: 0 } });
    expect(appendReviewQueue(phrenPath, PROJECT, "Stale", ["Machine past the default"], { origin: "machine" })).toEqual({ ok: true, data: 1 });
  });

  it("lets a project's own review budget override the store's", () => {
    writeGovJson(phrenPath, "retention-policy.json", { schemaVersion: 1, budgets: { reviewEntries: 1 } });
    fs.writeFileSync(path.join(phrenPath, PROJECT, "phren.project.yaml"), "config:\n  retentionPolicy:\n    budgets:\n      reviewEntries: 5\n");
    appendReviewQueue(phrenPath, PROJECT, "Review", ["One", "Two"], { origin: "machine" });
    expect(appendReviewQueue(phrenPath, PROJECT, "Review", ["Three"], { origin: "machine" })).toEqual({ ok: true, data: 1 });
  });

  it.each(["Stale", "Conflicts"] as const)("writes to correct section (%s)", (section) => {
    const result = appendReviewQueue(phrenPath, PROJECT, section, [`${section} entry`], { origin: "explicit" });
    expect(result.ok).toBe(true);

    const content = fs.readFileSync(path.join(phrenPath, PROJECT, "review.md"), "utf8");
    expect(content).toContain(`## ${section}`);
    expect(content).toContain(`${section} entry`);
  });

  it("rejects invalid project name", () => {
    const result = appendReviewQueue(phrenPath, "../escape", "Review", ["test"], { origin: "explicit" });
    expect(result.ok).toBe(false);
  });

  it("rejects nonexistent project", () => {
    const result = appendReviewQueue(phrenPath, "no-such-project", "Review", ["test"], { origin: "explicit" });
    expect(result.ok).toBe(false);
  });

  it("truncates oversized entries instead of rejecting", () => {
    const longEntry = "x".repeat(MAX_QUEUE_ENTRY_LENGTH + 50);
    const result = appendReviewQueue(phrenPath, PROJECT, "Review", [longEntry], { origin: "explicit" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toBe(1);
  });
});

// ── TTL promotion ──────────────────────────────────────────────────────────

// TTL -> Stale promotion used to live in the CLI handler, so nightly maintenance (which
// calls pruneDeadMemories directly) never ran it: one real store had 74 Review items and
// only 8 Stale ones.
describe("pruneDeadMemories TTL promotion", () => {
  const PROJECT = "ttl-test";

  function seedExpiredFinding(): void {
    fs.mkdirSync(path.join(phrenPath, PROJECT), { recursive: true });
    fs.writeFileSync(
      path.join(phrenPath, PROJECT, "FINDINGS.md"),
      [
        `# ${PROJECT} Findings`,
        "",
        // Recent date heading, so the retention sweep leaves it alone; the created stamp
        // is what makes it TTL-expired.
        `## ${new Date().toISOString().slice(0, 10)}`,
        "",
        "- Long-forgotten deploy ordering rule <!-- created: 2020-01-01 -->",
        "- Still current retry budget note",
        "",
      ].join("\n"),
    );
  }

  it("promotes TTL-expired findings into review.md's Stale section", () => {
    seedExpiredFinding();
    const result = pruneDeadMemories(phrenPath, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.ttlExpired).toBe(1);
    expect(result.data.message).toContain("Moved 1 TTL-expired entry");

    const queue = fs.readFileSync(path.join(phrenPath, PROJECT, "review.md"), "utf8");
    const staleSection = queue.split("## Stale")[1] ?? "";
    expect(staleSection).toContain("[ttl-expired: 2020-01-01]");
    expect(staleSection).toContain("Long-forgotten deploy ordering rule");
    expect(queue).not.toContain("Still current retry budget note");
  });

  // Maintenance expired by the TTL alone while the trust filter kept typed findings past it,
  // so a 200-day [decision] was injected yet queued as stale every night.
  it("expires a finding by the same rule as the trust filter", async () => {
    const { filterTrustedFindingsDetailed } = await import("../content/citation.js");
    const created = new Date(Date.now() - 200 * 86_400_000).toISOString().slice(0, 10);
    fs.mkdirSync(path.join(phrenPath, PROJECT), { recursive: true });
    const findings = [
      `# ${PROJECT} Findings`,
      "",
      "- [decision] Keep the store in plain markdown <!-- created: " + created + " -->",
      "- [pattern] Batch the index writes in one transaction <!-- created: " + created + " -->",
      "- Untyped deploy ordering rule <!-- created: " + created + " -->",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(phrenPath, PROJECT, "FINDINGS.md"), findings);

    const trusted = filterTrustedFindingsDetailed(findings, { ttlDays: 120, minConfidence: 0 }).content;
    const result = pruneDeadMemories(phrenPath, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stale = fs.readFileSync(path.join(phrenPath, PROJECT, "review.md"), "utf8").split("## Stale")[1] ?? "";
    for (const kept of ["Keep the store in plain markdown", "Batch the index writes"]) {
      expect(trusted).toContain(kept);
      expect(stale).not.toContain(kept);
    }
    expect(trusted).not.toContain("Untyped deploy ordering rule");
    expect(stale).toContain(`[ttl-expired: ${created}] Untyped deploy ordering rule`);
    expect(result.data.ttlExpired).toBe(1);
  });

  // The prune resolved the policy once against the global config, so a project's
  // own retentionDays / ttlDays override was ignored by nightly maintenance.
  it("honors a per-project retention override instead of the global window", async () => {
    const { writeProjectConfig } = await import("../project-config.js");
    const LONG = "long-retention";
    const oldDate = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
    fs.mkdirSync(path.join(phrenPath, LONG), { recursive: true });
    fs.writeFileSync(
      path.join(phrenPath, LONG, "FINDINGS.md"),
      [`# ${LONG} Findings`, "", `## ${oldDate}`, "", "- Archival decision worth keeping for years", ""].join("\n"),
    );
    // Global default is 365 days; this project keeps findings for ten years.
    writeProjectConfig(phrenPath, LONG, { config: { retentionPolicy: { retentionDays: 3650 } } });

    const result = pruneDeadMemories(phrenPath, LONG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.pruned).toBe(0);
    expect(fs.readFileSync(path.join(phrenPath, LONG, "FINDINGS.md"), "utf8")).toContain("Archival decision worth keeping for years");
  });

  it("honors a per-project ttlDays override", async () => {
    const { writeProjectConfig } = await import("../project-config.js");
    seedExpiredFinding();
    writeProjectConfig(phrenPath, PROJECT, { config: { retentionPolicy: { ttlDays: 100_000 } } });

    const result = pruneDeadMemories(phrenPath, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.ttlExpired).toBe(0);
  });

  it("reports but does not write in dry-run", () => {
    seedExpiredFinding();
    const result = pruneDeadMemories(phrenPath, PROJECT, true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.ttlExpired).toBe(1);
    expect(result.data.message).toContain("Would move 1 TTL-expired entry");
    expect(fs.existsSync(path.join(phrenPath, PROJECT, "review.md"))).toBe(false);
  });

  it("says how many TTL-expired entries it held back when the review queue is over budget", () => {
    seedExpiredFinding();
    writeGovJson(phrenPath, "retention-policy.json", { schemaVersion: 1, budgets: { reviewEntries: 1 } });
    fs.writeFileSync(path.join(phrenPath, PROJECT, "review.md"), "# Review\n\n## Review\n\n- One\n- Two\n\n## Stale\n\n## Conflicts\n");
    const result = pruneDeadMemories(phrenPath, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ ttlExpired: 1, heldBack: 1 });
    expect(result.data.message).toContain("Held back 1 TTL-expired entry: the review queue is over its budget");
    expect(result.data.message).not.toContain("Moved");
    expect(fs.readFileSync(path.join(phrenPath, PROJECT, "review.md"), "utf8")).not.toContain("ttl-expired");
  });

  it("leaves recently retrieved findings alone during the grace period", () => {
    seedExpiredFinding();
    const runtime = path.join(phrenPath, ".runtime");
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(
      path.join(runtime, "retrieval-log.jsonl"),
      JSON.stringify({
        file: `${PROJECT}/FINDINGS.md`,
        section: "findings",
        retrievedAt: new Date().toISOString(),
      }) + "\n",
    );

    const result = pruneDeadMemories(phrenPath, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.ttlExpired).toBe(0);
  });
});

describe("retention budgets in the policy file", () => {
  it("takes only a numeric 0 as off, falls back on junk, and reads age-out days under a week as the 30-day default", () => {
    writeGovJson(phrenPath, "retention-policy.json", { schemaVersion: 1, budgets: { reviewEntries: 0, runtimeMB: -5, runtimeAgeOutDays: 1, runtimeAgeOut: "yes" } });
    expect(getRetentionPolicy(phrenPath).budgets).toEqual({
      reviewEntries: 0, runtimeMB: 1024, fanoutArchiveMB: 512, runtimeAgeOutDays: 30, runtimeAgeOut: false,
    });
    for (const days of [0, 6.5, 7, 45]) {
      writeGovJson(phrenPath, "retention-policy.json", { schemaVersion: 1, budgets: { runtimeAgeOutDays: days } });
      expect(getRetentionPolicy(phrenPath).budgets.runtimeAgeOutDays).toBe(days >= 7 ? days : 30);
    }
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

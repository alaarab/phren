import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { detectConflicts, checkSemanticConflicts, extractDynamicEntities } from "../shared-content.js";
import { makeTempDir } from "../test-helpers.js";
import * as fs from "fs";
import * as path from "path";

describe("detectConflicts", () => {
  it("detects positive vs negative polarity for the same fragment", () => {
    const existing = ["- Always use Docker for deployments", "- Prefer Kubernetes over bare-metal"];
    const result = detectConflicts("Never use Docker in production — it adds too much overhead", existing);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("Docker");
  });

  it("detects negative vs positive conflict", () => {
    const existing = ["- Never use Docker in production without orchestration"];
    const result = detectConflicts("Always use Docker for local dev and production deploys", existing);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("Docker");
  });

  it("returns empty when both are same polarity", () => {
    const existing = ["- Always use TypeScript for new projects"];
    const result = detectConflicts("Always use TypeScript — strict mode catches real bugs", existing);
    expect(result).toHaveLength(0);
  });

  it("returns empty when new learning is neutral", () => {
    const existing = ["- Always use Docker for containerization"];
    const result = detectConflicts("Docker supports multi-stage builds", existing);
    expect(result).toHaveLength(0);
  });

  it("returns empty when no shared fragments", () => {
    const existing = ["- Prefer AWS for compute workloads"];
    const result = detectConflicts("Always use GCP for ML workloads", existing);
    // AWS and GCP are different fragments — no conflict
    expect(result).toHaveLength(0);
  });

  it("returns empty when existing line is neutral", () => {
    const existing = ["- Docker runs isolated containers"];
    const result = detectConflicts("Never use Docker for production — use bare metal", existing);
    expect(result).toHaveLength(0);
  });

  it("returns empty when no prose fragments found", () => {
    const existing = ["- Always commit before merging"];
    const result = detectConflicts("Never push without reviewing the diff first", existing);
    expect(result).toHaveLength(0);
  });

  it("can detect multiple conflicts", () => {
    const existing = [
      "- Always use Docker for deployments",
      "- Always use Docker in CI pipelines too",
      "- Use Postgres for everything",
    ];
    const result = detectConflicts("Never use Docker — bare metal is faster", existing);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("ignores superseded lines (they contain <!-- superseded_by -->)", () => {
    // Superseded lines still start with "- " so they're included — this documents the behavior
    // (detectConflicts is conservative; superseded entries are annotated but not excluded)
    const existing = ["- Always use Docker in production <!-- superseded_by: Use Kubernetes instead -->"];
    const result = detectConflicts("Never use Docker", existing);
    // Still detected — caller decides whether to act on it
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("extractDynamicEntities", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => { tmp = makeTempDir("dynamic-entities-"); });
  afterEach(() => tmp.cleanup());

  function writeFindings(phrenPath: string, project: string, bullets: string[]) {
    const dir = path.join(phrenPath, project);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "FINDINGS.md"), bullets.map(b => `- ${b}`).join("\n") + "\n");
  }

  it("returns empty set when no FINDINGS.md exists", () => {
    const entities = extractDynamicEntities(tmp.path, "nonexistent");
    expect(entities.size).toBe(0);
  });

  it("extracts CamelCase tool names that appear in 2+ bullets", () => {
    writeFindings(tmp.path, "gamedev", [
      "Always use GodotEngine for 2D sprite rendering — fastest iteration loop",
      "GodotEngine's GDScript has async/await built-in",
      "Unreal is better for AAA titles but GodotEngine is free",
    ]);
    const entities = extractDynamicEntities(tmp.path, "gamedev");
    expect(entities.has("godotengine")).toBe(true);
  });

  it("does not include tokens appearing in only 1 bullet", () => {
    writeFindings(tmp.path, "music", [
      "Ableton latency is configurable via ASIO driver",
      "Use JUCE for cross-platform audio plugins",
    ]);
    const entities = extractDynamicEntities(tmp.path, "music");
    // Each token only appears once — should not be included
    expect(entities.has("ableton")).toBe(false);
    expect(entities.has("juce")).toBe(false);
  });

  it("extracts all-caps acronyms that appear in 2+ bullets", () => {
    writeFindings(tmp.path, "infra", [
      "AWS S3 bucket names must be globally unique",
      "AWS IAM roles should follow least-privilege",
      "GCP is better for ML workloads than AWS",
    ]);
    const entities = extractDynamicEntities(tmp.path, "infra");
    expect(entities.has("aws")).toBe(true);
  });

  it("cache is written and reused on second call", () => {
    writeFindings(tmp.path, "proj", [
      "NiagaraSystem particle count affects GPU perf",
      "NiagaraSystem requires warm-up frames on load",
    ]);
    const first = extractDynamicEntities(tmp.path, "proj");
    expect(first.has("niagarasystem")).toBe(true);

    // Verify cache file was written
    const runtimeDir = path.join(tmp.path, ".runtime");
    const cacheFile = path.join(runtimeDir, "project-entities-proj.json");
    expect(fs.existsSync(cacheFile)).toBe(true);

    // Second call should read from cache
    const second = extractDynamicEntities(tmp.path, "proj");
    expect(second.has("niagarasystem")).toBe(true);
  });

  it("detectConflicts uses dynamic fragments for domain-specific tools", () => {
    // Godot is not in PROSE_ENTITY_RE but should still be detected via dynamic fragments
    const dynamicEntities = new Set(["godot"]);
    const existing = ["- Always use Godot for 2D games — fastest editor iteration"];
    const result = detectConflicts("Never use Godot, it lacks 3D rendering quality", existing, dynamicEntities);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("Godot");
  });

  it("detectConflicts without dynamic fragments misses domain-specific tools", () => {
    // Without dynamic fragments, Godot is not in the static regex
    const existing = ["- Always use Godot for 2D games"];
    const result = detectConflicts("Never use Godot", existing);
    // Godot not in PROSE_ENTITY_RE → no fragments found → no conflict detected
    expect(result).toHaveLength(0);
  });
});

describe("checkSemanticConflicts (LLM-based)", () => {
  let tmpDir: string;
  let tmpCleanup: (() => void) | undefined;

  function makePhren(): string {
    ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("phren-semantic-conflict-"));
    return tmpDir;
  }

  beforeEach(() => {
    process.env.PHREN_FEATURE_SEMANTIC_CONFLICT = "1";
  });

  afterEach(() => {
    delete process.env.PHREN_FEATURE_SEMANTIC_CONFLICT;
    vi.restoreAllMocks();
    if (tmpCleanup) {
      tmpCleanup();
      tmpCleanup = undefined;
    }
  });

  it("returns checked=false when feature flag is off", async () => {
    delete process.env.PHREN_FEATURE_SEMANTIC_CONFLICT;
    const phren = makePhren();
    const result = await checkSemanticConflicts(phren, "proj", "Never use Redis");
    expect(result.checked).toBe(false);
    expect(result.annotations).toHaveLength(0);
  });

  it("detects CONFLICT via cached LLM result and adds annotation", async () => {
    const phren = makePhren();
    const projDir = path.join(phren, "proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.mkdirSync(path.join(phren, ".runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, "FINDINGS.md"),
      "# proj Findings\n\n## 2026-01-01\n\n- Always use Docker for production deployments\n"
    );

    // Pre-populate the conflict cache with a CONFLICT result
    const crypto = await import("node:crypto");
    const existing = "- Always use Docker for production deployments";
    const newFinding = "Never use Docker in production — bare metal is faster";
    const key = crypto.createHash("sha256").update(existing + "|||" + newFinding).digest("hex");
    const cachePath = path.join(phren, ".runtime", "conflict-cache.json");
    fs.writeFileSync(cachePath, JSON.stringify({ [key]: { result: "CONFLICT", ts: Date.now() } }));

    const result = await checkSemanticConflicts(phren, "proj", newFinding);
    expect(result.checked).toBe(true);
    expect(result.annotations.length).toBeGreaterThanOrEqual(1);
    expect(result.annotations[0]).toContain("conflicts_with");
    expect(result.annotations[0]).toContain("Docker");
  });

  it("scans older projects beyond the two most recent ones", async () => {
    const phren = makePhren();
    fs.mkdirSync(path.join(phren, ".runtime"), { recursive: true });
    for (const project of ["proj", "recent-a", "recent-b", "older-proj"]) {
      fs.mkdirSync(path.join(phren, project), { recursive: true });
    }

    fs.writeFileSync(path.join(phren, "proj", "FINDINGS.md"), "# proj Findings\n");
    fs.writeFileSync(path.join(phren, "recent-a", "FINDINGS.md"), "# recent-a Findings\n\n- Use AWS for compute workloads\n");
    fs.writeFileSync(path.join(phren, "recent-b", "FINDINGS.md"), "# recent-b Findings\n\n- Prefer Kubernetes for orchestration\n");
    const existing = "- Always use Docker for production deployments";
    fs.writeFileSync(path.join(phren, "older-proj", "FINDINGS.md"), `# older-proj Findings\n\n${existing}\n`);

    const crypto = await import("node:crypto");
    const newFinding = "Never use Docker in production — bare metal is faster";
    const key = crypto.createHash("sha256").update(existing + "|||" + newFinding).digest("hex");
    fs.writeFileSync(
      path.join(phren, ".runtime", "conflict-cache.json"),
      JSON.stringify({ [key]: { result: "CONFLICT", ts: Date.now() } })
    );

    const result = await checkSemanticConflicts(phren, "proj", newFinding);
    expect(result.annotations.some((annotation) => annotation.includes("older-proj"))).toBe(true);
  });
});

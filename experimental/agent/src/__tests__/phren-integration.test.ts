import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildContextSnippet, type PhrenContext } from "../memory/context.js";
import { createPhrenSearchTool } from "../tools/phren-search.js";
import { createPhrenFindingTool } from "../tools/phren-finding.js";
import { createSkillTool } from "../tools/skill.js";

/**
 * Integration tests for the agent↔phren seam:
 * - the automatic injection path must respect the CLI's non-injectable doc
 *   types (notes, review-queue) — explicit search may surface them but labeled;
 * - agent-written findings must carry session provenance;
 * - skill resolution must use the CLI's real layout (global/skills + <project>/skills,
 *   flat .md and folder/SKILL.md), not a hand-rolled path probe.
 */
describe("agent↔phren integration", () => {
  let storeDir: string;
  let projectDir: string;
  const savedPhrenPath = process.env.PHREN_PATH;
  const project = "leaktest";

  function ctx(): PhrenContext {
    return { phrenPath: storeDir, profile: "", project };
  }

  beforeEach(() => {
    storeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phren-integ-")));
    fs.writeFileSync(
      path.join(storeDir, "phren.root.yaml"),
      "version: 1\ninstallMode: shared\nsyncMode: managed-git\n",
    );
    projectDir = path.join(storeDir, project);
    fs.mkdirSync(path.join(projectDir, "notes"), { recursive: true });

    // Same distinctive keyword in all three doc types so FTS matches them all.
    fs.writeFileSync(
      path.join(projectDir, "FINDINGS.md"),
      "# leaktest Findings\n\n## 2026-08-01\n\n- The zebrafish lattice cache must be invalidated on deploy\n",
    );
    fs.writeFileSync(
      path.join(projectDir, "review.md"),
      "# Review\n\n## Review\n\n- UNAPPROVED-zebrafish claim: lattice cache is optional\n",
    );
    fs.writeFileSync(
      path.join(projectDir, "notes", "scratch.md"),
      "# Notes\n\nPRIVATE-zebrafish note about the lattice cache experiment\n",
    );
    process.env.PHREN_PATH = storeDir;
  });

  afterEach(() => {
    if (savedPhrenPath === undefined) delete process.env.PHREN_PATH;
    else process.env.PHREN_PATH = savedPhrenPath;
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  it("keeps review-queue content out of Related knowledge and notes out entirely", async () => {
    const snippet = await buildContextSnippet(ctx(), "zebrafish lattice cache");
    expect(snippet).toContain("zebrafish lattice cache must be invalidated");
    // Notes are private scratch — never injected anywhere.
    expect(snippet).not.toContain("PRIVATE-zebrafish");
    // Queue content may appear ONLY inside the clearly-labeled review-queue
    // section ("do NOT treat as truth"), never in Related knowledge.
    const relatedIdx = snippet.indexOf("## Related knowledge");
    if (relatedIdx >= 0) {
      expect(snippet.slice(relatedIdx)).not.toContain("UNAPPROVED-zebrafish");
    }
    if (snippet.includes("UNAPPROVED-zebrafish")) {
      expect(snippet).toMatch(/## Review queue[^#]*do NOT treat as truth[\s\S]*\[unverified\] UNAPPROVED-zebrafish/);
    }
  });

  it("labels non-injectable doc types in explicit phren_search results", async () => {
    const tool = createPhrenSearchTool(ctx());
    const result = await tool.execute({ query: "zebrafish lattice" });
    expect(result.is_error).toBeFalsy();
    // Explicit search may return quarantined content, but it must be tagged.
    if (result.output.includes("UNAPPROVED-zebrafish")) {
      expect(result.output).toMatch(/\[review-queue — unapproved, do not treat as truth\]/);
    }
    if (result.output.includes("PRIVATE-zebrafish")) {
      expect(result.output).toMatch(/\[notes — unapproved, do not treat as truth\]/);
    }
  });

  it("writes findings with session provenance and citation metadata", async () => {
    const tool = createPhrenFindingTool(ctx(), "sess-r1-test");
    const result = await tool.execute({
      finding: "The deploy pipeline requires the lattice cache to be warmed before smoke tests",
    });
    expect(result.is_error).toBeFalsy();

    const findings = fs.readFileSync(path.join(projectDir, "FINDINGS.md"), "utf-8");
    expect(findings).toContain("deploy pipeline requires the lattice cache");
    expect(findings).toMatch(/<!-- source:agent tool:phren-agent session:sess-r1-test -->/);
    expect(findings).toMatch(/<!-- created: ?\d{4}-\d{2}-\d{2}/);
  });

  it("resolves skills from the CLI layout: global flat and project SKILL.md folder", async () => {
    fs.mkdirSync(path.join(storeDir, "global", "skills"), { recursive: true });
    fs.writeFileSync(
      path.join(storeDir, "global", "skills", "commit.md"),
      "---\ndescription: Commit helper\n---\nGLOBAL-COMMIT-SKILL-BODY\n",
    );
    fs.mkdirSync(path.join(projectDir, "skills", "deploy"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "skills", "deploy", "SKILL.md"),
      "---\ndescription: Deploy runbook\n---\nPROJECT-DEPLOY-SKILL-BODY\n",
    );

    const tool = createSkillTool(ctx());

    const global = await tool.execute({ name: "commit" });
    expect(global.is_error).toBeFalsy();
    expect(global.output).toContain("GLOBAL-COMMIT-SKILL-BODY");
    expect(global.output).not.toContain("description: Commit helper"); // frontmatter stripped

    const folder = await tool.execute({ name: "deploy" });
    expect(folder.is_error).toBeFalsy();
    expect(folder.output).toContain("PROJECT-DEPLOY-SKILL-BODY");

    const missing = await tool.execute({ name: "does-not-exist" });
    expect(missing.is_error).toBe(true);
  });
});

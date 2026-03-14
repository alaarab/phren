import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildIndex,
  queryRows,
} from "./shared-index.js";
import {
  countActiveFindings,
  autoArchiveToReference,
  addFindingToFile,
} from "./shared-content.js";
import { reclassifyLegacyTopicDocs, writeProjectTopics } from "./project-topics.js";
import { makeTempDir, grantAdmin } from "./test-helpers.js";
import * as path from "path";
import * as fs from "fs";

let tmpDir: string;
let tmpCleanup: (() => void) | undefined;

function makePhren(): string {
  ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("phren-reference-"));
  return tmpDir;
}

function makeProject(phrenDir: string, name: string, files: Record<string, string>): void {
  const dir = path.join(phrenDir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const fullPath = path.join(dir, file);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
}

beforeEach(() => {
  process.env.PHREN_PATH = undefined;
  delete process.env.PHREN_FINDINGS_CAP;
});

afterEach(() => {
  tmpCleanup?.();
  tmpCleanup = undefined;
  delete process.env.PHREN_ACTOR;
  delete process.env.PHREN_FINDINGS_CAP;
});

describe("countActiveFindings", () => {
  it("counts bullet entries outside details blocks", () => {
    const content = `# FINDINGS

## 2025-01-15

- First insight
- Second insight

<details>
<summary>Archived</summary>

- Old archived insight
</details>

## 2025-01-10

- Third insight
`;
    expect(countActiveFindings(content)).toBe(3);
  });

  it("returns 0 for empty content", () => {
    expect(countActiveFindings("# FINDINGS\n")).toBe(0);
  });

  it("counts all bullets when no details blocks exist", () => {
    const content = `# FINDINGS

## 2025-01-15

- One
- Two
- Three
- Four
`;
    expect(countActiveFindings(content)).toBe(4);
  });
});

describe("autoArchiveToReference", () => {
  it("archives oldest entries to reference/ files grouped by topic", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const findings = `# myapp FINDINGS

## 2025-01-20

- The API endpoint uses REST with pagination
- Build pipeline requires node 20

## 2025-01-10

- Database schema migration needs downtime
- Workaround for the timeout bug in auth module
- Git branch naming convention uses feature/ prefix
`;
    makeProject(phren, "myapp", { "FINDINGS.md": findings });

    const result = autoArchiveToReference(phren, "myapp", 2);
    expect(result.ok).toBe(true);
    const archived = result.ok ? result.data : 0;
    expect(archived).toBe(3);

    // Check that reference/ dir was created
    const referenceDir = path.join(phren, "myapp", "reference", "topics");
    expect(fs.existsSync(referenceDir)).toBe(true);

    // Check reference files exist
    const referenceFiles = fs.readdirSync(referenceDir);
    expect(referenceFiles.length).toBeGreaterThan(0);

    // Check FINDINGS.md was trimmed
    const updatedFindings = fs.readFileSync(path.join(phren, "myapp", "FINDINGS.md"), "utf8");
    const remainingCount = countActiveFindings(updatedFindings);
    expect(remainingCount).toBe(2);

    // Consolidation marker should be present
    expect(updatedFindings).toContain("<!-- consolidated:");
  });

  it("does nothing when entries <= keepCount", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const findings = `# myapp FINDINGS

## 2025-01-20

- First insight
- Second insight
`;
    makeProject(phren, "myapp", { "FINDINGS.md": findings });

    const result = autoArchiveToReference(phren, "myapp", 5);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe(0);
  });

  it("appends to existing reference files", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const findings = `# myapp FINDINGS

## 2025-01-20

- New API endpoint design

## 2025-01-05

- Old architecture decision about microservices
- Another old architecture choice for the database layer
`;
    makeProject(phren, "myapp", {
      "FINDINGS.md": findings,
      "reference/topics/architecture.md": "# myapp - Architecture\n\n<!-- phren:auto-topic slug=architecture -->\n\n## Archived 2024-12-01\n\n- Previous architecture note\n",
    });

    autoArchiveToReference(phren, "myapp", 1);

    const archFile = path.join(phren, "myapp", "reference", "topics", "architecture.md");
    const content = fs.readFileSync(archFile, "utf8");
    expect(content).toContain("Previous architecture note");
    expect(content).toContain("microservices");
  });

  it("removes empty date sections after archival", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const findings = `# myapp FINDINGS

## 2025-01-20

- Keep this one

## 2025-01-05

- Archive this old one
`;
    makeProject(phren, "myapp", { "FINDINGS.md": findings });

    autoArchiveToReference(phren, "myapp", 1);

    const updated = fs.readFileSync(path.join(phren, "myapp", "FINDINGS.md"), "utf8");
    expect(updated).not.toContain("## 2025-01-05");
    expect(updated).toContain("## 2025-01-20");
  });
});

describe("reference/ indexing", () => {
  it("indexes reference/ files with type 'reference'", async () => {
    const phren = makePhren();
    makeProject(phren, "myapp", {
      "FINDINGS.md": "# FINDINGS\n\n## 2025-01-20\n\n- A finding\n",
      "reference/architecture.md": "# Architecture\n\nThe system uses a microservices pattern.\n",
      "reference/findings.md": "# Findings\n\nTimeout on cold start is 30s.\n",
    });

    const db = await buildIndex(phren);

    const referenceRows = queryRows(
      db,
      "SELECT project, filename, type FROM docs WHERE type = 'reference'",
      []
    );
    expect(referenceRows).not.toBeNull();
    expect(referenceRows!.length).toBe(2);

    const filenames = referenceRows!.map(r => r[1]).sort();
    expect(filenames).toEqual(["architecture.md", "findings.md"]);

    // Verify they are searchable
    const searchResults = queryRows(
      db,
      "SELECT project, filename, type FROM docs WHERE docs MATCH 'microservices'",
      []
    );
    expect(searchResults).not.toBeNull();
    expect(searchResults!.length).toBe(1);
    expect(searchResults![0][2]).toBe("reference");
  });
});

describe("size cap in addFindingToFile", () => {
  it("auto-archives when cap is exceeded", () => {
    const phren = makePhren();
    grantAdmin(phren);

    // Build a FINDINGS.md with entries right at the cap
    const bullets = Array.from({ length: 5 }, (_, i) =>
      `- Finding number ${i + 1} about architecture decisions`
    ).join("\n");
    const findings = `# myapp FINDINGS\n\n## 2025-01-10\n\n${bullets}\n`;
    makeProject(phren, "myapp", { "FINDINGS.md": findings });

    // Set a low cap for testing
    process.env.PHREN_FINDINGS_CAP = "4";

    addFindingToFile(phren, "myapp", "Brand new insight about the build system");

    const updated = fs.readFileSync(path.join(phren, "myapp", "FINDINGS.md"), "utf8");
    const remaining = countActiveFindings(updated);
    // Should have at most cap entries (4), since we added one and had 5 (total 6, archives 2)
    expect(remaining).toBeLessThanOrEqual(4);

    // Knowledge dir should exist with archived entries
    const referenceDir = path.join(phren, "myapp", "reference");
    expect(fs.existsSync(referenceDir)).toBe(true);
  });

  it("does not archive when under cap", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const findings = `# myapp FINDINGS\n\n## 2025-01-10\n\n- Existing insight\n`;
    makeProject(phren, "myapp", { "FINDINGS.md": findings });

    process.env.PHREN_FINDINGS_CAP = "20";
    addFindingToFile(phren, "myapp", "Another insight");

    const referenceDir = path.join(phren, "myapp", "reference");
    expect(fs.existsSync(referenceDir)).toBe(false);
  });
});

describe("topic classification", () => {
  it("classifies architecture-related entries", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const findings = `# myapp FINDINGS

## 2025-01-20

- Keep this

## 2025-01-05

- The database schema requires a specific migration order
- Workaround for the race condition in auth
- Deploy pipeline needs manual approval step
`;
    makeProject(phren, "myapp", { "FINDINGS.md": findings });

    autoArchiveToReference(phren, "myapp", 1);

    const referenceDir = path.join(phren, "myapp", "reference", "topics");
    const files = fs.readdirSync(referenceDir).sort();

    // Should have created topic-specific files
    expect(files.length).toBeGreaterThan(0);

    if (fs.existsSync(path.join(referenceDir, "database.md"))) {
      const content = fs.readFileSync(path.join(referenceDir, "database.md"), "utf8");
      expect(content).toContain("database schema");
    }

    if (fs.existsSync(path.join(referenceDir, "auth.md"))) {
      const content = fs.readFileSync(path.join(referenceDir, "auth.md"), "utf8");
      expect(content).toContain("auth");
    }
  });

  it("uses custom project topics for archive routing", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const findings = `# game FINDINGS

## 2025-01-20

- Keep this one

## 2025-01-05

- Shader compilation hitch on first frame
- Gameplay state desync when pausing during combat
`;
    makeProject(phren, "game", { "FINDINGS.md": findings });
    const saved = writeProjectTopics(phren, "game", [
      { slug: "rendering", label: "Rendering", description: "Frame rendering and shaders", keywords: ["shader", "frame", "render", "gpu"] },
      { slug: "gameplay", label: "Gameplay", description: "Core gameplay state and combat systems", keywords: ["gameplay", "combat", "pause", "state"] },
      { slug: "general", label: "General", description: "Fallback", keywords: [] },
    ]);
    expect(saved.ok).toBe(true);

    autoArchiveToReference(phren, "game", 1);

    const renderingDoc = path.join(phren, "game", "reference", "topics", "rendering.md");
    const gameplayDoc = path.join(phren, "game", "reference", "topics", "gameplay.md");
    expect(fs.existsSync(renderingDoc)).toBe(true);
    expect(fs.existsSync(gameplayDoc)).toBe(true);
    expect(fs.readFileSync(renderingDoc, "utf8")).toContain("Shader compilation hitch");
    expect(fs.readFileSync(gameplayDoc, "utf8")).toContain("Gameplay state desync");
  });

  it("reclassifies legacy auto-managed topic docs into reference/topics and skips hand-written docs", () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "game", {
      "FINDINGS.md": "# game FINDINGS\n",
      "reference/frontend.md": [
        "# game - frontend",
        "",
        "## Archived 2025-01-10",
        "",
        "- Shader compilation hitch on first frame",
        "",
      ].join("\n"),
      "reference/rendering-notes.md": [
        "# Rendering Notes",
        "",
        "This is hand-written prose and should not be rewritten.",
      ].join("\n"),
    });
    const saved = writeProjectTopics(phren, "game", [
      { slug: "rendering", label: "Rendering", description: "Graphics and shaders", keywords: ["shader", "frame", "render"] },
      { slug: "general", label: "General", description: "Fallback", keywords: [] },
    ]);
    expect(saved.ok).toBe(true);

    const result = reclassifyLegacyTopicDocs(phren, "game");
    expect(result.movedFiles).toBe(1);
    expect(result.movedEntries).toBe(1);
    expect(result.skipped.some((item) => item.file === "reference/rendering-notes.md")).toBe(true);
    expect(fs.existsSync(path.join(phren, "game", "reference", "frontend.md"))).toBe(false);
    expect(fs.readFileSync(path.join(phren, "game", "reference", "topics", "rendering.md"), "utf8")).toContain("Shader compilation hitch");
    expect(fs.existsSync(path.join(phren, "game", "reference", "rendering-notes.md"))).toBe(true);
  });
});

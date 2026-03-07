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
import { makeTempDir, grantAdmin } from "./test-helpers.js";
import * as path from "path";
import * as fs from "fs";

let tmpDir: string;
let tmpCleanup: (() => void) | undefined;

function makeCortex(): string {
  ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("cortex-reference-"));
  return tmpDir;
}

function makeProject(cortexDir: string, name: string, files: Record<string, string>): void {
  const dir = path.join(cortexDir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const fullPath = path.join(dir, file);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
}

beforeEach(() => {
  process.env.CORTEX_PATH = undefined;
  delete process.env.CORTEX_FINDINGS_CAP;
});

afterEach(() => {
  tmpCleanup?.();
  tmpCleanup = undefined;
  delete process.env.CORTEX_ACTOR;
  delete process.env.CORTEX_FINDINGS_CAP;
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
    const cortex = makeCortex();
    grantAdmin(cortex);
    const findings = `# myapp FINDINGS

## 2025-01-20

- The API endpoint uses REST with pagination
- Build pipeline requires node 20

## 2025-01-10

- Database schema migration needs downtime
- Workaround for the timeout bug in auth module
- Git branch naming convention uses feature/ prefix
`;
    makeProject(cortex, "myapp", { "FINDINGS.md": findings });

    const result = autoArchiveToReference(cortex, "myapp", 2);
    expect(result.ok).toBe(true);
    const archived = result.ok ? result.data : 0;
    expect(archived).toBe(3);

    // Check that reference/ dir was created
    const referenceDir = path.join(cortex, "myapp", "reference");
    expect(fs.existsSync(referenceDir)).toBe(true);

    // Check reference files exist
    const referenceFiles = fs.readdirSync(referenceDir);
    expect(referenceFiles.length).toBeGreaterThan(0);

    // Check FINDINGS.md was trimmed
    const updatedFindings = fs.readFileSync(path.join(cortex, "myapp", "FINDINGS.md"), "utf8");
    const remainingCount = countActiveFindings(updatedFindings);
    expect(remainingCount).toBe(2);

    // Consolidation marker should be present
    expect(updatedFindings).toContain("<!-- consolidated:");
  });

  it("does nothing when entries <= keepCount", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const findings = `# myapp FINDINGS

## 2025-01-20

- First insight
- Second insight
`;
    makeProject(cortex, "myapp", { "FINDINGS.md": findings });

    const result = autoArchiveToReference(cortex, "myapp", 5);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe(0);
  });

  it("appends to existing reference files", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const findings = `# myapp FINDINGS

## 2025-01-20

- New API endpoint design

## 2025-01-05

- Old architecture decision about microservices
- Another old architecture choice for the database layer
`;
    makeProject(cortex, "myapp", {
      "FINDINGS.md": findings,
      "reference/architecture.md": "# myapp - architecture\n\n## Archived 2024-12-01\n\n- Previous architecture note\n",
    });

    autoArchiveToReference(cortex, "myapp", 1);

    const archFile = path.join(cortex, "myapp", "reference", "architecture.md");
    const content = fs.readFileSync(archFile, "utf8");
    expect(content).toContain("Previous architecture note");
    expect(content).toContain("microservices");
  });

  it("removes empty date sections after archival", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const findings = `# myapp FINDINGS

## 2025-01-20

- Keep this one

## 2025-01-05

- Archive this old one
`;
    makeProject(cortex, "myapp", { "FINDINGS.md": findings });

    autoArchiveToReference(cortex, "myapp", 1);

    const updated = fs.readFileSync(path.join(cortex, "myapp", "FINDINGS.md"), "utf8");
    expect(updated).not.toContain("## 2025-01-05");
    expect(updated).toContain("## 2025-01-20");
  });
});

describe("reference/ indexing", () => {
  it("indexes reference/ files with type 'reference'", async () => {
    const cortex = makeCortex();
    makeProject(cortex, "myapp", {
      "FINDINGS.md": "# FINDINGS\n\n## 2025-01-20\n\n- A finding\n",
      "reference/architecture.md": "# Architecture\n\nThe system uses a microservices pattern.\n",
      "reference/findings.md": "# Findings\n\nTimeout on cold start is 30s.\n",
    });

    const db = await buildIndex(cortex);

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
    const cortex = makeCortex();
    grantAdmin(cortex);

    // Build a FINDINGS.md with entries right at the cap
    const bullets = Array.from({ length: 5 }, (_, i) =>
      `- Finding number ${i + 1} about architecture decisions`
    ).join("\n");
    const findings = `# myapp FINDINGS\n\n## 2025-01-10\n\n${bullets}\n`;
    makeProject(cortex, "myapp", { "FINDINGS.md": findings });

    // Set a low cap for testing
    process.env.CORTEX_FINDINGS_CAP = "4";

    addFindingToFile(cortex, "myapp", "Brand new insight about the build system");

    const updated = fs.readFileSync(path.join(cortex, "myapp", "FINDINGS.md"), "utf8");
    const remaining = countActiveFindings(updated);
    // Should have at most cap entries (4), since we added one and had 5 (total 6, archives 2)
    expect(remaining).toBeLessThanOrEqual(4);

    // Knowledge dir should exist with archived entries
    const referenceDir = path.join(cortex, "myapp", "reference");
    expect(fs.existsSync(referenceDir)).toBe(true);
  });

  it("does not archive when under cap", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const findings = `# myapp FINDINGS\n\n## 2025-01-10\n\n- Existing insight\n`;
    makeProject(cortex, "myapp", { "FINDINGS.md": findings });

    process.env.CORTEX_FINDINGS_CAP = "20";
    addFindingToFile(cortex, "myapp", "Another insight");

    const referenceDir = path.join(cortex, "myapp", "reference");
    expect(fs.existsSync(referenceDir)).toBe(false);
  });
});

describe("topic classification", () => {
  it("classifies architecture-related entries", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const findings = `# myapp FINDINGS

## 2025-01-20

- Keep this

## 2025-01-05

- The database schema requires a specific migration order
- Workaround for the race condition in auth
- Deploy pipeline needs manual approval step
`;
    makeProject(cortex, "myapp", { "FINDINGS.md": findings });

    autoArchiveToReference(cortex, "myapp", 1);

    const referenceDir = path.join(cortex, "myapp", "reference");
    const files = fs.readdirSync(referenceDir).sort();

    // Should have created topic-specific files
    expect(files.length).toBeGreaterThan(0);

    // Architecture file should have the database entry
    if (fs.existsSync(path.join(referenceDir, "architecture.md"))) {
      const content = fs.readFileSync(path.join(referenceDir, "architecture.md"), "utf8");
      expect(content).toContain("database schema");
    }

    // Findings file should have the race condition entry
    if (fs.existsSync(path.join(referenceDir, "findings.md"))) {
      const content = fs.readFileSync(path.join(referenceDir, "findings.md"), "utf8");
      expect(content).toContain("race condition");
    }
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  countActiveLearnings,
  autoArchiveToKnowledge,
  addLearningToFile,
  buildIndex,
  queryRows,
} from "./shared.js";
import { makeTempDir, grantAdmin } from "./test-helpers.js";
import * as path from "path";
import * as fs from "fs";

let tmpDir: string;
let tmpCleanup: (() => void) | undefined;

function makeCortex(): string {
  ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("cortex-knowledge-"));
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
  delete process.env.CORTEX_LEARNINGS_CAP;
});

afterEach(() => {
  tmpCleanup?.();
  tmpCleanup = undefined;
  delete process.env.CORTEX_ACTOR;
  delete process.env.CORTEX_LEARNINGS_CAP;
});

describe("countActiveLearnings", () => {
  it("counts bullet entries outside details blocks", () => {
    const content = `# LEARNINGS

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
    expect(countActiveLearnings(content)).toBe(3);
  });

  it("returns 0 for empty content", () => {
    expect(countActiveLearnings("# LEARNINGS\n")).toBe(0);
  });

  it("counts all bullets when no details blocks exist", () => {
    const content = `# LEARNINGS

## 2025-01-15

- One
- Two
- Three
- Four
`;
    expect(countActiveLearnings(content)).toBe(4);
  });
});

describe("autoArchiveToKnowledge", () => {
  it("archives oldest entries to knowledge/ files grouped by topic", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const learnings = `# myapp LEARNINGS

## 2025-01-20

- The API endpoint uses REST with pagination
- Build pipeline requires node 20

## 2025-01-10

- Database schema migration needs downtime
- Workaround for the timeout bug in auth module
- Git branch naming convention uses feature/ prefix
`;
    makeProject(cortex, "myapp", { "LEARNINGS.md": learnings });

    const archived = autoArchiveToKnowledge(cortex, "myapp", 2);
    expect(archived).toBe(3);

    // Check that knowledge/ dir was created
    const knowledgeDir = path.join(cortex, "myapp", "knowledge");
    expect(fs.existsSync(knowledgeDir)).toBe(true);

    // Check knowledge files exist
    const knowledgeFiles = fs.readdirSync(knowledgeDir);
    expect(knowledgeFiles.length).toBeGreaterThan(0);

    // Check LEARNINGS.md was trimmed
    const updatedLearnings = fs.readFileSync(path.join(cortex, "myapp", "LEARNINGS.md"), "utf8");
    const remainingCount = countActiveLearnings(updatedLearnings);
    expect(remainingCount).toBe(2);

    // Consolidation marker should be present
    expect(updatedLearnings).toContain("<!-- consolidated:");
  });

  it("does nothing when entries <= keepCount", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const learnings = `# myapp LEARNINGS

## 2025-01-20

- First insight
- Second insight
`;
    makeProject(cortex, "myapp", { "LEARNINGS.md": learnings });

    const archived = autoArchiveToKnowledge(cortex, "myapp", 5);
    expect(archived).toBe(0);
  });

  it("appends to existing knowledge files", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const learnings = `# myapp LEARNINGS

## 2025-01-20

- New API endpoint design

## 2025-01-05

- Old architecture decision about microservices
- Another old architecture choice for the database layer
`;
    makeProject(cortex, "myapp", {
      "LEARNINGS.md": learnings,
      "knowledge/architecture.md": "# myapp - architecture\n\n## Archived 2024-12-01\n\n- Previous architecture note\n",
    });

    autoArchiveToKnowledge(cortex, "myapp", 1);

    const archFile = path.join(cortex, "myapp", "knowledge", "architecture.md");
    const content = fs.readFileSync(archFile, "utf8");
    expect(content).toContain("Previous architecture note");
    expect(content).toContain("microservices");
  });

  it("removes empty date sections after archival", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const learnings = `# myapp LEARNINGS

## 2025-01-20

- Keep this one

## 2025-01-05

- Archive this old one
`;
    makeProject(cortex, "myapp", { "LEARNINGS.md": learnings });

    autoArchiveToKnowledge(cortex, "myapp", 1);

    const updated = fs.readFileSync(path.join(cortex, "myapp", "LEARNINGS.md"), "utf8");
    expect(updated).not.toContain("## 2025-01-05");
    expect(updated).toContain("## 2025-01-20");
  });
});

describe("knowledge/ indexing", () => {
  it("indexes knowledge/ files with type 'knowledge'", async () => {
    const cortex = makeCortex();
    makeProject(cortex, "myapp", {
      "LEARNINGS.md": "# LEARNINGS\n\n## 2025-01-20\n\n- A learning\n",
      "knowledge/architecture.md": "# Architecture\n\nThe system uses a microservices pattern.\n",
      "knowledge/gotchas.md": "# Gotchas\n\nTimeout on cold start is 30s.\n",
    });

    const db = await buildIndex(cortex);

    const knowledgeRows = queryRows(
      db,
      "SELECT project, filename, type FROM docs WHERE type = 'knowledge'",
      []
    );
    expect(knowledgeRows).not.toBeNull();
    expect(knowledgeRows!.length).toBe(2);

    const filenames = knowledgeRows!.map(r => r[1]).sort();
    expect(filenames).toEqual(["architecture.md", "gotchas.md"]);

    // Verify they are searchable
    const searchResults = queryRows(
      db,
      "SELECT project, filename, type FROM docs WHERE docs MATCH 'microservices'",
      []
    );
    expect(searchResults).not.toBeNull();
    expect(searchResults!.length).toBe(1);
    expect(searchResults![0][2]).toBe("knowledge");
  });
});

describe("size cap in addLearningToFile", () => {
  it("auto-archives when cap is exceeded", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);

    // Build a LEARNINGS.md with entries right at the cap
    const bullets = Array.from({ length: 5 }, (_, i) =>
      `- Learning number ${i + 1} about architecture decisions`
    ).join("\n");
    const learnings = `# myapp LEARNINGS\n\n## 2025-01-10\n\n${bullets}\n`;
    makeProject(cortex, "myapp", { "LEARNINGS.md": learnings });

    // Set a low cap for testing
    process.env.CORTEX_LEARNINGS_CAP = "4";

    addLearningToFile(cortex, "myapp", "Brand new insight about the build system");

    const updated = fs.readFileSync(path.join(cortex, "myapp", "LEARNINGS.md"), "utf8");
    const remaining = countActiveLearnings(updated);
    // Should have at most cap entries (4), since we added one and had 5 (total 6, archives 2)
    expect(remaining).toBeLessThanOrEqual(4);

    // Knowledge dir should exist with archived entries
    const knowledgeDir = path.join(cortex, "myapp", "knowledge");
    expect(fs.existsSync(knowledgeDir)).toBe(true);
  });

  it("does not archive when under cap", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const learnings = `# myapp LEARNINGS\n\n## 2025-01-10\n\n- Existing insight\n`;
    makeProject(cortex, "myapp", { "LEARNINGS.md": learnings });

    process.env.CORTEX_LEARNINGS_CAP = "20";
    addLearningToFile(cortex, "myapp", "Another insight");

    const knowledgeDir = path.join(cortex, "myapp", "knowledge");
    expect(fs.existsSync(knowledgeDir)).toBe(false);
  });
});

describe("topic classification", () => {
  it("classifies architecture-related entries", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const learnings = `# myapp LEARNINGS

## 2025-01-20

- Keep this

## 2025-01-05

- The database schema requires a specific migration order
- Workaround for the race condition in auth
- Deploy pipeline needs manual approval step
`;
    makeProject(cortex, "myapp", { "LEARNINGS.md": learnings });

    autoArchiveToKnowledge(cortex, "myapp", 1);

    const knowledgeDir = path.join(cortex, "myapp", "knowledge");
    const files = fs.readdirSync(knowledgeDir).sort();

    // Should have created topic-specific files
    expect(files.length).toBeGreaterThan(0);

    // Architecture file should have the database entry
    if (fs.existsSync(path.join(knowledgeDir, "architecture.md"))) {
      const content = fs.readFileSync(path.join(knowledgeDir, "architecture.md"), "utf8");
      expect(content).toContain("database schema");
    }

    // Gotchas file should have the race condition entry
    if (fs.existsSync(path.join(knowledgeDir, "gotchas.md"))) {
      const content = fs.readFileSync(path.join(knowledgeDir, "gotchas.md"), "utf8");
      expect(content).toContain("race condition");
    }
  });
});
